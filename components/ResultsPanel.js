import { useEffect, useState } from 'react'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import * as XLSX from 'xlsx'
import { downloadJsonExport } from '../utils/exportToJson'
import TraceabilityMatrix, {
  joinRequirementLinks,
} from './TraceabilityMatrix'
import ContractRiskCard from './ContractRiskCard'
import CompanyFitCard from './CompanyFitCard'
import { supabase } from '../lib/supabase/client'

const statusColors = {
  'GO': 'success',
  'NO-GO': 'danger',
  'ESCALATE': 'warning'
}

const statusIcons = {
  'GO': '✅',
  'NO-GO': '🚫',
  'ESCALATE': '⚠️'
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
    if (item.status === 'ESCALATE') return sum + 1
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
  const highPriorityEscalations = []

  for (const dept of departments) {
    const items = complianceChecklist?.[dept] || []
    for (const item of items) {
      if (item.status === 'NO-GO') {
        noGoItems.push({ ...item, dept })
      } else if (item.status === 'ESCALATE') {
        const isHighPriority = HIGH_PRIORITY_TASKS.some(keyword =>
          item.task.toLowerCase().includes(keyword)
        )
        if (isHighPriority) {
          highPriorityEscalations.push({ ...item, dept })
        }
      }
    }
  }

  return { noGoItems, highPriorityEscalations }
}

// ── Export to PDF ─────────────────────────────────────────

