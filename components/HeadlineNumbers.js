import { useEffect, useState } from 'react'
import { describeDeadline } from '../utils/deadline'

// A2 — the four numbers a bid/no-bid conversation actually opens with.
//
// PURE DISPLAY. No writes, no AI, and nothing computed here that is not
// already computed somewhere else:
//
//   Requirements — complianceChecklist, already in the analysis object.
//   Risks        — collectRiskFlags(), already run by the Risk Flag Summary,
//                  passed down rather than recounted.
//   Fit score    — /api/fit/blockers, the same zero-token route the Company
//                  Fit card loads from. One extra read, no extra tokens.
//   Deadline     — summary.submissionDeadline, the same string the dashboard
//                  countdown reads, through the same shared parser.
//
// The fit score is fetched rather than passed because ResultsPanel does not
// hold it — the Company Fit card owns that state internally. Lifting it would
// mean rewriting that card, which is a bigger change than this feature earns.

const TONE_CLASS = {
  unknown: 'text-muted',
  passed: 'text-danger',
  urgent: 'text-danger',
  soon: 'text-warning',
  ok: 'text-success',
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className="px-3 py-2 flex-grow-1" style={{ minWidth: 150 }}>
      <div
        className="text-muted text-uppercase fw-bold"
        style={{ fontSize: '0.68rem', letterSpacing: '0.03em' }}
      >
        {label}
      </div>
      <div className={`fw-bold ${tone || 'text-dark'}`} style={{ fontSize: '1.5rem', lineHeight: 1.2 }}>
        {value}
      </div>
      {sub && (
        <div className="text-muted" style={{ fontSize: '0.74rem' }}>
          {sub}
        </div>
      )}
    </div>
  )
}

export default function HeadlineNumbers({
  rfpId,
  requirementCount,
  riskCount,
  deadlineText,
}) {
  const [fit, setFit] = useState(null)
  const [fitLoading, setFitLoading] = useState(false)

  useEffect(() => {
    if (!rfpId) return

    let cancelled = false

    async function load() {
      setFitLoading(true)

      try {
        const response = await fetch('/api/fit/blockers', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rfp_id: rfpId }),
        })

        const payload = await response.json()

        if (!cancelled && response.ok) {
          setFit({ ...payload.fit, hasProfile: payload.has_profile })
        }
      } catch {
        // A strip is a summary, not a source of truth. If the fit read fails
        // the other three numbers are still worth showing, so this stays quiet
        // and the tile reads "—". The Company Fit card below reports the error
        // properly.
      } finally {
        if (!cancelled) setFitLoading(false)
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [rfpId])

  const deadline = describeDeadline(deadlineText)

  const fitValue = fitLoading
    ? '…'
    : typeof fit?.score === 'number'
      ? fit.score
      : '—'

  const fitSub = !rfpId
    ? 'Save the analysis first'
    : fitLoading
      ? 'Checking…'
      : fit?.hasProfile === false
        ? 'No company profile yet'
        : fit?.provisional
          ? 'Provisional — not all judged'
          : fit?.verdict?.label || 'Not assessed'

  return (
    <div className="card mb-4 shadow-sm border-0">
      <div className="card-body p-0">
        <div className="d-flex flex-wrap divide-x bg-light rounded">
          <Stat
            label="Requirements"
            value={requirementCount ?? '—'}
            sub="in the compliance checklist"
          />
          <Stat
            label="Risks flagged"
            value={riskCount ?? '—'}
            sub={riskCount === 0 ? 'nothing critical found' : 'no-go or escalation'}
            tone={riskCount > 0 ? 'text-danger' : 'text-success'}
          />
          <Stat label="Fit score" value={fitValue} sub={fitSub} />
          <Stat
            label="Submission deadline"
            value={deadlineText ? deadline.label : 'Not stated'}
            sub={deadlineText || 'no date found in the document'}
            tone={TONE_CLASS[deadline.tone]}
          />
        </div>
      </div>
    </div>
  )
}
