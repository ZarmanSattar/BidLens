import { useState } from 'react'

// One-click replacement for the manual two-command shredder workflow.
//
// The payloads below are byte-for-byte what the PowerShell/curl calls send —
// POST application/json {"rfp_id": "..."} to each route in turn — so the
// manual path keeps working unchanged and this is purely a second caller.
// Neither route is modified.
//
// Two deliberate safety properties:
//
//   1. This button is only ever rendered from the EMPTY state of the
//      traceability matrix. /api/shredder/run appends a fresh set of REQ
//      numbers on every call (numbering is never reassigned), so offering a
//      re-run against an RFP that already has requirements would silently
//      double the dataset. An RFP with rows never shows the button.
//   2. Nothing fires without an explicit confirmation step. The run costs
//      real quota, so the estimate is shown first and the request is only
//      sent from the confirm handler.

// Both routes declare maxDuration = 300. Aborting earlier than the server
// will give up would report a failure for a run that is still writing rows.
const REQUEST_TIMEOUT_MS = 300000

// Measured against the 44-page / 222-candidate ODU document: classification
// is ~12 batches of 20 (~43k), linking ~8 batches against a 51-anchor catalog
// (~40k). Larger documents scale roughly linearly with candidate count.
const TOKEN_ESTIMATE = '~90,000-115,000 Groq tokens'

/**
 * POSTs a JSON body to one of the shredder routes.
 *
 * Mirrors the AbortController + timeout pattern handleAnalyze uses in
 * pages/index.js, with the longer deadline the shredder needs.
 *
 * @param {string} url
 * @param {object} payload
 * @returns {Promise<{ok: boolean, status: number, data: object}>}
 */
async function postJson(url, payload) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    const data = await response.json().catch(() => ({}))

    return { ok: response.ok, status: response.status, data }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Renders a quota block from either route verbatim.
 *
 * Both routes return the same shape on a rate-limit stop. Passing the numbers
 * through unedited is the whole point — "it failed" hides that most of the
 * work may have landed and exactly how much is left.
 */
function QuotaDetail({ quota, unitLabel }) {
  if (!quota) return null

  return (
    <ul className="mb-0 mt-2 ps-3" style={{ fontSize: '0.85rem' }}>
      <li>
        Batches completed: <strong>{quota.batches_completed}</strong> of{' '}
        <strong>{quota.batches_planned}</strong>
      </li>
      <li>
        Batches not attempted: <strong>{quota.batches_not_attempted}</strong>
      </li>
      {typeof quota.candidates_not_attempted === 'number' && (
        <li>
          Candidates not attempted:{' '}
          <strong>{quota.candidates_not_attempted}</strong>
        </li>
      )}
      {typeof quota.sources_not_attempted === 'number' && (
        <li>
          {unitLabel} not attempted:{' '}
          <strong>{quota.sources_not_attempted}</strong>
        </li>
      )}
      {typeof quota.retry_after_seconds === 'number' && (
        <li>
          Retry after: <strong>{Math.ceil(quota.retry_after_seconds / 60)}</strong>{' '}
          minute(s)
        </li>
      )}
      {quota.message && (
        <li className="text-muted">Groq said: {quota.message}</li>
      )}
    </ul>
  )
}

