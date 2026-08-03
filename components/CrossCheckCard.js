import { useState } from 'react'

// B2 — a second model's opinion on the FINANCIAL compliance decisions.
//
// Scope is not the whole checklist and the card must not imply it is. Of the
// 27 stored items, only the financial ones are decided from the document by
// analyze.js; the other 22 are fixed escalations no model produced, and
// Profitability Analysis is fixed the same way. The route therefore sends 4
// items, and every count rendered here is out of those 4 — never out of 27.
//
// COSTS TOKENS, and only on an explicit click. No auto-load, no follow-up
// call the user did not press — the same contract every other AI-calling
// card in this app keeps.
//
// Nothing is written back. The stored verdicts are untouched; this card only
// reports where a second reader would have decided differently, which is a
// prompt to go and read the clause, not a correction.

/**
 * ~11k chars of relevance-selected excerpts plus 4 financial verdicts back.
 * The route is bounded by an 8k tokens/minute ceiling on the cross-check
 * model, so a run cannot cost more than that however long the document is.
 */
const EST_TOKENS = 6000

const STATUS_STYLE = {
  GO: 'bg-success',
  ESCALATE: 'bg-warning text-dark',
  'NO-GO': 'bg-danger',
}

function StatusBadge({ value }) {
  if (!value) {
    return <span className="badge bg-light text-muted border">not reviewed</span>
  }

  return <span className={`badge ${STATUS_STYLE[value] || 'bg-secondary'}`}>{value}</span>
}

function DisagreementRow({ row }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="bg-light p-3 rounded mb-2 border border-warning border-opacity-50">
      <div className="d-flex gap-2 flex-wrap align-items-center mb-2">
        <span className="badge bg-light text-dark border text-uppercase" style={{ fontSize: '0.66rem' }}>
          {row.department}
        </span>
        <span className="fw-bold text-dark">{row.task}</span>
      </div>

      <div className="d-flex gap-3 flex-wrap align-items-center">
        <div>
          <div className="text-muted text-uppercase fw-bold" style={{ fontSize: '0.64rem' }}>
            Saved analysis
          </div>
          <StatusBadge value={row.primaryStatus} />
        </div>
        <div className="text-muted">vs</div>
        <div>
          <div className="text-muted text-uppercase fw-bold" style={{ fontSize: '0.64rem' }}>
            Second model
          </div>
          <StatusBadge value={row.secondStatus} />
        </div>
      </div>

      <button
        className="btn btn-sm btn-light border text-secondary fw-semibold mt-2"
        onClick={() => setOpen(!open)}
        style={{ fontSize: '0.75rem' }}
      >
        {open ? '▲ Hide both reasons' : '📄 Why they differ'}
      </button>

      {open && (
        <div className="mt-2 d-flex flex-column gap-2" style={{ fontSize: '0.82rem' }}>
          <div className="p-2 bg-white border rounded">
            <div className="text-muted fw-bold" style={{ fontSize: '0.7rem' }}>
              SAVED ANALYSIS
            </div>
            {row.primaryReason || '(no reason recorded)'}
          </div>
          <div className="p-2 bg-white border rounded">
            <div className="text-muted fw-bold" style={{ fontSize: '0.7rem' }}>
              SECOND MODEL
            </div>
            {row.secondReason || '(no reason given)'}
          </div>
        </div>
      )}
    </div>
  )
}

