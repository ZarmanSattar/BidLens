import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { estimateJudgeTokens } from '../lib/fit/judgeCost'

// §6.4 — the Company Fit section: score, factor breakdown, ranked gap list,
// and a recommended action per gap.
//
// Two halves, and the card is careful never to let them blur:
//
//   §6.2 blockers load automatically on mount from /api/fit/blockers. Plain
//   code, zero tokens, exactly like ContractRiskCard's scan.
//
//   §6.3 soft fit costs tokens and only runs from the button below, which
//   states the estimate before firing. Nothing on page load can reach it.
//
// A score with no AI judgment is marked PROVISIONAL rather than presented as a
// finished assessment — a blocker-only 100 means "no hard stop found", not
// "this company can do the work".

// ---------------------------------------------------------------------------
// Auto-continue (§6.3 polish).
//
// The work has not changed: the same batches, the same total tokens, the same
// server route. The only difference is that the client now waits out the rate
// limit and presses "continue" itself, instead of asking the user to sit there
// doing it five times.
//
// Nothing here starts on its own. The first call is still an explicit click
// with the cost estimate shown next to it; auto-continue only takes over after
// that, and only when the server reports work remaining.
// ---------------------------------------------------------------------------

/** Hard stop, so a genuinely broken state cannot spin forever. */
const MAX_AUTO_ATTEMPTS = 10

/** Used when the server gives no retry hint. Groq's TPM window is 60s. */
const DEFAULT_WAIT_SECONDS = 65

/** Never hammer the API faster than this, whatever the server says. */
const MIN_WAIT_SECONDS = 5

// Beyond this, waiting is not a rate-limit blip — it is a daily quota, and
// sitting on a countdown for twenty minutes helps nobody. The loop stops and
// hands control back with the real number.
const MAX_AUTO_WAIT_SECONDS = 300

const VERDICT_TONE = {
  no_bid: { badge: 'bg-danger', text: 'text-danger' },
  weak_fit: { badge: 'bg-danger', text: 'text-danger' },
  fit_with_gaps: { badge: 'bg-warning text-dark', text: 'text-warning' },
  strong_fit: { badge: 'bg-success', text: 'text-success' },
  // Both "we did not finish assessing" states render grey rather than green.
  // A confident colour on an unfinished assessment is the one thing this card
  // must never do.
  checks_clear: { badge: 'bg-secondary', text: 'text-secondary' },
  not_assessed: { badge: 'bg-secondary', text: 'text-secondary' },
}

const FACTOR_STATUS = {
  pass: { icon: '✅', badge: 'bg-success', label: 'Clear' },
  partial: { icon: '⚠️', badge: 'bg-warning text-dark', label: 'Partial' },
  fail: { icon: '🚫', badge: 'bg-danger', label: 'Blocked' },
  unknown: { icon: '❔', badge: 'bg-secondary', label: 'Not checked' },
}

const ACTION_STYLE = {
  do_not_bid: 'bg-danger',
  partner: 'bg-primary',
  subcontract: 'bg-info text-dark',
  build: 'bg-success',
}

const GAP_STYLE = {
  blocker: { border: 'border-danger', badge: 'bg-danger', label: 'Blocker' },
  gap: { border: 'border-warning', badge: 'bg-warning text-dark', label: 'Gap' },
  partial: { border: 'border-secondary', badge: 'bg-secondary', label: 'Partial' },
}

