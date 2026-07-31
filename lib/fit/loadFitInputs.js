// SERVER-ONLY. Loads the two inputs every fit check needs: the company
// profile, and the RFP's work requirements.
//
// Shared by /api/fit/blockers and /api/fit/judge so the two can never disagree
// about what "the requirement population" means. §6.3 judging a different set
// of rows than §6.2 blocked would produce a fit score covering requirements
// nobody checked.
//
// supabaseAdmin is required lazily, for the same reason traceability.js does
// it: a missing service-role key should surface as a request error, not as a
// crash at import time.

/** The role that represents "work this company would have to perform". */
const FIT_ROLE = 'work_requirement';

/**
 * Reads the single company_profile row.
 *
 * The table is a singleton by design (see the §6.1 migration), but this orders
 * by updated_at and takes one rather than assuming exactly one exists — a
 * profile that has not been created yet is a normal state, not an error.
 *
 * @returns {Promise<{profile: object|null, error: string|null}>}
 */
async function loadCompanyProfile() {
  const { supabaseAdmin } = require('../supabase/admin');

  const { data, error } = await supabaseAdmin
    .from('company_profile')
    .select(
      'id, certificates, insurance_limit, bonding_capacity, registrations, ' +
        'staff, geography, past_projects, updated_at'
    )
    .order('updated_at', { ascending: false })
    .limit(1);

  if (error) {
    return { profile: null, error: error.message };
  }

  return { profile: (data && data[0]) || null, error: null };
}

/**
 * Reads one RFP's work requirements, in REQ order.
 *
 * `role = 'work_requirement'` inherently excludes not_applicable,
 * submission_instruction, and evaluation_factor: fit is about work this
 * company would have to perform, not about how the bid is packaged or scored.
 *
 * @param {string} rfpId
 * @returns {Promise<{requirements: Array<object>, error: string|null}>}
 */
async function loadWorkRequirements(rfpId) {
  const { supabaseAdmin } = require('../supabase/admin');

  const { data, error } = await supabaseAdmin
    .from('requirements')
    .select(
      'id, req_number, requirement_text, page, section, role, department, ' +
        'confidence, needs_review'
    )
    .eq('rfp_id', rfpId)
    .eq('role', FIT_ROLE);

  if (error) {
    return { requirements: [], error: error.message };
  }

  // Sorted by the numeric tail of the REQ number, so REQ-2 does not sort
  // between REQ-19 and REQ-20 the way a plain string sort would put it. The
  // order matters here beyond presentation: §6.3 keys its judgments by
  // position in this array.
  const sequence = (value) => Number(/(\d+)\s*$/.exec(value || '')?.[1] || 0);

  const requirements = [...(data || [])].sort(
    (a, b) => sequence(a.req_number) - sequence(b.req_number)
  );

  return { requirements, error: null };
}

module.exports = { loadCompanyProfile, loadWorkRequirements, FIT_ROLE };
