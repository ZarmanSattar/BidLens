import { useMemo, useState } from 'react'
import {
  downloadTraceabilityMatrix,
  parseRelationshipNote,
  relationshipLabel,
  roleLabel,
} from '../utils/exportTraceabilityMatrix'
import ShredRfpButton from './ShredRfpButton'

// §4.5 — the Traceability Matrix table.
//
// Presentational only: it is handed rows that already carry their links, so
// the same component serves the standalone /traceability page (rows fetched
// server-side) and the card inside ResultsPanel (rows fetched client-side).
// Nothing here touches Supabase.

const ALL = 'all'

// Below this a classification is shown as low-confidence even when the row was
// not flagged. Mirrors the threshold classifyRequirements uses to set
// needs_review, so the two never disagree on screen.
const LOW_CONFIDENCE = 0.7

const ROLE_BADGE = {
  work_requirement: 'bg-primary',
  submission_instruction: 'bg-info text-dark',
  evaluation_factor: 'bg-warning text-dark',
  not_applicable: 'bg-secondary',
}

const KIND_BADGE = {
  sub_item_of: 'bg-secondary',
  submitted_under: 'bg-info text-dark',
  scored_by: 'bg-warning text-dark',
}

/**
 * Joins requirements to their outgoing links, resolving each link's target id
 * to that requirement's REQ number.
 *
 * Links whose target is not in `requirements` are dropped rather than shown as
 * a dangling id — that can only happen if the two were read at different
 * times, and a REQ number nobody can look up is worse than no row.
 *
 * @param {Array<object>} requirements
 * @param {Array<object>} links
 * @returns {Array<object>} requirements, each with a `links` array.
 */
export function joinRequirementLinks(requirements, links) {
  const rows = Array.isArray(requirements) ? requirements : []
  const byId = new Map(rows.map((row) => [row.id, row]))

  const grouped = new Map()

  for (const link of Array.isArray(links) ? links : []) {
    const target = byId.get(link?.linked_requirement_id)

    if (!target || !byId.has(link?.requirement_id)) {
      continue
    }

    const list = grouped.get(link.requirement_id) || []

    list.push({
      id: link.id,
      req_number: target.req_number,
      role: target.role,
      relationship_note: link.relationship_note,
    })

    grouped.set(link.requirement_id, list)
  }

  return rows.map((row) => ({ ...row, links: grouped.get(row.id) || [] }))
}

