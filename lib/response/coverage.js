// SERVER-ONLY. §8.4 — which requirements have a draft response and which do not.
//
// Pure DB reads. No AI, no token cost, and nothing here can trigger one — the
// generation pass (§8.3) does not exist yet and lands in Part 2.
//
// Right now this will honestly report 0 covered of N, because
// response_skeletons is created empty. That is the intended Part 1 state: the
// counter is wired to the real table so that the moment Part 2 writes a
// skeleton, the number moves without anything here changing.
//
// supabaseAdmin is required lazily, matching loadFitInputs and judgmentStore:
// a missing service-role key should surface as a request error rather than a
// crash at import time.

/**
 * The requirement roles a response skeleton is written for.
 *
 * work_requirement  — "here is how we will do this".
 * evaluation_factor — "here is why we score well on this". These are what the
 *                     proposal is graded against; drafting everything except
 *                     the scored content would be a strange place to stop.
 *
 * Deliberately excluded:
 *   submission_instruction — packaging rules (page limits, forms, copies).
 *     Actions to complete, not prose to draft.
 *   not_applicable — obligates nobody.
 *
 * On the reference dataset this is 84 + 25 = 109 of 222 requirements.
 */
const SKELETON_ROLES = ['work_requirement', 'evaluation_factor'];

/** Columns the coverage view needs about each requirement. */
const REQUIREMENT_COLUMNS =
  'id, req_number, requirement_text, page, section, role, department';

/**
 * Sorts by the numeric tail of a REQ number.
 *
 * REQ-2 must not sort between REQ-19 and REQ-20 the way a string sort puts it.
 *
 * @param {string} value
 * @returns {number}
 */
function sequence(value) {
  return Number(/(\d+)\s*$/.exec(value || '')?.[1] || 0);
}

/**
 * Loads the requirements a skeleton is expected for.
 *
 * @param {string} rfpId
 * @returns {Promise<{requirements: Array<object>, error: string|null}>}
 */
async function loadCoverableRequirements(rfpId) {
  const { supabaseAdmin } = require('../supabase/admin');

  const { data, error } = await supabaseAdmin
    .from('requirements')
    .select(REQUIREMENT_COLUMNS)
    .eq('rfp_id', rfpId)
    .in('role', SKELETON_ROLES);

  if (error) {
    return { requirements: [], error: error.message };
  }

  const requirements = [...(data || [])].sort(
    (a, b) => sequence(a.req_number) - sequence(b.req_number)
  );

  return { requirements, error: null };
}

/**
 * Loads existing skeletons for a set of requirements.
 *
 * Returns an empty map today — nothing writes to this table until Part 2 —
 * and the caller must render that as "0 covered", not as an error.
 *
 * @param {Array<object>} requirements
 * @returns {Promise<{skeletons: Map<string, object>, error: string|null}>}
 */
async function loadSkeletons(requirements) {
  const rows = Array.isArray(requirements) ? requirements : [];

  if (rows.length === 0) {
    return { skeletons: new Map(), error: null };
  }

  const { supabaseAdmin } = require('../supabase/admin');

  const { data, error } = await supabaseAdmin
    .from('response_skeletons')
    .select(
      'id, requirement_id, req_number, content, library_entry_ids, ' +
        'generated_against_library_updated_at, model, updated_at'
    )
    .in('requirement_id', rows.map((row) => row.id));

  if (error) {
    return { skeletons: new Map(), error: error.message };
  }

  return {
    skeletons: new Map((data || []).map((row) => [row.requirement_id, row])),
    error: null,
  };
}

/**
 * Computes coverage for one RFP.
 *
 * Pure over its inputs — the DB reads happen in the loaders above, so this
 * half is trivially testable and has no I/O of its own.
 *
 * @param {Array<object>} requirements Requirements a skeleton is expected for.
 * @param {Map<string, object>} skeletons Existing skeletons, keyed by
 *   requirement id.
 * @returns {object} Counts, the missing REQ numbers, and a per-department
 *   breakdown so a gap can be handed to the team that owns it.
 *
 * @example
 * computeCoverage(requirements, skeletons).missing // ['REQ-004', 'REQ-006']
 */
function computeCoverage(requirements, skeletons) {
  const rows = Array.isArray(requirements) ? requirements : [];
  const have = skeletons instanceof Map ? skeletons : new Map();

  const missing = [];
  const covered = [];
  const byDepartment = {};
  const byRole = {};

  for (const row of rows) {
    const department = row.department || 'Unassigned';
    const role = row.role || 'unknown';

    if (!byDepartment[department]) {
      byDepartment[department] = { total: 0, covered: 0, missing: 0 };
    }

    if (!byRole[role]) {
      byRole[role] = { total: 0, covered: 0, missing: 0 };
    }

    byDepartment[department].total += 1;
    byRole[role].total += 1;

    const entry = {
      requirementId: row.id,
      reqNumber: row.req_number,
      role: row.role,
      department: row.department,
      page: row.page,
      section: row.section,
      text: String(row.requirement_text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240),
    };

    if (have.has(row.id)) {
      covered.push(entry);
      byDepartment[department].covered += 1;
      byRole[role].covered += 1;
    } else {
      missing.push(entry);
      byDepartment[department].missing += 1;
      byRole[role].missing += 1;
    }
  }

  const total = rows.length;

  return {
    total,
    covered: covered.length,
    missing: missing.length,
    // 0 when there is nothing to cover, rather than NaN from 0/0.
    percent: total === 0 ? 0 : Math.round((covered.length / total) * 100),
    coveredItems: covered,
    missingItems: missing,
    // Just the numbers, for a compact "which ones are missing" list.
    missingReqNumbers: missing.map((entry) => entry.reqNumber),
    byDepartment,
    byRole,
    roles: SKELETON_ROLES,
    aiUsed: false,
  };
}

module.exports = {
  loadCoverableRequirements,
  loadSkeletons,
  computeCoverage,
  SKELETON_ROLES,
  REQUIREMENT_COLUMNS,
};
