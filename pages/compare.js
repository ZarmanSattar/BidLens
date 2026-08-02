import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase/client'

function getDecision(complianceChecklist) {
  const allItems = [
    ...(complianceChecklist?.financial || []),
    ...(complianceChecklist?.legal || []),
    ...(complianceChecklist?.operations || []),
    ...(complianceChecklist?.technical || []),
  ]
  const hasNoGo = allItems.some(item => item.status === 'NO-GO')
  const hasEscalate = allItems.some(item => item.status === 'ESCALATE')
  if (hasNoGo) return { label: 'REJECT', color: 'danger' }
  if (hasEscalate) return { label: 'ESCALATE', color: 'warning' }
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
    escalate: allItems.filter(i => i.status === 'ESCALATE').length,
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
    if (item.status === 'ESCALATE') return sum + 1
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

// B3 — the full rubric as comparison rows.
//
// analyze.js applies a FIXED 27-item checklist to every RFP, so the row basis
// is read off the analyses themselves rather than duplicated here: whichever
// entry has a checklist defines the rows, and every other entry is looked up
// against them by task name. That keeps this page correct if the rubric is
// ever extended, and keeps it from inventing rows the analysis does not have.
const RUBRIC_DEPARTMENTS = [
  { key: 'financial', label: '💰 Financial' },
  { key: 'legal', label: '⚖️ Legal' },
  { key: 'operations', label: '⚙️ Operations' },
  { key: 'technical', label: '💻 Technical' },
]

/**
 * @param {Array<object>} entries
 * @returns {Array<{key: string, label: string, tasks: string[]}>}
 */
function buildRubric(entries) {
  return RUBRIC_DEPARTMENTS.map((dept) => {
    const tasks = []

    for (const entry of entries) {
      for (const item of entry?.complianceChecklist?.[dept.key] || []) {
        const task = String(item?.task || '').trim()

        // Union across entries, first-seen order. Identical in practice —
        // the rubric is fixed — but a union means one odd analysis cannot
        // silently drop a row for everybody.
        if (task && !tasks.includes(task)) tasks.push(task)
      }
    }

    return { ...dept, tasks }
  }).filter((dept) => dept.tasks.length > 0)
}

/**
 * One entry's verdict for one task, or null when it has no such item.
 *
 * @param {object} entry
 * @param {string} deptKey
 * @param {string} task
 * @returns {object|null}
 */
function findRubricItem(entry, deptKey, task) {
  const items = entry?.complianceChecklist?.[deptKey] || []

  return items.find((item) => String(item?.task || '').trim() === task) || null
}

const STATUS_BADGE = { GO: 'success', 'NO-GO': 'danger', ESCALATE: 'warning' }

export default function Compare() {
  const router = useRouter()
  const [session, setSession] = useState(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        router.push('/login')
      } else {
        setSession(data.session)
        setCheckingSession(false)
      }
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!newSession) {
        router.push('/login')
      } else {
        setSession(newSession)
      }
    })
    return () => listener.subscription.unsubscribe()
  }, [router])

  useEffect(() => {
    if (!session || typeof window === 'undefined') return

    async function loadEntries() {
      const params = new URLSearchParams(window.location.search)
      const idsParam = params.get('ids')

      if (!idsParam) {
        setError('No RFPs selected for comparison.')
        setLoading(false)
        return
      }

      const ids = idsParam.split(',')

      if (ids.length < 2) {
        setError('Please select at least 2 RFPs to compare.')
        setLoading(false)
        return
      }

      const { data, error: fetchError } = await supabase
        .from('analyses')
        .select(`
          id,
          created_at,
          result,
          rfps ( id, title, original_filename )
        `)
        .in('id', ids)

      if (fetchError) {
        setError('Failed to load comparison: ' + fetchError.message)
        setLoading(false)
        return
      }

      if (!data || data.length < 2) {
        setError('Could not find the selected RFPs in history.')
        setLoading(false)
        return
      }

      // Preserve the order the ids were passed in, not whatever order the DB returns
      const byId = new Map(data.map(row => [row.id, row]))
      const ordered = ids
        .map(id => byId.get(id))
        .filter(Boolean)
        .map(row => ({
          id: row.id,
          fileName: row.rfps?.original_filename || row.rfps?.title,
          analyzedAt: row.created_at,
          ...row.result,
        }))

      setEntries(ordered)
      setLoading(false)
    }

    loadEntries()
  }, [session])

  if (checkingSession) {
    return <div className="container py-5">Loading...</div>
  }

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
  const rubric = buildRubric(entries)

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

                  <tr>
                    <td className="compare-label-cell">⚠️ ESCALATE Items</td>
                    {entries.map((entry, i) => {
                      const isBest = counts[i].escalate === Math.min(...counts.map(c => c.escalate))
                      return (
                        <td key={i} className={`compare-value-cell ${isBest ? 'compare-best' : ''}`}>
                          <span className="text-warning fw-bold fs-5">{counts[i].escalate}</span>
                        </td>
                      )
                    })}
                  </tr>

                  <tr className="table-secondary">
                    <td className="compare-label-cell fw-bold">RFP Details</td>
                    {entries.map((_, i) => <td key={i} className="compare-value-cell"></td>)}
                  </tr>

                  <tr>
                    <td className="compare-label-cell">📄 RFP Number</td>
                    {entries.map((entry, i) => (
                      <td key={i} className="compare-value-cell">
                        {entry.summary?.rfpNumber || '—'}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td className="compare-label-cell">💰 Contract Value</td>
                    {entries.map((entry, i) => (
                      <td key={i} className="compare-value-cell">
                        {entry.summary?.contractValue || '—'}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td className="compare-label-cell">📅 Deadline</td>
                    {entries.map((entry, i) => (
                      <td key={i} className="compare-value-cell">
                        {entry.summary?.submissionDeadline || '—'}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td className="compare-label-cell">⏱️ Duration</td>
                    {entries.map((entry, i) => (
                      <td key={i} className="compare-value-cell">
                        {entry.summary?.projectDuration || '—'}
                      </td>
                    ))}
                  </tr>

                  <tr>
                    <td className="compare-label-cell">📦 Deliverables</td>
                    {entries.map((entry, i) => {
                      const count = (entry.deliverables || []).reduce((sum, group) => {
                        return sum + (group.children ? group.children.length : 0);
                      }, 0);
                      return (
                        <td key={i} className="compare-value-cell">
                          {count} items
                        </td>
                      )
                    })}
                  </tr>

                  <tr className="table-secondary">
                    <td className="compare-label-cell fw-bold">Financial Highlights</td>
                    {entries.map((_, i) => <td key={i} className="compare-value-cell"></td>)}
                  </tr>

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

        {/* B3 — every rubric item, every RFP. The curated highlights above
            answer "which is better at a glance"; this answers "where exactly
            do these differ", which is the question that needs all 27 rows. */}
        {rubric.length > 0 && (
          <div className="card shadow-sm mb-4">
            <div className="card-header bg-dark text-white d-flex justify-content-between align-items-center flex-wrap gap-2">
              <h5 className="mb-0">📋 Full Compliance Rubric</h5>
              <span className="badge bg-light text-dark">
                {rubric.reduce((n, d) => n + d.tasks.length, 0)} items ×{' '}
                {entries.length} RFPs
              </span>
            </div>
            <div className="card-body p-0">
              <div className="table-responsive">
                <table className="table table-sm table-bordered mb-0 compare-table">
                  <thead>
                    <tr className="table-light">
                      <th className="compare-label-cell" style={{ minWidth: '190px' }}>
                        Checklist item
                      </th>
                      {entries.map((entry, i) => (
                        <th key={i} className="compare-value-cell">
                          {entry.summary?.projectTitle || entry.fileName}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rubric.map((dept) => (
                      <React.Fragment key={dept.key}>
                        <tr className="table-secondary">
                          <td className="compare-label-cell fw-bold">{dept.label}</td>
                          {entries.map((_, i) => (
                            <td key={i} className="compare-value-cell" />
                          ))}
                        </tr>

                        {dept.tasks.map((task) => {
                          const items = entries.map((entry) =>
                            findRubricItem(entry, dept.key, task)
                          )

                          const statuses = items.map((item) => item?.status || null)

                          // Rows where the RFPs actually differ are the point
                          // of the table — marked so they can be found without
                          // reading all 27.
                          const differs =
                            new Set(statuses.filter(Boolean)).size > 1

                          return (
                            <tr key={task}>
                              <td className="compare-label-cell">
                                {differs && (
                                  <span
                                    className="badge bg-info text-dark me-1"
                                    style={{ fontSize: '0.6rem' }}
                                  >
                                    differs
                                  </span>
                                )}
                                {task}
                              </td>
                              {items.map((item, i) => (
                                <td
                                  key={i}
                                  className={`compare-value-cell ${
                                    item?.status === 'GO'
                                      ? 'compare-best'
                                      : item?.status === 'NO-GO'
                                        ? 'compare-worst'
                                        : ''
                                  }`}
                                >
                                  {item ? (
                                    <>
                                      <span
                                        className={`badge bg-${STATUS_BADGE[item.status] || 'secondary'} me-1`}
                                      >
                                        {item.status}
                                      </span>
                                      <div
                                        style={{
                                          fontSize: '0.75rem',
                                          color: '#6c757d',
                                          marginTop: '4px',
                                        }}
                                      >
                                        {item.reason}
                                      </div>
                                    </>
                                  ) : (
                                    '—'
                                  )}
                                </td>
                              ))}
                            </tr>
                          )
                        })}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        <div className="card shadow-sm mb-4">
          <div className="card-header bg-primary text-white">
            <h5 className="mb-0">📦 Deliverables Comparison</h5>
          </div>
          <div className="card-body">
            <div className="row">
              {entries.map((entry, i) => (
                <div key={i} className={`col-md-${Math.floor(12 / entries.length)}`}>
                  <h6 className="fw-bold text-primary mb-3">
                    {entry.summary?.projectTitle || entry.fileName}
                  </h6>
                  <div className="small">
                    {(entry.deliverables || []).map((group, gIndex) => (
                      <div key={gIndex} className="mb-3">
                        <div className="fw-semibold text-dark mb-1">
                          {gIndex + 1}. {group.parent}
                        </div>
                        {group.children && group.children.length > 0 && (
                          <ul className="text-muted ms-3 mb-0 ps-0 list-unstyled">
                            {group.children.map((child, cIndex) => (
                              <li key={cIndex} className="mb-1">
                                <span className="me-2 text-secondary">{gIndex + 1}.{cIndex + 1}</span>
                                {child}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                    {(!entry.deliverables || entry.deliverables.length === 0) && (
                      <span className="text-muted fst-italic">No deliverables found.</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="text-center">
          <Link href="/dashboard" className="btn btn-outline-secondary">
            ← Back to Dashboard
          </Link>
        </div>

      </div>
    </>
  )
}
