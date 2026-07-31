import { useState } from 'react'

// §6.1 — the company profile editor.
//
// This is the only place the fit module's answers come from. §6.2 compares
// requirement text against these certificates and these two numbers, and §6.3
// judges every requirement against these lists — so an empty field here is not
// a cosmetic gap, it is a check that silently cannot run. The form says so
// next to each field rather than leaving that to be discovered.
//
// Every list column is jsonb, and the reader (judgeFit's describeList) renders
// whatever shape it finds. The shapes below are therefore a convenience, not a
// contract: a profile seeded by hand with different keys still works.

const LIST_FIELDS = [
  {
    key: 'certificates',
    label: 'Certifications',
    help: 'Used by the §6.2 blocker check. A certification an RFP names and this list does not hold is a hard no-bid.',
    addLabel: 'Add certification',
    columns: [
      { key: 'name', label: 'Certification', placeholder: 'ISO 9001:2015', width: 7 },
      { key: 'expires', label: 'Expires', type: 'date', width: 5 },
    ],
  },
  {
    key: 'registrations',
    label: 'Registrations',
    help: 'Procurement systems and identifiers you are registered in. Read by the AI fit judgment as evidence.',
    addLabel: 'Add registration',
    columns: [
      { key: 'name', label: 'Registration', placeholder: 'SAM.gov', width: 6 },
      { key: 'identifier', label: 'ID / number', placeholder: 'CAGE 1AB2C', width: 6 },
    ],
  },
  {
    key: 'staff',
    label: 'Staff',
    help: 'Who you can actually put on the work. Thin detail here produces more "gap" verdicts, which is the correct answer.',
    addLabel: 'Add staff group',
    columns: [
      { key: 'role', label: 'Role', placeholder: 'Drupal developer', width: 4 },
      { key: 'count', label: 'Headcount', type: 'number', width: 2 },
      { key: 'notes', label: 'Skills / notes', placeholder: 'Acquia certified, US-Eastern', width: 6 },
    ],
  },
  {
    key: 'geography',
    label: 'Geographies served',
    help: 'States or regions you can staff and support.',
    addLabel: 'Add geography',
    // A plain string list rather than objects — there is only one thing to say.
    simple: true,
    placeholder: 'Virginia',
  },
  {
    key: 'past_projects',
    label: 'Past projects',
    help: 'Relevant past performance. The strongest evidence the AI judgment has for a "can do" verdict.',
    addLabel: 'Add past project',
    columns: [
      { key: 'name', label: 'Project', placeholder: 'University CMS replatform', width: 4 },
      { key: 'client', label: 'Client', placeholder: 'Old Dominion University', width: 3 },
      { key: 'value', label: 'Value', placeholder: '$1.2M', width: 2 },
      { key: 'year', label: 'Year', placeholder: '2024', width: 3 },
      { key: 'summary', label: 'What you delivered', placeholder: 'Migrated 40k pages, WCAG 2.1 AA', width: 12 },
    ],
  },
]

/**
 * Normalizes a stored list into the shape the editor renders.
 *
 * Tolerant on purpose: a string where an object is expected becomes that
 * object's first column, so a hand-seeded profile opens in the form instead of
 * blanking the user's data.
 *
 * @param {unknown} value
 * @param {object} field
 * @returns {Array}
 */
function toRows(value, field) {
  const list = Array.isArray(value) ? value : []

  if (field.simple) {
    return list.map((entry) =>
      typeof entry === 'string' ? entry : String(entry?.name || entry?.value || '')
    )
  }

  return list.map((entry) => {
    if (typeof entry === 'string') {
      return { [field.columns[0].key]: entry }
    }

    return entry && typeof entry === 'object' ? { ...entry } : {}
  })
}

/**
 * Builds the initial form state from a stored profile row.
 *
 * @param {object|null} profile
 * @returns {object}
 */
function toFormState(profile) {
  const state = {
    insurance_limit:
      profile?.insurance_limit === null || profile?.insurance_limit === undefined
        ? ''
        : String(profile.insurance_limit),
    bonding_capacity:
      profile?.bonding_capacity === null || profile?.bonding_capacity === undefined
        ? ''
        : String(profile.bonding_capacity),
  }

  for (const field of LIST_FIELDS) {
    state[field.key] = toRows(profile?.[field.key], field)
  }

  return state
}

/**
 * A repeatable list of plain strings.
 */
function SimpleList({ field, rows, onChange }) {
  return (
    <>
      {rows.map((row, index) => (
        <div className="d-flex gap-2 mb-2" key={index}>
          <input
            className="form-control"
            value={row}
            placeholder={field.placeholder}
            onChange={(event) => {
              const next = [...rows]
              next[index] = event.target.value
              onChange(next)
            }}
          />
          <button
            type="button"
            className="btn btn-outline-secondary"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
            aria-label={`Remove ${field.label} row ${index + 1}`}
          >
            ✕
          </button>
        </div>
      ))}
    </>
  )
}

/**
 * A repeatable list of multi-column objects.
 */
