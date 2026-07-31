import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { estimateSkeletonTokens } from '../lib/response/skeletonCost'

// ---------------------------------------------------------------------------
// Auto-continue (§8.3), built in from the start rather than added after a
// failure. Generating ~109 drafts costs far more than the 12,000-token rolling
// window holds, so a run stopping part-way is the NORMAL outcome, not an
// error. The same loop and the same guards as CompanyFitCard, because those
// were paid for once already.
// ---------------------------------------------------------------------------

/** Hard stop, so a genuinely broken state cannot spin forever. */
const MAX_AUTO_ATTEMPTS = 10

/** Used when the server gives no retry hint. Groq's TPM window is 60s. */
const DEFAULT_WAIT_SECONDS = 65

/** Never hammer the API faster than this, whatever the server says. */
const MIN_WAIT_SECONDS = 5

// Beyond this it is a daily quota rather than the per-minute limit, and
// sitting on a countdown for twenty minutes helps nobody.
const MAX_AUTO_WAIT_SECONDS = 300

// §8.4 — how much of the proposal has a draft response, and what does not.
//
// Loads on mount from /api/skeletons/coverage: two table reads, zero tokens,
// no AI trigger of any kind on this card.
//
// Today it will read 0 of N covered, because §8.3's generation pass is Part 2
// and nothing writes to response_skeletons yet. That is deliberately shown as
// a real measurement rather than hidden behind a "coming soon" placeholder —
// the query is live, and the number moves by itself once generation lands.

const ROLE_LABEL = {
  work_requirement: 'Work requirements',
  evaluation_factor: 'Evaluation factors',
}

function CoverageBar({ covered, total, percent }) {
  const tone = percent === 100 ? 'success' : percent > 0 ? 'warning' : 'secondary'

  return (
    <div className="d-flex align-items-center gap-3 flex-wrap">
      <div>
        <div className={`display-6 fw-bold text-${tone} lh-1`}>
          {covered}
          <span className="fs-6 text-muted fw-normal">/{total}</span>
        </div>
        <div className="text-muted small">drafted</div>
      </div>

      <div className="flex-grow-1" style={{ minWidth: 200 }}>
        <div className="progress" style={{ height: 10 }}>
          <div className={`progress-bar bg-${tone}`} style={{ width: `${percent}%` }} />
        </div>
        <div className="text-muted mt-2" style={{ fontSize: '0.78rem' }}>
          {percent}% of the requirements that need a written response have one.
        </div>
      </div>
    </div>
  )
}

