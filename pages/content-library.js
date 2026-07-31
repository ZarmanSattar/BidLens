import Link from 'next/link'
import { useState } from 'react'
import { formatDateTime } from '../utils/formatDate'

// §8.1 — the content library settings page.
//
// Same shape as pages/company-profile.js: server-rendered through
// supabaseAdmin (content_library's RLS is company-wide, so the browser's anon
// client would be rejected), edited through a plain API route, no AI anywhere.
//
// The difference from the company profile is that this is a LIST rather than a
// singleton, so the editor is add/edit/delete per entry instead of one form.

const CATEGORIES = [
  {
    key: 'company_description',
    label: 'Company description',
    hint: 'Who you are, in the words you want a proposal to use.',
  },
  {
    key: 'past_project',
    label: 'Past project',
    hint: 'One project per entry. The strongest evidence a draft response can cite.',
  },
  {
    key: 'certificate',
    label: 'Certificate',
    hint: 'How you describe a credential in prose — not the profile field, the sentence about it.',
  },
  {
    key: 'staff_bio',
    label: 'Staff bio',
    hint: 'Named people you put forward in proposals.',
  },
  {
    key: 'standard_approach',
    label: 'Standard approach',
    hint: 'Reusable methodology: how you run discovery, migration, QA, support.',
  },
]

const CATEGORY_LABEL = Object.fromEntries(
  CATEGORIES.map((entry) => [entry.key, entry.label])
)

export async function getServerSideProps() {
  // Required lazily so a missing service-role key surfaces as a page message
  // rather than a build-time crash — same reason company-profile.js does it.
  const { supabaseAdmin } = require('../lib/supabase/admin')

  const { data, error } = await supabaseAdmin
    .from('content_library')
    .select('id, category, title, content, tags, created_at, updated_at')
    .order('category', { ascending: true })
    .order('title', { ascending: true })

  return {
    props: {
      initialEntries: error ? [] : data || [],
      loadError: error ? error.message : null,
    },
  }
}

const BLANK = { id: null, category: 'standard_approach', title: '', content: '', tags: '' }

