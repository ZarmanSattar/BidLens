import { useEffect, useState } from 'react'

// §5.4 — the Contract Risk section.
//
// Deliberately styled to match RiskFlagSummary: same card shell, same
// .risk-item / .risk-dept-badge rows, same severity colour language
// (danger / warning / secondary). The two sections answer different questions
// — RiskFlagSummary reports the AI compliance verdict, this one reports what
// plain pattern-matching found in the contract terms — so reading as one
// family matters.
//
// Every description rendered here is STATIC text from lib/risk. No AI call is
// made and no explanation is generated; §5.3 is out of scope for this pass.

const SEVERITY_STYLE = {
  high: {
    badge: 'bg-danger',
    border: 'border-danger',
    heading: 'text-danger',
    icon: '🚩',
    label: 'High',
  },
  medium: {
    badge: 'bg-warning text-dark',
    border: 'border-warning',
    heading: 'text-warning',
    icon: '⚠️',
    label: 'Medium',
  },
  low: {
    badge: 'bg-secondary',
    border: 'border-secondary',
    heading: 'text-secondary',
    icon: 'ℹ️',
    label: 'Low',
  },
}

const SEVERITY_ORDER = ['high', 'medium', 'low']

function EvidenceToggle({ matches }) {
  const [open, setOpen] = useState(false)

  if (!matches || matches.length === 0) {
    return null
  }

  return (
    <div className="mt-2">
      <button
        className="btn btn-sm btn-light border text-secondary fw-semibold"
        onClick={() => setOpen(!open)}
        style={{ fontSize: '0.75rem' }}
      >
        {open
          ? '▲ Hide evidence'
          : `📄 View evidence (${matches.length})`}
      </button>

      {open && (
        <div className="mt-2 d-flex flex-column gap-2">
          {matches.map((match, index) => (
            <div
              key={index}
              className="p-2 bg-white border rounded text-secondary"
              style={{ fontSize: '0.8rem', lineHeight: '1.5' }}
            >
              <div className="d-flex gap-2 mb-1 flex-wrap">
                {match.page && (
                  <span className="badge bg-light text-dark border">
                    p.{match.page}
                  </span>
                )}
                <span className="badge bg-light text-dark border font-monospace">
                  {match.raw}
                </span>
                {match.detail && (
                  <span className="badge bg-warning text-dark">
                    {match.detail}
                  </span>
                )}
              </div>
              {match.snippet}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function FindingRow({ finding }) {
  const style = SEVERITY_STYLE[finding.severity] || SEVERITY_STYLE.low

  return (
    <div
      className={`risk-item bg-light p-3 rounded mb-2 border ${style.border} border-opacity-25`}
    >
      <span className={`risk-dept-badge ${style.badge}`}>{finding.label}</span>
      <div className="flex-grow-1">
        <span className="fw-bold text-dark">{finding.title}</span>
        {finding.occurrences > 1 && (
          <span className="text-muted ms-2" style={{ fontSize: '0.78rem' }}>
            {finding.occurrences} mentions
          </span>
        )}
        <div className="mt-1">
          <span className="text-muted">{finding.description}</span>
        </div>
        {Array.isArray(finding.clauses) && finding.clauses.length > 0 && (
          <div className="mt-2 d-flex flex-wrap gap-1">
            {finding.clauses.map((clause) => (
              <span
                key={clause}
                className="badge bg-white text-dark border font-monospace"
                style={{ fontSize: '0.72rem' }}
              >
                {clause}
              </span>
            ))}
          </div>
        )}
        <EvidenceToggle matches={finding.matches} />
      </div>
    </div>
  )
}

export default function ContractRiskCard({ rfpId }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!rfpId) {
      return
    }

    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)

      try {
        const response = await fetch('/api/risk/scan', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rfp_id: rfpId }),
        })

        const payload = await response.json()

        if (cancelled) return

        if (!response.ok) {
          setError(payload.error || 'The contract risk scan failed.')
        } else {
          setData(payload)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err?.message || 'Could not reach the contract risk scan.')
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

  const findings = data?.findings || []
  const summary = data?.summary

  return (
    <div className="card mb-4 shadow-sm border-0">
      <div className="card-header bg-transparent border-bottom d-flex justify-content-between align-items-center flex-wrap gap-2">
        <h5 className="mb-0 fw-bold text-danger">📜 Contract Risk</h5>
        {summary && (
          <div className="d-flex gap-2 flex-wrap">
            {SEVERITY_ORDER.map((severity) => {
              const count = summary.bySeverity?.[severity] || 0

              if (count === 0) return null

              const style = SEVERITY_STYLE[severity]

              return (
                <span
                  key={severity}
                  className={`badge ${style.badge} px-2 py-2`}
                >
                  {style.icon} {style.label}: {count}
                </span>
              )
            })}
          </div>
        )}
      </div>

      <div className="card-body">
        {!rfpId ? (
          <p className="text-muted mb-0 text-center py-3">
            This analysis has not been saved to an RFP record yet, so the
            contract terms cannot be scanned.
          </p>
        ) : loading ? (
          <p className="text-muted mb-0 text-center py-3">
            <span className="spinner-border spinner-border-sm me-2" role="status" />
            Scanning contract terms…
          </p>
        ) : error ? (
          <div className="alert alert-warning mb-0">{error}</div>
        ) : findings.length === 0 ? (
          <div className="py-2">
            <span className="text-success fw-semibold">
              ✅ No risky clauses or wording matched the built-in patterns.
            </span>
            <div className="text-muted mt-2" style={{ fontSize: '0.85rem' }}>
              This is a pattern match over the document text, not a legal
              review. The clause library is a small starter set — absence of a
              finding is not assurance.
            </div>
          </div>
        ) : (
          <>
            {findings.map((finding) => (
              <FindingRow key={finding.id} finding={finding} />
            ))}

            <div
              className="text-muted mt-3 pt-3 border-top"
              style={{ fontSize: '0.78rem', lineHeight: '1.6' }}
            >
              Detected by pattern matching over the document text — no AI was
              used, and every description above is fixed reference text.
              Findings mean &ldquo;a human should read this&rdquo;, not
              &ldquo;this contract is bad&rdquo;. The clause library covers{' '}
              {data?.stats?.clause?.librarySize ?? 0} common FAR/DFARS clauses
              and is a starting set, not an exhaustive one.
              {data?.stats?.wording?.thresholds?.source ===
                'hardcoded-placeholder' && (
                <>
                  {' '}
                  Payment, warranty, and insurance thresholds are placeholders
                  until the company profile lands in Phase 3.
                </>
              )}
              {data?.text_source === 'raw_text_flat' && (
                <>
                  {' '}
                  This RFP has no per-page text stored, so page numbers are
                  unavailable.
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