export default function ResponseCoverageCard({ rfpId }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [showAll, setShowAll] = useState(false)

  // §8.3 generation state. Entirely separate from the zero-token load above:
  // the card renders identically when none of it is touched.
  const [building, setBuilding] = useState(false)
  const [autoRunning, setAutoRunning] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [countdown, setCountdown] = useState(0)
  const [notice, setNotice] = useState(null)

  // Refs, not state: the loop reads the CURRENT stop flag between awaits, and
  // a value captured when it started would never change from inside it.
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

      try {
        const response = await fetch('/api/skeletons/coverage', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rfp_id: rfpId }),
        })

        const payload = await response.json()

        if (cancelled) return

        if (!response.ok) {
          setError(payload.error || 'The coverage check failed.')
        } else {
          setData(payload)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err?.message || 'Could not reach the coverage check.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()

    return () => {
      cancelled = true
      // Switching RFP or unmounting must not leave a loop running against the
      // previous one, nor a countdown ticking into a dead card.
      stopRef.current = true
      clearWaitTimer()
    }
  }, [rfpId])

  const missing = data?.missingItems || []
  const visible = showAll ? missing : missing.slice(0, 12)

  const progress = data?.progress
  const remaining = progress ? progress.remaining : missing.length
  const complete = Boolean(progress?.complete)
  const canGenerate = Boolean(data?.generation_available)

  // Prices what is LEFT, not the whole document — after a partial run the
  // number on the button has to be the cost of continuing.
  const estimate = estimateSkeletonTokens(remaining)

  function clearWaitTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  /**
   * Waits `seconds`, ticking a visible countdown, resolving early on Stop.
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
   * One call to /api/response/build, normalized into a loop decision.
   *
   * @returns {Promise<object>} `fatal` means stop now — a real failure, not a
   *   rate limit.
   */
  async function buildOnce() {
    let response
    let payload

    try {
      response = await fetch('/api/response/build', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rfp_id: rfpId }),
      })

      payload = await response.json().catch(() => ({}))
    } catch (err) {
      return {
        fatal: true,
        message: err?.message || 'Could not reach the generation service.',
      }
    }

    // Even a 429 carries progress built from what IS saved.
    if (payload.progress) {
      setData((previous) => ({
        ...previous,
        progress: payload.progress,
        covered: payload.progress.drafted,
        missing: payload.progress.remaining,
        percent:
          payload.progress.total === 0
            ? 0
            : Math.round((payload.progress.drafted / payload.progress.total) * 100),
      }))
    }

    // A 429 is the expected rate-limit stop and IS retryable. Every other
    // non-OK status is a real problem that retrying would hit identically.
    if (!response.ok && response.status !== 429) {
      return {
        fatal: true,
        message: payload.error || 'The generation pass failed.',
      }
    }

    const retryAfterMs = payload.stats?.aborted?.retryAfterMs

    const waitSeconds = Number.isFinite(Number(retryAfterMs))
      ? Math.max(MIN_WAIT_SECONDS, Math.ceil(Number(retryAfterMs) / 1000) + 5)
      : DEFAULT_WAIT_SECONDS

    return {
      fatal: false,
      remaining: payload.progress?.remaining ?? 0,
      drafted: payload.progress?.drafted ?? 0,
      total: payload.progress?.total ?? 0,
      draftedThisCall: payload.progress?.drafted_this_call ?? 0,
      waitSeconds,
      message: payload.message,
    }
  }

  // Opt-in. The first call is an explicit click with the estimate beside it;
  // from there this drives the remaining batches itself.
  async function handleBuild() {
    stopRef.current = false

    setAutoRunning(true)
    setNotice(null)

    let attempts = 0
    let lastRemaining = null

    try {
      while (!stopRef.current) {
        attempts += 1

        setAttempt(attempts)
        setBuilding(true)

        const outcome = await buildOnce()

        setBuilding(false)

        if (stopRef.current) break

        if (outcome.fatal) {
          setNotice({ tone: 'warning', text: outcome.message })
          break
        }

        if (outcome.remaining === 0) {
          setNotice({
            tone: 'success',
            text: `All ${outcome.total} requirements have a current draft.`,
          })
          break
        }

        // Two consecutive calls with no forward progress means waiting longer
        // will not help.
        if (lastRemaining !== null && outcome.remaining === lastRemaining) {
          setNotice({
            tone: 'warning',
            text:
              `Stopped: two attempts in a row drafted nothing new (${outcome.remaining} ` +
              'still to write). Everything drafted so far is saved. ' +
              (outcome.message || 'Try again later, or check the server logs.'),
          })
          break
        }

        lastRemaining = outcome.remaining

        if (attempts >= MAX_AUTO_ATTEMPTS) {
          setNotice({
            tone: 'warning',
            text:
              `Stopped after ${MAX_AUTO_ATTEMPTS} automatic attempts with ` +
              `${outcome.remaining} still to draft. Everything so far is saved — ` +
              'press Continue to keep going.',
          })
          break
        }

        if (outcome.waitSeconds > MAX_AUTO_WAIT_SECONDS) {
          setNotice({
            tone: 'warning',
            text:
              `Groq wants ${Math.ceil(outcome.waitSeconds / 60)} minute(s) before the ` +
              'next call, which is a daily quota rather than the per-minute limit. ' +
              `Stopping here — ${outcome.drafted} of ${outcome.total} are drafted and saved.`,
          })
          break
        }

        setNotice({
          tone: 'info',
          text:
            `Drafted ${outcome.drafted} of ${outcome.total} — ${outcome.remaining} to go. ` +
            'Everything drafted is saved. Waiting out Groq’s rate limit, then continuing automatically.',
        })

        if ((await waitWithCountdown(outcome.waitSeconds)) === 'stopped') break
      }

      if (stopRef.current) {
        setNotice({
          tone: 'info',
          text:
            'Stopped. Everything drafted so far is saved — press Continue to ' +
            'pick up where it left off.',
        })
      }
    } finally {
      clearWaitTimer()
      setBuilding(false)
      setAutoRunning(false)
      setCountdown(0)
      setAttempt(0)
    }
  }

  /** Cancels the loop. A call in flight finishes and saves, since stopping
   *  mid-request would waste tokens already spent. */
  function handleStop() {
    stopRef.current = true
    clearWaitTimer()
    setCountdown(0)
  }

  return (
    <div className="card mb-4 shadow-sm border-0">
      <div className="card-header bg-transparent border-bottom d-flex justify-content-between align-items-center flex-wrap gap-2">
        <h5 className="mb-0 fw-bold text-primary">✍️ Response Coverage</h5>
        <Link href="/content-library" className="btn btn-sm btn-outline-secondary">
          Edit content library ↗
        </Link>
      </div>

      <div className="card-body">
        {!rfpId ? (
          <p className="text-muted mb-0 text-center py-3">
            This analysis has not been saved to an RFP record yet, so there is
            nothing to draft against.
          </p>
        ) : loading ? (
          <p className="text-muted mb-0 text-center py-3">
            <span className="spinner-border spinner-border-sm me-2" role="status" />
            Counting drafted responses…
          </p>
        ) : error ? (
          <div className="alert alert-warning mb-0">{error}</div>
        ) : !data ? null : data.total === 0 ? (
          <div className="alert alert-info mb-0">
            <strong>Nothing to respond to yet.</strong>
            <div className="mt-2 small">{data.note}</div>
          </div>
        ) : (
          <>
            <CoverageBar
              covered={data.covered}
              total={data.total}
              percent={data.percent}
            />

            {data.note && (
              <div className="alert alert-secondary mt-3 py-2" style={{ fontSize: '0.85rem' }}>
                {data.note}
              </div>
            )}

            {/* §8.3 trigger. Opt-in — everything above is free and automatic,
                this costs tokens and only runs on click. The button retires
                only when nothing is left, so a partial run leaves it live. */}
            <div className="d-flex flex-wrap align-items-center gap-2 my-3 py-3 border-top border-bottom">
              <button
                className="btn btn-sm btn-outline-primary fw-semibold"
                onClick={handleBuild}
                disabled={autoRunning || complete || !canGenerate || data.total === 0}
              >
                {building ? (
                  <>
                    <span className="spinner-border spinner-border-sm me-2" role="status" />
                    Drafting…{attempt > 1 ? ` (attempt ${attempt})` : ''}
                  </>
                ) : autoRunning ? (
                  <>
                    <span className="spinner-border spinner-border-sm me-2" role="status" />
                    Waiting to continue…
                  </>
                ) : complete ? (
                  '✓ All drafted'
                ) : data.covered > 0 ? (
                  `✨ Continue drafting (${remaining} left)`
                ) : (
                  '✨ Draft responses with AI'
                )}
              </button>

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
                        Drafted <strong>{data.covered}</strong> of{' '}
                        <strong>{data.total}</strong> — continuing in{' '}
                        <strong>{countdown}s</strong> (attempt {attempt} of{' '}
                        {MAX_AUTO_ATTEMPTS})
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
                  {!canGenerate
                    ? 'Needs content library entries first.'
                    : `Uses AI · ${estimate.batches} call${
                        estimate.batches === 1 ? '' : 's'
                      } for ${remaining} requirement${remaining === 1 ? '' : 's'} · ` +
                      `${estimate.label} · continues automatically if rate-limited`}
                </span>
              )}
            </div>

            {notice && (
              <div className={`alert alert-${notice.tone} py-2`} style={{ fontSize: '0.85rem' }}>
                {notice.text}
              </div>
            )}

            {/* §8.2 staleness — drafts that exist but can no longer be trusted.
                Counted inside "still to write", because that is the work. */}
            {data.stale > 0 && (
              <div className="alert alert-warning py-2" style={{ fontSize: '0.85rem' }}>
                <strong>
                  {data.stale} draft{data.stale === 1 ? ' is' : 's are'} out of date.
                </strong>{' '}
                {data.staleItems
                  .slice(0, 3)
                  .map((item) => `${item.reqNumber} (${item.reasons.join(', ').replace(/_/g, ' ')})`)
                  .join(', ')}
                {data.staleItems.length > 3 && `, +${data.staleItems.length - 3} more`}. These
                will be redrafted rather than skipped.
              </div>
            )}

            <div className="row g-2 mt-2">
              {Object.entries(data.byRole || {}).map(([role, counts]) => (
                <div className="col-md-6" key={role}>
                  <div className="p-2 bg-light border rounded">
                    <div className="fw-semibold text-dark" style={{ fontSize: '0.85rem' }}>
                      {ROLE_LABEL[role] || role}
                    </div>
                    <div className="text-muted" style={{ fontSize: '0.8rem' }}>
                      {counts.covered} drafted · {counts.missing} to write ·{' '}
                      {counts.total} total
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {Object.keys(data.byDepartment || {}).length > 0 && (
              <div className="mt-3">
                <div className="text-muted text-uppercase fw-bold" style={{ fontSize: '0.68rem' }}>
                  By department
                </div>
                <div className="d-flex flex-wrap gap-2 mt-1">
                  {Object.entries(data.byDepartment).map(([department, counts]) => (
                    <span key={department} className="badge bg-light text-dark border">
                      {department}: {counts.covered}/{counts.total}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {missing.length > 0 && (
              <div className="mt-4">
                <h6 className="fw-bold text-dark d-flex align-items-center gap-2 flex-wrap">
                  Still to write
                  <span className="badge bg-light text-dark border">{missing.length}</span>
                </h6>

                <div className="d-flex flex-wrap gap-1 mb-3">
                  {data.missingReqNumbers.slice(0, showAll ? undefined : 40).map((reqNumber) => (
                    <span
                      key={reqNumber}
                      className="badge bg-white text-dark border font-monospace"
                      style={{ fontSize: '0.7rem' }}
                    >
                      {reqNumber}
                    </span>
                  ))}
                  {!showAll && data.missingReqNumbers.length > 40 && (
                    <span className="text-muted" style={{ fontSize: '0.75rem' }}>
                      +{data.missingReqNumbers.length - 40} more
                    </span>
                  )}
                </div>

                {visible.map((entry) => (
                  <div
                    key={entry.requirementId}
                    className="bg-light p-2 rounded mb-2 border border-secondary border-opacity-25"
                  >
                    <div className="d-flex gap-2 flex-wrap align-items-center mb-1">
                      <span className="badge bg-white text-dark border font-monospace">
                        {entry.reqNumber}
                      </span>
                      {entry.department && (
                        <span className="badge bg-light text-dark border">
                          {entry.department}
                        </span>
                      )}
                      <span className="badge bg-light text-dark border">
                        {ROLE_LABEL[entry.role] || entry.role}
                      </span>
                      {entry.page && (
                        <span className="badge bg-light text-dark border">
                          p.{entry.page}
                        </span>
                      )}
                    </div>
                    <div className="text-secondary" style={{ fontSize: '0.82rem' }}>
                      {entry.text}
                    </div>
                  </div>
                ))}

                {missing.length > 12 && (
                  <button
                    className="btn btn-sm btn-light border text-secondary fw-semibold"
                    onClick={() => setShowAll(!showAll)}
                    style={{ fontSize: '0.75rem' }}
                  >
                    {showAll ? '▲ Show fewer' : `▼ Show all ${missing.length}`}
                  </button>
                )}
              </div>
            )}

            <div
              className="text-muted mt-3 pt-3 border-top"
              style={{ fontSize: '0.78rem', lineHeight: '1.6' }}
            >
              Counts {(data.roles_counted || []).map((role) => ROLE_LABEL[role] || role).join(' and ').toLowerCase()}{' '}
              only. Submission instructions are packaging rules rather than
              prose, and requirements marked not applicable obligate nobody, so
              neither needs a written response. No AI was used to produce this
              count.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
