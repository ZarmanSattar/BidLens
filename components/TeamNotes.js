import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase/client'

// B4 — team notes on any checklist item or requirement.
//
// ZERO TOKEN COST. Plain rows, no AI anywhere near this.
//
// Written through the browser's own Supabase client rather than an API route,
// matching how rfps and analyses are already inserted: the session is the
// author, and RLS is what enforces ownership. Routing this through
// supabaseAdmin would mean trusting a client-supplied author id, which is
// exactly what the anon key plus a policy avoids.
//
// REQUIRES A MIGRATION THAT IS NOT APPLIED YET. Until public.item_notes
// exists, every query here fails with PostgREST 42P01 ("relation does not
// exist"), which is caught and shown as a quiet one-line notice rather than an
// error — a missing table is a deployment state, not a fault the reader caused.

/**
 * Codes meaning "that table isn't there".
 *
 * PGRST205 is the one that actually fires: Supabase answers an unknown table
 * from its schema cache ("Could not find the table 'public.item_notes' in the
 * schema cache") long before Postgres would raise 42P01. Verified against the
 * live project — assuming the Postgres code alone left this path dead, and the
 * card showed a raw error instead of the notice below. 42P01 is kept for the
 * direct-connection case.
 */
const MISSING_TABLE_CODES = new Set(['PGRST205', '42P01'])

function isMissingTable(error) {
  return (
    MISSING_TABLE_CODES.has(error?.code) ||
    /(could not find the table|relation).*item_notes/i.test(error?.message || '')
  )
}

function timeAgo(iso) {
  const then = new Date(iso).getTime()

  if (!Number.isFinite(then)) return ''

  const mins = Math.round((Date.now() - then) / 60000)

  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`

  return new Date(iso).toLocaleDateString()
}

/**
 * @param {object} props
 * @param {string} props.rfpId
 * @param {'checklist'|'requirement'} props.targetKind
 * @param {string} props.targetKey Task name, or a requirements row id.
 * @param {string} [props.label] What the note is about, shown in the header.
 */
export default function TeamNotes({ rfpId, targetKind, targetKey, label }) {
  const [notes, setNotes] = useState([])
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [unavailable, setUnavailable] = useState(false)
  const [session, setSession] = useState(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data?.session || null))
  }, [])

  useEffect(() => {
    if (!rfpId || !targetKey) return

    let cancelled = false

    async function load() {
      const { data, error: readError } = await supabase
        .from('item_notes')
        .select('id, body, author_email, created_at')
        .eq('rfp_id', rfpId)
        .eq('target_kind', targetKind)
        .eq('target_key', targetKey)
        .order('created_at', { ascending: true })

      if (cancelled) return

      if (readError) {
        if (isMissingTable(readError)) setUnavailable(true)
        else setError(readError.message)

        return
      }

      setNotes(data || [])
    }

    load()

    return () => {
      cancelled = true
    }
  }, [rfpId, targetKind, targetKey])

  async function add() {
    const body = draft.trim()

    if (!body || saving) return

    if (!session?.user) {
      setError('Sign in to leave a note.')

      return
    }

    setSaving(true)
    setError(null)

    const { data, error: writeError } = await supabase
      .from('item_notes')
      .insert({
        rfp_id: rfpId,
        target_kind: targetKind,
        target_key: targetKey,
        body,
        author_id: session.user.id,
        // Denormalized so a note still says who wrote it without a join to
        // auth.users, which the anon key cannot read.
        author_email: session.user.email || null,
      })
      .select('id, body, author_email, created_at')
      .single()

    setSaving(false)

    if (writeError) {
      if (isMissingTable(writeError)) setUnavailable(true)
      else setError(writeError.message)

      return
    }

    setNotes((previous) => [...previous, data])
    setDraft('')
  }

  async function remove(id) {
    const { error: deleteError } = await supabase.from('item_notes').delete().eq('id', id)

    if (deleteError) {
      setError(deleteError.message)

      return
    }

    setNotes((previous) => previous.filter((note) => note.id !== id))
  }

  if (unavailable) {
    return (
      <div className="text-muted" style={{ fontSize: '0.72rem' }}>
        Notes are not enabled yet (the item_notes table has not been created).
      </div>
    )
  }

  if (!rfpId) return null

  return (
    <div className="mt-2">
      <button
        className="btn btn-sm btn-light border text-secondary fw-semibold"
        style={{ fontSize: '0.72rem' }}
        onClick={() => setOpen(!open)}
      >
        {open ? '▲ Hide notes' : `🗒️ Notes${notes.length > 0 ? ` (${notes.length})` : ''}`}
      </button>

      {open && (
        <div className="mt-2 p-2 bg-white border rounded">
          {label && (
            <div className="text-muted text-uppercase fw-bold mb-2" style={{ fontSize: '0.64rem' }}>
              {label}
            </div>
          )}

          {notes.length === 0 && (
            <div className="text-muted mb-2" style={{ fontSize: '0.78rem' }}>
              No notes yet.
            </div>
          )}

          {notes.map((note) => (
            <div key={note.id} className="border-bottom pb-2 mb-2" style={{ fontSize: '0.82rem' }}>
              <div className="d-flex justify-content-between align-items-start gap-2">
                <div className="text-dark" style={{ whiteSpace: 'pre-wrap' }}>
                  {note.body}
                </div>
                {session?.user?.email === note.author_email && (
                  <button
                    className="btn btn-sm btn-link text-danger p-0"
                    style={{ fontSize: '0.7rem' }}
                    onClick={() => remove(note.id)}
                  >
                    delete
                  </button>
                )}
              </div>
              <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                {note.author_email || 'unknown'} · {timeAgo(note.created_at)}
              </div>
            </div>
          ))}

          {error && (
            <div className="alert alert-warning py-1 px-2 mb-2" style={{ fontSize: '0.76rem' }}>
              {error}
            </div>
          )}

          <div className="d-flex gap-2">
            <input
              className="form-control form-control-sm"
              placeholder="Add a note for the team…"
              value={draft}
              maxLength={2000}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  add()
                }
              }}
            />
            <button
              className="btn btn-sm btn-primary fw-semibold"
              onClick={add}
              disabled={saving || !draft.trim()}
            >
              {saving ? '…' : 'Add'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
