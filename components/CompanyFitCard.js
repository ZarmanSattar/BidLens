import { useEffect, useState } from 'react'
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

export default function CompanyFitCard({ rfpId }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  // §6.3 state. Entirely separate from the zero-token load above: the card
  // renders identically when all of it is empty.
  const [judging, setJudging] = useState(false)
  const [judgeNotice, setJudgeNotice] = useState(null)

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
    }
  }, [rfpId])

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

  // §6.3 — opt-in, one call, never fired on render. Mirrors ContractRiskCard's
  // explain button and the shredder's deliberate two-step.
  async function handleJudge() {
    setJudging(true)
    setJudgeNotice(null)

    try {
      const response = await fetch('/api/fit/judge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rfp_id: rfpId }),
      })

      const payload = await response.json().catch(() => ({}))

      // Even a 429 carries progress and a score built from what IS saved, so
      // the state is adopted before the error branch returns. Anything already
      // written to fit_judgments is not lost by a failed continuation.
      if (payload.progress) {
        setData((previous) => ({
          ...previous,
          fit: payload.fit || previous.fit,
          progress: payload.progress,
        }))
      }

      if (!response.ok) {
        setJudgeNotice({
          tone: 'warning',
          text:
            payload.error ||
            'The fit judgment failed. The blocker checks below are unaffected.',
        })

        return
      }

      const done = payload.progress?.judged ?? 0
      const left = payload.progress?.remaining ?? 0
      const thisCall = payload.progress?.judged_this_call ?? 0

      if (left === 0) {
        // Nothing further to spend on. Only now does the button retire.
        setJudgeNotice(
          thisCall === 0
            ? { tone: 'info', text: payload.message || 'Already judged — no AI call was needed.' }
            : null
        )
      } else if (thisCall === 0) {
        setJudgeNotice({
          tone: 'warning',
          text:
            payload.message ||
            'No new requirements could be judged this time. Anything already saved is unaffected — try again.',
        })
      } else {
        // A partial run is the expected outcome on a rate-limited tier, not a
        // fault: ~20,000 tokens of work does not fit in a 12,000-token rolling
        // window. Progress IS saved, so say so and say what continuing costs.
        const stopped = payload.stats?.aborted

        setJudgeNotice({
          tone: 'info',
          text:
            `Judged ${thisCall} more — ${done} of ${payload.progress.total} now done, ${left} to go. ` +
            (stopped
              ? "Groq's rate limit stopped the run early. Everything judged so far is saved; press the button again once the limit resets to continue where it left off."
              : 'Everything judged so far is saved. Press the button again to continue.'),
        })
      }
    } catch (err) {
      setJudgeNotice({
        tone: 'warning',
        text:
          err?.message ||
          'Could not reach the fit judgment service. The blocker checks below are unaffected.',
      })
    } finally {
      setJudging(false)
    }
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
                  judging || complete || !data.has_profile || clearCount === 0
                }
              >
                {judging ? (
                  <>
                    <span
                      className="spinner-border spinner-border-sm me-2"
                      role="status"
                    />
                    Judging fit…
                  </>
                ) : complete ? (
                  '✓ Fit judged'
                ) : progress && progress.judged > 0 ? (
                  `✨ Continue judging (${remaining} left)`
                ) : (
                  '✨ Judge fit with AI'
                )}
              </button>

              {!complete && (
                <span className="text-muted" style={{ fontSize: '0.78rem' }}>
                  {!data.has_profile
                    ? 'Needs a company profile first.'
                    : clearCount === 0
                      ? 'Every requirement is already blocked — nothing left to judge.'
                      : `Uses AI · ${estimate.batches} call${
                          estimate.batches === 1 ? '' : 's'
                        } for ${remaining} remaining requirement${
                          remaining === 1 ? '' : 's'
                        } · ${estimate.label}`}
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
