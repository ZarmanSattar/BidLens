import { useState, useEffect } from 'react'
import Link from 'next/link'

function getDecision(complianceChecklist) {
  const allItems = [
    ...(complianceChecklist?.financial || []),
    ...(complianceChecklist?.legal || []),
    ...(complianceChecklist?.operations || []),
    ...(complianceChecklist?.technical || []),
  ]
  const hasNoGo = allItems.some(item => item.status === 'NO-GO')
  const hasReview = allItems.some(item => item.status === 'REVIEW')
  if (hasNoGo) return { label: 'REJECT', color: 'danger' }
  if (hasReview) return { label: 'ESCALATE', color: 'warning' }
  return { label: 'PROCEED', color: 'success' }
}

function getCounts(complianceChecklist) {
  const allItems = [
    ...(complianceChecklist?.financial || []),
    ...(complianceChecklist?.legal || []),
    ...(complianceChecklist?.operations || []),
    ...(complianceChecklist?.technical || []),
  ]
  return {
    go: allItems.filter(i => i.status === 'GO').length,
    noGo: allItems.filter(i => i.status === 'NO-GO').length,
    review: allItems.filter(i => i.status === 'REVIEW').length,
    total: allItems.length,
  }
}

function getBidScore(complianceChecklist) {
  const allItems = [
    ...(complianceChecklist?.financial || []),
    ...(complianceChecklist?.legal || []),
    ...(complianceChecklist?.operations || []),
    ...(complianceChecklist?.technical || []),
  ]
  if (allItems.length === 0) return 0
  const maxPoints = allItems.length * 2
  const earned = allItems.reduce((sum, item) => {
    if (item.status === 'GO') return sum + 2
    if (item.status === 'REVIEW') return sum + 1
    return sum
  }, 0)
  return Math.round((earned / maxPoints) * 100)
}

function getScoreLabel(score) {
  if (score >= 80) return { label: 'Strong Bid', color: '#198754' }
  if (score >= 60) return { label: 'Bid with Caution', color: '#856404' }
  return { label: 'Do Not Bid', color: '#dc3545' }
}

function getFinancialHighlights(complianceChecklist) {
  const items = complianceChecklist?.financial || []
  const payment = items.find(i => i.task.toLowerCase().includes('payment'))
  const insurance = items.find(i => i.task.toLowerCase().includes('insurance'))
  const bond = items.find(i => i.task.toLowerCase().includes('bond'))
  return { payment, insurance, bond }
}

function getBestIndex(entries, getValue, higherIsBetter = true) {
  if (entries.length === 0) return -1
  let bestIdx = 0
  let bestVal = getValue(entries[0])
  for (let i = 1; i < entries.length; i++) {
    const val = getValue(entries[i])
    if (higherIsBetter ? val > bestVal : val < bestVal) {
      bestIdx = i
      bestVal = val
    }
  }
  return bestIdx
}

