// A3 — the one-click polished report.
//
// Extends the export that pages/index.js has always had rather than replacing
// it: the summary / deliverables / evaluation-criteria / compliance tables are
// the same tables, built the same way with the same jsPDF + autoTable the app
// already ships. What is added is what a report needs and an export did not —
// a cover page, an at-a-glance block, and dedicated Risk and Fit sections.
//
// Both libraries stay dynamically imported. They are ~400KB together and no
// page load should pay for them; the cost belongs to the click.
//
// Risks here are a plain status filter (NO-GO / ESCALATE) rather than the
// "high priority" subset the on-screen Risk Flag Summary shows. A report is
// read away from the app by someone who cannot expand a card, so it carries
// every flagged item rather than the shortlist.

const BRAND = [13, 110, 253]
const INK = [33, 37, 41]
const MUTED = [130, 137, 145]

const DEPARTMENTS = [
  { key: 'financial', label: 'Financial', color: [255, 193, 7] },
  { key: 'legal', label: 'Legal', color: [220, 53, 69] },
  { key: 'operations', label: 'Operations', color: [108, 117, 125] },
  { key: 'technical', label: 'Technical', color: [13, 110, 253] },
]

/**
 * Every checklist item carrying a flagged status, with its department.
 *
 * @param {object} checklist results.complianceChecklist
 * @returns {{noGo: object[], escalate: object[], total: number}}
 */
function collectFlagged(checklist) {
  const noGo = []
  const escalate = []

  let total = 0

  for (const dept of DEPARTMENTS) {
    for (const item of checklist?.[dept.key] || []) {
      total += 1

      if (item.status === 'NO-GO') noGo.push({ ...item, dept: dept.label })
      else if (item.status === 'ESCALATE') escalate.push({ ...item, dept: dept.label })
    }
  }

  return { noGo, escalate, total }
}

/**
 * Flattens the deliverables tree into numbered table rows.
 *
 * A deliverable is a GROUP — `{ parent: "Helpdesk Support Services", children:
 * ["Remote troubleshooting", ...] }` — not a string. Passing the group
 * straight into a table cell is what printed "[object Object]"; the export
 * this replaced had the same defect, so the PDF has never rendered these.
 *
 * Numbering matches the results page exactly: "1" for the group, "1.1", "1.2"
 * for its children, so a printed report and the screen can be read side by
 * side.
 *
 * Plain strings are still accepted — older analyses stored them that way, and
 * a report should not blow up on its own history.
 *
 * @param {Array<object|string>} deliverables
 * @returns {Array<[string, string]>}
 */
function flattenDeliverables(deliverables) {
  const rows = []

  ;(Array.isArray(deliverables) ? deliverables : []).forEach((group, index) => {
    if (typeof group === 'string') {
      rows.push([String(index + 1), group])

      return
    }

    if (!group || typeof group !== 'object') {
      return
    }

    const parent = String(group.parent || group.title || group.text || '').trim()

    if (parent) {
      rows.push([String(index + 1), parent])
    }

    const children = Array.isArray(group.children) ? group.children : []

    children.forEach((child, childIndex) => {
      const text =
        typeof child === 'string'
          ? child
          : String(child?.text || child?.title || '').trim()

      if (text) {
        rows.push([`${index + 1}.${childIndex + 1}`, text])
      }
    })
  })

  return rows
}

/**
 * Fit score for the report, read from the same zero-token route the Company
 * Fit card uses. Never throws — a report without a fit section is still a
 * report, and this must not be able to block the download.
 *
 * @param {string|null} rfpId
 * @returns {Promise<object|null>}
 */
async function loadFit(rfpId) {
  if (!rfpId) return null

  try {
    const response = await fetch('/api/fit/blockers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rfp_id: rfpId }),
    })

    if (!response.ok) return null

    const payload = await response.json()

    return {
      fit: payload.fit || null,
      blockers: payload.blockers || [],
      hasProfile: Boolean(payload.has_profile),
      requirementsTotal: payload.requirements_total || 0,
    }
  } catch {
    return null
  }
}

/**
 * Builds the report document and returns it WITHOUT saving.
 *
 * Split from the download so the layout can be exercised outside a browser —
 * `doc.save()` needs a DOM, everything above it does not. Tests build the doc
 * and inspect it; the app builds it and saves it.
 *
 * @param {object} results The analysis object (pages/api/analyze.js shape).
 * @param {object} [options]
 * @param {string} [options.rfpId] Enables the Fit & Gaps section.
 * @returns {Promise<{doc: object, filename: string}>}
 */