function ObjectList({ field, rows, onChange }) {
  return (
    <>
      {rows.map((row, index) => (
        <div className="border rounded p-3 mb-2 bg-white" key={index}>
          <div className="row g-2">
            {field.columns.map((column) => (
              <div className={`col-md-${column.width || 6}`} key={column.key}>
                <label className="form-label text-muted small mb-1">
                  {column.label}
                </label>
                <input
                  className="form-control form-control-sm"
                  type={column.type || 'text'}
                  value={row[column.key] ?? ''}
                  placeholder={column.placeholder || ''}
                  onChange={(event) => {
                    const next = [...rows]
                    next[index] = { ...next[index], [column.key]: event.target.value }
                    onChange(next)
                  }}
                />
              </div>
            ))}
          </div>

          <div className="text-end mt-2">
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              ✕ Remove
            </button>
          </div>
        </div>
      ))}
    </>
  )
}

export default function CompanyProfileForm({ profile, onSaved }) {
  const [form, setForm] = useState(() => toFormState(profile))
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState(null)

  function setList(key, rows) {
    setForm((previous) => ({ ...previous, [key]: rows }))
  }

  function addRow(field) {
    setList(field.key, [...form[field.key], field.simple ? '' : {}])
  }

  async function handleSubmit(event) {
    event.preventDefault()

    setSaving(true)
    setNotice(null)

    try {
      const response = await fetch('/api/company-profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      })

      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        setNotice({
          tone: 'danger',
          text: payload.error || 'The profile could not be saved.',
        })

        return
      }

      setNotice({
        tone: 'success',
        text: payload.created
          ? 'Company profile created. Fit checks can now run.'
          : 'Company profile saved.',
      })

      // Re-seed from what the server actually stored, so blank rows the API
      // dropped disappear from the form too rather than reappearing on save.
      setForm(toFormState(payload.profile))
      onSaved?.(payload.profile)
    } catch (err) {
      setNotice({
        tone: 'danger',
        text: err?.message || 'Could not reach the server.',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {notice && (
        <div className={`alert alert-${notice.tone}`}>{notice.text}</div>
      )}

      <div className="card shadow-sm border-0 mb-4">
        <div className="card-header bg-transparent border-bottom">
          <h5 className="mb-0 fw-bold text-primary">💰 Financial capacity</h5>
        </div>
        <div className="card-body bg-light">
          <div className="row g-3">
            <div className="col-md-6">
              <label className="form-label fw-semibold">Insurance limit (USD)</label>
              <input
                className="form-control"
                type="number"
                min="0"
                step="any"
                value={form.insurance_limit}
                placeholder="5000000"
                onChange={(event) =>
                  setForm((previous) => ({
                    ...previous,
                    insurance_limit: event.target.value,
                  }))
                }
              />
              <div className="form-text">
                Leave blank if you do not want the insurance blocker check to
                run. Blank means <em>not checked</em>, not zero.
              </div>
            </div>

            <div className="col-md-6">
              <label className="form-label fw-semibold">Bonding capacity (USD)</label>
              <input
                className="form-control"
                type="number"
                min="0"
                step="any"
                value={form.bonding_capacity}
                placeholder="2000000"
                onChange={(event) =>
                  setForm((previous) => ({
                    ...previous,
                    bonding_capacity: event.target.value,
                  }))
                }
              />
              <div className="form-text">
                Same rule: blank skips the bonding check entirely.
              </div>
            </div>
          </div>
        </div>
      </div>

      {LIST_FIELDS.map((field) => (
        <div className="card shadow-sm border-0 mb-4" key={field.key}>
          <div className="card-header bg-transparent border-bottom d-flex justify-content-between align-items-center flex-wrap gap-2">
            <h5 className="mb-0 fw-bold text-dark">{field.label}</h5>
            <span className="badge bg-light text-dark border">
              {form[field.key].length}
            </span>
          </div>
          <div className="card-body bg-light">
            <p className="text-muted small">{field.help}</p>

            {form[field.key].length === 0 && (
              <p className="text-muted fst-italic small mb-3">
                Nothing listed yet.
              </p>
            )}

            {field.simple ? (
              <SimpleList
                field={field}
                rows={form[field.key]}
                onChange={(rows) => setList(field.key, rows)}
              />
            ) : (
              <ObjectList
                field={field}
                rows={form[field.key]}
                onChange={(rows) => setList(field.key, rows)}
              />
            )}

            <button
              type="button"
              className="btn btn-sm btn-outline-primary fw-semibold"
              onClick={() => addRow(field)}
            >
              + {field.addLabel}
            </button>
          </div>
        </div>
      ))}

      <div className="d-flex gap-2 align-items-center mb-5">
        <button
          type="submit"
          className="btn btn-primary fw-semibold shadow-sm"
          disabled={saving}
        >
          {saving ? (
            <>
              <span className="spinner-border spinner-border-sm me-2" role="status" />
              Saving…
            </>
          ) : (
            '💾 Save company profile'
          )}
        </button>

        <span className="text-muted small">
          Saving costs nothing and makes no AI call.
        </span>
      </div>
    </form>
  )
}