function exportToPDF(data) {
  const doc = new jsPDF('landscape')
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

  const deliverableRows = []
  if (data.deliverables && data.deliverables.length > 0) {
    data.deliverables.forEach((group, gIndex) => {
      deliverableRows.push([`${gIndex + 1}`, group.parent])
      if (group.children && group.children.length > 0) {
        group.children.forEach((child, cIndex) => {
          deliverableRows.push([`${gIndex + 1}.${cIndex + 1}`, child])
        })
      }
    })
  }

  const afterSummary = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : 34
  doc.setFontSize(13)
  doc.setTextColor(33, 37, 41)
  doc.text('Deliverables', 14, afterSummary)
  autoTable(doc, {
    startY: afterSummary + 4,
    head: [['Level', 'Deliverable']],
    body: deliverableRows,
    theme: 'striped',
    headStyles: { fillColor: [13, 110, 253] },
    styles: { fontSize: 9 },
    columnStyles: { 0: { cellWidth: 15 } },
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
    columnStyles: { 0: { cellWidth: 15 } },
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
      head: [['Checklist Item', 'Decision', 'Reason', 'Evidence from RFP']],
      body: items.map(item => [item.task, item.status, item.reason || '', item.evidence || '']),
      theme: 'grid',
      headStyles: { fillColor: dept.color },
      styles: { fontSize: 8, cellPadding: 3 },
      columnStyles: {
        0: { cellWidth: 40 },
        1: { cellWidth: 22, halign: 'center' },
        2: { cellWidth: 100 },
        3: { cellWidth: 100 },
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

    const deliverableData = [['Level', 'Deliverable']]
    if (data.deliverables && data.deliverables.length > 0) {
      data.deliverables.forEach((group, gIndex) => {
        deliverableData.push([`${gIndex + 1}`, group.parent])
        if (group.children && group.children.length > 0) {
          group.children.forEach((child, cIndex) => {
            deliverableData.push([`${gIndex + 1}.${cIndex + 1}`, child])
          })
        }
      })
    }
    const deliverableSheet = XLSX.utils.aoa_to_sheet(deliverableData)
    deliverableSheet['!cols'] = [{ wch: 10 }, { wch: 80 }]
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
        ['Checklist Item', 'Decision', 'Reason', 'Evidence from RFP'],
        ...items.map(item => [item.task, item.status, item.reason || '', item.evidence || ''])
      ]
      const sheet = XLSX.utils.aoa_to_sheet(sheetData)
      sheet['!cols'] = [{ wch: 35 }, { wch: 15 }, { wch: 60 }, { wch: 60 }]
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
    <div className="card mb-4 shadow-sm border-0">
      <div className="card-header text-white border-0" style={{ backgroundColor: color }}>
        <h5 className="mb-0 fw-bold">🎯 Bid Decision Score</h5>
      </div>
      <div className="card-body bg-light">
        <div className="bid-score-wrapper">
          <div className={`bid-score-circle ${variant} bg-white shadow-sm`}>
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
            <div className="bid-score-subtitle text-dark">
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
  const { noGoItems, highPriorityEscalations } = collectRiskFlags(complianceChecklist)

  if (noGoItems.length === 0 && highPriorityEscalations.length === 0) {
    return (
      <div className="card mb-4 shadow-sm border-success border-opacity-25">
        <div className="card-body py-3 bg-success bg-opacity-10 rounded">
          <span className="text-success fw-semibold">
            ✅ No critical issues found. All financial thresholds are within acceptable range.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="card mb-4 shadow-sm border-0">
      <div className="card-header bg-transparent border-bottom">
        <h5 className="mb-0 fw-bold text-danger">🚨 Risk Flag Summary</h5>
      </div>
      <div className="card-body">

        {noGoItems.length > 0 && (
          <div className="mb-3">
            <p className="fw-bold text-danger mb-3 border-bottom pb-2">
              🚫 Critical Issues — NO-GO ({noGoItems.length})
            </p>
            {noGoItems.map((item, index) => (
              <div className="risk-item bg-light p-3 rounded mb-2 border border-danger border-opacity-25" key={index}>
                <span className="risk-dept-badge bg-danger">
                  {item.dept.charAt(0).toUpperCase() + item.dept.slice(1)}
                </span>
                <div>
                  <span className="fw-bold text-dark">{item.task}</span>
                  {item.reason && (
                    <div className="mt-1">
                      <span className="text-muted">{item.reason}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {highPriorityEscalations.length > 0 && (
          <div className="mt-4">
            <p className="fw-bold text-warning mb-3 border-bottom pb-2">
              ⚠️ High Priority Escalations ({highPriorityEscalations.length})
            </p>
            {highPriorityEscalations.map((item, index) => (
              <div className="risk-item bg-light p-3 rounded mb-2 border border-warning border-opacity-25" key={index}>
                <span className="risk-dept-badge bg-warning text-dark">
                  {item.dept.charAt(0).toUpperCase() + item.dept.slice(1)}
                </span>
                <div>
                  <span className="fw-bold text-dark">{item.task}</span>
                  {item.reason && (
                    <div className="mt-1">
                      <span className="text-muted">{item.reason}</span>
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
    <div className="card mb-4 shadow-sm border-0">
      <div className="card-header bg-transparent border-bottom">
        <h5 className="mb-0 fw-bold text-secondary">📋 RFP Summary</h5>
      </div>
      <div className="card-body bg-light rounded-bottom">
        <div className="row g-3">
          {fields.map((field, index) => (
            field.value && field.value !== 'null' && (
              <div className="col-md-4 col-sm-6" key={index}>
                <div className="p-3 bg-white border rounded h-100 shadow-sm">
                  <span className="text-muted small text-uppercase fw-bold" style={{ letterSpacing: '0.5px' }}>
                    {field.label}
                  </span>
                  <p className="mb-0 fw-semibold text-dark mt-1">{field.value}</p>
                </div>
              </div>
            )
          ))}
        </div>
      </div>
    </div>
  )
}

// Smart Parsing Deliverable Component
function DeliverableItem({ text, indexStr }) {
  const [isOpen, setIsOpen] = useState(false)
  const colonIndex = text.indexOf(':')

  // If no colon is found, render it as a standard item
  if (colonIndex === -1) {
    return (
      <li className="list-group-item py-3 px-4 d-flex align-items-start border-0 border-bottom">
        <span className="text-primary fw-bold me-3 mt-1" style={{ fontSize: '0.85rem' }}>
          {indexStr}
        </span>
        <span className="text-secondary" style={{ lineHeight: '1.6' }}>
          {text}
        </span>
      </li>
    )
  }

  // Split at the colon to create a title and description
  const title = text.slice(0, colonIndex).trim()
  const description = text.slice(colonIndex + 1).trim()

  return (
    <li className="list-group-item py-3 px-4 d-flex align-items-start border-0 border-bottom">
      <span className="text-primary fw-bold me-3 mt-1" style={{ fontSize: '0.85rem' }}>
        {indexStr}
      </span>
      <div className="flex-grow-1">
        <div className="d-flex justify-content-between align-items-center">
          <span className="fw-bold text-dark">{title}</span>
          <button 
            className="btn btn-sm btn-link text-decoration-none text-secondary p-0 ms-3 text-nowrap"
            onClick={() => setIsOpen(!isOpen)}
            style={{ fontSize: '0.8rem' }}
          >
            {isOpen ? '▲ Hide Details' : '⌄ View Details'}
          </button>
        </div>
        {isOpen && (
          <div className="mt-2 text-secondary" style={{ lineHeight: '1.6', fontSize: '0.9rem' }}>
            {description}
          </div>
        )}
      </div>
    </li>
  )
}

// Collapsible Evidence Component
function EvidenceToggle({ text }) {
  const [isOpen, setIsOpen] = useState(false)

  if (!text || text === 'Not specified in RFP') {
    return <span className="text-muted fst-italic">{text}</span>
  }

  return (
    <div>
      <button 
        className="btn btn-sm btn-light border text-secondary fw-semibold d-flex align-items-center gap-2 mb-2"
        onClick={() => setIsOpen(!isOpen)}
        style={{ fontSize: '0.8rem' }}
      >
        {isOpen ? '▲ Hide Evidence' : '📄 View Evidence'}
      </button>
      
      {isOpen && (
        <div className="p-3 bg-light border rounded text-secondary shadow-sm" style={{ fontSize: '0.85rem', lineHeight: '1.6', maxHeight: '250px', overflowY: 'auto' }}>
          {text}
        </div>
      )}
    </div>
  )
}

function DepartmentChecklist({ items }) {
  if (!items || items.length === 0) {
    return <p className="text-muted p-4 text-center">No items found.</p>
  }

  const goCount = items.filter(i => i.status === 'GO').length
  const noGoCount = items.filter(i => i.status === 'NO-GO').length
  const escalateCount = items.filter(i => i.status === 'ESCALATE').length

  return (
    <div>
      <div className="d-flex gap-4 mb-3 px-4 pt-4 pb-2 border-bottom">
        <span className="badge bg-success bg-opacity-10 text-success border border-success border-opacity-25 px-3 py-2 fs-6">
          ✅ GO: {goCount}
        </span>
        <span className="badge bg-danger bg-opacity-10 text-danger border border-danger border-opacity-25 px-3 py-2 fs-6">
          🚫 NO-GO: {noGoCount}
        </span>
        <span className="badge bg-warning bg-opacity-10 text-dark border border-warning border-opacity-50 px-3 py-2 fs-6">
          ⚠️ ESCALATE: {escalateCount}
        </span>
      </div>
      
      <div className="table-responsive px-3 pb-3">
        <table className="table table-hover align-middle mb-0 border">
          <thead className="table-light text-secondary">
            <tr>
              <th className="py-3 px-3" style={{ width: '22%' }}>Checklist Item</th>
              <th className="py-3 px-3 text-center" style={{ width: '13%' }}>Decision</th>
              <th className="py-3 px-3" style={{ width: '25%' }}>Reason</th>
              {/* Enforced minimum width to prevent horizontal squeezing */}
              <th className="py-3 px-3" style={{ width: '40%', minWidth: '300px' }}>Evidence from RFP</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={index}>
                <td className="fw-bold text-dark px-3 py-3">{item.task}</td>
                <td className="text-center px-3 py-3">
                  <span className={`badge bg-${statusColors[item.status] || 'secondary'} px-2 py-2 w-100`}>
                    {statusIcons[item.status]} {item.status}
                  </span>
                </td>
                <td className="px-3 py-3">
                  <span className="text-muted" style={{ lineHeight: '1.5', display: 'block' }}>
                    {item.reason}
                  </span>
                </td>
                <td className="px-3 py-3">
                  <EvidenceToggle text={item.evidence} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// §4.5 — the Traceability Matrix card.
//
// Reads through the anon client rather than an API route: RLS already scopes
// requirements and requirement_links to the owning user, so the browser query
// returns this session's rows and nothing else. That is the same pattern
// dashboard.js uses to read rfps and analyses.
//
// The shredder is not part of the analyze flow, so a freshly analyzed RFP has
// no requirements until /api/shredder/run is called for it. TraceabilityMatrix
// renders that as its empty state; this card just reports the load.
function TraceabilityCard({ rfpId }) {
  const [rows, setRows] = useState([])
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  // Bumped after a shred run so the effect below re-reads the newly written
  // requirements and links.
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    // No state reset here: the render below already refuses to show the matrix
    // without an rfpId, so stale rows are unreachable rather than merely
    // cleared, and clearing them synchronously would cascade a render.
    if (!rfpId) {
      return
    }

    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)

      const { data: requirements, error: requirementsError } = await supabase
        .from('requirements')
        .select(
          'id, req_number, requirement_text, page, section, role, department, ' +
            'confidence, needs_review, classification_error'
        )
        .eq('rfp_id', rfpId)

      if (cancelled) return

      if (requirementsError) {
        setError(requirementsError.message)
        setLoading(false)

        return
      }

      const requirementRows = requirements || []

      // requirement_links carries no rfp_id, so this RFP's requirement ids are
      // the filter. Skipped entirely when there are no requirements — an
      // .in() on an empty list is a query with no possible result.
      const { data: links, error: linksError } = requirementRows.length
        ? await supabase
            .from('requirement_links')
            .select('id, requirement_id, linked_requirement_id, relationship_note')
            .in(
              'requirement_id',
              requirementRows.map((row) => row.id)
            )
        : { data: [], error: null }

      if (cancelled) return

      if (linksError) {
        setError(linksError.message)
        setLoading(false)

        return
      }

      const sequence = (value) => Number(/(\d+)\s*$/.exec(value || '')?.[1] || 0)

      setRows(
        joinRequirementLinks(requirementRows, links || []).sort(
          (a, b) => sequence(a.req_number) - sequence(b.req_number)
        )
      )
      setLoading(false)
    }

    load()

    return () => {
      cancelled = true
    }
  }, [rfpId, reloadKey])

  return (
    <div className="card shadow-sm mb-5 border-0">
      <div className="card-header bg-dark text-white border-0 py-3 d-flex justify-content-between align-items-center">
        <h5 className="mb-0 fw-bold">🔗 Traceability Matrix</h5>
        {rfpId && (
          <a
            href={`/traceability?rfp_id=${rfpId}`}
            className="btn btn-sm btn-outline-light"
          >
            Open full view ↗
          </a>
        )}
      </div>
      <div className="card-body p-0 bg-white border border-top-0 rounded-bottom">
        {!rfpId ? (
          <div className="text-center py-5 text-muted">
            This analysis has not been saved to an RFP record yet, so there are
            no shredded requirements to trace.
          </div>
        ) : loading ? (
          <div className="text-center py-5 text-muted">
            <span className="spinner-border spinner-border-sm me-2" role="status" />
            Loading requirements…
          </div>
        ) : (
          <TraceabilityMatrix
            rows={rows}
            error={error}
            rfpId={rfpId}
            onShredded={() => setReloadKey((key) => key + 1)}
          />
        )}
      </div>
    </div>
  )
}

export default function ResultsPanel({ data, rfpId, onExportPDF, onExportExcel }) {
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
          className="btn btn-outline-danger fw-semibold shadow-sm"
          onClick={onExportPDF}
        >
          📄 Export PDF
        </button>
        <button
          className="btn btn-outline-success fw-semibold shadow-sm"
          onClick={onExportExcel}
        >
          📊 Export Excel
        </button>
        <button
          className="btn btn-outline-primary fw-semibold shadow-sm"
          onClick={() => downloadJsonExport(data)}
        >
          🗂️ Export JSON
        </button>
      </div>

      <BidScoreCard complianceChecklist={data.complianceChecklist} />
      <RiskFlagSummary complianceChecklist={data.complianceChecklist} />
      {/* Contract Risk (§5.4) — sits next to the Risk Flag Summary because the
          two answer adjacent questions: that one is the AI compliance verdict,
          this one is what pattern-matching found in the contract terms. */}
      <ContractRiskCard rfpId={rfpId} />
      {/* Company Fit (§6.4) — follows Contract Risk because it answers the
          next question in the same sequence: that card says what the contract
          asks of any bidder, this one says what it asks of THIS company. */}
      <CompanyFitCard rfpId={rfpId} />
      <SummaryCard summary={data.summary} />

      {/* RE-STYLED Deliverables */}
      <div className="card mb-4 shadow-sm border-0">
        <div className="card-header bg-transparent border-bottom">
          <h5 className="mb-0 fw-bold text-primary">📦 Project Deliverables</h5>
        </div>
        <div className="card-body bg-light p-4 rounded-bottom">
          {data.deliverables && data.deliverables.length > 0 ? (
            <div className="row g-4">
              {data.deliverables.map((group, gIndex) => (
                <div key={gIndex} className="col-12">
                  <div className="card border shadow-sm h-100">
                    <div className="card-header bg-white border-bottom py-3">
                      <h6 className="fw-bold text-dark mb-0 d-flex align-items-center">
                        <span className="badge bg-primary me-2 rounded-pill">{gIndex + 1}</span> 
                        {group.parent}
                      </h6>
                    </div>
                    {group.children && group.children.length > 0 && (
                      <ul className="list-group list-group-flush">
                        {group.children.map((child, cIndex) => (
                          <DeliverableItem 
                            key={cIndex} 
                            text={child} 
                            indexStr={`${gIndex + 1}.${cIndex + 1}`} 
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-muted border rounded bg-white">
              <span className="fs-3 d-block mb-2">📭</span>
              No deliverables found in this document.
            </div>
          )}
        </div>
      </div>

      {/* RE-STYLED Evaluation Criteria */}
      <div className="card mb-4 shadow-sm border-0">
        <div className="card-header bg-transparent border-bottom">
          <h5 className="mb-0 fw-bold text-info">📊 Evaluation Criteria</h5>
        </div>
        <div className="card-body bg-white p-0">
          {data.evaluationCriteria && data.evaluationCriteria.length > 0 ? (
            <ul className="list-group list-group-flush">
              {data.evaluationCriteria.map((item, index) => (
                <li key={index} className="list-group-item py-3 px-4 text-secondary d-flex align-items-center">
                  <span className="badge bg-info text-dark rounded-circle me-3 py-2 px-2">{index + 1}</span>
                  <span className="fw-semibold">{item}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-center py-5 text-muted">
              No explicit evaluation criteria found.
            </div>
          )}
        </div>
      </div>

      {/* Compliance Checklist Table */}
      <div className="card shadow-sm mb-5 border-0">
        <div className="card-header bg-dark text-white border-0 py-3">
          <h5 className="mb-0 fw-bold">✅ Department Compliance Checklist</h5>
        </div>
        <div className="card-body p-0 bg-white border border-top-0 rounded-bottom"> 
          {/* Tabs */}
          <div className="px-3 pt-3 bg-light border-bottom">
            <ul className="nav nav-tabs border-bottom-0">
              {departments.map((dept) => (
                <li className="nav-item" key={dept.key}>
                  <button
                    className={`nav-link border-0 ${activeTab === dept.key ? 'active fw-bold text-dark border-bottom border-dark border-3' : 'text-muted'}`}
                    onClick={() => setActiveTab(dept.key)}
                    style={{ backgroundColor: 'transparent', borderRadius: '0' }}
                  >
                    {dept.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          
          {/* Table Content */}
          <div className="pt-2">
            <DepartmentChecklist
              items={data.complianceChecklist?.[activeTab]}
            />
          </div>
        </div>
      </div>

      {/* Traceability Matrix (§4.5) */}
      <TraceabilityCard rfpId={rfpId} />

    </div>
  )
}