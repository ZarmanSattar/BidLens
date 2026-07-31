// SERVER-ONLY. Persistence for §7.3/§7.4: the diff, judgment carry-forward,
// and staleness.
//
// Kept apart from diffRequirements.js for the same reason judgmentStore.js is
// kept apart from judgeFit.js — the matcher is pure and testable without a
// database, and gets its persistence injected rather than baked in.
//
// supabaseAdmin is required lazily, matching every other module here: a
// missing service-role key should surface as a request error, not a crash at
// import time.

/** Reads that the §7.4 view needs about each side of a comparison. */
const REQUIREMENT_COLUMNS =
  'id, req_number, requirement_text, page, section, role, department';

/**
 * Finds or creates the amendments row linking two RFPs.
 *
 * `unique (amended_rfp_id)` means an amended RFP has exactly one original, so
 * re-running a diff finds the existing row rather than forking history.
 *
 * @param {string} originalRfpId
 * @param {string} amendedRfpId
 * @returns {Promise<{amendment: object|null, error: string|null}>}
 */
async function ensureAmendment(originalRfpId, amendedRfpId) {
  const { supabaseAdmin } = require('../supabase/admin');

  const { data: existing, error: readError } = await supabaseAdmin
    .from('amendments')
    .select('id, original_rfp_id, amended_rfp_id, diff, created_at')
    .eq('amended_rfp_id', amendedRfpId)
    .maybeSingle();

  if (readError) {
    return { amendment: null, error: readError.message };
  }

  if (existing) {
    // Re-pointing an amendment at a different original is a different claim
    // about the world, not a refresh. Refused rather than silently rewritten.
    if (existing.original_rfp_id !== originalRfpId) {
      return {
        amendment: null,
        error:
          'That RFP is already recorded as an amendment of a different ' +
          'original. Delete the existing link before re-pointing it.',
      };
    }

    return { amendment: existing, error: null };
  }

  const { data, error } = await supabaseAdmin
    .from('amendments')
    .insert({ original_rfp_id: originalRfpId, amended_rfp_id: amendedRfpId })
    .select('id, original_rfp_id, amended_rfp_id, diff, created_at')
    .maybeSingle();

  return { amendment: data || null, error: error ? error.message : null };
}

/**
 * Replaces the stored diff for one amendment.
 *
 * Delete-then-insert rather than upsert: a re-run is a fresh opinion about the
 * whole comparison, and a pair that no longer matches must not survive as a
 * stale row that the partial unique indexes would then fight over.
 *
 * @param {string} amendmentId
 * @param {Array<object>} changes diffRequirements output.
 * @param {object} summary Stats to store on amendments.diff.
 * @returns {Promise<{saved: number, error: string|null}>}
 */
async function saveChanges(amendmentId, changes, summary) {
  const { supabaseAdmin } = require('../supabase/admin');

  const { error: clearError } = await supabaseAdmin
    .from('requirement_changes')
    .delete()
    .eq('amendment_id', amendmentId);

  if (clearError) {
    return { saved: 0, error: clearError.message };
  }

  const rows = (Array.isArray(changes) ? changes : []).map((change) => ({
    amendment_id: amendmentId,
    original_requirement_id: change.originalRequirementId,
    amended_requirement_id: change.amendedRequirementId,
    change_type: change.changeType,
    similarity: change.similarity,
    match_method: change.matchMethod,
    note: change.note,
  }));

  if (rows.length > 0) {
    // Chunked: a full restatement of a large solicitation is a few hundred
    // rows, and one oversized statement is a worse failure than four.
    const CHUNK = 200;

    for (let index = 0; index < rows.length; index += CHUNK) {
      const { error } = await supabaseAdmin
        .from('requirement_changes')
        .insert(rows.slice(index, index + CHUNK));

      if (error) {
        return { saved: index, error: error.message };
      }
    }
  }

  const { error: summaryError } = await supabaseAdmin
    .from('amendments')
    .update({ diff: summary || {} })
    .eq('id', amendmentId);

  return {
    saved: rows.length,
    error: summaryError ? summaryError.message : null,
  };
}