export default function Compare() {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const params = new URLSearchParams(window.location.search)
    const idsParam = params.get('ids')

    if (!idsParam) {
      setError('No RFPs selected for comparison.')
      setLoading(false)
      return
    }

    const ids = idsParam.split(',').map(id => parseInt(id))

    if (ids.length < 2) {
      setError('Please select at least 2 RFPs to compare.')
      setLoading(false)
      return
    }

    const stored = localStorage.getItem('bidlens_history')
    if (!stored) {
      setError('No history found. Please analyze some RFPs first.')
      setLoading(false)
      return
    }

    const history = JSON.parse(stored)
    const selected = ids
      .map(id => history.find(e => e.id === id))
      .filter(Boolean)

    if (selected.length < 2) {
      setError('Could not find the selected RFPs in history.')
      setLoading(false)
      return
    }

    setEntries(selected)
    setLoading(false)
  }, [])

  if (loading) {
    return (
      <>
        <nav className="navbar navbar-dark bg-dark px-4">
          <span className="navbar-brand fw-bold fs-4">
            Bid<span style={{ color: '#0d6efd' }}>Lens</span>
          </span>
        </nav>
        <div className="container py-5 text-center">
          <div className="spinner-border text-primary" role="status" />
          <p className="mt-3 text-muted">Loading comparison...</p>
        </div>
      </>
    )
  }

  if (error) {
    return (
      <>
        <nav className="navbar navbar-dark bg-dark px-4">
          <span className="navbar-brand fw-bold fs-4">
            Bid<span style={{ color: '#0d6efd' }}>Lens</span>
          </span>
        </nav>
        <div className="container py-5 text-center">
          <div style={{ fontSize: '3rem' }}>⚠️</div>
          <h5 className="mt-3">{error}</h5>
          <Link href="/dashboard" className="btn btn-primary mt-3">
            ← Back to Dashboard
          </Link>
        </div>
      </>
    )
  }

  const scores = entries.map(e => getBidScore(e.complianceChecklist))
  const counts = entries.map(e => getCounts(e.complianceChecklist))
  const decisions = entries.map(e => getDecision(e.complianceChecklist))
  const financials = entries.map(e => getFinancialHighlights(e.complianceChecklist))

  const bestScoreIdx = getBestIndex(entries, (_, i) => scores[i !== undefined ? i : 0], true)
  const bestGoIdx = getBestIndex(entries.map((_, i) => i), i => counts[i].go, true)
  const leastNoGoIdx = getBestIndex(entries.map((_, i) => i), i => counts[i].noGo, false)

  const recommendedIdx = scores.indexOf(Math.max(...scores))

  return (
    <>
      <nav className="navbar navbar-dark bg-dark px-4">
        <span className="navbar-brand fw-bold fs-4">
          Bid<span style={{ color: '#0d6efd' }}>Lens</span>
        </span>
        <div className="d-flex align-items-center gap-3">
          <span className="text-secondary small">RFP Comparison</span>
          <Link href="/dashboard" className="btn btn-outline-light btn-sm">
            ← Dashboard
          </Link>
        </div>
      </nav>

      <div className="container py-5" style={{ maxWidth: '1100px' }}>

        <h2 className="fw-bold mb-1">RFP Comparison</h2>
        <p className="text-muted mb-4">
          Comparing {entries.length} RFPs side by side. Green highlights indicate the better value.
        </p>

        {/* Recommendation Banner */}
        <div className="alert alert-success mb-4 d-flex align-items-center gap-3">
          <span style={{ fontSize: '1.8rem' }}>🏆</span>
          <div>
            <div className="fw-bold fs-5">
              Recommended Bid: {entries[recommendedIdx]?.summary?.projectTitle || entries[recommendedIdx]?.fileName}
            </div>
            <div className="text-muted small">
              Highest bid score of {scores[recommendedIdx]} — {getScoreLabel(scores[recommendedIdx]).label}
            </div>
          </div>
        </div>

        {/* Main Comparison Table */}
        <div className="card shadow-sm mb-4">
          <div className="card-header bg-dark text-white">
            <h5 className="mb-0">📊 Side-by-Side Comparison</h5>
          </div>
          <div className="card-body p-0">
            <div className="table-responsive">
              <table className="table table-bordered mb-0">
                <thead>
                  <tr>
                    <th className="compare-label-cell" style={{ minWidth: '160px' }}>Field</th>
                    {entries.map((entry, i) => (
                      <th key={i} className="compare-header-cell" style={{ minWidth: '220px' }}>
                        <div className="fw-bold">{entry.summary?.projectTitle || entry.fileName}</div>
                        <div style={{ fontSize: '0.75rem', opacity: 0.8, marginTop: '4px' }}>
                          {entry.summary?.issuingAgency || '—'}
                        </div>
                        {i === recommendedIdx && (
                          <span className="badge bg-success mt-1">🏆 Recommended</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>

                  {/* Bid Score */}
                  <tr>
                    <td className="compare-label-cell">🎯 Bid Score</td>
                    {entries.map((entry, i) => {
                      const score = scores[i]
                      const { color } = getScoreLabel(score)
                      const isBest = score === Math.max(...scores)
                      return (
                        <td key={i} className={`compare-value-cell ${isBest ? 'compare-best' : ''}`}>
                          <span className="fw-bold fs-5" style={{ color }}>
                            {score}
                          </span>
                          <span className="text-muted"> / 100</span>
                          <div style={{ fontSize: '0.78rem', color }}>
                            {getScoreLabel(score).label}
                          </div>
                        </td>
                      )
                    })}
                  </tr>

                  {/* Decision */}
                  <tr>
                    <td className="compare-label-cell">📋 Decision</td>
                    {entries.map((entry, i) => {
                      const dec = decisions[i]
                      return (
                        <td key={i} className="compare-value-cell">
                          <span className={`badge bg-${dec.color}`}>{dec.label}</span>
                        </td>
                      )
                    })}
                  </tr>

                  {/* GO Count */}
                  <tr>
                    <td className="compare-label-cell">✅ GO Items</td>
                    {entries.map((entry, i) => {
                      const isBest = counts[i].go === Math.max(...counts.map(c => c.go))
                      return (
                        <td key={i} className={`compare-value-cell ${isBest ? 'compare-best' : ''}`}>
                          <span className="text-success fw-bold fs-5">{counts[i].go}</span>
                          <span className="text-muted"> / {counts[i].total}</span>
                        </td>
                      )
                    })}
                  </tr>

                  {/* NO-GO Count */}
                  <tr>
                    <td className="compare-label-cell">🚫 NO-GO Items</td>
                    {entries.map((entry, i) => {
                      const isBest = counts[i].noGo === Math.min(...counts.map(c => c.noGo))
                      return (
                        <td key={i} className={`compare-value-cell ${isBest ? 'compare-best' : counts[i].noGo > 0 ? 'compare-worst' : ''}`}>
                          <span className={`fw-bold fs-5 ${counts[i].noGo > 0 ? 'text-danger' : 'text-success'}`}>
                            {counts[i].noGo}
                          </span>
                        </td>
                      )
                    })}
                  </tr>

                  {/* REVIEW Count */}
                  <tr>
                    <td className="compare-label-cell">⚠️ REVIEW Items</td>
                    {entries.map((entry, i) => {
                      const isBest = counts[i].review === Math.min(...counts.map(c => c.review))
                      return (
                        <td key={i} className={`compare-value-cell ${isBest ? 'compare-best' : ''}`}>
                          <span className="text-warning fw-bold fs-5">{counts[i].review}</span>
                        </td>
                      )
                    })}
                  </tr>

                  {/* Divider */}
                  <tr className="table-secondary">
                    <td className="compare-label-cell fw-bold">RFP Details</td>
                    {entries.map((_, i) => <td key={i} className="compare-value-cell"></td>)}
                  </tr>

                  {/* RFP Number */}
                  <tr>
                    <td className="compare-label-cell">📄 RFP Number</td>
                    {entries.map((entry, i) => (
                      <td key={i} className="compare-value-cell">
                        {entry.summary?.rfpNumber || '—'}
                      </td>
                    ))}
                  </tr>

                  {/* Contract Value */}
                  <tr>
                    <td className="compare-label-cell">💰 Contract Value</td>
                    {entries.map((entry, i) => (
                      <td key={i} className="compare-value-cell">
                        {entry.summary?.contractValue || '—'}
                      </td>
                    ))}
                  </tr>

                  {/* Submission Deadline */}
                  <tr>
                    <td className="compare-label-cell">📅 Deadline</td>
                    {entries.map((entry, i) => (
                      <td key={i} className="compare-value-cell">
                        {entry.summary?.submissionDeadline || '—'}
                      </td>
                    ))}
                  </tr>

                  {/* Project Duration */}
                  <tr>
                    <td className="compare-label-cell">⏱️ Duration</td>
                    {entries.map((entry, i) => (
                      <td key={i} className="compare-value-cell">
                        {entry.summary?.projectDuration || '—'}
                      </td>
                    ))}
                  </tr>

                  {/* Deliverables Count */}
                  <tr>
                    <td className="compare-label-cell">📦 Deliverables</td>
                    {entries.map((entry, i) => {
                      const count = entry.deliverables?.length || 0
                      return (
                        <td key={i} className="compare-value-cell">
                          {count} items
                        </td>
                      )
                    })}
                  </tr>

                  {/* Divider */}
                  <tr className="table-secondary">
                    <td className="compare-label-cell fw-bold">Financial Highlights</td>
                    {entries.map((_, i) => <td key={i} className="compare-value-cell"></td>)}
                  </tr>

                  {/* Payment Terms */}
                  <tr>
                    <td className="compare-label-cell">💳 Payment Terms</td>
                    {entries.map((entry, i) => {
                      const item = financials[i].payment
                      return (
                        <td key={i} className={`compare-value-cell ${item?.status === 'GO' ? 'compare-best' : item?.status === 'NO-GO' ? 'compare-worst' : ''}`}>
                          {item ? (
                            <>
                              <span className={`badge bg-${item.status === 'GO' ? 'success' : item.status === 'NO-GO' ? 'danger' : 'warning'} me-1`}>
                                {item.status}
                              </span>
                              <div style={{ fontSize: '0.75rem', color: '#6c757d', marginTop: '4px' }}>
                                {item.reason}
                              </div>
                            </>
                          ) : '—'}
                        </td>
                      )
                    })}
                  </tr>

                  {/* Insurance */}
                  <tr>
                    <td className="compare-label-cell">🛡️ Insurance</td>
                    {entries.map((entry, i) => {
                      const item = financials[i].insurance
                      return (
                        <td key={i} className={`compare-value-cell ${item?.status === 'GO' ? 'compare-best' : item?.status === 'NO-GO' ? 'compare-worst' : ''}`}>
                          {item ? (
                            <>
                              <span className={`badge bg-${item.status === 'GO' ? 'success' : item.status === 'NO-GO' ? 'danger' : 'warning'} me-1`}>
                                {item.status}
                              </span>
                              <div style={{ fontSize: '0.75rem', color: '#6c757d', marginTop: '4px' }}>
                                {item.reason}
                              </div>
                            </>
                          ) : '—'}
                        </td>
                      )
                    })}
                  </tr>

                  {/* Bid Bond */}
                  <tr>
                    <td className="compare-label-cell">📝 Bid Bond</td>
                    {entries.map((entry, i) => {
                      const item = financials[i].bond
                      return (
                        <td key={i} className="compare-value-cell">
                          {item ? (
                            <>
                              <span className={`badge bg-${item.status === 'GO' ? 'success' : item.status === 'NO-GO' ? 'danger' : 'warning'} me-1`}>
                                {item.status}
                              </span>
                              <div style={{ fontSize: '0.75rem', color: '#6c757d', marginTop: '4px' }}>
                                {item.reason}
                              </div>
                            </>
                          ) : '—'}
                        </td>
                      )
                    })}
                  </tr>

                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Deliverables Comparison */}
        <div className="card shadow-sm mb-4">
          <div className="card-header bg-primary text-white">
            <h5 className="mb-0">📦 Deliverables Comparison</h5>
          </div>
          <div className="card-body">
            <div className="row">
              {entries.map((entry, i) => (
                <div key={i} className={`col-md-${Math.floor(12 / entries.length)}`}>
                  <h6 className="fw-bold text-primary">
                    {entry.summary?.projectTitle || entry.fileName}
                  </h6>
                  <ul className="small">
                    {(entry.deliverables || []).map((d, j) => (
                      <li key={j} className="mb-1">{d}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Back Button */}
        <div className="text-center">
          <Link href="/dashboard" className="btn btn-outline-secondary">
            ← Back to Dashboard
          </Link>
        </div>

      </div>
    </>
  )
}