function ScoreDial({ fit }) {
  const tone = VERDICT_TONE[fit.verdict.key] || VERDICT_TONE.not_assessed

  return (
    <div className="d-flex align-items-center gap-3 flex-wrap">
      <div>
        <div className={`display-5 fw-bold ${tone.text} lh-1`}>
          {fit.score === null ? '—' : fit.score}
          <span className="fs-6 text-muted fw-normal">/100</span>
        </div>
        <span className={`badge ${tone.badge} mt-2`}>{fit.verdict.label}</span>
      </div>

      <div className="flex-grow-1" style={{ minWidth: 200 }}>
        <div className="progress" style={{ height: 10 }}>
          <div
            className={`progress-bar ${tone.badge}`}
            style={{ width: `${fit.score ?? 0}%` }}
          />
        </div>
        <div className="text-muted mt-2" style={{ fontSize: '0.78rem' }}>
          {fit.provisional ? (
            <>
              <strong>Provisional.</strong> Hard blocker checks only — the
              capability half has not been assessed, so this is not yet a fit
              score.
            </>
          ) : (
            <>
              {fit.capabilityScore}/100 capability coverage
              {fit.scoring.penalty > 0 && (
                <> · −{fit.scoring.penalty} for {fit.counts.blockers} blocker(s)</>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function FactorRow({ factor }) {
  const style = FACTOR_STATUS[factor.status] || FACTOR_STATUS.unknown

  return (
    <div className="d-flex gap-2 align-items-start py-2 border-bottom">
      <span style={{ fontSize: '0.95rem' }}>{style.icon}</span>
      <div className="flex-grow-1">
        <div className="d-flex gap-2 align-items-center flex-wrap">
          <span className="fw-semibold text-dark">{factor.label}</span>
          <span className={`badge ${style.badge}`} style={{ fontSize: '0.68rem' }}>
            {style.label}
          </span>
          {typeof factor.score === 'number' && (
            <span className="text-muted" style={{ fontSize: '0.78rem' }}>
              {factor.score}/100
            </span>
          )}
        </div>
        <div className="text-muted" style={{ fontSize: '0.82rem' }}>
          {factor.detail}
        </div>
      </div>
    </div>
  )
}

function GapRow({ gap }) {
  const style = GAP_STYLE[gap.kind === 'blocker' ? 'blocker' : gap.verdict]

  return (
    <div
      className={`bg-light p-3 rounded mb-2 border ${style.border} border-opacity-25`}
    >
      <div className="d-flex gap-2 flex-wrap align-items-center mb-2">
        <span className={`badge ${style.badge}`}>{style.label}</span>
        <span className="badge bg-white text-dark border font-monospace">
          {gap.reqNumber}
        </span>
        {gap.page && (
          <span className="badge bg-light text-dark border">p.{gap.page}</span>
        )}
        {gap.department && (
          <span className="badge bg-light text-dark border">
            {gap.department}
          </span>
        )}
        {gap.source === 'ai' && (
          <span className="badge bg-primary bg-opacity-10 text-primary border border-primary border-opacity-25">
            ✨ AI
          </span>
        )}
        {gap.needsReview && (
          <span className="badge bg-warning text-dark">
            Low confidence — verify
          </span>
        )}
      </div>

      <div className="fw-bold text-dark">{gap.title}</div>

      {gap.detail && (
        <div className="text-muted mt-1" style={{ fontSize: '0.87rem' }}>
          {gap.detail}
        </div>
      )}

      {(gap.required || gap.available) && (
        <div className="row g-2 mt-2">
          <div className="col-md-6">
            <div className="p-2 bg-white border rounded h-100">
              <div className="text-muted text-uppercase fw-bold" style={{ fontSize: '0.66rem' }}>
                The RFP asks for
              </div>
              <div className="text-dark" style={{ fontSize: '0.82rem' }}>
                {gap.required || '—'}
              </div>
            </div>
          </div>
          <div className="col-md-6">
            <div className="p-2 bg-white border rounded h-100">
              <div className="text-muted text-uppercase fw-bold" style={{ fontSize: '0.66rem' }}>
                The profile has
              </div>
              <div className="text-dark" style={{ fontSize: '0.82rem' }}>
                {gap.available || '—'}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="d-flex gap-2 align-items-start mt-2 flex-wrap">
        <span className={`badge ${ACTION_STYLE[gap.action.key] || 'bg-secondary'}`}>
          {gap.action.label}
        </span>
        <span className="text-muted flex-grow-1" style={{ fontSize: '0.8rem' }}>
          {gap.action.why}
        </span>
      </div>

      {gap.text && (
        <details className="mt-2">
          <summary className="text-secondary" style={{ fontSize: '0.78rem', cursor: 'pointer' }}>
            Requirement text
          </summary>
          <div
            className="mt-2 p-2 bg-white border rounded text-secondary"
            style={{ fontSize: '0.8rem', lineHeight: 1.5 }}
          >
            {gap.text}
          </div>
        </details>
      )}
    </div>
  )
}

/**
 * @param {object} props
 * @param {string} props.rfpId
 * @param {number} [props.refreshToken] Bump to force a re-read of the blocker
 *   check. Needed because this card's inputs can change without `rfpId`
 *   changing: fit is assessed against `work_requirement` rows, and those are
 *   written by the shredder AFTER this card has already mounted and answered.
 *   On the results page the shred button is a sibling of this card, so the
 *   card kept rendering the pre-shred payload — requirements_total 0, "no work
 *   requirements to check" — while the traceability matrix beside it showed
 *   the rows that had just been written. Optional: a caller that mounts after
 *   the shred (the traceability page) needs no token and passes none.
 */
export default function CompanyFitCard({ rfpId, refreshToken = 0 }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  // §6.3 state. Entirely separate from the zero-token load above: the card
  // renders identically when all of it is empty.
  const [judging, setJudging] = useState(false)
  const [judgeNotice, setJudgeNotice] = useState(null)

  // Auto-continue state.
  const [autoRunning, setAutoRunning] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [countdown, setCountdown] = useState(0)

  // Refs, not state: the loop is an async function that has to read the CURRENT
  // stop flag between awaits. A state value captured when the loop started
  // would never change from inside it.
  const stopRef = useRef(false)
  const timerRef = useRef(null)

  useEffect(() => {
    if (!rfpId) {
      return
    }

    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      // A different RFP's notices must never survive onto a new check. The
      // judgments themselves now come back from the server with the blocker
      // load, so there is no client-side copy to clear.
      setJudgeNotice(null)

      try {
        const response = await fetch('/api/fit/blockers', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rfp_id: rfpId }),
        })

        const payload = await response.json()

        if (cancelled) return

        if (!response.ok) {
          setError(payload.error || 'The company fit check failed.')
        } else {
          setData(payload)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err?.message || 'Could not reach the company fit check.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()

    return () => {
      cancelled = true
      // Switching RFP (or unmounting) must not leave an auto-loop running
      // against the previous one, nor a countdown ticking into a dead card.
      stopRef.current = true
      clearWaitTimer()
    }
  }, [rfpId, refreshToken])

  const fit = data?.fit
  const clearCount = data?.clear_count ?? 0

  // Progress comes from the SERVER on every response — both the free blocker
  // load and the judgment call — because fit_judgments is the source of truth
  // now, not component state. `remaining` is what the next click would cost.
  const progress = data?.progress
  const remaining = progress ? progress.remaining : clearCount
  const complete = Boolean(progress?.complete)

  // Estimate what is LEFT, not the whole document. After a partial run, the
  // number on the button has to be the price of continuing.
  const estimate = estimateJudgeTokens(remaining)

  function clearWaitTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  /**
   * Waits `seconds`, ticking a visible countdown, and resolves early on Stop.
   *
   * @param {number} seconds
   * @returns {Promise<'done'|'stopped'>}
   */
  function waitWithCountdown(seconds) {
    return new Promise((resolve) => {
      let left = seconds

      setCountdown(left)

      timerRef.current = setInterval(() => {
        if (stopRef.current) {
          clearWaitTimer()
          setCountdown(0)
          resolve('stopped')

          return
        }

        left -= 1
        setCountdown(left)

        if (left <= 0) {
          clearWaitTimer()
          resolve('done')
        }
      }, 1000)
    })
  }

  /**
   * One call to /api/fit/judge, normalized into a decision the loop can act on.
   *
   * @returns {Promise<object>} `{fatal, message, remaining, judgedThisCall,
   *   waitSeconds}`. `fatal` means stop now and show the message — a real
   *   failure, not a rate limit.
   */
  async function judgeOnce() {
    let response
    let payload

    try {
      response = await fetch('/api/fit/judge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rfp_id: rfpId }),
      })

      payload = await response.json().catch(() => ({}))
    } catch (err) {
      // Could not reach the server at all. Retrying blindly would just spin.
      return {
        fatal: true,
        message:
          err?.message ||
          'Could not reach the fit judgment service. The blocker checks below are unaffected.',
      }
    }

    // Even a 429 carries progress and a score built from what IS saved, so the
    // state is adopted before any error branch returns. Anything already
    // written to fit_judgments is never lost by a failed continuation.
    if (payload.progress) {
      setData((previous) => ({
        ...previous,
        fit: payload.fit || previous.fit,
        progress: payload.progress,
      }))
    }

    // A 429 is the expected rate-limit stop and IS retryable. Every other
    // non-OK status is a real problem — a missing profile, an unshredded RFP, a
    // server fault — and retrying it would fail identically.
    if (!response.ok && response.status !== 429) {
      return {
        fatal: true,
        message:
          payload.error ||
          'The fit judgment failed. The blocker checks below are unaffected.',
      }
    }

    // The server already passes judgeFit's abort block straight through, so the
    // real reset time is available without any change to the route. It is in
    // milliseconds here, unlike the shredder routes which normalize to
    // retry_after_seconds at the route layer.
    const retryAfterMs = payload.stats?.aborted?.retryAfterMs

    const waitSeconds = Number.isFinite(Number(retryAfterMs))
      ? Math.max(MIN_WAIT_SECONDS, Math.ceil(Number(retryAfterMs) / 1000) + 5)
      : DEFAULT_WAIT_SECONDS

    return {
      fatal: false,
      remaining: payload.progress?.remaining ?? 0,
      judged: payload.progress?.judged ?? 0,
      total: payload.progress?.total ?? 0,
      judgedThisCall: payload.progress?.judged_this_call ?? 0,
      rateLimited: Boolean(payload.stats?.aborted) || response.status === 429,
      waitSeconds,
      message: payload.message,
    }
  }

  // §6.3 — opt-in. The FIRST call is still an explicit click with the cost
  // estimate shown beside it; from there this drives the remaining calls
  // itself, waiting out the rate limit between them. Same batches, same total
  // cost — just without making the user press the button five times.
  async function handleJudge() {
    stopRef.current = false

    setAutoRunning(true)
    setJudgeNotice(null)

    let attempts = 0
    let lastRemaining = null

    try {
      while (!stopRef.current) {
        attempts += 1

        setAttempt(attempts)
        setJudging(true)

        const outcome = await judgeOnce()

        setJudging(false)

        if (stopRef.current) {
          break
        }

        if (outcome.fatal) {
          setJudgeNotice({ tone: 'warning', text: outcome.message })

          break
        }

        if (outcome.remaining === 0) {
          setJudgeNotice(
            outcome.judgedThisCall === 0 && attempts === 1
              ? {
                  tone: 'info',
                  text: outcome.message || 'Already judged — no AI call was needed.',
                }
              : {
                  tone: 'success',
                  text: `All ${outcome.total} unblocked requirements judged and saved.`,
                }
          )

          break
        }

        // No forward progress between two consecutive calls means waiting
        // longer will not help — something other than the rate limit is
        // stopping it.
        if (lastRemaining !== null && outcome.remaining === lastRemaining) {
          setJudgeNotice({
            tone: 'warning',
            text:
              `Stopped: two attempts in a row judged nothing new (${outcome.remaining} still ` +
              'to go). Everything judged so far is saved. ' +
              (outcome.message || 'Try again later, or check the server logs.'),
          })

          break
        }

        lastRemaining = outcome.remaining

        if (attempts >= MAX_AUTO_ATTEMPTS) {
          setJudgeNotice({
            tone: 'warning',
            text:
              `Stopped after ${MAX_AUTO_ATTEMPTS} automatic attempts with ` +
              `${outcome.remaining} requirement(s) still to judge. Everything ` +
              'judged so far is saved — press Continue to keep going.',
          })

          break
        }

        if (outcome.waitSeconds > MAX_AUTO_WAIT_SECONDS) {
          setJudgeNotice({
            tone: 'warning',
            text:
              `Groq wants ${Math.ceil(outcome.waitSeconds / 60)} minute(s) before the next ` +
              'call, which is a daily quota rather than the per-minute limit. ' +
              `Stopping here — ${outcome.judged} of ${outcome.total} are judged and saved. ` +
              'Press Continue once the quota resets.',
          })

          break
        }

        setJudgeNotice({
          tone: 'info',
          text:
            `Judged ${outcome.judged} of ${outcome.total} so far — ${outcome.remaining} to go. ` +
            'Everything judged is saved. Waiting out Groq’s rate limit, then continuing automatically.',
        })

        if ((await waitWithCountdown(outcome.waitSeconds)) === 'stopped') {
          break
        }
      }

      if (stopRef.current) {
        setJudgeNotice({
          tone: 'info',
          text:
            'Stopped. Everything judged so far is saved — press Continue to pick ' +
            'up where it left off.',
        })
      }
    } finally {
      clearWaitTimer()
      setJudging(false)
      setAutoRunning(false)
      setCountdown(0)
      setAttempt(0)
    }
  }

  /** Cancels the auto-loop. A call already in flight is allowed to finish and
   *  save, since stopping mid-request would waste tokens already spent. */
  function handleStop() {
    stopRef.current = true
    clearWaitTimer()
    setCountdown(0)
  }

  return (
    <div className="card mb-4 shadow-sm border-0">
      <div className="card-header bg-transparent border-bottom d-flex justify-content-between align-items-center flex-wrap gap-2">
        <h5 className="mb-0 fw-bold text-primary">🏢 Company Fit</h5>
        <Link
          href="/company-profile"
          className="btn btn-sm btn-outline-secondary"
        >
          Edit company profile ↗
        </Link>
      </div>

      <div className="card-body">
        {!rfpId ? (
          <p className="text-muted mb-0 text-center py-3">
            This analysis has not been saved to an RFP record yet, so it cannot
            be checked against the company profile.
          </p>
        ) : loading ? (
          <p className="text-muted mb-0 text-center py-3">
            <span className="spinner-border spinner-border-sm me-2" role="status" />
            Checking requirements against the company profile…
          </p>
        ) : error ? (
          <div className="alert alert-warning mb-0">{error}</div>
        ) : !data ? null : data.requirements_total === 0 ? (
          <div className="alert alert-info mb-0">
            <strong>No work requirements to check.</strong>
            <div className="mt-2 small">
              Fit is assessed against classified <code>work_requirement</code>{' '}
              rows. Shred this RFP first.
            </div>
          </div>
        ) : (
          <>
            {!data.has_profile && (
              <div className="alert alert-warning">
                <strong>No company profile on file.</strong>
                <div className="mt-2 small">
                  Nothing could be checked — this is not a clean bill of health.{' '}
                  <Link href="/company-profile">Fill in the company profile</Link>{' '}
                  to enable the blocker checks and the fit judgment.
                </div>
              </div>
            )}

            <ScoreDial fit={fit} />

            {/* §6.3 trigger. Opt-in by design — everything above is free and
                automatic, this costs tokens and only runs on click.
                The button retires ONLY when nothing is left to judge. A
                partial run leaves it live, because pressing it again now
                continues from the saved judgments instead of starting over. */}
            <div className="d-flex flex-wrap align-items-center gap-2 my-3 py-3 border-top border-bottom">
              <button
                className="btn btn-sm btn-outline-primary fw-semibold"
                onClick={handleJudge}
                disabled={
                  autoRunning || complete || !data.has_profile || clearCount === 0
                }
              >
                {judging ? (
                  <>
                    <span
                      className="spinner-border spinner-border-sm me-2"
                      role="status"
                    />
                    Judging fit…
                    {attempt > 1 ? ` (attempt ${attempt})` : ''}
                  </>
                ) : autoRunning ? (
                  <>
                    <span
                      className="spinner-border spinner-border-sm me-2"
                      role="status"
                    />
                    Waiting to continue…
                  </>
                ) : complete ? (
                  '✓ Fit judged'
                ) : progress && progress.judged > 0 ? (
                  `✨ Continue judging (${remaining} left)`
                ) : (
                  '✨ Judge fit with AI'
                )}
              </button>

              {/* Live state while the loop is running: what is done, what is
                  left, and exactly how long until the next call — never a
                  silent hang. */}
              {autoRunning && (
                <>
                  <button
                    className="btn btn-sm btn-outline-secondary fw-semibold"
                    onClick={handleStop}
                  >
                    ■ Stop
                  </button>

                  <span className="text-muted" style={{ fontSize: '0.78rem' }}>
                    {countdown > 0 ? (
                      <>
                        Judged <strong>{progress?.judged ?? 0}</strong> of{' '}
                        <strong>{progress?.total ?? clearCount}</strong> —
                        continuing in <strong>{countdown}s</strong> (attempt{' '}
                        {attempt} of {MAX_AUTO_ATTEMPTS})
                      </>
                    ) : (
                      <>
                        Continuing automatically · attempt {attempt} of{' '}
                        {MAX_AUTO_ATTEMPTS} · no extra cost beyond the estimate
                      </>
                    )}
                  </span>
                </>
              )}

              {!complete && !autoRunning && (
                <span className="text-muted" style={{ fontSize: '0.78rem' }}>
                  {!data.has_profile
                    ? 'Needs a company profile first.'
                    : clearCount === 0
                      ? 'Every requirement is already blocked — nothing left to judge.'
                      : `Uses AI · ${estimate.batches} call${
                          estimate.batches === 1 ? '' : 's'
                        } for ${remaining} remaining requirement${
                          remaining === 1 ? '' : 's'
                        } · ${estimate.label} · continues automatically if Groq rate-limits, no extra cost`}
                </span>
              )}

              {progress && progress.judged > 0 && (
                <span
                  className="badge bg-light text-dark border"
                  style={{ fontSize: '0.72rem' }}
                >
                  {progress.judged} of {progress.total} judged
                  {complete ? '' : ` · ${remaining} to go`}
                </span>
              )}
            </div>

            {data.judgments_error && (
              <div className="alert alert-warning py-2" style={{ fontSize: '0.85rem' }}>
                Saved fit judgments could not be read ({data.judgments_error}).
                The blocker checks below are unaffected.
              </div>
            )}

            {judgeNotice && (
              <div
                className={`alert alert-${judgeNotice.tone} py-2`}
                style={{ fontSize: '0.85rem' }}
              >
                {judgeNotice.text}
              </div>
            )}

            <h6 className="fw-bold text-dark mt-3">Factor breakdown</h6>
            <div className="mb-4">
              {fit.factors.map((factor) => (
                <FactorRow key={factor.key} factor={factor} />
              ))}
            </div>

            <h6 className="fw-bold text-dark d-flex align-items-center gap-2 flex-wrap">
              Gaps and recommended actions
              <span className="badge bg-light text-dark border">
                {fit.gaps.length}
              </span>
            </h6>

            {fit.gaps.length === 0 ? (
              <div className="py-2">
                <span className="text-success fw-semibold">
                  ✅ No blockers found in the checks that could run.
                </span>
                <div className="text-muted mt-2" style={{ fontSize: '0.85rem' }}>
                  {fit.provisional
                    ? 'The capability half has not been assessed yet — run the fit judgment above for the rest of the picture.'
                    : 'Every judged requirement came back as “can do”.'}
                </div>
              </div>
            ) : (
              fit.gaps.map((gap) => (
                <GapRow key={gap.id} gap={gap} />
              ))
            )}

            <div
              className="text-muted mt-3 pt-3 border-top"
              style={{ fontSize: '0.78rem', lineHeight: '1.6' }}
            >
              Blockers are exact comparisons made in plain code against the
              company profile — no AI, and each one names the REQ number that
              caused it. Recommended actions come from a fixed rule table, not
              from a model. {data.stats?.unquantified > 0 && (
                <>
                  {data.stats.unquantified} requirement(s) state a bond or
                  coverage as a percentage of contract value, which cannot be
                  compared without knowing that value — they produced no
                  blocker.{' '}
                </>
              )}
              {(data.stats?.skippedRules || []).length > 0 && (
                <>
                  Not every rule could run: {data.stats.skippedRules.join(', ')}{' '}
                  had nothing on the profile to compare against.
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
