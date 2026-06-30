import { useState, useEffect } from 'react'
import Link from 'next/link'
import ResultsPanel from '../components/ResultsPanel'

function exportToPDF(results) {
  import('jspdf').then(({ default: jsPDF }) => {
    import('jspdf-autotable').then(({ default: autoTable }) => {
      const doc = new jsPDF()
      const pageWidth = doc.internal.pageSize.getWidth()
      doc.setFontSize(20)
      doc.setTextColor(13, 110, 253)
      doc.text('BidLens — RFP Analysis Report', pageWidth / 2, 18, { align: 'center' })
      if (results.summary) {
        doc.setFontSize(13)
        doc.setTextColor(33, 37, 41)
        doc.text('RFP Summary', 14, 30)
        autoTable(doc, {
          startY: 34,
          head: [['Field', 'Value']],
          body: [
            ['Issuing Agency', results.summary.issuingAgency || 'N/A'],
            ['Project Title', results.summary.projectTitle || 'N/A'],
            ['RFP Number', results.summary.rfpNumber || 'N/A'],
            ['Contract Value', results.summary.contractValue || 'N/A'],
            ['Submission Deadline', results.summary.submissionDeadline || 'N/A'],
            ['Project Duration', results.summary.projectDuration || 'N/A'],
          ],
          theme: 'grid',
          headStyles: { fillColor: [108, 117, 125] },
          styles: { fontSize: 9 },
        })
      }
      const afterSummary = doc.lastAutoTable.finalY + 8
      doc.setFontSize(13)
      doc.setTextColor(33, 37, 41)
      doc.text('Deliverables', 14, afterSummary)
      autoTable(doc, {
        startY: afterSummary + 4,
        head: [['#', 'Deliverable']],
        body: (results.deliverables || []).map((item, i) => [i + 1, item]),
        theme: 'striped',
        headStyles: { fillColor: [13, 110, 253] },
        styles: { fontSize: 9 },
        columnStyles: { 0: { cellWidth: 10 } },
      })
      const afterDeliverables = doc.lastAutoTable.finalY + 8
      doc.setFontSize(13)
      doc.text('Evaluation Criteria', 14, afterDeliverables)
      autoTable(doc, {
        startY: afterDeliverables + 4,
        head: [['#', 'Criterion']],
        body: (results.evaluationCriteria || []).map((item, i) => [i + 1, item]),
        theme: 'striped',
        headStyles: { fillColor: [13, 202, 240] },
        styles: { fontSize: 9 },
        columnStyles: { 0: { cellWidth: 10 } },
      })
      const departments = [
        { key: 'financial', label: 'Financial', color: [255, 193, 7] },
        { key: 'legal', label: 'Legal', color: [220, 53, 69] },
        { key: 'operations', label: 'Operations', color: [108, 117, 125] },
        { key: 'technical', label: 'Technical', color: [13, 110, 253] },
      ]
      for (const dept of departments) {
        const items = results.complianceChecklist?.[dept.key] || []
        if (items.length === 0) continue
        const startY = doc.lastAutoTable.finalY + 8
        doc.setFontSize(13)
        doc.setTextColor(33, 37, 41)
        doc.text(`Compliance — ${dept.label}`, 14, startY)
        autoTable(doc, {
          startY: startY + 4,
          head: [['Task', 'Status', 'Reason']],
          body: items.map(item => [item.task, item.status, item.reason || '']),
          theme: 'grid',
          headStyles: { fillColor: dept.color },
          styles: { fontSize: 8, cellPadding: 3 },
          columnStyles: {
            0: { cellWidth: 70 },
            1: { cellWidth: 20, halign: 'center' },
            2: { cellWidth: 90 },
          },
        })
      }
      const pageCount = doc.internal.getNumberOfPages()
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i)
        doc.setFontSize(8)
        doc.setTextColor(150)
        doc.text(
          `BidLens RFP Analysis — Page ${i} of ${pageCount}`,
          pageWidth / 2,
          doc.internal.pageSize.getHeight() - 8,
          { align: 'center' }
        )
      }
      doc.save('BidLens_RFP_Analysis.pdf')
    })
  })
}

