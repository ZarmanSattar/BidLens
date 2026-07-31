const { supabaseAdmin } = require('../../../lib/supabase/admin')
const { scanContractRisk } = require('../../../lib/risk/scanContractRisk')
const { explainFindings } = require('../../../lib/risk/explainFindings')

// §5.3 — AI explanations for one RFP's contract-risk findings.
//
//   POST application/json  {"rfp_id": "..."}
//
// Separate from /api/risk/scan on purpose, mirroring how the shredder keeps
// run and link apart: /api/risk/scan stays free and automatic, this one costs
// tokens and only ever runs when someone presses a button. Nothing on a page
// load can reach it.
//
// The findings are RE-DERIVED here rather than accepted from the request body.
// The scan is deterministic and takes ~13ms, so re-running it is cheaper than
// trusting the client — and it means the explanations can only ever describe
// findings this server actually produced from the stored document.

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

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured' })
  }

  try {
    const { data: rfp, error } = await supabaseAdmin
      .from('rfps')
      .select('id, raw_text, pages')
      .eq('id', rfpId)
      .maybeSingle()

    if (error) {
      return res.status(400).json({ error: `Invalid rfp_id: ${error.message}` })
    }

    if (!rfp) {
      return res.status(404).json({ error: 'No RFP found for that rfp_id' })
    }

    const input =
      Array.isArray(rfp.pages) && rfp.pages.length > 0
        ? rfp.pages
        : typeof rfp.raw_text === 'string' && rfp.raw_text.trim()
          ? rfp.raw_text
          : null

    if (!input) {
      return res.status(400).json({
        error: 'This RFP has no stored text to scan.',
        rfp_id: rfpId,
      })
    }

    const { findings } = scanContractRisk(input)

    if (findings.length === 0) {
      return res.status(200).json({
        rfp_id: rfpId,
        explanations: {},
        stats: { findings: 0, explained: 0, aiUsed: false },
        degraded: false,
        message: 'This RFP has no findings to explain.',
      })
    }

    const { explanations, stats, error: explainError } =
      await explainFindings(findings)

    // A failed explanation pass is NOT a failed request. The card renders the
    // findings either way, so this returns 200 with an empty map and says what
    // went wrong, rather than an error status the UI would have to treat as
    // fatal. The one exception is a rate limit, which the caller should be
    // able to distinguish so it can tell the user to wait.
    if (explainError && explainError.status === 429) {
      return res.status(429).json({
        error:
          'Groq rate limit reached. The findings above are unaffected — ' +
          'wait for the limit to reset and try explaining again.',
        rfp_id: rfpId,
        explanations: {},
        stats,
      })
    }

    return res.status(200).json({
      rfp_id: rfpId,
      explanations,
      stats,
      // True when the call did not produce explanations. Findings are still
      // complete; only the enhancement is missing.
      degraded: Boolean(explainError),
      message: explainError ? explainError.message : null,
    })
  } catch (err) {
    console.error('[risk/explain] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected explanation error',
    })
  }
}
