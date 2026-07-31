const { supabaseAdmin } = require('../../../lib/supabase/admin')
const { scanContractRisk } = require('../../../lib/risk/scanContractRisk')

// §5.1 + §5.2 — contract-risk scan for one RFP.
//
//   POST application/json  {"rfp_id": "..."}
//
// Computed at request time rather than persisted into analyses.result, which
// is the pattern the AI analysis uses. Three reasons that split is right here:
//
//   1. The scan is pure regex over stored text. It costs milliseconds and no
//      tokens, so there is nothing to amortize by caching it.
//   2. Persisting it would only ever cover RFPs analyzed AFTER this shipped.
//      Every analyses row already in the table predates it and would render
//      an empty section forever.
//   3. The findings are a function of the clause library and the thresholds,
//      both of which will change. A stored copy silently goes stale; a
//      recomputed one cannot.
//
// This route makes no AI call. §5.3 is out of scope for this pass.

export const maxDuration = 60

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')

    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const rfpId = body.rfp_id || body.rfpId || ''

  if (!rfpId) {
    return res.status(400).json({ error: 'rfp_id is required' })
  }

  try {
    // service_role bypasses RLS, so the RFP's existence is confirmed here
    // rather than relying on a policy to do it.
    const { data: rfp, error } = await supabaseAdmin
      .from('rfps')
      .select('id, title, raw_text, pages')
      .eq('id', rfpId)
      .maybeSingle()

    if (error) {
      return res.status(400).json({ error: `Invalid rfp_id: ${error.message}` })
    }

    if (!rfp) {
      return res.status(404).json({ error: 'No RFP found for that rfp_id' })
    }

    // rfps.pages is one string per page, so the 1-based index IS the page
    // number and every finding can cite one. raw_text is the same document
    // flattened — usable, but page numbers come back null. Same fidelity
    // ordering the shredder uses.
    let input
    let textSource

    if (Array.isArray(rfp.pages) && rfp.pages.length > 0) {
      input = rfp.pages
      textSource = 'pages_column'
    } else if (typeof rfp.raw_text === 'string' && rfp.raw_text.trim()) {
      input = rfp.raw_text
      textSource = 'raw_text_flat'
    } else {
      return res.status(400).json({
        error:
          'This RFP has no stored text to scan. It was uploaded before the ' +
          'document text was captured.',
        rfp_id: rfpId,
      })
    }

    const started = Date.now()
    const { findings, summary, stats } = scanContractRisk(input)
    const durationMs = Date.now() - started

    console.log(
      '[risk] scanned',
      textSource,
      Array.isArray(input) ? `${input.length} pages` : `${input.length} chars`,
      '->',
      summary.total,
      'findings in',
      durationMs,
      'ms'
    )

    return res.status(200).json({
      rfp_id: rfpId,
      title: rfp.title || '',
      // 'raw_text_flat' means every finding's page is null — the flattened
      // column does not preserve page boundaries.
      text_source: textSource,
      duration_ms: durationMs,
      findings,
      summary,
      stats,
    })
  } catch (err) {
    console.error('[risk] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected risk scan error',
    })
  }
}
