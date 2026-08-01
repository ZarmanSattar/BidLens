import Link from 'next/link'
import { useEffect, useState } from 'react'
import CrossFileConflictsCard from '../components/CrossFileConflictsCard'
import { formatDate } from '../utils/formatDate'

// §7.3/§7.4 — the amendment comparison view.
//
// Usage: /amendments?rfp_id=<either side of the link>
//
// Everything on this page is zero-token. The diff is plain string matching
// (measured at 99%+ against the real dataset), the fit scores are read from
// already-persisted judgments, and the cross-file check is pattern matching.
// The only thing here that costs anything is the shredder, which this page
// links to rather than triggers.

export async function getServerSideProps({ query }) {
  const rfpId = typeof query.rfp_id === 'string' ? query.rfp_id.trim() : ''

  // Required lazily so a missing service-role key surfaces as a page message
  // rather than a build-time crash — same reason traceability.js does it.
  const { supabaseAdmin } = require('../lib/supabase/admin')

  const { data: rfps, error } = await supabaseAdmin
    .from('rfps')
    .select('id, title, created_at')
    .order('created_at', { ascending: false })

  return {
    props: {
      rfpId,
      rfps: error ? [] : rfps || [],
      loadError: error ? error.message : null,
    },
  }
}

const CHANGE_STYLE = {
  removed: { badge: 'bg-danger', label: 'Removed', border: 'border-danger' },
  changed: { badge: 'bg-warning text-dark', label: 'Changed', border: 'border-warning' },
  added: { badge: 'bg-success', label: 'Added', border: 'border-success' },
}

function CountTile({ label, value, tone }) {
  return (
    <div className="col">
      <div className={`p-3 rounded border border-${tone} border-opacity-25 bg-light h-100`}>
        <div className={`fs-3 fw-bold text-${tone} lh-1`}>{value}</div>
        <div className="text-muted small">{label}</div>
      </div>
    </div>
  )
}

function ChangeRow({ change }) {
  const style = CHANGE_STYLE[change.changeType] || CHANGE_STYLE.changed
  const source = change.original || change.amended

  return (
    <div className={`bg-light p-3 rounded mb-2 border ${style.border} border-opacity-25`}>
      <div className="d-flex gap-2 flex-wrap align-items-center mb-2">
        <span className={`badge ${style.badge}`}>{style.label}</span>
        {change.original && (
          <span className="badge bg-white text-dark border font-monospace">
            was {change.original.reqNumber}
          </span>
        )}
        {change.amended && (
          <span className="badge bg-white text-dark border font-monospace">
            now {change.amended.reqNumber}
          </span>
        )}
        {source?.department && (
          <span className="badge bg-light text-dark border">{source.department}</span>
        )}
        {typeof change.similarity === 'number' && (
          <span className="text-muted" style={{ fontSize: '0.75rem' }}>
            {Math.round(change.similarity * 100)}% similar
          </span>
        )}
      </div>

      {change.changeType === 'changed' ? (
        <div className="row g-2">
          <div className="col-md-6">
            <div className="p-2 bg-white border rounded h-100">
              <div className="text-muted text-uppercase fw-bold" style={{ fontSize: '0.66rem' }}>
                Original
              </div>
              <div className="text-dark" style={{ fontSize: '0.83rem' }}>
                {change.original?.text}
              </div>
            </div>
          </div>
          <div className="col-md-6">
            <div className="p-2 bg-white border rounded h-100">
              <div className="text-muted text-uppercase fw-bold" style={{ fontSize: '0.66rem' }}>
                Amended
              </div>
              <div className="text-dark" style={{ fontSize: '0.83rem' }}>
                {change.amended?.text}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-2 bg-white border rounded">
          <div className="text-dark" style={{ fontSize: '0.83rem' }}>
            {source?.text}
          </div>
        </div>
      )}
    </div>
  )
}

