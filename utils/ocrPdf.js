// B1 — client-side OCR for scanned PDFs.
//
// BROWSER ONLY. Every import here is dynamic, so none of it enters the page
// bundle: the ~450KB pdf.js build and the tesseract.js wrapper are fetched as
// separate chunks the first time someone actually uploads a scan, and never
// for the overwhelming majority of uploads that are ordinary text PDFs.
//
// Why the browser and not the server: OCR needs the PDF rasterised to images
// first, and rasterising server-side means a native canvas binary (node-canvas
// or @napi-rs/canvas) inside a serverless function with a 250MB unzipped
// ceiling and a 60s wall clock. The browser already has a Canvas
// implementation, already has the file in memory, and has no timeout. The cost
// is that the user's machine does the work, which is why progress is reported
// page by page rather than left to look like a hang.
//
// The output deliberately matches rfps.pages — one string per page, in order —
// so OCR'd text enters the pipeline through exactly the same shape a normal
// parse produces, and nothing downstream needs to know the difference.

/** Render scale. 2x is the accuracy/speed knee — 1x loses small type, 3x is slow. */
const RENDER_SCALE = 2

/**
 * Page ceiling for one OCR run.
 *
 * OCR runs about 1-3 seconds per page on a typical laptop. Fifty pages is
 * already a two-minute wait; past that the honest answer is "re-export this
 * with OCR enabled" rather than pretending the browser is a good place to do
 * it. The cap is reported, never silent.
 */
const MAX_OCR_PAGES = 50

/** Served from public/ rather than a CDN, so OCR works with no third party. */
const WORKER_SRC = '/pdf.worker.min.mjs'

/**
 * Reads a scanned PDF by rendering each page and running OCR over it.
 *
 * @param {File|Blob} file The PDF the user already selected.
 * @param {object} [options]
 * @param {(progress: {page: number, pages: number, stage: string}) => void}
 *   [options.onProgress] Called as each page starts and finishes.
 * @param {number} [options.maxPages]
 * @returns {Promise<{pages: string[], pageCount: number, ocrPages: number,
 *   truncated: boolean, chars: number}>}
 *   `pages` is one string per OCR'd page, in document order.
 */
export async function ocrPdf(file, options = {}) {
  if (typeof window === 'undefined') {
    throw new Error('ocrPdf runs in the browser only.')
  }

  const maxPages = Number(options.maxPages) || MAX_OCR_PAGES
  const report = typeof options.onProgress === 'function' ? options.onProgress : () => {}

  const [pdfjs, tesseract] = await Promise.all([
    import('pdfjs-dist'),
    import('tesseract.js'),
  ])

  pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC

  const buffer = await file.arrayBuffer()

  // The loading task is kept, not discarded, because IT owns teardown — see
  // the cleanup block below.
  const loadingTask = pdfjs.getDocument({ data: buffer })
  const pdf = await loadingTask.promise

  const pageCount = pdf.numPages
  const ocrPages = Math.min(pageCount, maxPages)

  report({ page: 0, pages: ocrPages, stage: 'starting' })

  // One worker for the whole document. Creating a worker per page re-downloads
  // and re-initialises the language data every time, which dominates the run.
  const worker = await tesseract.createWorker('eng')

  const pages = []

  try {
    for (let pageNumber = 1; pageNumber <= ocrPages; pageNumber += 1) {
      report({ page: pageNumber, pages: ocrPages, stage: 'rendering' })

      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale: RENDER_SCALE })

      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)

      const context = canvas.getContext('2d', { willReadFrequently: true })

      // A white ground first. A transparent canvas OCRs as black-on-black and
      // returns nothing, which looks exactly like "this page was blank".
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)

      await page.render({ canvasContext: context, viewport, canvas }).promise

      report({ page: pageNumber, pages: ocrPages, stage: 'reading' })

      const { data } = await worker.recognize(canvas)

      pages.push(String(data?.text || '').trim())

      // Canvases of a 2x-scaled page are tens of megabytes. Releasing each one
      // keeps a fifty-page run from ending in an out-of-memory tab crash.
      canvas.width = 0
      canvas.height = 0

      page.cleanup()
    }
  } finally {
    // Releasing memory must NEVER be able to lose the text. This whole block
    // runs in a `finally`, so anything thrown here replaces the function's
    // return value — which is exactly what happened when `pdf.destroy()` threw
    // a TypeError: every page had already been read correctly, and the results
    // were discarded on the way out. Each step is isolated so a failure to
    // tidy up costs memory, never output.
    try {
      await worker.terminate()
    } catch (cleanupError) {
      console.warn('[ocr] tesseract worker did not terminate cleanly:', cleanupError?.message)
    }

    // pdf.js holds the whole document in memory until told otherwise.
    //
    // destroy() lives on the LOADING TASK, not on the document proxy. In
    // pdfjs-dist 6.x PDFDocumentProxy exposes cleanup() and a loadingTask
    // getter but no destroy() at all, so calling pdf.destroy() threw. cleanup()
    // releases the fonts and rendering caches; destroy() tears down the worker
    // and the document itself, so both are worth doing, in that order.
    try {
      await pdf.cleanup()
    } catch (cleanupError) {
      console.warn('[ocr] document cleanup failed:', cleanupError?.message)
    }

    try {
      await loadingTask.destroy()
    } catch (cleanupError) {
      console.warn('[ocr] document destroy failed:', cleanupError?.message)
    }
  }

  report({ page: ocrPages, pages: ocrPages, stage: 'done' })

  return {
    pages,
    pageCount,
    ocrPages,
    truncated: pageCount > ocrPages,
    chars: pages.join('').replace(/\s+/g, ' ').trim().length,
  }
}

export default ocrPdf