function exportToExcel(results) {
  import('xlsx').then((XLSX) => {
    const workbook = XLSX.utils.book_new()
    const summaryData = [
      ['Field', 'Value'],
      ['Issuing Agency', results.summary?.issuingAgency || ''],
      ['Project Title', results.summary?.projectTitle || ''],
      ['RFP Number', results.summary?.rfpNumber || ''],
      ['Contract Value', results.summary?.contractValue || ''],
      ['Submission Deadline', results.summary?.submissionDeadline || ''],
      ['Project Duration', results.summary?.projectDuration || ''],
    ]
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData)
    summarySheet['!cols'] = [{ wch: 25 }, { wch: 50 }]
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary')
    const deliverableData = [
      ['#', 'Deliverable'],
      ...(results.deliverables || []).map((item, i) => [i + 1, item])
    ]
    const deliverableSheet = XLSX.utils.aoa_to_sheet(deliverableData)
    deliverableSheet['!cols'] = [{ wch: 5 }, { wch: 80 }]
    XLSX.utils.book_append_sheet(workbook, deliverableSheet, 'Deliverables')
    const criteriaData = [
      ['#', 'Evaluation Criterion'],
      ...(results.evaluationCriteria || []).map((item, i) => [i + 1, item])
    ]
    const criteriaSheet = XLSX.utils.aoa_to_sheet(criteriaData)
    criteriaSheet['!cols'] = [{ wch: 5 }, { wch: 80 }]
    XLSX.utils.book_append_sheet(workbook, criteriaSheet, 'Evaluation Criteria')
    for (const dept of ['financial', 'legal', 'operations', 'technical']) {
      const items = results.complianceChecklist?.[dept] || []
      const sheetData = [
        ['Task', 'Status', 'Reason'],
        ...items.map(item => [item.task, item.status, item.reason || ''])
      ]
      const sheet = XLSX.utils.aoa_to_sheet(sheetData)
      sheet['!cols'] = [{ wch: 50 }, { wch: 12 }, { wch: 70 }]
      XLSX.utils.book_append_sheet(workbook, sheet, dept.charAt(0).toUpperCase() + dept.slice(1))
    }
    XLSX.writeFile(workbook, 'BidLens_RFP_Analysis.xlsx')
  })
}

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

function parseDeadline(deadlineStr) {
  if (!deadlineStr) return null
  const cleaned = deadlineStr
    .replace(/at\s+\d+:\d+\s*(AM|PM)?\s*(EST|CST|PST|EDT|CDT|PDT|UTC)?/i, '')
    .trim()
  const parsed = new Date(cleaned)
  return isNaN(parsed.getTime()) ? null : parsed
}

function getDaysRemaining(deadlineStr) {
  const deadline = parseDeadline(deadlineStr)
  if (!deadline) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diff = Math.ceil((deadline - today) / (1000 * 60 * 60 * 24))
  return diff
}

