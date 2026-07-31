import { useEffect, useState } from 'react'
import Link from 'next/link'

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
    }
  }, [rfpId])

  const missing = data?.missingItems || []
  const visible = showAll ? missing : missing.slice(0, 12)

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

            {!data.generation_available && (
              <div className="alert alert-secondary mt-3 py-2" style={{ fontSize: '0.85rem' }}>
                {data.note}
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
