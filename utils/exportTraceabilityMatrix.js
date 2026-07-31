// utils/exportTraceabilityMatrix.js
//
// §4.5 — Excel export for the Traceability Matrix.
//
// Follows the module shape of exportToJson.js: a pure builder that never
// throws and never mutates its input, plus a thin download wrapper. The
// spreadsheet itself is built with the SheetJS idiom already used by
// ResultsPanel's exportToExcel — dynamic import('xlsx'), aoa_to_sheet, !cols
// widths, book_append_sheet, writeFile — rather than a second one.
//
// This file does not read the database or the analysis result. It takes the
// same already-joined rows the matrix table renders, so what exports is
// exactly what was on screen, filters included.

const MATRIX_HEADERS = [
  'REQ ID',
  'Role',
  'Department',
  'Confidence',
  'Needs Review',
  'Page',
  'Section',
  'Linked Requirements',
  'Relationship',
  'Requirement Text',
]

const ROLE_LABELS = {
  work_requirement: 'Work requirement',
  submission_instruction: 'Submission instruction',
  evaluation_factor: 'Evaluation factor',
  not_applicable: 'Not a contractor requirement',
}

const KIND_LABELS = {
  sub_item_of: 'Sub-item of',
  submitted_under: 'Submitted under',
  scored_by: 'Scored by',
}

// Column widths, in the order MATRIX_HEADERS declares.
const MATRIX_COLUMN_WIDTHS = [12, 24, 16, 12, 14, 8, 34, 24, 46, 70]

/**
 * Splits a relationship_note into its machine-readable kind and the prose
 * after it. linkRequirements writes "kind: detail"; anything without that
 * prefix is treated as all detail, since the column is free text and may
 * hold links written before the convention existed.
 *
 * @param {string} note
 * @returns {{kind: string|null, detail: string}}
 */
export function parseRelationshipNote(note) {
  const text = String(note || '').trim()
  const separator = text.indexOf(':')

  if (separator === -1) {
    return { kind: null, detail: text }
  }

  const kind = text.slice(0, separator).trim()

  if (!KIND_LABELS[kind]) {
    return { kind: null, detail: text }
  }

  return { kind, detail: text.slice(separator + 1).trim() }
}

/**
 * @param {string} kind
 * @returns {string}
 */
export function relationshipLabel(kind) {
  return KIND_LABELS[kind] || 'Related to'
}

/**
 * @param {string} role
 * @returns {string}
 */
export function roleLabel(role) {
  return ROLE_LABELS[role] || (role ? String(role) : 'Unclassified')
}

/**
 * One requirement's links rendered as two parallel cells: the REQ numbers it
 * points at, and the human-readable relationships behind them.
 *
 * @param {Array<object>} links
 * @returns {{numbers: string, relationships: string}}
 */
function describeLinks(links) {
  const list = Array.isArray(links) ? links : []

  if (list.length === 0) {
    return { numbers: '', relationships: '' }
  }

  const numbers = list.map((link) => link?.req_number || '').filter(Boolean)

  const relationships = list.map((link) => {
    const { kind, detail } = parseRelationshipNote(link?.relationship_note)

    return `${relationshipLabel(kind)} ${link?.req_number || '?'}${
      detail ? ` — ${detail}` : ''
    }`
  })

  return {
    numbers: numbers.join(', '),
    // Newlines inside a cell: Excel shows them once wrap text is on, and they
    // keep several relationships readable without a second sheet.
    relationships: relationships.join('\n'),
  }
}

/**
 * Builds the matrix worksheet as an array of arrays.
 *
 * Pure: returns a brand-new array, never mutates `rows`, never throws. An
 * unusable input degrades to a header-only sheet rather than an exception,
 * matching how buildJsonExport handles the same situation.
 *
 * @param {Array<object>} rows Requirements, each optionally carrying `links`.
 * @returns {Array<Array<string|number>>}
 */
export function buildMatrixSheetData(rows) {
  try {
    const list = Array.isArray(rows) ? rows : []

    return [
      [...MATRIX_HEADERS],
      ...list.map((row) => {
        const source = row && typeof row === 'object' ? row : {}
        const { numbers, relationships } = describeLinks(source.links)

        const confidence = Number(source.confidence)

        return [
          String(source.req_number || ''),
          roleLabel(source.role),
          String(source.department || ''),
          // A number, not a string, so the column sorts and filters as one in
          // Excel. Null confidence stays blank rather than becoming 0 — those
          // are not the same claim.
          Number.isFinite(confidence) ? confidence : '',
          source.needs_review ? 'YES' : '',
          Number.isFinite(Number(source.page)) ? Number(source.page) : '',
          String(source.section || ''),
          numbers,
          relationships,
          String(source.requirement_text || ''),
        ]
      }),
    ]
  } catch {
    return [[...MATRIX_HEADERS]]
  }
}

/**
 * A short "what is in this file" sheet, so an exported matrix is readable
 * without the app next to it.
 *
 * @param {Array<object>} rows The rows actually exported (post-filter).
 * @param {object} [filters] The filter state that produced them.
 * @returns {Array<Array<string|number>>}
 */
export function buildMatrixSummaryData(rows, filters = {}) {
  const list = Array.isArray(rows) ? rows : []

  const linked = list.filter(
    (row) => Array.isArray(row?.links) && row.links.length > 0
  ).length

  const flagged = list.filter((row) => row?.needs_review).length

  return [
    ['Field', 'Value'],
    ['Export', 'BidLens Traceability Matrix'],
    ['Generated', new Date().toISOString()],
    ['Role filter', filters.role && filters.role !== 'all' ? roleLabel(filters.role) : 'All roles'],
    ['Department filter', filters.department && filters.department !== 'all' ? filters.department : 'All departments'],
    ['Requirements exported', list.length],
    ['With at least one link', linked],
    ['Flagged for review', flagged],
  ]
}

/**
 * Builds the workbook and triggers a browser download.
 *
 * Mirrors ResultsPanel's exportToExcel: xlsx is imported dynamically so the
 * library stays out of the initial bundle and only loads when someone
 * actually exports.
 *
 * @param {Array<object>} rows Requirements with their links, already filtered.
 * @param {object} [options]
 * @param {object} [options.filters] Filter state, recorded on the Summary sheet.
 * @param {string} [options.filename='BidLens_Traceability_Matrix.xlsx']
 * @returns {Promise<void>}
 */
export function downloadTraceabilityMatrix(rows, options = {}) {
  const filters = options.filters || {}
  const filename = options.filename || 'BidLens_Traceability_Matrix.xlsx'

  return import('xlsx').then((XLSX) => {
    const workbook = XLSX.utils.book_new()

    const summarySheet = XLSX.utils.aoa_to_sheet(
      buildMatrixSummaryData(rows, filters)
    )
    summarySheet['!cols'] = [{ wch: 25 }, { wch: 50 }]
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary')

    const matrixData = buildMatrixSheetData(rows)
    const matrixSheet = XLSX.utils.aoa_to_sheet(matrixData)
    matrixSheet['!cols'] = MATRIX_COLUMN_WIDTHS.map((wch) => ({ wch }))
    // Autofilter on the header row, so the role/department filtering the tab
    // offers survives into the spreadsheet instead of being baked away by it.
    matrixSheet['!autofilter'] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: {
          r: Math.max(0, matrixData.length - 1),
          c: MATRIX_HEADERS.length - 1,
        },
      }),
    }
    XLSX.utils.book_append_sheet(workbook, matrixSheet, 'Traceability Matrix')

    XLSX.writeFile(workbook, filename)
  })
}
