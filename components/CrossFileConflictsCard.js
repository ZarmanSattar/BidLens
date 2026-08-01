import { useEffect, useState } from 'react'

// §7.2 — contradictions between the files of one RFP package.
//
// Loads on mount from /api/package/contradictions, which is pure pattern
// matching over stored text: zero tokens, same as /api/risk/scan and
// /api/fit/blockers. There is no AI trigger on this card at all.
//
// A single-file RFP renders the "nothing to compare" state rather than a
// reassuring green tick. Every RFP uploaded before §7.1 is single-file, and
// "no conflicts found" would be a claim this card is not entitled to make.

function ConflictRow({ conflict }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="bg-light p-3 rounded mb-2 border border-danger border-opacity-25">
      <div className="d-flex gap-2 flex-wrap align-items-center mb-2">
        <span className="badge bg-danger">Conflict</span>
        <span className="fw-bold text-dark">{conflict.title}</span>
      </div>

      <div className="row g-2">
        {conflict.values.map((entry, index) => (
          <div className="col-md-6" key={index}>
            <div className="p-2 bg-white border rounded h-100">
              <div
                className="text-muted text-uppercase fw-bold"
                style={{ fontSize: '0.66rem' }}
              >
                {entry.filename}
                {entry.page ? ` · p.${entry.page}` : ''}
              </div>
              <div className="fw-bold text-dark">{entry.display}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="text-muted mt-2" style={{ fontSize: '0.85rem' }}>
        {conflict.description}
      </div>

      <button
        className="btn btn-sm btn-light border text-secondary fw-semibold mt-2"
        onClick={() => setOpen(!open)}
        style={{ fontSize: '0.75rem' }}
      >
        {open ? '▲ Hide evidence' : `📄 View evidence (${conflict.values.length})`}
      </button>

      {open && (
        <div className="mt-2 d-flex flex-column gap-2">
          {conflict.values.map((entry, index) => (
            <div
              key={index}
              className="p-2 bg-white border rounded text-secondary"
              style={{ fontSize: '0.8rem', lineHeight: '1.5' }}
            >
              <div className="mb-1">
                <span className="badge bg-light text-dark border">
                  {entry.filename}
                </span>
              </div>
              {entry.snippet}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function CrossFileConflictsCard({
  rfpId,
  hideWhenNothingToCompare = false,
}) {
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
        const response = await fetch('/api/package/contradictions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rfp_id: rfpId }),
        })

        const payload = await response.json()

        if (cancelled) return

        if (!response.ok) {
          setError(payload.error || 'The cross-file check failed.')
        } else {
          setData(payload)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err?.message || 'Could not reach the cross-file check.')
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

  const conflicts = data?.conflicts || []

  // The results panel mounts this card for every analysis, and most uploads are
  // a single file. "Nothing to compare" is the honest answer on /amendments,
  // where the package is the subject; in a results panel it would be a
  // permanent empty card on the common path. `data` is null while loading and
  // after a failure, so this also keeps the spinner from flashing there.
  if (hideWhenNothingToCompare && !data?.stats?.comparable) {
    return null
  }

  return (
    <div className="card mb-4 shadow-sm border-0">
      <div className="card-header bg-transparent border-bottom d-flex justify-content-between align-items-center flex-wrap gap-2">
        <h5 className="mb-0 fw-bold text-warning">🗂️ Cross-File Consistency</h5>
        {data?.files?.length > 0 && (
          <span className="badge bg-light text-dark border">
            {data.files.length} file{data.files.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="card-body">
        {loading ? (
          <p className="text-muted mb-0 text-center py-3">
            <span className="spinner-border spinner-border-sm me-2" role="status" />
            Comparing the files in this package…
          </p>
        ) : error ? (
          <div className="alert alert-warning mb-0">{error}</div>
        ) : !data ? null : !data.stats?.comparable ? (
          <div className="py-2">
            <span className="text-muted fw-semibold">
              Nothing to compare.
            </span>
            <div className="text-muted mt-2" style={{ fontSize: '0.85rem' }}>
              {data.stats?.reason}{' '}
              This is not a clean bill of health — a single document cannot
              contradict another one.
            </div>
          </div>
        ) : conflicts.length === 0 ? (
          <div className="py-2">
            <span className="text-success fw-semibold">
              ✅ The {data.files.length} files agree on every value that could be
              compared.
            </span>
            <div className="text-muted mt-2" style={{ fontSize: '0.85rem' }}>
              Checked {data.stats.factsExtracted} stated value(s) across payment
              terms, insurance, bonding and submission dates. This is a pattern
              match over the text, not a legal review.
            </div>
          </div>
        ) : (
          <>
            <div className="alert alert-danger py-2" style={{ fontSize: '0.88rem' }}>
              <strong>
                {conflicts.length} contradiction{conflicts.length === 1 ? '' : 's'}{' '}
                between files in this package.
              </strong>{' '}
              Both values are in the solicitation, so pricing against one leaves
              the other unaddressed. Raise these as written questions.
            </div>

            {conflicts.map((conflict) => (
              <ConflictRow key={conflict.id} conflict={conflict} />
            ))}
          </>
        )}

        <div
          className="text-muted mt-3 pt-3 border-top"
          style={{ fontSize: '0.78rem', lineHeight: '1.6' }}
        >
          Detected by pattern matching across each file separately — no AI was
          used and no tokens were spent. Only values stated explicitly enough to
          compare are checked; silence in one file is never treated as
          disagreement. Page numbers count through the whole package rather than
          restarting at each file, so they match the ones the Contract Risk card
          cites.
        </div>
      </div>
    </div>
  )
}