export default function ShredRfpButton({ rfpId, onComplete }) {
  // idle -> confirming -> working -> (done | failed)
  const [phase, setPhase] = useState('idle')
  const [step, setStep] = useState('')
  const [result, setResult] = useState(null)
  const [failure, setFailure] = useState(null)

  if (!rfpId) {
    return null
  }

  async function handleRun() {
    setPhase('working')
    setFailure(null)
    setResult(null)

    try {
      // ---- §4.1-4.3: extract, classify, number, persist ----
      setStep('Extracting and classifying requirements… (this can take a few minutes)')

      const run = await postJson('/api/shredder/run', { rfp_id: rfpId })

      if (!run.ok) {
        setFailure({
          stage: 'Classification (/api/shredder/run)',
          status: run.status,
          message: run.data.error || 'The shredder run failed.',
          detail: run.data,
        })
        setPhase('failed')

        return
      }

      // A partial run means Groq hit a quota wall mid-way. Firing the link
      // pass into that same wall would fail identically and burn a request
      // for nothing, so it is skipped and the partial state reported instead.
      if (run.data.complete === false) {
        setFailure({
          stage: 'Classification stopped early (quota)',
          status: run.status,
          message:
            `${run.data.inserted} requirement(s) were classified and saved ` +
            'before Groq hit its quota. The linking pass was NOT started, ' +
            'because it would fail the same way. Re-run once the quota resets.',
          detail: run.data,
          partial: true,
        })
        setPhase('failed')
        onComplete?.()

        return
      }

      // ---- §4.4: linking pass ----
      setStep(
        `Classified ${run.data.inserted} requirements. Linking related requirements…`
      )

      const link = await postJson('/api/shredder/link', { rfp_id: rfpId })

      if (!link.ok) {
        setFailure({
          stage: 'Linking (/api/shredder/link)',
          status: link.status,
          message:
            (link.data.error || 'The linking pass failed.') +
            ` The ${run.data.inserted} classified requirements were saved and ` +
            'are safe — only the links are missing. Re-running the link route ' +
            'alone will complete them.',
          detail: link.data,
          partial: true,
        })
        setPhase('failed')
        onComplete?.()

        return
      }

      setResult({ run: run.data, link: link.data })
      setPhase('done')
      onComplete?.()
    } catch (err) {
      const aborted = err?.name === 'AbortError'

      setFailure({
        stage: 'Request',
        status: 0,
        message: aborted
          ? 'The request timed out after 5 minutes. The server may still be ' +
            'writing rows — reload before starting another run, so you do not ' +
            'create a duplicate set of REQ numbers.'
          : err?.message || 'Network error. Make sure the server is running.',
        detail: null,
      })
      setPhase('failed')
    } finally {
      setStep('')
    }
  }

  if (phase === 'working') {
    return (
      <div className="text-center py-4">
        <div className="spinner-border text-primary mb-3" role="status" />
        <p className="fw-semibold text-dark mb-1">Shredding this RFP…</p>
        <p className="text-muted small mb-0">{step}</p>
        <p className="text-muted mb-0 mt-2" style={{ fontSize: '0.78rem' }}>
          Leave this tab open. Closing it will not stop the server, but you will
          lose the progress report.
        </p>
      </div>
    )
  }

  if (phase === 'done' && result) {
    return (
      <div className="py-4 px-3">
        <div className="alert alert-success mb-0">
          <strong>✅ Shred complete.</strong>
          <ul className="mb-0 mt-2 ps-3" style={{ fontSize: '0.88rem' }}>
            <li>
              Candidates found: <strong>{result.run.candidates}</strong>
            </li>
            <li>
              Requirements classified and saved:{' '}
              <strong>{result.run.inserted}</strong> (
              {result.run.first_req_number} – {result.run.last_req_number})
            </li>
            <li>
              Flagged for review: <strong>{result.run.needs_review}</strong>
            </li>
            <li>
              Links written: <strong>{result.link.inserted}</strong>
            </li>
            <li className="text-muted">
              Text source: {result.run.text_source}
              {result.run.pages ? ` · ${result.run.pages} pages` : ''}
            </li>
          </ul>
        </div>
      </div>
    )
  }

  if (phase === 'failed' && failure) {
    return (
      <div className="py-4 px-3">
        <div
          className={`alert ${failure.partial ? 'alert-warning' : 'alert-danger'} mb-3`}
        >
          <strong>
            {failure.partial ? '⚠️ Partly completed' : '🚫 Failed'} —{' '}
            {failure.stage}
            {failure.status ? ` (HTTP ${failure.status})` : ''}
          </strong>
          <div className="mt-2" style={{ fontSize: '0.9rem' }}>
            {failure.message}
          </div>

          <QuotaDetail
            quota={failure.detail?.quota}
            unitLabel="Work requirements"
          />

          {typeof failure.detail?.retry_after_seconds === 'number' &&
            !failure.detail?.quota && (
              <div className="mt-2" style={{ fontSize: '0.85rem' }}>
                Retry after{' '}
                <strong>
                  {Math.ceil(failure.detail.retry_after_seconds / 60)}
                </strong>{' '}
                minute(s).
              </div>
            )}

          {typeof failure.detail?.candidates === 'number' && (
            <div className="mt-2" style={{ fontSize: '0.85rem' }}>
              Candidates found: <strong>{failure.detail.candidates}</strong> ·
              inserted: <strong>{failure.detail.inserted ?? 0}</strong>
            </div>
          )}
        </div>

        <div className="text-center">
          <button
            className="btn btn-outline-secondary btn-sm"
            onClick={() => {
              setPhase('idle')
              setFailure(null)
            }}
          >
            Back
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'confirming') {
    return (
      <div className="py-4 px-3">
        <div className="alert alert-warning">
          <strong>⚠️ This run costs real Groq quota.</strong>
          <p className="mb-2 mt-2" style={{ fontSize: '0.9rem' }}>
            Shredding this RFP will use approximately{' '}
            <strong>{TOKEN_ESTIMATE}</strong> — roughly a full day of the
            free-tier allowance. It runs two passes in sequence: classification
            (<code>/api/shredder/run</code>), then linking (
            <code>/api/shredder/link</code>).
          </p>
          <p className="mb-0" style={{ fontSize: '0.85rem' }}>
            It may take several minutes. If the quota runs out part-way, whatever
            was classified is still saved and you will see exactly how far it
            got.
          </p>
        </div>

        <div className="d-flex gap-2 justify-content-center">
          <button className="btn btn-primary fw-semibold" onClick={handleRun}>
            Yes, shred this RFP
          </button>
          <button
            className="btn btn-outline-secondary"
            onClick={() => setPhase('idle')}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="text-center py-5 text-muted">
      <span className="fs-3 d-block mb-2">🔗</span>
      <p className="mb-1 fw-semibold">No shredded requirements for this RFP yet.</p>
      <p className="mb-3 small">
        Extract every requirement, classify it by role and department, and link
        related requirements to each other.
      </p>
      <button
        className="btn btn-primary fw-semibold shadow-sm"
        onClick={() => setPhase('confirming')}
      >
        ⚙️ Shred this RFP
      </button>
      <p className="mb-0 mt-2" style={{ fontSize: '0.75rem' }}>
        Uses AI · {TOKEN_ESTIMATE}
      </p>
    </div>
  )
}
