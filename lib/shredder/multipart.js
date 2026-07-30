// Minimal multipart/form-data reader for the shredder route.
//
// pages/api/analyze.js already contains this logic, but it lives inside a
// Next.js API route and exports nothing, so it cannot be imported — and
// analyze.js is out of scope to modify. Rather than reimplement it a third
// time later, the same parsing lives here where any server-side module can
// use it. It handles exactly what the app sends: one file part plus plain
// text fields, no nested multipart, no streaming.

/**
 * Buffers a raw request body. Requires `config.api.bodyParser = false`.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {string} contentType
 * @returns {string|null} The multipart boundary, or null when absent.
 */
function getBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(
    String(contentType || '')
  );

  return (match?.[1] || match?.[2] || '').trim() || null;
}

/**
 * Splits a multipart body into its file part and its text fields.
 *
 * @param {Buffer} buffer Raw request body.
 * @param {string} boundary
 * @returns {{file: Buffer|null, filename: string|null,
 *   fields: Object<string, string>}}
 */
function parseMultipart(buffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const fields = {};

  let file = null;
  let filename = null;
  let cursor = 0;

  while (cursor < buffer.length) {
    const boundaryStart = buffer.indexOf(boundaryBuffer, cursor);

    if (boundaryStart === -1) {
      break;
    }

    const partStart = boundaryStart + boundaryBuffer.length;
    const nextBoundary = buffer.indexOf(boundaryBuffer, partStart);

    if (nextBoundary === -1) {
      break;
    }

    let part = buffer.slice(partStart, nextBoundary);

    if (part.slice(0, 2).toString() === '\r\n') {
      part = part.slice(2);
    }

    const headerEnd = part.indexOf(headerSeparator);

    if (headerEnd !== -1) {
      const headers = part.slice(0, headerEnd).toString('utf8');
      let body = part.slice(headerEnd + headerSeparator.length);

      if (body.slice(-2).toString() === '\r\n') {
        body = body.slice(0, -2);
      }

      const filenameMatch = /filename="([^"]*)"/i.exec(headers);

      if (filenameMatch) {
        if (!file) {
          file = body;
          filename = filenameMatch[1] || null;
        }
      } else {
        const nameMatch = /name="([^"]+)"/i.exec(headers);

        if (nameMatch) {
          fields[nameMatch[1]] = body.toString('utf8').trim();
        }
      }
    }

    cursor = nextBoundary;
  }

  return { file, filename, fields };
}

module.exports = {
  getRawBody,
  getBoundary,
  parseMultipart,
};
