const { checkCrossFile } = require('../../../lib/amendments/crossFileCheck')
const { loadFiles } = require('../../../lib/amendments/amendmentStore')

// §7.2 — contradictions between the files of one RFP package.
//
//   POST application/json  {"rfp_id": "..."}
//
// ZERO TOKEN COST. Pattern matching and value comparison only. Safe to call on
// page load, exactly like /api/risk/scan and /api/fit/blockers.
//
// Nothing is persisted: the check is pure over the stored file text, so
// re-deriving it on view is cheap and a stored copy would go stale the moment
// an extractor changes.

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
    const { files, error } = await loadFiles(rfpId)

    if (error) {
      return res.status(400).json({ error: `Invalid rfp_id: ${error}` })
    }

    const { conflicts, values, stats } = checkCrossFile(files)

    return res.status(200).json({
      rfp_id: rfpId,
      // Zero rows means a single-file upload — every RFP created before §7.1
      // is in that state, and it is not an error.
      multi_file: files.length > 1,
      files: files.map((file) => ({
        id: file.id,
        filename: file.filename,
        role: file.role,
        sort_order: file.sort_order,
        page_offset: file.page_offset,
        page_count: file.page_count,
      })),
      conflicts,
      // Every comparable fact found, whether or not it conflicts — useful for
      // showing "checked, and they agree" rather than a bare empty list.
      values,
      stats,
    })
  } catch (err) {
    console.error('[package/contradictions] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected cross-file check error',
    })
  }
}