function LinkedCell({ links }) {
  if (!links || links.length === 0) {
    return <span className="text-muted">—</span>
  }

  return (
    <div className="d-flex flex-column gap-1">
      {links.map((link) => {
        const { kind, detail } = parseRelationshipNote(link.relationship_note)

        return (
          <div key={link.id} style={{ fontSize: '0.8rem' }}>
            <span
              className={`badge ${KIND_BADGE[kind] || 'bg-light text-dark border'} me-1`}
            >
              {relationshipLabel(kind)}
            </span>
            <span className="fw-semibold text-dark">{link.req_number}</span>
            {detail && (
              <div className="text-muted mt-1" style={{ lineHeight: '1.4' }}>
                {detail}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Offers a retry when — and only when — some rows failed to classify.
 *
 * Costs tokens, so it never fires on its own. Scoped to the failed rows by the
 * route itself, which selects on classification_error and updates in place, so
 * pressing this cannot disturb a requirement that already classified.
 */
function RetryFailedBanner({ rows, rfpId, onComplete }) {
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState(null)

  const failed = (rows || []).filter((row) => row?.classification_error)

  if (failed.length === 0 || !rfpId) {
    return null
  }

  async function retry() {
    setRunning(true)
    setNotice(null)

    try {
      const response = await fetch('/api/shredder/reclassify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rfp_id: rfpId }),
      })

      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        setNotice({ tone: 'warning', text: payload.error || 'The retry failed.' })

        return
      }

      setNotice({
        tone: payload.recovered > 0 ? 'success' : 'warning',
        text: payload.message,
      })

      if (payload.recovered > 0 && typeof onComplete === 'function') {
        onComplete()
      }
    } catch (error) {
      setNotice({ tone: 'warning', text: error?.message || 'Could not reach the retry.' })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="alert alert-warning m-3 mb-0">
      <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
        <div>
          <strong>
            {failed.length} requirement{failed.length === 1 ? '' : 's'} could not be
            classified.
          </strong>
          <div className="small mt-1">
            The extracted text for {failed.length === 1 ? 'it' : 'them'} is intact —
            only the classification step failed, usually because the AI provider
            was rate-limited mid-run. Retrying re-attempts just these rows and
            leaves every classified requirement untouched.
          </div>
        </div>
        <button
          className="btn btn-sm btn-warning fw-semibold text-nowrap"
          onClick={retry}
          disabled={running}
        >
          {running ? (
            <>
              <span className="spinner-border spinner-border-sm me-2" role="status" />
              Retrying…
            </>
          ) : (
            `↻ Retry ${failed.length} failed row${failed.length === 1 ? '' : 's'}`
          )}
        </button>
      </div>

      {notice && (
        <div className={`alert alert-${notice.tone} py-2 mt-3 mb-0 small`}>
          {notice.text}
        </div>
      )}
    </div>
  )
}

function RequirementRow({ row }) {
  const [expanded, setExpanded] = useState(false)
  const [showError, setShowError] = useState(false)

  const confidence = Number(row.confidence)
  const hasConfidence = Number.isFinite(confidence)
  const isLow = hasConfidence && confidence < LOW_CONFIDENCE

  // Two different reasons a row is worth a second look, and they are not the
  // same thing: needs_review may be set on a row whose confidence is fine
  // (a missing department does it), and classification_error means the model
  // never saw the row at all.
  const flagged = row.needs_review || isLow || Boolean(row.classification_error)

  const text = String(row.requirement_text || '')
  const isLong = text.length > 160

  return (
    <tr className={flagged ? 'table-warning' : undefined}>
      <td className="px-3 py-3 text-nowrap align-top">
        <span className="fw-bold text-dark">{row.req_number}</span>
        {flagged && (
          <div className="mt-1">
            <span className="badge bg-warning text-dark" style={{ fontSize: '0.7rem' }}>
              ⚠️ Review
            </span>
          </div>
        )}
        {/* The provider's error is a few hundred characters of JSON. Printed
            in full it swamped this cell and read as though it had REPLACED the
            requirement — it never did: requirement_text still holds the
            extracted candidate, and always did. What a reader needs here is
            the state ("this one was never classified"), with the raw text
            available on demand for whoever is debugging it. */}
        {row.classification_error && (
          <div className="mt-1">
            <span
              className="badge bg-danger"
              style={{ fontSize: '0.68rem' }}
              title={row.classification_error}
            >
              ⚠ Not classified
            </span>
            <div
              className="text-danger mt-1"
              style={{ fontSize: '0.68rem', lineHeight: '1.3' }}
            >
              Classification failed — needs retry
            </div>
            <button
              className="btn btn-sm btn-link text-decoration-none p-0 mt-1 text-secondary"
              style={{ fontSize: '0.68rem' }}
              onClick={() => setShowError(!showError)}
            >
              {showError ? '▲ Hide error' : '⌄ Show error'}
            </button>
            {showError && (
              <div
                className="text-muted mt-1 p-2 bg-light border rounded"
                style={{
                  fontSize: '0.65rem',
                  lineHeight: '1.3',
                  maxHeight: 120,
                  overflowY: 'auto',
                  wordBreak: 'break-word',
                }}
              >
                {row.classification_error}
              </div>
            )}
          </div>
        )}
      </td>

      <td className="px-3 py-3 align-top">
        <span className={`badge ${ROLE_BADGE[row.role] || 'bg-light text-dark border'}`}>
          {roleLabel(row.role)}
        </span>
      </td>

      <td className="px-3 py-3 align-top text-secondary">
        {row.department || <span className="text-muted fst-italic">Unassigned</span>}
      </td>

      <td className="px-3 py-3 align-top text-center">
        {hasConfidence ? (
          <span className={isLow ? 'fw-bold text-danger' : 'text-secondary'}>
            {confidence.toFixed(2)}
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>

      <td className="px-3 py-3 align-top">
        <LinkedCell links={row.links} />
      </td>

      <td className="px-3 py-3 align-top">
        <div className="text-secondary" style={{ lineHeight: '1.5', fontSize: '0.85rem' }}>
          {expanded || !isLong ? text : `${text.slice(0, 160)}…`}
        </div>
        {isLong && (
          <button
            className="btn btn-sm btn-link text-decoration-none p-0 mt-1"
            onClick={() => setExpanded(!expanded)}
            style={{ fontSize: '0.75rem' }}
          >
            {expanded ? '▲ Less' : '⌄ More'}
          </button>
        )}
        <div className="text-muted mt-1" style={{ fontSize: '0.72rem' }}>
          {row.section || 'No section'}
          {row.page ? ` · p.${row.page}` : ''}
        </div>
      </td>
    </tr>
  )
}

// `rfpId` and `onShredded` are optional and used only by the empty state: with
// them it can offer a one-click shred, without them it stays presentational.
export default function TraceabilityMatrix({ rows, error, rfpId, onShredded }) {
  const [role, setRole] = useState(ALL)
  const [department, setDepartment] = useState(ALL)
  const [flaggedOnly, setFlaggedOnly] = useState(false)

  const all = useMemo(() => (Array.isArray(rows) ? rows : []), [rows])

  // Filter options come from the data, not a hardcoded list. The ODU set
  // already contains a department ("Human Resources") outside the five the
  // classifier prompt names, so a fixed list would hide rows silently.
  const roleOptions = useMemo(
    () => [...new Set(all.map((row) => row.role).filter(Boolean))].sort(),
    [all]
  )

  const departmentOptions = useMemo(
    () => [...new Set(all.map((row) => row.department).filter(Boolean))].sort(),
    [all]
  )

  const filtered = useMemo(
    () =>
      all.filter((row) => {
        if (role !== ALL && row.role !== role) return false
        if (department !== ALL && row.department !== department) return false

        if (flaggedOnly) {
          const confidence = Number(row.confidence)
          const isLow = Number.isFinite(confidence) && confidence < LOW_CONFIDENCE

          if (!row.needs_review && !isLow && !row.classification_error) {
            return false
          }
        }

        return true
      }),
    [all, role, department, flaggedOnly]
  )

  const linkedCount = useMemo(
    () => filtered.filter((row) => row.links && row.links.length > 0).length,
    [filtered]
  )

  if (error) {
    return (
      <div className="alert alert-danger mb-0">
        Could not load the traceability matrix: {error}
      </div>
    )
  }

  // The shred trigger lives ONLY here, in the empty state. /api/shredder/run
  // appends a new set of REQ numbers on every call, so an RFP that already has
  // requirements must never be offered a one-click re-run — it would silently
  // produce a duplicate set. Without an rfpId the button renders nothing and
  // this stays the plain message it always was.
  if (all.length === 0) {
    return <ShredRfpButton rfpId={rfpId} onComplete={onShredded} />
  }

  return (
    <div>
      {/* A partially-failed shred used to be a dead end: the shred button only
          renders on an EMPTY rfp (re-running it would append a duplicate REQ
          set), so there was no way back. This retries the failed rows only —
          in place, no new rows, no renumbering. */}
      <RetryFailedBanner rows={all} rfpId={rfpId} onComplete={onShredded} />

      {/* Filters + export */}
      <div className="d-flex flex-wrap gap-3 align-items-end px-3 pt-3 pb-3 bg-light border-bottom">
        <div>
          <label className="form-label small text-muted fw-semibold mb-1">Role</label>
          <select
            className="form-select form-select-sm"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            <option value={ALL}>All roles</option>
            {roleOptions.map((value) => (
              <option key={value} value={value}>
                {roleLabel(value)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="form-label small text-muted fw-semibold mb-1">
            Department
          </label>
          <select
            className="form-select form-select-sm"
            value={department}
            onChange={(event) => setDepartment(event.target.value)}
          >
            <option value={ALL}>All departments</option>
            {departmentOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <div className="form-check mb-2">
          <input
            className="form-check-input"
            type="checkbox"
            id="traceability-flagged-only"
            checked={flaggedOnly}
            onChange={(event) => setFlaggedOnly(event.target.checked)}
          />
          <label className="form-check-label small" htmlFor="traceability-flagged-only">
            Needs review only
          </label>
        </div>

        <div className="ms-auto d-flex align-items-center gap-3 mb-2">
          <span className="text-muted small">
            {filtered.length} of {all.length} requirements · {linkedCount} linked
          </span>
          <button
            className="btn btn-sm btn-outline-success fw-semibold"
            onClick={() =>
              downloadTraceabilityMatrix(filtered, {
                filters: { role, department },
              })
            }
            disabled={filtered.length === 0}
          >
            📊 Export Excel
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-5 text-muted">
          No requirements match these filters.
        </div>
      ) : (
        <div className="table-responsive px-3 pb-3 pt-3">
          <table className="table table-hover align-middle mb-0 border">
            <thead className="table-light text-secondary">
              <tr>
                <th className="py-3 px-3" style={{ width: '9%' }}>REQ ID</th>
                <th className="py-3 px-3" style={{ width: '13%' }}>Role</th>
                <th className="py-3 px-3" style={{ width: '10%' }}>Department</th>
                <th className="py-3 px-3 text-center" style={{ width: '8%' }}>
                  Confidence
                </th>
                <th className="py-3 px-3" style={{ width: '25%', minWidth: '220px' }}>
                  Linked Requirements
                </th>
                <th className="py-3 px-3" style={{ width: '35%', minWidth: '280px' }}>
                  Requirement
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <RequirementRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