export default function ContentLibraryPage({ initialEntries, loadError }) {
  const [entries, setEntries] = useState(initialEntries)
  const [draft, setDraft] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState(null)

  const editing = Boolean(draft.id)

  function startEdit(entry) {
    setDraft({
      id: entry.id,
      category: entry.category,
      title: entry.title,
      content: entry.content,
      tags: Array.isArray(entry.tags) ? entry.tags.join(', ') : '',
    })
    setNotice(null)

    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  async function refresh() {
    const response = await fetch('/api/content-library')
    const payload = await response.json().catch(() => ({}))

    if (response.ok) {
      setEntries(payload.entries || [])
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()

    setSaving(true)
    setNotice(null)

    try {
      const response = await fetch('/api/content-library', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      })

      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        setNotice({ tone: 'danger', text: payload.error || 'Could not save that entry.' })

        return
      }

      setNotice({
        tone: 'success',
        text: editing ? 'Entry updated.' : 'Entry added to the library.',
      })
      setDraft(BLANK)
      await refresh()
    } catch (err) {
      setNotice({ tone: 'danger', text: err?.message || 'Could not reach the server.' })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(entry) {
    setNotice(null)

    try {
      const response = await fetch(
        `/api/content-library?id=${encodeURIComponent(entry.id)}`,
        { method: 'DELETE' }
      )

      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        setNotice({ tone: 'danger', text: payload.error || 'Could not delete that entry.' })

        return
      }

      if (draft.id === entry.id) {
        setDraft(BLANK)
      }

      setNotice({ tone: 'success', text: `Removed “${entry.title}”.` })
      await refresh()
    } catch (err) {
      setNotice({ tone: 'danger', text: err?.message || 'Could not reach the server.' })
    }
  }

  const grouped = CATEGORIES.map((category) => ({
    ...category,
    items: entries.filter((entry) => entry.category === category.key),
  }))

  return (
    <>
      <nav className="navbar navbar-dark bg-dark px-4">
        <span className="navbar-brand fw-bold fs-4">
          Bid<span>Lens</span>
        </span>
        <div className="d-flex align-items-center gap-3">
          <Link href="/dashboard" className="btn btn-outline-light btn-sm">
            📊 Dashboard
          </Link>
          <Link href="/company-profile" className="btn btn-outline-light btn-sm">
            🏢 Company Profile
          </Link>
        </div>
      </nav>

      <div className="container py-4" style={{ maxWidth: 960 }}>
        <div className="mb-4">
          <h1 className="fw-bold h3 mb-1">📚 Content Library</h1>
          <p className="text-muted mb-0">
            Reusable text blocks that draft responses are built from. Nothing
            here is generated — this is your writing, stored so a proposal can
            reuse it instead of restating it.
          </p>
        </div>

        {loadError && (
          <div className="alert alert-danger">
            Could not load the library: {loadError}
          </div>
        )}

        {notice && <div className={`alert alert-${notice.tone}`}>{notice.text}</div>}

        {entries.length === 0 && !loadError && (
          <div className="alert alert-info">
            <strong>The library is empty.</strong>
            <div className="mt-2 small">
              Response drafting reads from here, so an empty library means a
              draft has nothing of yours to reuse. Add at least a company
              description and one past project.
            </div>
          </div>
        )}

        <div className="card shadow-sm border-0 mb-4">
          <div className="card-header bg-transparent border-bottom">
            <h5 className="mb-0 fw-bold text-primary">
              {editing ? 'Edit entry' : 'Add an entry'}
            </h5>
          </div>
          <div className="card-body bg-light">
            <form onSubmit={handleSubmit}>
              <div className="row g-3">
                <div className="col-md-4">
                  <label className="form-label fw-semibold">Category</label>
                  <select
                    className="form-select"
                    value={draft.category}
                    onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                  >
                    {CATEGORIES.map((category) => (
                      <option key={category.key} value={category.key}>
                        {category.label}
                      </option>
                    ))}
                  </select>
                  <div className="form-text">
                    {CATEGORIES.find((c) => c.key === draft.category)?.hint}
                  </div>
                </div>

                <div className="col-md-8">
                  <label className="form-label fw-semibold">Title</label>
                  <input
                    className="form-control"
                    value={draft.title}
                    placeholder="ODU CMS replatform — 40k pages migrated"
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    required
                  />
                </div>

                <div className="col-12">
                  <label className="form-label fw-semibold">Content</label>
                  <textarea
                    className="form-control"
                    rows={6}
                    value={draft.content}
                    placeholder="The paragraph as you would want it to appear in a proposal."
                    onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                    required
                  />
                </div>

                <div className="col-12">
                  <label className="form-label fw-semibold">Tags</label>
                  <input
                    className="form-control"
                    value={draft.tags}
                    placeholder="drupal, accessibility, higher-ed"
                    onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                  />
                  <div className="form-text">
                    Comma-separated. Used to narrow which entries a draft draws
                    on.
                  </div>
                </div>
              </div>

              <div className="d-flex gap-2 align-items-center mt-3">
                <button type="submit" className="btn btn-primary fw-semibold" disabled={saving}>
                  {saving ? (
                    <>
                      <span className="spinner-border spinner-border-sm me-2" role="status" />
                      Saving…
                    </>
                  ) : editing ? (
                    '💾 Save changes'
                  ) : (
                    '+ Add entry'
                  )}
                </button>

                {editing && (
                  <button
                    type="button"
                    className="btn btn-outline-secondary"
                    onClick={() => setDraft(BLANK)}
                  >
                    Cancel
                  </button>
                )}

                <span className="text-muted small">
                  Saving costs nothing and makes no AI call.
                </span>
              </div>
            </form>
          </div>
        </div>

        {grouped.map((category) => (
          <div className="card shadow-sm border-0 mb-4" key={category.key}>
            <div className="card-header bg-transparent border-bottom d-flex justify-content-between align-items-center">
              <h5 className="mb-0 fw-bold text-dark">{category.label}</h5>
              <span className="badge bg-light text-dark border">
                {category.items.length}
              </span>
            </div>
            <div className="card-body">
              {category.items.length === 0 ? (
                <p className="text-muted fst-italic small mb-0">Nothing here yet.</p>
              ) : (
                category.items.map((entry) => (
                  <div
                    key={entry.id}
                    className="bg-light p-3 rounded mb-2 border border-secondary border-opacity-25"
                  >
                    <div className="d-flex justify-content-between align-items-start gap-2 flex-wrap">
                      <div>
                        <span className="fw-bold text-dark">{entry.title}</span>
                        <div className="text-muted" style={{ fontSize: '0.75rem' }}>
                          {CATEGORY_LABEL[entry.category]} · updated{' '}
                          {formatDateTime(entry.updated_at)}
                        </div>
                      </div>
                      <div className="d-flex gap-2">
                        <button
                          className="btn btn-sm btn-outline-primary"
                          onClick={() => startEdit(entry)}
                        >
                          Edit
                        </button>
                        <button
                          className="btn btn-sm btn-outline-danger"
                          onClick={() => handleDelete(entry)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>

                    <div
                      className="mt-2 text-secondary"
                      style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}
                    >
                      {entry.content}
                    </div>

                    {Array.isArray(entry.tags) && entry.tags.length > 0 && (
                      <div className="mt-2 d-flex flex-wrap gap-1">
                        {entry.tags.map((tag) => (
                          <span
                            key={tag}
                            className="badge bg-white text-dark border"
                            style={{ fontSize: '0.7rem' }}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
