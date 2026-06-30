const Groq = require('groq-sdk')
const pdfParse = require('pdf-parse')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

export const config = {
  api: {
    bodyParser: false,
  },
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function getBoundary(contentType) {
  const parts = contentType.split(';')
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed.startsWith('boundary=')) {
      return trimmed.slice('boundary='.length)
    }
  }
  return null
}

function extractFileFromMultipart(buffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`)
  const parts = []
  let start = 0
  while (start < buffer.length) {
    const boundaryIndex = buffer.indexOf(boundaryBuffer, start)
    if (boundaryIndex === -1) break
    parts.push(boundaryIndex)
    start = boundaryIndex + boundaryBuffer.length
  }
  if (parts.length < 2) return null
  const firstPart = buffer.slice(parts[0] + boundaryBuffer.length, parts[1])
  const headerEnd = firstPart.indexOf('\r\n\r\n')
  if (headerEnd === -1) return null
  return firstPart.slice(headerEnd + 4, firstPart.length - 2)
}

function cleanText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[^\x20-\x7E\n]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s+|\s+$/gm, '')
    .slice(0, 12000)
    .trim()
}

function normalizeStatus(status) {
  if (!status) return 'REVIEW'
  const upper = status.toUpperCase()
  if (upper.includes('NO') || upper.includes('REJECT')) return 'NO-GO'
  if (upper === 'GO' || upper.includes('PROCEED')) return 'GO'
  return 'REVIEW'
}

function normalizeDepartments(checklist) {
  const departments = ['financial', 'legal', 'operations', 'technical']
  const fallbackItem = {
    task: 'Manual review required',
    status: 'REVIEW',
    reason: 'AI could not extract items for this department — please review manually',
  }
  const result = {}
  for (const dept of departments) {
    const items = checklist?.[dept]
    if (!items || !Array.isArray(items) || items.length === 0) {
      result[dept] = [fallbackItem]
    } else {
      result[dept] = items.map(item => ({
        task: item.task || 'Unknown task',
        status: normalizeStatus(item.status),
        reason: item.reason || '',
      }))
    }
  }
  return result
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Step 1: Extract PDF from request
    const rawBody = await getRawBody(req)
    const contentType = req.headers['content-type']
    const boundary = getBoundary(contentType)

    if (!boundary) {
      return res.status(400).json({ error: 'Invalid form data' })
    }

    const fileBuffer = extractFileFromMultipart(rawBody, boundary)

    if (!fileBuffer) {
      return res.status(400).json({ error: 'Could not extract file' })
    }

    // Step 2: Convert PDF to text
    const pdfData = await pdfParse(fileBuffer)
    const rawText = pdfData.text

    if (!rawText || rawText.trim().length === 0) {
      return res.status(400).json({ error: 'PDF appears to be empty or unreadable' })
    }

    // Step 3: Clean the extracted text before sending to Groq
    const rfpText = cleanText(rawText)

    // Step 4: Send to Groq with properly split system and user messages
    const systemPrompt = `You are an expert RFP (Request for Proposal) analyst working for a company called SPS.

Apply these compliance rules strictly when assigning GO, NO-GO, or REVIEW status:

FINANCIAL RULES:
- Payment Terms: NET30 = GO. More than NET30 = REVIEW.
- Financial Stability: Unaudited financial statements required = REVIEW.
- Insurance: Total insurance $5M or less = GO. More than $5M = NO-GO.
- Profitability Analysis: Always REVIEW.
- Bid Bond: Always REVIEW.

LEGAL RULES:
- Relevant Experience: Always REVIEW.
- Registration Requirement: Always REVIEW.
- Financial Statement of Previous Year: Always REVIEW.
- Qualified Personnel: Always REVIEW.
- Technical Knowhow: Always REVIEW.
- Compliance of Law: Always REVIEW.
- State Registration: Always REVIEW.
- E-Verify: Always REVIEW.
- Contractual Obligations: Always REVIEW.

OPERATIONS RULES:
- Required Forms (Tax ID, Owner Name, ownership percentage): Always REVIEW.
- Small Business or MBE certification: Always REVIEW.
- Workers Compensation Insurance: Always REVIEW.
- Business with Iran disclosure: Always REVIEW.
- Submission Deadlines: Always REVIEW.
- Document Compliance: Always REVIEW.
- Signatory Authority: Always REVIEW.
- Vendor Registration: Always REVIEW.

TECHNICAL RULES:
- Scope of Services alignment with SPS: Always REVIEW.
- Technical Requirements match SPS capabilities: Always REVIEW.
- Compliance with Industry Standards: Always REVIEW.
- Security Requirements: Always REVIEW.
- Integration Needs: Always REVIEW.

IMPORTANT: For every checklist item, write a specific reason that references actual details, numbers, dates, or requirements found in the RFP document. Do not just say "Always review" — explain WHY based on what the RFP actually says.

STATUS DEFINITIONS:
- GO: Requirement is clearly met based on the rules above.
- NO-GO: Requirement cannot be met or is a dealbreaker.
- REVIEW: Requires human review before a final decision.

You always respond with valid JSON only. No markdown, no explanation, no code blocks, just the raw JSON object.

Return exactly this JSON structure:
{
  "summary": {
    "issuingAgency": "string or null",
    "projectTitle": "string or null",
    "contractValue": "string or null",
    "submissionDeadline": "string or null",
    "projectDuration": "string or null",
    "rfpNumber": "string or null"
  },
  "deliverables": ["string"],
  "evaluationCriteria": ["string"],
  "complianceChecklist": {
    "financial": [{ "task": "string", "status": "GO or NO-GO or REVIEW", "reason": "string" }],
    "legal": [{ "task": "string", "status": "GO or NO-GO or REVIEW", "reason": "string" }],
    "operations": [{ "task": "string", "status": "GO or NO-GO or REVIEW", "reason": "string" }],
    "technical": [{ "task": "string", "status": "GO or NO-GO or REVIEW", "reason": "string" }]
  }
}`

    const userPrompt = `Analyze this RFP document and return the JSON response as instructed:\n\n${rfpText}`

    // Step 5: Call Groq API
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      max_tokens: 6000,
    })

    // Step 6: Extract raw response
    const rawResponse = completion.choices[0].message.content

    // Step 7: Parse JSON safely
    let analysis
    try {
      const cleaned = rawResponse
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim()
      analysis = JSON.parse(cleaned)
    } catch {
      return res.status(500).json({
        error: 'AI returned invalid JSON',
        raw: rawResponse
      })
    }

    // Step 8: Normalize status values and fill missing departments
    analysis.complianceChecklist = normalizeDepartments(analysis.complianceChecklist)

    // Step 9: Send to frontend
    return res.status(200).json(analysis)

  } catch (error) {
    console.error('Analysis error:', error)
    return res.status(500).json({ error: error.message })
  }
}