/**
 * Copies fit judgments from unchanged originals onto their amended twins.
 *
 * This is the entire reason 'unchanged' pairs are stored. Without it an
 * amendment starts with zero judgments and costs a full ~20,000-token re-run
 * to rediscover answers that did not change; with it, only genuinely new or
 * altered requirements need judging.
 *
 * Deliberately limited to 'unchanged'. A 'changed' requirement's old verdict is
 * exactly what §7.4 must treat as stale — carrying it forward would launder a
 * stale answer into a fresh-looking one.
 *
 * @param {string} amendmentId
 * @returns {Promise<{carried: number, skipped: number, error: string|null}>}
 */
async function carryForwardJudgments(amendmentId) {
  const { supabaseAdmin } = require('../supabase/admin');

  const { data: pairs, error: pairError } = await supabaseAdmin
    .from('requirement_changes')
    .select('original_requirement_id, amended_requirement_id')
    .eq('amendment_id', amendmentId)
    .eq('change_type', 'unchanged');

  if (pairError) {
    return { carried: 0, skipped: 0, error: pairError.message };
  }

  const list = pairs || [];

  if (list.length === 0) {
    return { carried: 0, skipped: 0, error: null };
  }

  const { data: judgments, error: judgmentError } = await supabaseAdmin
    .from('fit_judgments')
    .select(
      'requirement_id, verdict, evidence_rfp, evidence_profile, note, ' +
        'confidence, judged_against_profile_updated_at'
    )
    .in('requirement_id', list.map((pair) => pair.original_requirement_id));

  if (judgmentError) {
    return { carried: 0, skipped: 0, error: judgmentError.message };
  }

  const byOriginal = new Map(
    (judgments || []).map((row) => [row.requirement_id, row])
  );

  const rows = [];
  let skipped = 0;

  for (const pair of list) {
    const source = byOriginal.get(pair.original_requirement_id);

    if (!source) {
      // The original was never judged, so there is nothing to carry.
      skipped += 1;

      continue;
    }

    rows.push({
      requirement_id: pair.amended_requirement_id,
      verdict: source.verdict,
      evidence_rfp: source.evidence_rfp,
      evidence_profile: source.evidence_profile,
      note: source.note,
      confidence: source.confidence,
      // The ORIGINAL's profile stamp is carried, not "now". The verdict was
      // formed against that profile, and claiming otherwise would make an old
      // answer look current the moment the profile changes.
      judged_against_profile_updated_at: source.judged_against_profile_updated_at,
      updated_at: new Date().toISOString(),
    });
  }

  if (rows.length === 0) {
    return { carried: 0, skipped, error: null };
  }

  const { error } = await supabaseAdmin
    .from('fit_judgments')
    .upsert(rows, { onConflict: 'requirement_id' });

  return {
    carried: error ? 0 : rows.length,
    skipped,
    error: error ? error.message : null,
  };
}

/**
 * Loads one amendment's stored diff, joined to both sides' requirement rows.
 *
 * @param {string} amendmentId
 * @returns {Promise<{rows: Array<object>, error: string|null}>}
 */
async function loadChanges(amendmentId) {
  const { supabaseAdmin } = require('../supabase/admin');

  const { data, error } = await supabaseAdmin
    .from('requirement_changes')
    .select(
      'id, change_type, similarity, match_method, note, ' +
        `original:original_requirement_id (${REQUIREMENT_COLUMNS}), ` +
        `amended:amended_requirement_id (${REQUIREMENT_COLUMNS})`
    )
    .eq('amendment_id', amendmentId);

  if (error) {
    return { rows: [], error: error.message };
  }

  return { rows: data || [], error: null };
}

/**
 * The original requirements whose fit judgment the amendment invalidates.
 *
 * §7.4 staleness, DERIVED rather than stored. A judgment is stale when its
 * requirement was changed or removed by the amendment — that is a join against
 * the current diff, so re-running a diff corrects it automatically and there is
 * no second copy of the truth to drift out of sync.
 *
 * @param {string} amendmentId
 * @returns {Promise<{stale: Array<object>, error: string|null}>}
 *   One entry per judgment that should no longer be trusted, with the reason.
 */
