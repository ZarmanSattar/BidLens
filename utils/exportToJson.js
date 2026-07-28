// utils/exportToJson.js
//
// Phase 2 — "Export as JSON" feature.
//
// Pure transform + browser download for turning BidLens's internal analysis
// result (the shape returned by pages/api/analyze.js -> normalizeAnalysis)
// into the DIFFERENT target export schema requested for this feature.
//
// This file does not touch, import, or depend on the API, the Groq prompt, or
// any normalization logic. It only reads the already-normalized result object.

const DEPARTMENTS = ['financial', 'legal', 'operations', 'technical']

const DEPARTMENT_LABELS = {
  financial: 'Financial',
  legal: 'Legal',
  operations: 'Operations',
  technical: 'Technical',
}

const DEPARTMENT_EMPTY_MESSAGE =
  'No compliance items identified for this department.'

// Pick ONE representative reason string for a department's compliance summary,
// using the priority: NO-GO item -> High risk_level item -> first item.
function deriveComplianceSummary(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return DEPARTMENT_EMPTY_MESSAGE
  }

  const noGo = items.find((item) => item && item.status === 'NO-GO')

  if (noGo) {
    return String(noGo.reason || '')
  }

  const highRisk = items.find(
    (item) => item && item.risk_level === 'High'
  )

  if (highRisk) {
    return String(highRisk.reason || '')
  }

  return String(items[0]?.reason || '')
}

// Split a child deliverable string on the FIRST colon into name/reference.
function mapSubDeliverable(child) {
  const text = String(child || '')
  const colonIndex = text.indexOf(':')

  if (colonIndex === -1) {
    return {
      name: text.trim(),
      page_number: '',
      reference: '',
    }
  }

  return {
    name: text.slice(0, colonIndex).trim(),
    page_number: '',
    reference: text.slice(colonIndex + 1).trim(),
  }
}

function mapDeliverable(entry) {
  const children = Array.isArray(entry?.children) ? entry.children : []

  return {
    deliverable: String(entry?.parent || ''),
    page_number: '',
    reference: '',
    sub_deliverables: children.map(mapSubDeliverable),
  }
}

function mapChecklistItem(item) {
  const source = item && typeof item === 'object' ? item : {}

  return {
    item: String(source.task || ''),
    status: source.status ?? '',
    risk_level: source.risk_level ?? '',
    reasoning: String(source.reason || ''),
    rfp_evidence: String(source.evidence || ''),
    mitigation_strategy: source.mitigation_strategy ?? '',
    impact_on_bid_strategy: source.impact_on_bid_strategy ?? '',
  }
}

// Safe, fully-shaped object returned when the transform cannot run.
function buildEmptyExport() {
  const compliance = {}
  const strategicChecklist = { executive_summary: '' }

  for (const dept of DEPARTMENTS) {
    compliance[DEPARTMENT_LABELS[dept]] = DEPARTMENT_EMPTY_MESSAGE
    strategicChecklist[dept] = []
  }

  return {
    summary: '',
    compliance,
    deliverables: [],
    evaluation_criteria: [],
    go_nogo: { score: 0, verdict: '', summary: '', reasons: [] },
    key_requirements: [],
    risks: [],
    sections_analyzed: [],
    strategic_checklist: strategicChecklist,
    timeline: [],
  }
}

// Pure function: returns a brand-new object in the target export schema.
// Never mutates analysisResult; never throws.
export function buildJsonExport(analysisResult) {
  try {
    const src =
      analysisResult && typeof analysisResult === 'object'
        ? analysisResult
        : {}

    const checklist =
      src.complianceChecklist &&
      typeof src.complianceChecklist === 'object'
        ? src.complianceChecklist
        : {}

    const executiveSummary =
      typeof src.executive_summary === 'string'
        ? src.executive_summary
        : ''

    const compliance = {}
    for (const dept of DEPARTMENTS) {
      compliance[DEPARTMENT_LABELS[dept]] = deriveComplianceSummary(
        checklist[dept]
      )
    }

    const strategicChecklist = { executive_summary: executiveSummary }
    for (const dept of DEPARTMENTS) {
      const items = Array.isArray(checklist[dept]) ? checklist[dept] : []
      strategicChecklist[dept] = items.map(mapChecklistItem)
    }

    const deliverables = Array.isArray(src.deliverables)
      ? src.deliverables.map(mapDeliverable)
      : []

    // Key order below intentionally matches the target schema exactly.
    return {
      summary: executiveSummary,
      compliance,
      deliverables,
      evaluation_criteria: Array.isArray(src.evaluationCriteria)
        ? [...src.evaluationCriteria]
        : [],
      go_nogo:
        src.go_nogo && typeof src.go_nogo === 'object'
          ? src.go_nogo
          : { score: 0, verdict: '', summary: '', reasons: [] },
      key_requirements: Array.isArray(src.key_requirements)
        ? [...src.key_requirements]
        : [],
      risks: Array.isArray(src.risks) ? [...src.risks] : [],
      sections_analyzed: Array.isArray(src.sections_analyzed)
        ? [...src.sections_analyzed]
        : [],
      strategic_checklist: strategicChecklist,
      timeline: Array.isArray(src.timeline) ? [...src.timeline] : [],
    }
  } catch (err) {
    return buildEmptyExport()
  }
}

// Builds the export object, serializes it with 2-space indentation, and
// triggers a browser file download. Uses the browser-native Blob +
// createObjectURL + temporary anchor pattern (the same approach the
// jsPDF/XLSX exports perform internally), and mirrors the existing
// "BidLens_RFP_Analysis" filename convention with a .json extension.
export function downloadJsonExport(analysisResult) {
  const exportObject = buildJsonExport(analysisResult)
  const jsonString = JSON.stringify(exportObject, null, 2)

  const blob = new Blob([jsonString], { type: 'application/json' })
  const url = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.href = url
  link.download = 'BidLens_RFP_Analysis.json'

  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)

  URL.revokeObjectURL(url)
}
