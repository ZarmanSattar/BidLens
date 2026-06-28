import { useState } from 'react'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import * as XLSX from 'xlsx'

const statusColors = {
  'GO': 'success',
  'NO-GO': 'danger',
  'REVIEW': 'warning'
}

const statusIcons = {
  'GO': '✅',
  'NO-GO': '🚫',
  'REVIEW': '⚠️'
}

const HIGH_PRIORITY_TASKS = [
  'payment terms',
  'insurance',
  'bid bond',
  'profitability',
  'performance bond',
]

// ── Bid Score Calculation ─────────────────────────────────

function calculateBidScore(complianceChecklist) {
  const allItems = [
    ...(complianceChecklist?.financial || []),
    ...(complianceChecklist?.legal || []),
    ...(complianceChecklist?.operations || []),
    ...(complianceChecklist?.technical || []),
  ]
  if (allItems.length === 0) return { score: 0, label: 'Do Not Bid', variant: 'donot', color: '#dc3545', earned: 0, total: 0 }

  const maxPoints = allItems.length * 2
  const earned = allItems.reduce((sum, item) => {
    if (item.status === 'GO') return sum + 2
    if (item.status === 'REVIEW') return sum + 1
    return sum
  }, 0)

  const score = Math.round((earned / maxPoints) * 100)

  if (score >= 80) return { score, label: 'Strong Bid', variant: 'strong', color: '#198754', earned, total: allItems.length }
  if (score >= 60) return { score, label: 'Bid with Caution', variant: 'caution', color: '#ffc107', earned, total: allItems.length }
  return { score, label: 'Do Not Bid', variant: 'donot', color: '#dc3545', earned, total: allItems.length }
}

// ── Risk Flag Collection ──────────────────────────────────

function collectRiskFlags(complianceChecklist) {
  const departments = ['financial', 'legal', 'operations', 'technical']
  const noGoItems = []
  const highPriorityReviews = []

  for (const dept of departments) {
    const items = complianceChecklist?.[dept] || []
    for (const item of items) {
      if (item.status === 'NO-GO') {
        noGoItems.push({ ...item, dept })
      } else if (item.status === 'REVIEW') {
        const isHighPriority = HIGH_PRIORITY_TASKS.some(keyword =>
          item.task.toLowerCase().includes(keyword)
        )
        if (isHighPriority) {
          highPriorityReviews.push({ ...item, dept })
        }
      }
    }
  }

  return { noGoItems, highPriorityReviews }
}

// ── Export to PDF ─────────────────────────────────────────