export default function CrossCheckCard({ rfpId }) {
  const [data, setData] = useState(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)

  async function run() {
    if (!rfpId || running) return

    setRunning(true)
    setError(null)

    try {
      const response = await fetch('/api/crosscheck/checklist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rfp_id: rfpId }),
      })

      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        setError(payload.error || 'The cross-check failed.')

        return
      }

      setData(payload)
    } catch (err) {
      setError(err?.message || 'Could not reach the cross-check.')
    } finally {
      setRunning(false)
    }
  }

  if (!rfpId) {
    return null
  }

  const counts = data?.counts
  const scope = data?.scope

  // The count every figure on this card is out of. scored_out_of is the
  // route's own name for the same number and is read as a fallback so a
  // response cached from before the rename cannot render "undefined".
  const scoredCount = counts?.items_in_scope ?? counts?.scored_out_of ?? 0

  const excludedUnjudged = scope?.excluded_unjudged || []
  const excludedOutOfScope = scope?.excluded_out_of_scope || 0
  const withoutEvidence = data?.text?.items_without_evidence || []

  return (
    <div className="card mb-4 shadow-sm border-0">
      <div className="card-header bg-transparent border-bottom d-flex justify-content-between align-items-center flex-wrap gap-2">
        <h5 className="mb-0 fw-bold text-secondary">
          🔍 Second-Model Cross-Check
          <span className="text-muted fw-normal ms-2" style={{ fontSize: '0.8rem' }}>
            financial items
          </span>
        </h5>
        <span className="badge bg-light text-dark border">~{Math.round(EST_TOKENS / 1000)}k tokens</span>
      </div>

      <div className="card-body">
        {!data && (
          <div className="alert alert-secondary py-2" style={{ fontSize: '0.85rem' }}>
            {/* Kept to the four things a reader needs before pressing:
                what is checked, what it costs, that it is opt-in, and that it
                writes nothing. Why the rest of the checklist is excluded used
                to be argued here; it is now explained in the "Not scored"
                block after a run, where it is actually relevant. */}
            A second model re-checks the{' '}
            <strong>financial items only</strong>, without seeing the saved
            verdicts. Anywhere the two disagree is worth reading yourself.
            Costs about{' '}
            <strong>~{Math.round(EST_TOKENS / 1000)}k tokens</strong>, runs only
            when you press the button, and{' '}
            <strong>changes nothing already saved</strong>.
          </div>
        )}

        {error && <div className="alert alert-warning py-2">{error}</div>}

        {counts && (
          <>
            <div className="d-flex flex-wrap gap-4 mb-3 p-3 bg-light rounded">
              <div>
                <div className="text-muted text-uppercase fw-bold" style={{ fontSize: '0.66rem' }}>
                  Agreement
                </div>
                <div className="fw-bold fs-4 text-dark">
                  {counts.agreement_rate === null ? '—' : `${counts.agreement_rate}%`}
                </div>
                {/* Denominator is items_in_scope, matching the rate the route
                    computes. Showing "of reviewed" here would contradict the
                    percentage above whenever the model skipped an item. */}
                <div className="text-muted" style={{ fontSize: '0.74rem' }}>
                  {counts.agreed} of {scoredCount} financial item
                  {scoredCount === 1 ? '' : 's'}
                </div>
              </div>
              <div>
                <div className="text-muted text-uppercase fw-bold" style={{ fontSize: '0.66rem' }}>
                  Disagreements
                </div>
                <div
                  className={`fw-bold fs-4 ${counts.disagreed > 0 ? 'text-warning' : 'text-success'}`}
                >
                  {counts.disagreed}
                </div>
                <div className="text-muted" style={{ fontSize: '0.74rem' }}>
                  of {scoredCount} scored
                </div>
              </div>
              {counts.not_reviewed > 0 && (
                <div>
                  <div className="text-muted text-uppercase fw-bold" style={{ fontSize: '0.66rem' }}>
                    Not reviewed
                  </div>
                  <div className="fw-bold fs-4 text-muted">{counts.not_reviewed}</div>
                  <div className="text-muted" style={{ fontSize: '0.74rem' }}>
                    counted as neither
                  </div>
                </div>
              )}
            </div>

            {/* What was NOT scored. Without this the card reads as a
                whole-checklist audit that happened to find 4 items, rather
                than a deliberately narrow one — and a reader would not know
                Profitability was never put to a model at all. */}
            {(excludedUnjudged.length > 0 || excludedOutOfScope > 0) && (
              <div
                className="text-muted mb-3 p-3 border rounded"
                style={{ fontSize: '0.78rem', lineHeight: '1.6' }}
              >
                <span className="fw-bold text-dark">Not scored.</span>{' '}
                {scope?.note ||
                  'Only the financial items decided from the document are cross-checked.'}
                {excludedUnjudged.length > 0 && (
                  <div className="mt-2 d-flex flex-wrap gap-1 align-items-center">
                    {excludedUnjudged.map((item) => (
                      <span
                        key={`${item.department}-${item.task}`}
                        className="badge bg-white text-dark border"
                        style={{ fontSize: '0.7rem' }}
                      >
                        {item.task} — policy-fixed {item.primaryStatus}, not
                        scored
                      </span>
                    ))}
                  </div>
                )}
                {excludedOutOfScope > 0 && (
                  <div className="mt-2">
                    {excludedOutOfScope} further checklist item
                    {excludedOutOfScope === 1 ? '' : 's'} outside the financial
                    section were not sent for the same reason.
                  </div>
                )}
              </div>
            )}

            {/* An item the excerpt search found nothing for was still judged,
                but on silence. Its verdict is much weaker than the others and
                the card should not present them as equivalent. */}
            {withoutEvidence.length > 0 && (
              <div className="alert alert-warning py-2 mb-3" style={{ fontSize: '0.82rem' }}>
                <strong>
                  No supporting text was found for{' '}
                  {withoutEvidence.join(', ')}.
                </strong>{' '}
                The second model judged{' '}
                {withoutEvidence.length === 1 ? 'that item' : 'those items'} on
                an absence of evidence, so treat{' '}
                {withoutEvidence.length === 1 ? 'its verdict' : 'their verdicts'}{' '}
                as weaker than the rest.
              </div>
            )}

            {data.disagreements.length === 0 ? (
              <div className="alert alert-success py-2 mb-0" style={{ fontSize: '0.88rem' }}>
                Both models reached the same verdict on every item reviewed.
                That is agreement, not proof — two readers can be wrong the same
                way.
              </div>
            ) : (
              <>
                <div className="alert alert-warning py-2" style={{ fontSize: '0.88rem' }}>
                  <strong>
                    {data.disagreements.length} item
                    {data.disagreements.length === 1 ? '' : 's'} where a second
                    reader decided differently.
                  </strong>{' '}
                  Harsher second opinions are listed first. Neither verdict is
                  automatically right — read the clause.
                </div>

                {data.disagreements.map((row) => (
                  <DisagreementRow key={row.index} row={row} />
                ))}
              </>
            )}
          </>
        )}

        <div className="d-flex gap-2 flex-wrap align-items-center mt-3">
          <button
            className="btn btn-outline-secondary fw-semibold"
            onClick={run}
            disabled={running}
          >
            {running ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" role="status" />
                Second model reading…
              </>
            ) : data ? (
              '↻ Re-run cross-check'
            ) : (
              '🔍 Cross-check with a second model'
            )}
          </button>
        </div>

        <div
          className="text-muted mt-3 pt-3 border-top"
          style={{ fontSize: '0.78rem', lineHeight: '1.6' }}
        >
          {data
            ? `Compared ${data.models.primary} against ${data.models.crosscheck} over the same ${scoredCount} financial item${scoredCount === 1 ? '' : 's'}, out of ${counts.items_in_checklist ?? '—'} in the full checklist. Nothing was written back — the saved analysis is unchanged.`
            : 'The second model is given the same financial items and passages of the same document, so a disagreement is about the decision, not about different questions being asked.'}
        </div>
      </div>
    </div>
  )
}