export default function AmendmentsPage({ rfpId, rfps, loadError }) {
  const [comparison, setComparison] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [originalChoice, setOriginalChoice] = useState('')
  const [linking, setLinking] = useState(false)

  useEffect(() => {
    if (!rfpId) return

    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)

      try {
        const response = await fetch('/api/amendments/compare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rfp_id: rfpId }),
        })

        const payload = await response.json()

        if (cancelled) return

        if (!response.ok) setError(payload.error || 'The comparison failed.')
        else setComparison(payload)
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Could not reach the comparison.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [rfpId])

  // §7.3 — link this RFP as an amendment of another and run the diff. Zero
  // tokens: it compares requirements that are already shredded.
  async function handleLink() {
    if (!originalChoice) return

    setLinking(true)
    setNotice(null)

    try {
      const response = await fetch('/api/amendments/diff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          original_rfp_id: originalChoice,
          amended_rfp_id: rfpId,
        }),
      })

      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        setNotice({ tone: 'warning', text: payload.error || 'The diff failed.' })

        return
      }

      setNotice({
        tone: 'success',
        text:
          `Diff complete — ${payload.stats.byType.added} added, ` +
          `${payload.stats.byType.changed} changed, ` +
          `${payload.stats.byType.removed} removed, ` +
          `${payload.stats.byType.unchanged} unchanged. ` +
          `${payload.carry_forward.carried} fit judgment(s) carried forward.` +
          (payload.message ? ' ' + payload.message : ''),
      })

      const refreshed = await fetch('/api/amendments/compare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rfp_id: rfpId }),
      })

      setComparison(await refreshed.json())
    } catch (err) {
      setNotice({ tone: 'warning', text: err?.message || 'Could not reach the diff.' })
    } finally {
      setLinking(false)
    }
  }

  const counts = comparison?.counts
  const recommendation = comparison?.recommendation
  const stale = comparison?.stale_judgments || []

  // The RFP in the URL is always the AMENDED side of the pair. Naming it back
  // to the user is what stops the two sides being chosen the wrong way round.
  const currentTitle =
    rfps.find((rfp) => rfp.id === rfpId)?.title || 'the RFP you started from'

  return (
    <>
      <nav className="navbar navbar-dark bg-dark px-4">
        <span className="navbar-brand fw-bold fs-4">
          Bid<span>Lens</span>
        </span>
        <div className="d-flex align-items-center gap-3">
          <Link href="/dashboard" className="btn btn-outline-light btn-sm">
            📊 Dashboard
          </Link>
        </div>
      </nav>

      <div className="container-fluid py-4 px-4" style={{ maxWidth: 1200 }}>
        <div className="mb-4">
          <h1 className="fw-bold h3 mb-1">📑 Amendment Tracking</h1>
          <p className="text-muted mb-0">
            What an amended solicitation changed, and whether those changes move
            the bid decision.
          </p>
        </div>

        {loadError && <div className="alert alert-danger">{loadError}</div>}

        {!rfpId ? (
          <div className="alert alert-info">
            <strong>Start from the AMENDMENT — the newer, revised RFP.</strong>
            <div className="mt-2 small">
              Pick the revised solicitation below. On the next step you will
              choose which earlier version it replaces. Starting from the
              earlier version instead records the pair backwards.
            </div>
            {rfps.length > 0 && (
              <>
                <div className="mt-3 mb-1 small fw-semibold text-uppercase text-muted">
                  Choose the amendment (newest first)
                </div>
                <ul className="mb-0 ps-3">
                  {rfps.map((rfp) => (
                    <li key={rfp.id}>
                      <Link href={`/amendments?rfp_id=${rfp.id}`}>{rfp.title}</Link>{' '}
                      <span className="text-muted small">
                        · uploaded {formatDate(rfp.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : loading ? (
          <p className="text-muted py-4">
            <span className="spinner-border spinner-border-sm me-2" role="status" />
            Loading comparison…
          </p>
        ) : error ? (
          <div className="alert alert-warning">{error}</div>
        ) : (
          <>
            {notice && (
              <div className={`alert alert-${notice.tone}`}>{notice.text}</div>
            )}

            {/* Not yet linked — offer to link it to an original. */}
            {comparison && !comparison.linked && (
              <div className="card shadow-sm border-0 mb-4">
                <div className="card-header bg-transparent border-bottom">
                  <h5 className="mb-0 fw-bold text-primary">
                    Which earlier RFP does this replace?
                  </h5>
                </div>
                <div className="card-body">
                  <div className="alert alert-light border py-2 small mb-3">
                    Recording <strong>{currentTitle}</strong> as the{' '}
                    <strong>AMENDMENT</strong> — the revised version. Choose the{' '}
                    <strong>ORIGINAL</strong> it replaces below. If{' '}
                    {currentTitle} is actually the earlier version, go back and
                    start from the newer one instead.
                  </div>
                  <p className="text-muted small">
                    BidLens will diff the two requirement sets. Both must
                    already be shredded. This costs nothing — the comparison is
                    plain text matching, no AI.
                  </p>
                  <div className="d-flex gap-2 flex-wrap align-items-center">
                    <select
                      className="form-select"
                      style={{ maxWidth: 460 }}
                      value={originalChoice}
                      onChange={(e) => setOriginalChoice(e.target.value)}
                    >
                      <option value="">
                        Select the ORIGINAL / base version…
                      </option>
                      {rfps
                        .filter((rfp) => rfp.id !== rfpId)
                        .map((rfp) => (
                          <option key={rfp.id} value={rfp.id}>
                            {rfp.title}
                          </option>
                        ))}
                    </select>
                    <button
                      className="btn btn-primary fw-semibold"
                      onClick={handleLink}
                      disabled={!originalChoice || linking}
                    >
                      {linking ? 'Diffing…' : 'Link and diff'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {comparison?.linked && (
              <>
                <div className="card shadow-sm border-0 mb-4">
                  <div className="card-body bg-light d-flex flex-wrap gap-4">
                    <div>
                      <div className="text-muted small text-uppercase fw-bold">
                        Original
                      </div>
                      <div className="fw-semibold text-dark">
                        {comparison.original.title}
                      </div>
                      <div className="text-muted" style={{ fontSize: '0.78rem' }}>
                        the earlier version
                      </div>
                    </div>
                    <div className="fs-4 text-muted">→</div>
                    <div>
                      <div className="text-muted small text-uppercase fw-bold">
                        Amended
                      </div>
                      <div className="fw-semibold text-dark">
                        {comparison.amended.title}
                      </div>
                      <div className="text-muted" style={{ fontSize: '0.78rem' }}>
                        the revised version you started from
                      </div>
                    </div>
                  </div>
                </div>

                {/* §7.4 — does the decision itself move? */}
                <div
                  className={`alert ${
                    recommendation?.changed ? 'alert-danger' : 'alert-secondary'
                  }`}
                >
                  <strong>
                    {recommendation?.changed
                      ? '⚠️ The bid recommendation changes'
                      : 'Bid recommendation'}
                  </strong>
                  <div className="mt-2" style={{ fontSize: '0.9rem' }}>
                    {recommendation?.note}
                  </div>
                  {recommendation?.from && recommendation?.to && (
                    <div className="mt-2 d-flex gap-2 align-items-center flex-wrap">
                      <span className={`badge bg-${recommendation.from.tone}`}>
                        {recommendation.from.label}
                      </span>
                      <span>→</span>
                      <span className={`badge bg-${recommendation.to.tone}`}>
                        {recommendation.to.label}
                      </span>
                      {typeof recommendation.scoreDelta === 'number' && (
                        <span className="text-muted small">
                          score {recommendation.scoreDelta >= 0 ? '+' : ''}
                          {recommendation.scoreDelta}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="row row-cols-2 row-cols-md-4 g-3 mb-4">
                  <CountTile label="Added" value={counts?.added ?? 0} tone="success" />
                  <CountTile label="Changed" value={counts?.changed ?? 0} tone="warning" />
                  <CountTile label="Removed" value={counts?.removed ?? 0} tone="danger" />
                  <CountTile label="Unchanged" value={counts?.unchanged ?? 0} tone="secondary" />
                </div>

                {/* §7.4 — judgments this amendment invalidated. */}
                {stale.length > 0 && (
                  <div className="card shadow-sm border-0 mb-4">
                    <div className="card-header bg-transparent border-bottom">
                      <h5 className="mb-0 fw-bold text-warning">
                        ♻️ Stale fit judgments{' '}
                        <span className="badge bg-light text-dark border">
                          {stale.length}
                        </span>
                      </h5>
                    </div>
                    <div className="card-body">
                      <p className="text-muted small">
                        These requirements were judged against the original
                        wording. The amendment changed or removed them, so the
                        verdicts below no longer describe what is being asked.
                      </p>
                      {stale.map((entry) => (
                        <div
                          key={entry.requirementId}
                          className="bg-light p-3 rounded mb-2 border border-warning border-opacity-25"
                        >
                          <div className="d-flex gap-2 flex-wrap align-items-center mb-1">
                            <span className="badge bg-warning text-dark">
                              {entry.reason === 'removed' ? 'Removed' : 'Reworded'}
                            </span>
                            <span className="badge bg-white text-dark border font-monospace">
                              {entry.reqNumber}
                            </span>
                            <span className="badge bg-light text-dark border">
                              was: {entry.verdict}
                            </span>
                          </div>
                          <div className="text-muted" style={{ fontSize: '0.85rem' }}>
                            {entry.note}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="card shadow-sm border-0 mb-4">
                  <div className="card-header bg-transparent border-bottom">
                    <h5 className="mb-0 fw-bold text-dark">
                      What changed{' '}
                      <span className="badge bg-light text-dark border">
                        {comparison.changes.length}
                      </span>
                    </h5>
                  </div>
                  <div className="card-body">
                    {comparison.changes.length === 0 ? (
                      <span className="text-success fw-semibold">
                        ✅ No material differences — every requirement matched
                        unchanged.
                      </span>
                    ) : (
                      comparison.changes.map((change) => (
                        <ChangeRow key={change.id} change={change} />
                      ))
                    )}
                  </div>
                </div>
              </>
            )}

            <CrossFileConflictsCard rfpId={rfpId} />
          </>
        )}
      </div>
    </>
  )
}