export default function Dashboard() {
  const [history, setHistory] = useState([])
  const [expandedId, setExpandedId] = useState(null)
  const [selectedIds, setSelectedIds] = useState([])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('bidlens_history')
      if (stored) {
        const parsed = JSON.parse(stored)
        const sorted = parsed.sort((a, b) => b.id - a.id)
        setHistory(sorted)
      }
    }
  }, [])

  function handleDelete(id) {
    const updated = history.filter(entry => entry.id !== id)
    setHistory(updated)
    localStorage.setItem('bidlens_history', JSON.stringify(updated))
    if (expandedId === id) setExpandedId(null)
    setSelectedIds(prev => prev.filter(sid => sid !== id))
  }

  function handleToggleExpand(id) {
    setExpandedId(prev => prev === id ? null : id)
  }

  function handleClearAll() {
    if (confirm('Are you sure you want to clear all history?')) {
      localStorage.removeItem('bidlens_history')
      setHistory([])
      setExpandedId(null)
      setSelectedIds([])
    }
  }

  function handleSelectToggle(id) {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(sid => sid !== id) : [...prev, id]
    )
  }

  const totalAnalyzed = history.length
  const proceedCount = history.filter(e => getDecision(e.complianceChecklist).label === 'PROCEED').length
  const escalateCount = history.filter(e => getDecision(e.complianceChecklist).label === 'ESCALATE').length
  const rejectCount = history.filter(e => getDecision(e.complianceChecklist).label === 'REJECT').length

  const deadlineEntries = history
    .filter(e => e.summary?.submissionDeadline)
    .map(e => ({
      ...e,
      daysRemaining: getDaysRemaining(e.summary.submissionDeadline),
    }))
    .filter(e => e.daysRemaining !== null)
    .sort((a, b) => a.daysRemaining - b.daysRemaining)

  return (
    <>
      <nav className="navbar navbar-dark bg-dark px-4">
        <span className="navbar-brand fw-bold fs-4">
          Bid<span style={{ color: '#0d6efd' }}>Lens</span>
        </span>
        <div className="d-flex align-items-center gap-3">
          <span className="text-secondary small">Dashboard</span>
          <Link href="/" className="btn btn-primary btn-sm">
            🔍 New Analysis
          </Link>
        </div>
      </nav>

      <div className="container py-5" style={{ maxWidth: '1100px' }}>

        {/* Header */}
        <div className="d-flex justify-content-between align-items-center mb-4">
          <h2 className="fw-bold mb-0">RFP History</h2>
          <div className="d-flex gap-2">
            {selectedIds.length >= 2 && (
              <Link
                href={`/compare?ids=${selectedIds.join(',')}`}
                className="btn btn-primary btn-sm"
              >
                ⚖️ Compare Selected ({selectedIds.length})
              </Link>
            )}
            {history.length > 0 && (
              <button
                className="btn btn-outline-danger btn-sm"
                onClick={handleClearAll}
              >
                🗑️ Clear All
              </button>
            )}
          </div>
        </div>

        {/* Stats Row */}
        <div className="row mb-4 g-3">
          <div className="col-md-3">
            <div className="dashboard-stat-card">
              <div className="dashboard-stat-number text-dark">{totalAnalyzed}</div>
              <div className="dashboard-stat-label">Total Analyzed</div>
            </div>
          </div>
          <div className="col-md-3">
            <div className="dashboard-stat-card">
              <div className="dashboard-stat-number text-success">{proceedCount}</div>
              <div className="dashboard-stat-label">PROCEED</div>
            </div>
          </div>
          <div className="col-md-3">
            <div className="dashboard-stat-card">
              <div className="dashboard-stat-number text-warning">{escalateCount}</div>
              <div className="dashboard-stat-label">ESCALATE</div>
            </div>
          </div>
          <div className="col-md-3">
            <div className="dashboard-stat-card">
              <div className="dashboard-stat-number text-danger">{rejectCount}</div>
              <div className="dashboard-stat-label">REJECT</div>
            </div>
          </div>
        </div>

        {/* Deadline Tracker */}
        {deadlineEntries.length > 0 && (
          <div className="card shadow-sm mb-4">
            <div className="card-header bg-warning text-dark">
              <h5 className="mb-0">⏰ Deadline Tracker</h5>
            </div>
            <div className="card-body">
              {deadlineEntries.map(entry => {
                const days = entry.daysRemaining
                let cls = 'deadline-ok'
                let badgeColor = '#198754'
                let badgeBg = '#d1f7e0'
                let label = `${days} days left`

                if (days < 0) {
                  cls = 'deadline-expired'
                  badgeColor = '#6c757d'
                  badgeBg = '#e9ecef'
                  label = 'EXPIRED'
                } else if (days <= 7) {
                  cls = 'deadline-urgent'
                  badgeColor = '#dc3545'
                  badgeBg = '#ffdde1'
                  label = `${days} days left`
                } else if (days <= 30) {
                  cls = 'deadline-soon'
                  badgeColor = '#856404'
                  badgeBg = '#fff3cd'
                  label = `${days} days left`
                }

                return (
                  <div className={`deadline-item ${cls}`} key={entry.id}>
                    <div>
                      <div className="fw-semibold" style={{ fontSize: '0.9rem' }}>
                        {entry.summary?.projectTitle || entry.fileName}
                      </div>
                      <div className="text-muted" style={{ fontSize: '0.78rem' }}>
                        {entry.summary?.issuingAgency} — Due: {entry.summary?.submissionDeadline}
                      </div>
                    </div>
                    <span
                      className="deadline-days"
                      style={{ color: badgeColor, backgroundColor: badgeBg }}
                    >
                      {label}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Empty State */}
        {history.length === 0 && (
          <div className="text-center py-5">
            <div style={{ fontSize: '3rem' }}>📭</div>
            <h5 className="mt-3 text-muted">No analyses yet</h5>
            <p className="text-muted">Upload and analyze an RFP to see it here.</p>
            <Link href="/" className="btn btn-primary">
              🔍 Start New Analysis
            </Link>
          </div>
        )}

        {/* History Table */}
        {history.length > 0 && (
          <div className="card shadow-sm">
            <div className="card-body p-0">
              {selectedIds.length > 0 && selectedIds.length < 2 && (
                <div className="alert alert-info m-3 mb-0 py-2">
                  <small>Select at least 2 RFPs to compare. Currently selected: {selectedIds.length}</small>
                </div>
              )}
              <table className="table table-hover mb-0">
                <thead className="table-dark">
                  <tr>
                    <th className="text-center" style={{ width: '40px' }}>
                      <input
                        type="checkbox"
                        className="form-check-input"
                        onChange={e => {
                          if (e.target.checked) {
                            setSelectedIds(history.map(h => h.id))
                          } else {
                            setSelectedIds([])
                          }
                        }}
                        checked={selectedIds.length === history.length && history.length > 0}
                      />
                    </th>
                    <th>RFP File</th>
                    <th>Agency</th>
                    <th>Date</th>
                    <th className="text-center">Score</th>
                    <th className="text-center">✅ GO</th>
                    <th className="text-center">🚫 NO-GO</th>
                    <th className="text-center">⚠️ REVIEW</th>
                    <th className="text-center">Decision</th>
                    <th className="text-center">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(entry => {
                    const decision = getDecision(entry.complianceChecklist)
                    const counts = getCounts(entry.complianceChecklist)
                    const score = getBidScore(entry.complianceChecklist)
                    const isExpanded = expandedId === entry.id
                    const isSelected = selectedIds.includes(entry.id)

                    const scoreColor = score >= 80 ? '#198754' : score >= 60 ? '#856404' : '#dc3545'

                    return (
                      <>
                        <tr key={entry.id} className={isExpanded ? 'table-active' : ''}>
                          <td className="text-center">
                            <input
                              type="checkbox"
                              className="form-check-input"
                              checked={isSelected}
                              onChange={() => handleSelectToggle(entry.id)}
                            />
                          </td>
                          <td>
                            <span className="fw-semibold" style={{ fontSize: '0.88rem' }}>
                              {entry.fileName}
                            </span>
                          </td>
                          <td style={{ fontSize: '0.85rem' }}>
                            {entry.summary?.issuingAgency || '—'}
                          </td>
                          <td style={{ fontSize: '0.85rem' }}>
                            {new Date(entry.analyzedAt).toLocaleDateString('en-US', {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric'
                            })}
                          </td>
                          <td className="text-center">
                            <span className="fw-bold" style={{ color: scoreColor }}>
                              {score}
                            </span>
                          </td>
                          <td className="text-center">
                            <span className="text-success fw-bold">{counts.go}</span>
                          </td>
                          <td className="text-center">
                            <span className="text-danger fw-bold">{counts.noGo}</span>
                          </td>
                          <td className="text-center">
                            <span className="text-warning fw-bold">{counts.review}</span>
                          </td>
                          <td className="text-center">
                            <span className={`badge bg-${decision.color}`}>
                              {decision.label}
                            </span>
                          </td>
                          <td className="text-center">
                            <div className="d-flex gap-1 justify-content-center">
                              <button
                                className="btn btn-outline-primary btn-sm"
                                onClick={() => handleToggleExpand(entry.id)}
                              >
                                {isExpanded ? '▲ Hide' : '▼ View'}
                              </button>
                              <button
                                className="btn btn-outline-danger btn-sm"
                                onClick={() => handleDelete(entry.id)}
                              >
                                🗑️
                              </button>
                            </div>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`${entry.id}-expanded`}>
                            <td colSpan={10} className="p-0">
                              <div className="expanded-results-panel">
                                <ResultsPanel
                                  data={entry}
                                  onExportPDF={() => exportToPDF(entry)}
                                  onExportExcel={() => exportToExcel(entry)}
                                />
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    </>
  )
}
