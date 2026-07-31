const { CONFIDENCE_THRESHOLD } = require('./judgeFit');

// SERVER-ONLY. Reads and writes persisted §6.3 judgments.
//
// Kept apart from loadFitInputs.js because that file is strictly about the
// INPUTS a fit check needs (profile, requirements) and has no write path.
// Kept apart from judgeFit.js because that module must stay free of any DB
// dependency: it is the piece the stub tests drive, and giving it a Supabase
// import would mean every test needed a database. judgeFit calls back into
// this through its `onBatch` hook instead, so persistence is injected rather
// than baked in.
//
// supabaseAdmin is required lazily, matching loadFitInputs: a missing
// service-role key should surface as a request error, not a crash at import.

/** Columns every reader wants. */
const SELECT_COLUMNS =
  'requirement_id, verdict, evidence_rfp, evidence_profile, note, ' +
  'confidence, judged_against_profile_updated_at, created_at';

/**
 * Rebuilds the in-memory judgment shape from a stored row.
 *
 * `needsReview` is derived here rather than stored (see the migration): a row
 * only exists when the model returned a usable verdict, so low confidence is
 * unambiguous, and the threshold can be retuned without a backfill.
 *
 * @param {object} row
 * @param {object} requirement The requirement it belongs to.
 * @returns {object} Same shape judgeFit produces, so consumers cannot tell a
 *   restored judgment from a freshly generated one.
 */
function toJudgment(row, requirement) {
  const confidence = Number(row.confidence);
  const score = Number.isFinite(confidence) ? confidence : 0;

  return {
    verdict: row.verdict,
    evidenceRfp: row.evidence_rfp || '',
    evidenceProfile: row.evidence_profile || '',
    note: row.note || '',
    confidence: score,
    needsReview: score < CONFIDENCE_THRESHOLD,
    requirementId: row.requirement_id,
    reqNumber: requirement?.req_number || null,
    department: requirement?.department || null,
    page: requirement?.page ?? null,
    requirementText: String(requirement?.requirement_text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220),
    // Marks provenance for the UI, and for anyone debugging why a run made
    // fewer calls than expected.
    restored: true,
  };
}

/**
 * Loads judgments that are still valid for the CURRENT company profile.
 *
 * Rows judged against any other profile timestamp are deliberately not
 * returned. They are not deleted either — the upsert in saveJudgments will
 * overwrite them when the requirement is re-judged, and until then leaving
 * them costs nothing and keeps the delete path off the read path.
 *
 * @param {Array<object>} requirements The requirements to look up.
 * @param {string} profileUpdatedAt company_profile.updated_at, as stored.
 * @returns {Promise<{judgments: Map<string, object>, error: string|null}>}
 *   Keyed by requirement id.
 */
async function loadJudgments(requirements, profileUpdatedAt) {
  const rows = Array.isArray(requirements) ? requirements : [];

  if (rows.length === 0 || !profileUpdatedAt) {
    return { judgments: new Map(), error: null };
  }

  const { supabaseAdmin } = require('../supabase/admin');

  const byId = new Map(rows.map((row) => [row.id, row]));

  const { data, error } = await supabaseAdmin
    .from('fit_judgments')
    .select(SELECT_COLUMNS)
    .in('requirement_id', [...byId.keys()])
    .eq('judged_against_profile_updated_at', profileUpdatedAt);

  if (error) {
    return { judgments: new Map(), error: error.message };
  }

  const judgments = new Map();

  for (const row of data || []) {
    judgments.set(row.requirement_id, toJudgment(row, byId.get(row.requirement_id)));
  }

  return { judgments, error: null };
}

/**
 * Writes one batch of fresh judgments.
 *
 * Called after EACH successful batch rather than once at the end, for the same
 * reason /api/shredder/run inserts per batch: a run that dies at batch 3 must
 * keep what batches 1 and 2 earned. Storing at the end would mean a quota wall
 * costs everything, which is the exact failure this table exists to prevent.
 *
 * Upserts on requirement_id, so re-judging a stale verdict replaces it in
 * place and the unique constraint never fires.
 *
 * @param {Array<object>} judgments judgeFit-shaped judgments, each carrying
 *   requirementId.
 * @param {string} profileUpdatedAt The profile they were judged against.
 * @returns {Promise<{saved: number, error: string|null}>}
 *   Never throws. A failed write loses persistence for that batch, not the
 *   judgments themselves — the caller still has them in memory and still
 *   returns them to the client.
 */
async function saveJudgments(judgments, profileUpdatedAt) {
  const list = (Array.isArray(judgments) ? judgments : []).filter(
    (judgment) => judgment && judgment.requirementId
  );

  if (list.length === 0 || !profileUpdatedAt) {
    return { saved: 0, error: null };
  }

  try {
    const { supabaseAdmin } = require('../supabase/admin');

    const rows = list.map((judgment) => ({
      requirement_id: judgment.requirementId,
      verdict: judgment.verdict,
      evidence_rfp: judgment.evidenceRfp || null,
      evidence_profile: judgment.evidenceProfile || null,
      note: judgment.note || null,
      confidence: judgment.confidence,
      judged_against_profile_updated_at: profileUpdatedAt,
      updated_at: new Date().toISOString(),
    }));

    const { error } = await supabaseAdmin
      .from('fit_judgments')
      .upsert(rows, { onConflict: 'requirement_id' });

    if (error) {
      console.error('[fit/store] batch write failed:', error.message);

      return { saved: 0, error: error.message };
    }

    return { saved: rows.length, error: null };
  } catch (err) {
    console.error('[fit/store] batch write threw:', err?.message);

    return { saved: 0, error: err?.message || 'write failed' };
  }
}

module.exports = { loadJudgments, saveJudgments, toJudgment };
