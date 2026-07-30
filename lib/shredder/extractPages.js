const pdfParse = require('pdf-parse');

// Page-aware wrapper around pdf-parse — the same library and the same
// getTextContent rendering pages/api/analyze.js already relies on.
//
// analyze.js calls pdfParse(buffer) and reads pdfData.text, which is every
// page concatenated into one string with the page boundaries thrown away.
// §4.1 needs a page number per requirement, so this module supplies its own
// `pagerender` callback (a documented pdf-parse option) that reproduces the
// default renderer's output exactly and records each page's text on the way
// past. Same parser, same text, boundaries retained.

/**
 * Reproduces pdf-parse's default page renderer.
 *
 * Copied deliberately rather than improved on: the goal is text identical to
 * what analyze.js already sees, not better text. Items are concatenated in
 * order with a newline inserted whenever the vertical position changes.
 *
 * @param {object} pageData A pdf.js page object.
 * @returns {Promise<string>} The page's text.
 */
function renderPage(pageData) {
  return pageData
    .getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    })
    .then((textContent) => {
      let lastY;
      let text = '';

      for (const item of textContent.items) {
        if (lastY === item.transform[5] || !lastY) {
          text += item.str;
        } else {
          text += '\n' + item.str;
        }

        lastY = item.transform[5];
      }

      return text;
    });
}

/**
 * Structure-preserving text cleanup.
 *
 * analyze.js's cleanText() collapses runs of spaces immediately, which
 * destroys the column gaps that identify table rows. This keeps intra-line
 * spacing so the candidate filter can still see table structure; callers
 * collapse whitespace when they emit final requirement text, which lands on
 * the same result analyze.js produces.
 *
 * @param {string} text
 * @returns {string}
 */
function cleanPageText(text) {
  const normalized = String(text || '')
    .normalize('NFKC')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  // Written as an explicit code-point pass rather than a regex character
  // class so no raw control bytes have to live in this source file. Maps C0
  // controls and non-breaking spaces to a plain space, leaving tab and
  // newline intact because both carry layout meaning.
  let stripped = '';

  for (const char of normalized) {
    const code = char.codePointAt(0);

    const isControl =
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f;

    const isNonBreakingSpace = code === 0xa0 || code === 0x202f;

    stripped += isControl || isNonBreakingSpace ? ' ' : char;
  }

  return stripped
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts a PDF's text with page boundaries preserved.
 *
 * @param {Buffer} fileBuffer Raw PDF bytes.
 * @returns {Promise<{pages: Array<{page: number, text: string}>,
 *   text: string, numPages: number}>}
 *   `pages` is 1-indexed and in document order. `text` is every page joined,
 *   equivalent to what analyze.js reads off pdfParse().text.
 */
async function extractPages(fileBuffer) {
  const pages = [];

  // pdf-parse awaits pagerender sequentially from page 1..n, so pushing here
  // yields pages in document order.
  const data = await pdfParse(fileBuffer, {
    pagerender: (pageData) =>
      renderPage(pageData).then((text) => {
        pages.push({ page: pages.length + 1, text: cleanPageText(text) });

        return text;
      }),
  });

  return {
    pages,
    text: pages.map((entry) => entry.text).join('\n\n'),
    numPages: Number(data?.numpages) || pages.length,
  };
}

module.exports = {
  extractPages,
  cleanPageText,
};