function exportToPDF(data) {
  const doc = new jsPDF()
  const pageWidth = doc.internal.pageSize.getWidth()

  doc.setFontSize(20)
  doc.setTextColor(13, 110, 253)
  doc.text('BidLens — RFP Analysis Report', pageWidth / 2, 18, { align: 'center' })

  if (data.summary) {
    doc.setFontSize(13)
    doc.setTextColor(33, 37, 41)
    doc.text('RFP Summary', 14, 30)
    autoTable(doc, {
      startY: 34,
      head: [['Field', 'Value']],
      body: [
        ['Issuing Agency', data.summary.issuingAgency || 'N/A'],
        ['Project Title', data.summary.projectTitle || 'N/A'],
        ['RFP Number', data.summary.rfpNumber || 'N/A'],
        ['Contract Value', data.summary.contractValue || 'N/A'],
        ['Submission Deadline', data.summary.submissionDeadline || 'N/A'],
        ['Project Duration', data.summary.projectDuration || 'N/A'],
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
    body: (data.deliverables || []).map((item, i) => [i + 1, item]),
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
    body: (data.evaluationCriteria || []).map((item, i) => [i + 1, item]),
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
    const items = data.complianceChecklist?.[dept.key] || []
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
}

// ── Export to Excel ───────────────────────────────────────

function exportToExcel(data) {
  import('xlsx').then((XLSX) => {
    const workbook = XLSX.utils.book_new()

    const summaryData = [
      ['Field', 'Value'],
      ['Issuing Agency', data.summary?.issuingAgency || ''],
      ['Project Title', data.summary?.projectTitle || ''],
      ['RFP Number', data.summary?.rfpNumber || ''],
      ['Contract Value', data.summary?.contractValue || ''],
      ['Submission Deadline', data.summary?.submissionDeadline || ''],
      ['Project Duration', data.summary?.projectDuration || ''],
    ]
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData)
    summarySheet['!cols'] = [{ wch: 25 }, { wch: 50 }]
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary')

    const deliverableData = [
      ['#', 'Deliverable'],
      ...(data.deliverables || []).map((item, i) => [i + 1, item])
    ]
    const deliverableSheet = XLSX.utils.aoa_to_sheet(deliverableData)
    deliverableSheet['!cols'] = [{ wch: 5 }, { wch: 80 }]
    XLSX.utils.book_append_sheet(workbook, deliverableSheet, 'Deliverables')

    const criteriaData = [
      ['#', 'Evaluation Criterion'],
      ...(data.evaluationCriteria || []).map((item, i) => [i + 1, item])
    ]
    const criteriaSheet = XLSX.utils.aoa_to_sheet(criteriaData)
    criteriaSheet['!cols'] = [{ wch: 5 }, { wch: 80 }]
    XLSX.utils.book_append_sheet(workbook, criteriaSheet, 'Evaluation Criteria')

    for (const dept of ['financial', 'legal', 'operations', 'technical']) {
      const items = data.complianceChecklist?.[dept] || []
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

// ── Sub Components ────────────────────────────────────────

function BidScoreCard({ complianceChecklist }) {
  const { score, label, variant, color, total } = calculateBidScore(complianceChecklist)

  const descriptions = {
    strong: 'This RFP meets most requirements. Recommend proceeding with the bid.',
    caution: 'This RFP has several items requiring review. Proceed carefully after team assessment.',
    donot: 'This RFP has critical dealbreakers. Do not bid without resolving NO-GO items.',
  }

  return (
    <div className="card mb-4 shadow-sm">
      <div className="card-header text-white" style={{ backgroundColor: color }}>
        <h5 className="mb-0">🎯 Bid Decision Score</h5>
      </div>
      <div className="card-body">
        <div className="bid-score-wrapper">
          <div className={`bid-score-circle ${variant}`}>
            <span className="bid-score-number" style={{ color }}>
              {score}
            </span>
            <span className="bid-score-label-small" style={{ color }}>
              / 100
            </span>
          </div>
          <div className="bid-score-info">
            <div className="bid-score-title" style={{ color }}>
              {label}
            </div>
            <div className="bid-score-subtitle">
              {descriptions[variant]}
            </div>
            <div className="mt-2">
              <small className="text-muted">
                Based on {total} compliance items across all departments
              </small>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function RiskFlagSummary({ complianceChecklist }) {
  const { noGoItems, highPriorityReviews } = collectRiskFlags(complianceChecklist)

  if (noGoItems.length === 0 && highPriorityReviews.length === 0) {
    return (
      <div className="card mb-4 shadow-sm border-success">
        <div className="card-body py-3">
          <span className="text-success fw-semibold">
            ✅ No critical issues found. All financial thresholds are within acceptable range.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="card mb-4 shadow-sm">
      <div className="card-header bg-danger text-white">
        <h5 className="mb-0">🚨 Risk Flag Summary</h5>
      </div>
      <div className="card-body">

        {noGoItems.length > 0 && (
          <div className="mb-3">
            <p className="fw-semibold text-danger mb-2">
              🚫 Critical Issues — NO-GO ({noGoItems.length})
            </p>
            {noGoItems.map((item, index) => (
              <div className="risk-item" key={index}>
                <span className="risk-dept-badge">
                  {item.dept.charAt(0).toUpperCase() + item.dept.slice(1)}
                </span>
                <div>
                  <span className="fw-semibold">{item.task}</span>
                  {item.reason && (
                    <div>
                      <small className="text-muted fst-italic">{item.reason}</small>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {highPriorityReviews.length > 0 && (
          <div>
            <p className="fw-semibold text-warning mb-2">
              ⚠️ High Priority Reviews ({highPriorityReviews.length})
            </p>
            {highPriorityReviews.map((item, index) => (
              <div className="risk-item" key={index}>
                <span className="risk-dept-badge">
                  {item.dept.charAt(0).toUpperCase() + item.dept.slice(1)}
                </span>
                <div>
                  <span className="fw-semibold">{item.task}</span>
                  {item.reason && (
                    <div>
                      <small className="text-muted fst-italic">{item.reason}</small>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  )
}

function SummaryCard({ summary }) {
  if (!summary) return null

  const fields = [
    { label: 'Issuing Agency', value: summary.issuingAgency },
    { label: 'Project Title', value: summary.projectTitle },
    { label: 'RFP Number', value: summary.rfpNumber },
    { label: 'Contract Value', value: summary.contractValue },
    { label: 'Submission Deadline', value: summary.submissionDeadline },
    { label: 'Project Duration', value: summary.projectDuration },
  ]

  return (
    <div className="card mb-4 shadow-sm">
      <div className="card-header bg-secondary text-white">
        <h5 className="mb-0">📋 RFP Summary</h5>
      </div>
      <div className="card-body">
        <div className="row">
          {fields.map((field, index) => (
            field.value && field.value !== 'null' && (
              <div className="col-md-6 mb-2" key={index}>
                <span className="text-muted small">{field.label}</span>
                <p className="mb-0 fw-semibold">{field.value}</p>
              </div>
            )
          ))}
        </div>
      </div>
    </div>
  )
}

function ChecklistItem({ task, status, reason }) {
  const [showReason, setShowReason] = useState(false)

  return (
    <div className="border-bottom py-2">
      <div className="d-flex align-items-start justify-content-between">
        <span className="me-3">{task}</span>
        <div className="d-flex align-items-center gap-2">
          <span className={`badge bg-${statusColors[status] || 'secondary'} text-nowrap`}>
            {statusIcons[status]} {status}
          </span>
          {reason && (
            <button
              className="btn btn-link btn-sm p-0 text-muted"
              onClick={() => setShowReason(!showReason)}
              title="Show reason"
            >
              {showReason ? '▲' : '▼'}
            </button>
          )}
        </div>
      </div>
      {showReason && reason && (
        <div className="mt-1">
          <small className="text-muted fst-italic">{reason}</small>
        </div>
      )}
    </div>
  )
}

function DepartmentChecklist({ items }) {
  if (!items || items.length === 0) {
    return <p className="text-muted">No items found.</p>
  }

  const goCount = items.filter(i => i.status === 'GO').length
  const noGoCount = items.filter(i => i.status === 'NO-GO').length
  const reviewCount = items.filter(i => i.status === 'REVIEW').length

  return (
    <div>
      <div className="d-flex gap-3 mb-3">
        <small className="text-success fw-semibold">✅ GO: {goCount}</small>
        <small className="text-danger fw-semibold">🚫 NO-GO: {noGoCount}</small>
        <small className="text-warning fw-semibold">⚠️ REVIEW: {reviewCount}</small>
      </div>
      {items.map((item, index) => (
        <ChecklistItem
          key={index}
          task={item.task}
          status={item.status}
          reason={item.reason}
        />
      ))}
    </div>
  )
}

export default function ResultsPanel({ data, onExportPDF, onExportExcel }) {
  const [activeTab, setActiveTab] = useState('financial')

  const departments = [
    { key: 'financial', label: '🏦 Financial' },
    { key: 'legal', label: '⚖️ Legal' },
    { key: 'operations', label: '⚙️ Operations' },
    { key: 'technical', label: '💻 Technical' },
  ]

  return (
    <div className="mt-4">

      {/* Export Buttons */}
      <div className="d-flex gap-2 mb-4 justify-content-end">
        <button
          className="btn btn-outline-danger btn-sm"
          onClick={onExportPDF}
        >
          📄 Export PDF
        </button>
        <button
          className="btn btn-outline-success btn-sm"
          onClick={onExportExcel}
        >
          📊 Export Excel
        </button>
      </div>

      {/* Bid Score Card */}
      <BidScoreCard complianceChecklist={data.complianceChecklist} />

      {/* Risk Flag Summary */}
      <RiskFlagSummary complianceChecklist={data.complianceChecklist} />

      {/* RFP Summary */}
      <SummaryCard summary={data.summary} />

      {/* Deliverables */}
      <div className="card mb-4 shadow-sm">
        <div className="card-header bg-primary text-white">
          <h5 className="mb-0">📦 Deliverables</h5>
        </div>
        <div className="card-body">
          {data.deliverables && data.deliverables.length > 0 ? (
            <ul className="mb-0">
              {data.deliverables.map((item, index) => (
                <li key={index} className="py-1">{item}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted mb-0">No deliverables found.</p>
          )}
        </div>
      </div>

      {/* Evaluation Criteria */}
      <div className="card mb-4 shadow-sm">
        <div className="card-header bg-info text-white">
          <h5 className="mb-0">📊 Evaluation Criteria</h5>
        </div>
        <div className="card-body">
          {data.evaluationCriteria && data.evaluationCriteria.length > 0 ? (
            <ul className="mb-0">
              {data.evaluationCriteria.map((item, index) => (
                <li key={index} className="py-1">{item}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted mb-0">No evaluation criteria found.</p>
          )}
        </div>
      </div>

      {/* Compliance Checklist */}
      <div className="card shadow-sm">
        <div className="card-header bg-dark text-white">
          <h5 className="mb-0">✅ Compliance Checklist</h5>
        </div>
        <div className="card-body">
          <ul className="nav nav-tabs mb-3">
            {departments.map((dept) => (
              <li className="nav-item" key={dept.key}>
                <button
                  className={`nav-link ${activeTab === dept.key ? 'active' : ''}`}
                  onClick={() => setActiveTab(dept.key)}
                >
                  {dept.label}
                </button>
              </li>
            ))}
          </ul>
          <DepartmentChecklist
            items={data.complianceChecklist?.[activeTab]}
          />
        </div>
      </div>

    </div>
  )
}
