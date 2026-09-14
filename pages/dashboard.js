import { useState, useEffect } from 'react'
import Link from 'next/link'
import ResultsPanel from '../components/ResultsPanel'
import { supabase } from '../lib/supabase/client'
import { PLACEHOLDER_OWNER_ID } from '../lib/placeholderOwner'
import { formatDate } from '../utils/formatDate'
import { getDaysRemaining } from '../utils/deadline'

// ── PDF evidence rendering ────────────────────────────────
//
// Evidence is sliced out of the raw extracted document text, so a quote that
// spans a page break swallows the source PDF's own page furniture along with
// it — "...in the past five (5) years, Page 10 of 21 comparable to Old
// Dominion University in size..." is a real string in a stored ODU analysis.
//
// This strips it at render time only. The artifact is in the STORED evidence,
// which means the on-screen Evidence column shows it too; fixing that belongs
// upstream in the extraction, not here. Stripping downstream is safe on its
// own terms — a genuine requirement never reads "Page 10 of 21" — so the
// filter runs regardless of where the text originated.
const PAGE_FURNITURE = /\[?\(?\s*\bpages?\s+\d+\s*(?:of|\/)\s*\d+\s*\)?\]?/gi

// Long enough to carry the quote that justifies a decision, short enough that
// one row does not eat a landscape page. Cells above this are cut at a
// sentence boundary; the full text stays in the Excel and JSON exports.
const EVIDENCE_MAX_CHARS = 650

// Below this, evidence is a placeholder or a fragment ("Not specified in RFP"
// is 20 chars and repeats constantly). Collapsing those into a back-reference
// would be less readable than just repeating them.
const EVIDENCE_DEDUPE_MIN_CHARS = 60

function stripPageFurniture(value) {
  return String(value || '')
    .replace(PAGE_FURNITURE, ' ')
    // Removal leaves a double space, and can strand a space before the
    // punctuation that followed the footer.
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim()
}

/**
 * Cuts `text` to at most `limit` characters, preferring the last sentence
 * boundary inside the budget so a cell never ends mid-word or mid-clause.
 *
 * Falls back to the last word boundary when the first sentence alone already
 * overruns the budget — some RFP paragraphs run 400 characters without a full
 * stop, and a word break still beats a character break.
 *
 * The ellipsis is appended only when something was actually removed.
 *
 * @param {string} value
 * @param {number} [limit]
 * @returns {string}
 */
