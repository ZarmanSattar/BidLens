// SERVER-ONLY. Persistence and staleness for §8.3 skeletons.
//
// Kept apart from buildSkeletons.js for the same reason judgmentStore.js is
// kept apart from judgeFit.js: the generator stays free of any DB dependency
// so it can be driven entirely by stub tests, and receives persistence through
// its onBatch hook instead.
//
// STALENESS IS DERIVED, NEVER STORED — the three rules Part 1 committed to:
//
//   1. LIBRARY EDITED    a referenced entry's updated_at is newer than the
//                        skeleton's generated_against_library_updated_at.
//   2. ENTRY DELETED     a referenced id is no longer in content_library.
//   3. REQUIREMENT MOVED the requirement appears in Module 5's
//                        requirement_changes as changed or removed.
//
// Nothing writes a stale flag. Every rule is a read-time comparison, so fixing
// the cause (re-generating, restoring an entry, re-running a diff) clears it
// automatically and there is no second copy of the truth to drift.

const SELECT_COLUMNS =
  'id, requirement_id, req_number, content, library_entry_ids, ' +
  'generated_against_library_updated_at, model, created_at, updated_at';

/**
 * Loads the whole content library.
 *
 * Returned in full because §8.2's filtering happens per batch, in code — the
 * DB has no idea which entries a given batch wants.
 *
 * @returns {Promise<{entries: Array<object>, latestUpdatedAt: string|null,
 *   error: string|null}>}
 */
async function loadLibrary() {
  const { supabaseAdmin } = require('../supabase/admin');

  const { data, error } = await supabaseAdmin
    .from('content_library')
    .select('id, category, title, content, tags, updated_at')
    .order('category', { ascending: true });

  if (error) {
    return { entries: [], latestUpdatedAt: null, error: error.message };
  }

  const entries = data || [];

  const latestUpdatedAt = entries.reduce(
    (latest, entry) =>
      !latest || Date.parse(entry.updated_at) > Date.parse(latest)
        ? entry.updated_at
        : latest,
    null
  );

  return { entries, latestUpdatedAt, error: null };
}

/**
 * Loads existing skeletons for a set of requirements.
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
    .select(SELECT_COLUMNS)
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
 * The requirement ids Module 5 says changed or were removed.
 *
 * Rule 3. Scoped to the requirements being looked at, so an unrelated RFP's
 * amendment cannot mark these stale.
 *
 * @param {Array<object>} requirements
 * @returns {Promise<{changed: Map<string, string>, error: string|null}>}
 *   Maps requirement id -> change_type.
 */
async function loadRequirementChanges(requirements) {
  const rows = Array.isArray(requirements) ? requirements : [];

  if (rows.length === 0) {
    return { changed: new Map(), error: null };
  }

  const { supabaseAdmin } = require('../supabase/admin');

  const { data, error } = await supabaseAdmin
    .from('requirement_changes')
    .select('original_requirement_id, change_type')
    .in('original_requirement_id', rows.map((row) => row.id))
    .in('change_type', ['changed', 'removed']);

  if (error) {
    return { changed: new Map(), error: error.message };
  }

  const changed = new Map();

  for (const row of data || []) {
    if (row.original_requirement_id) {
      changed.set(row.original_requirement_id, row.change_type);
    }
  }

  return { changed, error: null };
}

/**
 * Decides whether one skeleton is stale, and why.
 *
 * Pure — every input is passed in, so the whole rule set is testable without a
 * database.
 *
 * @param {object} skeleton A response_skeletons row.
 * @param {Map<string, object>} libraryById Current library, keyed by id.
 * @param {Map<string, string>} changedRequirements Rule 3 lookup.
 * @returns {{stale: boolean, reasons: string[], detail: string|null}}
 *
 * @example
 * evaluateStaleness(row, libraryById, changed).reasons // ['library_edited']
 */
function evaluateStaleness(skeleton, libraryById, changedRequirements) {
  const reasons = [];
  const details = [];

  const generatedAt = Date.parse(
    skeleton.generated_against_library_updated_at
  );

  const referenced = Array.isArray(skeleton.library_entry_ids)
    ? skeleton.library_entry_ids
    : [];

  for (const id of referenced) {
    const entry = libraryById.get(id);

    // Rule 2 — cited content that no longer exists.
    if (!entry) {
      if (!reasons.includes('library_entry_deleted')) {
        reasons.push('library_entry_deleted');
      }

      details.push('a library entry it cited has been deleted');

      continue;
    }

    // Rule 1 — cited content edited since the draft was written.
    if (Number.isFinite(generatedAt) && Date.parse(entry.updated_at) > generatedAt) {
      if (!reasons.includes('library_edited')) {
        reasons.push('library_edited');
      }

      details.push(`“${entry.title}” has been edited since this was drafted`);
    }
  }

  // Rule 3 — the requirement itself moved under it.
  const changeType = changedRequirements.get(skeleton.requirement_id);

  if (changeType === 'removed') {
    reasons.push('requirement_removed');
    details.push('the requirement no longer exists in the amended solicitation');
  } else if (changeType === 'changed') {
    reasons.push('requirement_changed');
    details.push('the requirement was reworded by an amendment');
  }

  return {
    stale: reasons.length > 0,
    reasons,
    detail: details.length > 0 ? details.join('; ') : null,
  };
}

/**
 * Writes one batch of skeletons.
 *
 * Called after EACH successful batch rather than at the end, so a run stopped
 * by a quota wall keeps everything it already produced — the same principle as
 * the shredder's per-batch insert and §6.3's judgment persistence.
 *
 * @param {Array<object>} skeletons buildSkeletons-shaped drafts.
 * @param {string} libraryStamp The library state they were written from.
 * @param {string} [model]
 * @returns {Promise<{saved: number, error: string|null}>} Never throws.
 */
async function saveSkeletons(skeletons, libraryStamp, model) {
  const list = (Array.isArray(skeletons) ? skeletons : []).filter(
    (skeleton) => skeleton && skeleton.requirementId && skeleton.content
  );

  if (list.length === 0) {
    return { saved: 0, error: null };
  }

  try {
    const { supabaseAdmin } = require('../supabase/admin');

    const rows = list.map((skeleton) => ({
      requirement_id: skeleton.requirementId,
      req_number: skeleton.reqNumber || '',
      content: skeleton.content,
      library_entry_ids: skeleton.usedLibraryIds || [],
      // The library state this draft was written from — the anchor rule 1
      // compares against. Taken from the run, not from now(), so a library
      // edited mid-run correctly marks the earlier batches stale.
      generated_against_library_updated_at: libraryStamp,
      model: model || null,
      updated_at: new Date().toISOString(),
    }));

    const { error } = await supabaseAdmin
      .from('response_skeletons')
      .upsert(rows, { onConflict: 'requirement_id' });

    if (error) {
      console.error('[response/store] batch write failed:', error.message);

      return { saved: 0, error: error.message };
    }

    return { saved: rows.length, error: null };
  } catch (err) {
    console.error('[response/store] batch write threw:', err?.message);

    return { saved: 0, error: err?.message || 'write failed' };
  }
}

module.exports = {
  loadLibrary,
  loadSkeletons,
  loadRequirementChanges,
  evaluateStaleness,
  saveSkeletons,
  SELECT_COLUMNS,
};