async function loadStaleJudgments(amendmentId) {
  const { supabaseAdmin } = require('../supabase/admin');

  const { data: affected, error: changeError } = await supabaseAdmin
    .from('requirement_changes')
    .select(
      'change_type, original_requirement_id, ' +
        `original:original_requirement_id (${REQUIREMENT_COLUMNS})`
    )
    .eq('amendment_id', amendmentId)
    .in('change_type', ['changed', 'removed']);

  if (changeError) {
    return { stale: [], error: changeError.message };
  }

  const list = (affected || []).filter((row) => row.original_requirement_id);

  if (list.length === 0) {
    return { stale: [], error: null };
  }

  const { data: judgments, error: judgmentError } = await supabaseAdmin
    .from('fit_judgments')
    .select('requirement_id, verdict, confidence')
    .in('requirement_id', list.map((row) => row.original_requirement_id));

  if (judgmentError) {
    return { stale: [], error: judgmentError.message };
  }

  const judged = new Map(
    (judgments || []).map((row) => [row.requirement_id, row])
  );

  const stale = [];

  for (const row of list) {
    const judgment = judged.get(row.original_requirement_id);

    if (!judgment) {
      continue;
    }

    stale.push({
      requirementId: row.original_requirement_id,
      reqNumber: row.original?.req_number || null,
      requirementText: row.original?.requirement_text || null,
      department: row.original?.department || null,
      verdict: judgment.verdict,
      confidence: judgment.confidence,
      reason: row.change_type,
      note:
        row.change_type === 'removed'
          ? 'This requirement no longer exists in the amended solicitation, so its fit verdict describes work that is not in scope.'
          : 'The wording of this requirement changed, so the fit verdict was formed against text that no longer applies.',
    });
  }

  return { stale, error: null };
}

/**
 * Loads the files that make up one RFP package.
 *
 * An RFP with no rows here is a single-file upload — every RFP created before
 * §7.1 is in that state, and callers must treat the empty result as "one file"
 * rather than "no text".
 *
 * @param {string} rfpId
 * @returns {Promise<{files: Array<object>, error: string|null}>}
 */
async function loadFiles(rfpId) {
  const { supabaseAdmin } = require('../supabase/admin');

  const { data, error } = await supabaseAdmin
    .from('rfp_files')
    .select('id, filename, role, sort_order, raw_text, pages, page_offset, page_count')
    .eq('rfp_id', rfpId)
    .order('sort_order', { ascending: true });

  if (error) {
    return { files: [], error: error.message };
  }

  return { files: data || [], error: null };
}

/**
 * The amendment record for an RFP, whichever side of the link it is on.
 *
 * @param {string} rfpId
 * @returns {Promise<{asAmendment: object|null, asOriginal: Array<object>,
 *   error: string|null}>}
 */
async function loadAmendmentLinks(rfpId) {
  const { supabaseAdmin } = require('../supabase/admin');

  const columns = 'id, original_rfp_id, amended_rfp_id, diff, created_at';

  const [amended, original] = await Promise.all([
    supabaseAdmin.from('amendments').select(columns).eq('amended_rfp_id', rfpId).maybeSingle(),
    supabaseAdmin.from('amendments').select(columns).eq('original_rfp_id', rfpId),
  ]);

  if (amended.error || original.error) {
    return {
      asAmendment: null,
      asOriginal: [],
      error: (amended.error || original.error).message,
    };
  }

  return {
    asAmendment: amended.data || null,
    asOriginal: original.data || [],
    error: null,
  };
}

module.exports = {
  ensureAmendment,
  saveChanges,
  carryForwardJudgments,
  loadChanges,
  loadStaleJudgments,
  loadFiles,
  loadAmendmentLinks,
  REQUIREMENT_COLUMNS,
};