function truncateAtSentence(value, limit = EVIDENCE_MAX_CHARS) {
  const text = String(value || '').trim()

  if (text.length <= limit) return text

  const window = text.slice(0, limit)

  let cut = -1
  const boundary = /[.!?]["'’)\]]?(?=\s|$)/g
  let match

  while ((match = boundary.exec(window)) !== null) {
    cut = match.index + match[0].length
  }

  // Require the sentence break to keep a useful share of the budget, otherwise
  // a stray "No. 3" early in the text would truncate the cell to nothing.
  if (cut > limit * 0.4) {
    return `${text.slice(0, cut).trim()} ...`
  }

  const space = window.lastIndexOf(' ')

  return `${(space > 0 ? window.slice(0, space) : window).trim()} ...`
}

/**
 * Builds the body rows for one department's compliance table.
 *
 * The same evidence quote is genuinely stored against several checklist rows —
 * in the demo_rfp analyses, operations/"Document Compliance" and
 * operations/"Vendor Registration" hold byte-identical strings. Printing it
 * twice at full length wastes half a page and reads like two findings where
 * there is one, so repeats within a table become a back-reference.
 *
 * @param {Array<object>} items
 * @returns {Array<Array<string>>}
 */
function buildComplianceRows(items) {
  const seen = new Map()

  return items.map((item) => {
    const cleaned = stripPageFurniture(item.evidence)

    let evidence = cleaned

    if (cleaned.length >= EVIDENCE_DEDUPE_MIN_CHARS && seen.has(cleaned)) {
      evidence = `(same evidence as "${seen.get(cleaned)}" above)`
    } else {
      if (cleaned.length >= EVIDENCE_DEDUPE_MIN_CHARS) seen.set(cleaned, item.task)
      evidence = truncateAtSentence(cleaned)
    }

    return [item.task, item.status, item.reason || '', evidence]
  })
}

// Readable text on each fill rather than the badge colours the screen uses —
// white-on-amber is unreadable in print and survives photocopying worse.
const DECISION_CELL_STYLES = {
  'GO': { fillColor: [209, 231, 221], textColor: [11, 74, 45] },
  'ESCALATE': { fillColor: [255, 243, 205], textColor: [102, 77, 3] },
  'NO-GO': { fillColor: [248, 215, 218], textColor: [132, 32, 41] },
}

function colorDecisionCell(hook) {
  if (hook.section !== 'body' || hook.column.index !== 1) return

  const style = DECISION_CELL_STYLES[String(hook.cell.raw || '').trim().toUpperCase()]

  if (!style) return

  hook.cell.styles.fillColor = style.fillColor
  hook.cell.styles.textColor = style.textColor
  hook.cell.styles.fontStyle = 'bold'
}

/**
 * The four numbers the dashboard row already shows, repeated at the top of the
 * report so the first page answers "should we bid" without being read through.
 *
 * Reuses getCounts/getBidScore — the same functions that produce the on-screen
 * figures, so the PDF cannot disagree with the table it was exported from.
 *
 * @returns {number} The y coordinate to continue drawing at.
 */
function drawHeadlineStats(doc, results, pageWidth, top) {
  const counts = getCounts(results.complianceChecklist)
  const score = getBidScore(results.complianceChecklist)
  const total = counts.go + counts.noGo + counts.escalate

  const scoreColor = score >= 80 ? [25, 135, 84] : score >= 60 ? [133, 100, 4] : [220, 53, 69]

  const tiles = [
    { label: 'Requirements reviewed', value: String(total), color: [13, 110, 253] },
    { label: 'NO-GO items', value: String(counts.noGo), color: [220, 53, 69] },
    { label: 'Escalations', value: String(counts.escalate), color: [133, 100, 4] },
    { label: 'Bid score', value: `${score} / 100`, color: scoreColor },
  ]

  const margin = 14
  const gap = 5
  const width = (pageWidth - margin * 2 - gap * (tiles.length - 1)) / tiles.length
  const height = 20

  tiles.forEach((tile, index) => {
    const x = margin + index * (width + gap)

    doc.setFillColor(248, 249, 250)
    doc.setDrawColor(222, 226, 230)
    doc.roundedRect(x, top, width, height, 2, 2, 'FD')

    // A colour bar rather than a coloured fill: the number stays legible and
    // the tile still reads at a glance.
    doc.setFillColor(...tile.color)
    doc.rect(x, top, 2, height, 'F')

    doc.setFontSize(14)
    doc.setTextColor(...tile.color)
    doc.text(tile.value, x + 7, top + 10)

    doc.setFontSize(8)
    doc.setTextColor(108, 117, 125)
    doc.text(tile.label, x + 7, top + 16)
  })

  return top + height
}

function exportToPDF(results) {
  import('jspdf').then(({ default: jsPDF }) => {
    import('jspdf-autotable').then(({ default: autoTable }) => {
      const doc = new jsPDF('landscape')
      const pageWidth = doc.internal.pageSize.getWidth()
      doc.setFontSize(20)
      doc.setTextColor(13, 110, 253)
      doc.text('BidLens — RFP Analysis Report', pageWidth / 2, 18, { align: 'center' })

      const afterStats = drawHeadlineStats(doc, results, pageWidth, 24)

      if (results.summary) {
        doc.setFontSize(13)
        doc.setTextColor(33, 37, 41)
        doc.text('RFP Summary', 14, afterStats + 10)
        autoTable(doc, {
          startY: afterStats + 14,
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

      const deliverableRows = []
      if (results.deliverables && results.deliverables.length > 0) {
        results.deliverables.forEach((group, gIndex) => {
          deliverableRows.push([`${gIndex + 1}`, group.parent])
          if (group.children && group.children.length > 0) {
            group.children.forEach((child, cIndex) => {
              deliverableRows.push([`${gIndex + 1}.${cIndex + 1}`, child])
            })
          }
        })
      }

      const afterSummary = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : afterStats + 14
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
        body: (results.evaluationCriteria || []).map((item, i) => [i + 1, item]),
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
        const items = results.complianceChecklist?.[dept.key] || []
        if (items.length === 0) continue
        const startY = doc.lastAutoTable.finalY + 8
        doc.setFontSize(13)
        doc.setTextColor(33, 37, 41)
        doc.text(`Compliance — ${dept.label}`, 14, startY)
        autoTable(doc, {
          startY: startY + 4,
          head: [['Checklist Item', 'Decision', 'Reason', 'Evidence from RFP']],
          body: buildComplianceRows(items),
          theme: 'grid',
          headStyles: { fillColor: dept.color },
          styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak', valign: 'top' },
          // 46/24/78/118 = 266mm of the 269mm a landscape page leaves between
          // the default margins. Evidence keeps the widest column now that it
          // is capped, but Reason gets 78 rather than being matched 100/100
          // against untruncated evidence — that pairing is what wrapped a
          // two-line reason next to a forty-line quote.
          columnStyles: {
            0: { cellWidth: 46 },
            1: { cellWidth: 24, halign: 'center' },
            2: { cellWidth: 78 },
            3: { cellWidth: 118 },
          },
          didParseCell: colorDecisionCell,
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

    const deliverableData = [['Level', 'Deliverable']]
    if (results.deliverables && results.deliverables.length > 0) {
      results.deliverables.forEach((group, gIndex) => {
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
      ...(results.evaluationCriteria || []).map((item, i) => [i + 1, item])
    ]
    const criteriaSheet = XLSX.utils.aoa_to_sheet(criteriaData)
    criteriaSheet['!cols'] = [{ wch: 5 }, { wch: 80 }]
    XLSX.utils.book_append_sheet(workbook, criteriaSheet, 'Evaluation Criteria')

    for (const dept of ['financial', 'legal', 'operations', 'technical']) {
      const items = results.complianceChecklist?.[dept] || []
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

// parseDeadline / getDaysRemaining moved to utils/deadline.js when A2's
// headline strip and A4's alert check needed the same parsing. Imported at the
// top of this file — behaviour is unchanged, there is just one copy now.

export default function Dashboard() {
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [dbError, setDbError] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [selectedIds, setSelectedIds] = useState([])

  useEffect(() => {
    async function loadHistory() {
      setHistoryLoading(true)
      const { data, error } = await supabase
        .from('analyses')
        .select(`
          id,
          created_at,
          result,
          rfps ( id, title, original_filename )
        `)
        .order('created_at', { ascending: false })

      if (error) {
        setDbError('Failed to load history: ' + error.message)
        setHistoryLoading(false)
        return
      }

      const mapped = (data || []).map(row => ({
        id: row.id,
        rfpId: row.rfps?.id,
        fileName: row.rfps?.original_filename || row.rfps?.title,
        analyzedAt: row.created_at,
        ...row.result,
      }))
      setHistory(mapped)
      setHistoryLoading(false)
    }

    loadHistory()
  }, [])

  async function handleDelete(id) {
    const entry = history.find(e => e.id === id)
    if (!entry) return

    const { error } = await supabase.from('rfps').delete().eq('id', entry.rfpId)
    if (error) {
      setDbError('Failed to delete: ' + error.message)
      return
    }

    const updated = history.filter(e => e.id !== id)
    setHistory(updated)
    if (expandedId === id) setExpandedId(null)
    setSelectedIds(prev => prev.filter(sid => sid !== id))
  }

  function handleToggleExpand(id) {
    setExpandedId(prev => prev === id ? null : id)
  }

  async function handleClearAll() {
    if (confirm('Are you sure you want to clear all history?')) {
      const { error } = await supabase
        .from('rfps')
        .delete()
        .eq('owner_id', PLACEHOLDER_OWNER_ID)

      if (error) {
        setDbError('Failed to clear history: ' + error.message)
        return
      }

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
          <Link href="/" className="btn btn-primary btn-sm">
            🔍 New Analysis
          </Link>
          <Link href="/company-profile" className="btn btn-outline-light btn-sm">
            🏢 Company Profile
          </Link>
          <Link href="/content-library" className="btn btn-outline-light btn-sm">
            📚 Content Library
          </Link>
          <Link href="/amendments" className="btn btn-outline-light btn-sm">
            📑 Amendments
          </Link>
        </div>
      </nav>

      <div className="container py-5" style={{ maxWidth: '1100px' }}>

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

        {dbError && (
          <div className="alert alert-warning" role="alert">
            {dbError}
          </div>
        )}

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

        {historyLoading && (
          <div className="text-center py-5">
            <div className="spinner-border text-primary" role="status" />
            <p className="mt-3 text-muted">Loading history...</p>
          </div>
        )}

        {!historyLoading && history.length === 0 && (
          <div className="text-center py-5">
            <div style={{ fontSize: '3rem' }}>📭</div>
            <h5 className="mt-3 text-muted">No analyses yet</h5>
            <p className="text-muted">Upload and analyze an RFP to see it here.</p>
            <Link href="/" className="btn btn-primary">
              🔍 Start New Analysis
            </Link>
          </div>
        )}

        {!historyLoading && history.length > 0 && (
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
                    <th className="text-center">⚠️ ESCALATE</th>
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
                            {formatDate(entry.analyzedAt)}
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
                            <span className="text-warning fw-bold">{counts.escalate}</span>
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
                                  rfpId={entry.rfpId}
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
