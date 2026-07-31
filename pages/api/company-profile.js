const { supabaseAdmin } = require('../../lib/supabase/admin')

// §6.1 — CRUD for the single company profile row.
//
//   GET  /api/company-profile        -> {profile: {...} | null}
//   PUT  /api/company-profile        -> upserts THE row, returns it
//   DELETE /api/company-profile      -> clears it
//
// The table is a singleton (see the §6.1 migration): one company, one profile.
// This route enforces that in code as well, by updating the existing row when
// there is one and inserting only when there is none — so the constraint being
// absent on an un-migrated database still cannot produce a second row through
// the app.
//
// Writes go through supabaseAdmin rather than the browser's anon client. The
// profile's RLS is company-wide (auth.role() = 'authenticated'), so an anon
// write would be rejected, and the settings page is server-rendered anyway.

/** Columns the client is allowed to set. Anything else in the body is dropped. */
const ARRAY_FIELDS = [
  'certificates',
  'registrations',
  'staff',
  'geography',
  'past_projects',
]

const NUMBER_FIELDS = ['insurance_limit', 'bonding_capacity']

const SELECT_COLUMNS =
  'id, certificates, insurance_limit, bonding_capacity, registrations, ' +
  'staff, geography, past_projects, updated_at'

/**
 * Coerces a numeric field, treating blank as "not stated".
 *
 * Not-stated is meaningful: §6.2 skips the insurance and bonding rules
 * entirely when the figure is null, rather than comparing against zero and
 * blocking everything.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Builds the row to write from a request body.
 *
 * Every array field is stored as-is after dropping empty entries — the columns
 * are jsonb and §6.3 renders whatever shape it finds, so a hand-seeded profile
 * that does not match the form exactly still works.
 *
 * @param {object} body
 * @returns {object}
 */
function toRow(body) {
  const row = {}

  for (const field of ARRAY_FIELDS) {
    const value = body[field]

    row[field] = Array.isArray(value)
      ? value.filter((entry) => {
          if (entry === null || entry === undefined || entry === '') {
            return false
          }

          // An object row whose every field was left blank is a form artifact,
          // not data the user entered.
          if (typeof entry === 'object') {
            return Object.values(entry).some(
              (item) => item !== null && item !== undefined && item !== ''
            )
          }

          return true
        })
      : []
  }

  for (const field of NUMBER_FIELDS) {
    row[field] = toNumber(body[field])
  }

  return row
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { data, error } = await supabaseAdmin
        .from('company_profile')
        .select(SELECT_COLUMNS)
        .order('updated_at', { ascending: false })
        .limit(1)

      if (error) {
        return res.status(500).json({ error: error.message })
      }

      return res.status(200).json({ profile: (data && data[0]) || null })
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const row = toRow(body)

      const { data: existing, error: readError } = await supabaseAdmin
        .from('company_profile')
        .select('id')
        .order('updated_at', { ascending: false })
        .limit(1)

      if (readError) {
        return res.status(500).json({ error: readError.message })
      }

      const current = existing && existing[0]

      const { data, error } = current
        ? await supabaseAdmin
            .from('company_profile')
            .update(row)
            .eq('id', current.id)
            .select(SELECT_COLUMNS)
            .maybeSingle()
        : await supabaseAdmin
            .from('company_profile')
            .insert(row)
            .select(SELECT_COLUMNS)
            .maybeSingle()

      if (error) {
        return res.status(500).json({ error: error.message })
      }

      return res.status(200).json({ profile: data, created: !current })
    }

    if (req.method === 'DELETE') {
      const { error } = await supabaseAdmin
        .from('company_profile')
        .delete()
        // Supabase refuses an unfiltered delete. Every real row has a uuid, so
        // this matches all of them without naming one.
        .not('id', 'is', null)

      if (error) {
        return res.status(500).json({ error: error.message })
      }

      return res.status(200).json({ profile: null, deleted: true })
    }

    res.setHeader('Allow', 'GET, PUT, DELETE')

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('[company-profile] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected company profile error',
    })
  }
}