export async function buildReportDoc(results, options = {}) {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])

  const { describeDeadline } = await import('./deadline')

  const summary = results?.summary || {}
  const flagged = collectFlagged(results?.complianceChecklist)
  const fitData = await loadFit(options.rfpId)
  const deadline = describeDeadline(summary.submissionDeadline)

  const doc = new jsPDF()
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()

  // ── Cover ────────────────────────────────────────────────────────────────
  doc.setFillColor(...BRAND)
  doc.rect(0, 0, pageWidth, 52, 'F')

  doc.setTextColor(255, 255, 255)
  doc.setFontSize(26)
  doc.text('BidLens', 20, 26)
  doc.setFontSize(12)
  doc.text('RFP Analysis Report', 20, 37)

  doc.setTextColor(...INK)
  doc.setFontSize(18)

  const title = summary.projectTitle || results?.title || 'Untitled solicitation'
  const titleLines = doc.splitTextToSize(title, pageWidth - 40)

  doc.text(titleLines.slice(0, 3), 20, 76)

  doc.setFontSize(11)
  doc.setTextColor(...MUTED)

  let coverY = 76 + titleLines.slice(0, 3).length * 8 + 6

  for (const [label, value] of [
    ['Issuing agency', summary.issuingAgency],
    ['RFP number', summary.rfpNumber],
    ['Contract value', summary.contractValue],
  ]) {
    if (!value) continue
    doc.text(`${label}: ${value}`, 20, coverY)
    coverY += 7
  }

  // At-a-glance — the same four numbers the on-screen headline strip shows.
  autoTable(doc, {
    startY: Math.max(coverY + 8, 128),
    head: [['At a glance', '']],
    body: [
      ['Requirements reviewed', String(flagged.total)],
      ['No-go items', String(flagged.noGo.length)],
      ['Escalations', String(flagged.escalate.length)],
      [
        'Fit score',
        fitData?.fit && typeof fitData.fit.score === 'number'
          ? `${fitData.fit.score} — ${fitData.fit.verdict?.label || ''}`.trim()
          : 'Not assessed',
      ],
      [
        'Submission deadline',
        summary.submissionDeadline
          ? `${summary.submissionDeadline} (${deadline.label})`
          : 'Not stated in the document',
      ],
    ],
    theme: 'grid',
    headStyles: { fillColor: BRAND },
    styles: { fontSize: 10, cellPadding: 4 },
    columnStyles: { 0: { cellWidth: 70, fontStyle: 'bold' } },
    margin: { left: 20, right: 20 },
  })

  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  doc.text(
    `Generated ${new Date().toLocaleString()} · Automated analysis — verify against the source document before relying on it.`,
    20,
    pageHeight - 20,
    { maxWidth: pageWidth - 40 }
  )

  // ── Summary ──────────────────────────────────────────────────────────────
  doc.addPage()

  doc.setFontSize(14)
  doc.setTextColor(...INK)
  doc.text('1. Solicitation summary', 14, 20)

  autoTable(doc, {
    startY: 25,
    head: [['Field', 'Value']],
    body: [
      ['Issuing Agency', summary.issuingAgency || 'N/A'],
      ['Project Title', summary.projectTitle || 'N/A'],
      ['RFP Number', summary.rfpNumber || 'N/A'],
      ['Contract Value', summary.contractValue || 'N/A'],
      ['Submission Deadline', summary.submissionDeadline || 'N/A'],
      ['Project Duration', summary.projectDuration || 'N/A'],
    ],
    theme: 'grid',
    headStyles: { fillColor: [108, 117, 125] },
    styles: { fontSize: 9 },
  })

  // ── Risks ────────────────────────────────────────────────────────────────
  let y = doc.lastAutoTable.finalY + 10

  doc.setFontSize(14)
  doc.setTextColor(...INK)
  doc.text('2. Risks and blockers', 14, y)

  if (flagged.noGo.length === 0 && flagged.escalate.length === 0) {
    doc.setFontSize(10)
    doc.setTextColor(25, 135, 84)
    doc.text('No no-go items or escalations were flagged.', 14, y + 8)
    y += 14
  } else {
    autoTable(doc, {
      startY: y + 5,
      head: [['Severity', 'Dept', 'Item', 'Reason']],
      body: [
        ...flagged.noGo.map((item) => ['NO-GO', item.dept, item.task, item.reason || '']),
        ...flagged.escalate.map((item) => ['ESCALATE', item.dept, item.task, item.reason || '']),
      ],
      theme: 'grid',
      headStyles: { fillColor: [220, 53, 69] },
      styles: { fontSize: 8, cellPadding: 3 },
      columnStyles: {
        0: { cellWidth: 22, fontStyle: 'bold' },
        1: { cellWidth: 22 },
        2: { cellWidth: 60 },
      },
    })
    y = doc.lastAutoTable.finalY + 10
  }

  // ── Fit and gaps ─────────────────────────────────────────────────────────
  doc.setFontSize(14)
  doc.setTextColor(...INK)
  doc.text('3. Company fit and gaps', 14, y)

  if (!fitData) {
    doc.setFontSize(10)
    doc.setTextColor(...MUTED)
    doc.text(
      'Fit was not assessed for this report (analysis not saved, or the fit check was unavailable).',
      14,
      y + 8,
      { maxWidth: pageWidth - 28 }
    )
    y += 16
  } else if (!fitData.hasProfile) {
    doc.setFontSize(10)
    doc.setTextColor(...MUTED)
    doc.text(
      'No company profile has been filled in, so nothing could be checked against this solicitation.',
      14,
      y + 8,
      { maxWidth: pageWidth - 28 }
    )
    y += 16
  } else {
    autoTable(doc, {
      startY: y + 5,
      head: [['Measure', 'Value']],
      body: [
        [
          'Fit score',
          typeof fitData.fit?.score === 'number'
            ? `${fitData.fit.score} / 100`
            : 'Not scored',
        ],
        ['Verdict', fitData.fit?.verdict?.label || 'Not assessed'],
        ['Provisional', fitData.fit?.provisional ? 'Yes — not all requirements judged' : 'No'],
        ['Hard blockers', String(fitData.blockers.length)],
        ['Requirements considered', String(fitData.requirementsTotal)],
      ],
      theme: 'grid',
      headStyles: { fillColor: [25, 135, 84] },
      styles: { fontSize: 9 },
      columnStyles: { 0: { cellWidth: 60, fontStyle: 'bold' } },
    })

    if (fitData.blockers.length > 0) {
      autoTable(doc, {
        startY: doc.lastAutoTable.finalY + 4,
        head: [['Blocker', 'Why']],
        body: fitData.blockers
          .slice(0, 40)
          .map((blocker) => [
            blocker.requirementText || blocker.reqNumber || 'Requirement',
            blocker.reason || blocker.note || '',
          ]),
        theme: 'striped',
        headStyles: { fillColor: [220, 53, 69] },
        styles: { fontSize: 8, cellPadding: 3 },
        columnStyles: { 0: { cellWidth: 90 } },
      })
    }

    y = doc.lastAutoTable.finalY + 10
  }

  // ── Requirements ─────────────────────────────────────────────────────────
  doc.addPage()

  doc.setFontSize(14)
  doc.setTextColor(...INK)
  doc.text('4. Requirements by department', 14, 20)

  let started = false

  for (const dept of DEPARTMENTS) {
    const items = results?.complianceChecklist?.[dept.key] || []

    if (items.length === 0) continue

    const startY = started ? doc.lastAutoTable.finalY + 8 : 26

    doc.setFontSize(11)
    doc.setTextColor(...INK)
    doc.text(dept.label, 14, startY)

    autoTable(doc, {
      startY: startY + 4,
      head: [['Task', 'Status', 'Reason']],
      body: items.map((item) => [item.task, item.status, item.reason || '']),
      theme: 'grid',
      headStyles: { fillColor: dept.color },
      styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' },
      // Only the status column is pinned; Task and Reason share whatever is
      // left. Fixing all three (the 70/20/90 these tables were carried over
      // with) made autoTable report an overflow on every department, because
      // the declared widths were narrower than the longest unbreakable content.
      columnStyles: {
        1: { cellWidth: 22, halign: 'center' },
      },
      margin: { left: 14, right: 14 },
    })

    started = true
  }

  if (!started) {
    doc.setFontSize(10)
    doc.setTextColor(...MUTED)
    doc.text('No compliance checklist was produced for this analysis.', 14, 28)
  }

  // ── Deliverables and evaluation criteria ─────────────────────────────────
  const deliverables = results?.deliverables || []
  const criteria = results?.evaluationCriteria || []

  if (deliverables.length > 0 || criteria.length > 0) {
    doc.addPage()

    doc.setFontSize(14)
    doc.setTextColor(...INK)
    doc.text('5. Deliverables and evaluation criteria', 14, 20)

    if (deliverables.length > 0) {
      autoTable(doc, {
        startY: 26,
        head: [['#', 'Deliverable']],
        body: flattenDeliverables(deliverables),
        theme: 'striped',
        headStyles: { fillColor: BRAND },
        styles: { fontSize: 9, overflow: 'linebreak' },
        columnStyles: { 0: { cellWidth: 16 } },
      })
    }

    if (criteria.length > 0) {
      autoTable(doc, {
        startY: deliverables.length > 0 ? doc.lastAutoTable.finalY + 8 : 26,
        head: [['#', 'Evaluation criterion']],
        body: criteria.map((item, index) => [index + 1, item]),
        theme: 'striped',
        headStyles: { fillColor: [13, 202, 240] },
        styles: { fontSize: 9 },
        columnStyles: { 0: { cellWidth: 10 } },
      })
    }
  }

  // ── Footer on every page ─────────────────────────────────────────────────
  const pageCount = doc.internal.getNumberOfPages()

  for (let index = 1; index <= pageCount; index += 1) {
    doc.setPage(index)
    doc.setFontSize(8)
    doc.setTextColor(...MUTED)
    doc.text(
      `BidLens RFP Analysis Report — page ${index} of ${pageCount}`,
      pageWidth / 2,
      pageHeight - 8,
      { align: 'center' }
    )
  }

  const safeTitle = String(summary.projectTitle || 'rfp')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .toLowerCase()

  return {
    doc,
    filename: options.filename || `bidlens-report-${safeTitle || 'analysis'}.pdf`,
  }
}

/**
 * Builds the report and hands it to the browser as a download.
 *
 * @param {object} results
 * @param {object} [options] Passed through to buildReportDoc.
 * @returns {Promise<void>}
 */
export async function exportReportPdf(results, options = {}) {
  const { doc, filename } = await buildReportDoc(results, options)

  doc.save(filename)
}

export default exportReportPdf
