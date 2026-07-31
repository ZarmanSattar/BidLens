const { supabaseAdmin } = require('../../lib/supabase/admin')

// §8.1 — CRUD for the reusable content library.
//
//   GET    /api/content-library            -> {entries: [...]}
//   POST   /api/content-library            -> creates one entry
//   PUT    /api/content-library            -> updates one entry (body.id)
//   DELETE /api/content-library?id=...     -> deletes one entry
//
// Unlike company_profile, which is a singleton row, this is a LIST — so the
// route is per-entry rather than upsert-the-one-row.
//
// Writes go through supabaseAdmin for the same reason the company profile does:
// content_library's RLS is company-wide (auth.role() = 'authenticated') rather
// than owner-scoped, and the settings page is server-rendered.
//
// No AI anywhere in this file. Saving library content costs nothing.

/** Must match the CHECK constraint in the §8.1 migration. */
const CATEGORIES = [
  'company_description',
  'past_project',
  'certificate',
  'staff_bio',
  'standard_approach',
]

const SELECT_COLUMNS =
  'id, category, title, content, tags, created_at, updated_at'

/**
 * Validates and shapes a request body into a writable row.
 *
 * @param {object} body
 * @returns {{row: object|null, error: string|null}}
 */
function toRow(body) {
  const category = String(body.category || '').trim()

  if (!CATEGORIES.includes(category)) {
    return {
      row: null,
      error: `category must be one of: ${CATEGORIES.join(', ')}`,
    }
  }

  const title = String(body.title || '').trim()

  if (!title) {
    return { row: null, error: 'title is required' }
  }

  const content = String(body.content || '').trim()

  if (!content) {
    return { row: null, error: 'content is required' }
  }

  // Tags arrive either as an array or as a comma-separated string from the
  // form. Both are accepted; both are stored as a clean array.
  const rawTags = Array.isArray(body.tags)
    ? body.tags
    : String(body.tags || '').split(',')

  const tags = rawTags
    .map((tag) => String(tag).trim())
    .filter(Boolean)
    // Duplicates in a tag list are always a mistake, never meaningful.
    .filter((tag, index, all) => all.indexOf(tag) === index)

  return { row: { category, title, content, tags }, error: null }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { data, error } = await supabaseAdmin
        .from('content_library')
        .select(SELECT_COLUMNS)
        .order('category', { ascending: true })
        .order('title', { ascending: true })

      if (error) {
        return res.status(500).json({ error: error.message })
      }

      return res.status(200).json({ entries: data || [], categories: CATEGORIES })
    }

    if (req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const { row, error: invalid } = toRow(body)

      if (invalid) {
        return res.status(400).json({ error: invalid })
      }

      const { data, error } = await supabaseAdmin
        .from('content_library')
        .insert(row)
        .select(SELECT_COLUMNS)
        .maybeSingle()

      if (error) {
        return res.status(500).json({ error: error.message })
      }

      return res.status(200).json({ entry: data, created: true })
    }

    if (req.method === 'PUT') {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const id = String(body.id || '').trim()

      if (!id) {
        return res.status(400).json({ error: 'id is required' })
      }

      const { row, error: invalid } = toRow(body)

      if (invalid) {
        return res.status(400).json({ error: invalid })
      }

      // updated_at is left to the trigger rather than set here, so the value a
      // skeleton is compared against always comes from the database clock.
      const { data, error } = await supabaseAdmin
        .from('content_library')
        .update(row)
        .eq('id', id)
        .select(SELECT_COLUMNS)
        .maybeSingle()

      if (error) {
        return res.status(500).json({ error: error.message })
      }

      if (!data) {
        return res.status(404).json({ error: 'No library entry with that id' })
      }

      return res.status(200).json({ entry: data, created: false })
    }

    if (req.method === 'DELETE') {
      const id = String(req.query.id || req.body?.id || '').trim()

      if (!id) {
        return res.status(400).json({ error: 'id is required' })
      }

      const { error } = await supabaseAdmin
        .from('content_library')
        .delete()
        .eq('id', id)

      if (error) {
        return res.status(500).json({ error: error.message })
      }

      // Deleting an entry a skeleton cited is allowed. §8.2's staleness rules
      // detect the dangling id at read time and mark those skeletons stale,
      // which is better than blocking a library edit to protect a draft.
      return res.status(200).json({ deleted: true, id })
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE')

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('[content-library] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected content library error',
    })
  }
}
