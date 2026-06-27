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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
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

    const pdfData = await pdfParse(fileBuffer)
    const rfpText = pdfData.text

    if (!rfpText || rfpText.trim().length === 0) {
      return res.status(400).json({ error: 'PDF appears to be empty or unreadable' })
    }

    const prompt = `
You are an expert RFP (Request for Proposal) analyst working for a company called SPS.

You have been given the following compliance rules to apply when analyzing any RFP document. Apply these rules strictly when assigning GO, NO-GO, or REVIEW status to each checklist item.

COMPLIANCE RULES:

FINANCIAL RULES:
- Payment Terms: If NET30 then GO. If more than NET30 then REVIEW (escalate to accounting).
- Financial Stability: Unaudited financial statements are required — mark as REVIEW until confirmed.
- Insurance: If total insurance required is $5 million or less then GO. If more than $5 million then NO-GO.
- Profitability Analysis: Always REVIEW — requires human assessment of revenue vs projected costs.
- Bid Bond: Always REVIEW — must be confirmed and submitted.

LEGAL RULES:
- Relevant Experience: Always REVIEW — must verify company has relevant past experience.
- Registration Requirement: Always REVIEW — must verify company is registered appropriately.
- Financial Statement of Previous Year: Always REVIEW — must be collected and submitted.
- Qualified Personnel: Always REVIEW — must verify qualified staff are available.
- Technical Knowhow: Always REVIEW — must verify technical capability exists.
- Compliance of Law: Always REVIEW — must verify all legal compliance.
- State Registration: Always REVIEW — must verify registration in the state where project is executed.
- E-Verify: Always REVIEW — must confirm E-Verify enrollment.
- Contractual Obligations: Always REVIEW — termination clauses, liability limits, and dispute resolution must be reviewed by legal team.

OPERATIONS RULES:
- Required Forms (Tax ID, Owner Name, ownership percentage): Always REVIEW — must be completed.
- Small Business or MBE certification: Always REVIEW — check if applicable and complete.
- Workers Compensation Insurance: Always REVIEW — must confirm certificate is in place.
- Business with Iran disclosure: Always REVIEW — must complete the disclosure form.
- Submission Deadlines: Always REVIEW — must confirm all forms submitted on time.
- Document Compliance: Always REVIEW — verify formatting and submission requirements.
- Signatory Authority: Always REVIEW — confirm correct person with authority signs.
- Vendor Registration: Always REVIEW — confirm registration is complete before submission.

TECHNICAL RULES:
- Scope of Services alignment with SPS: Always REVIEW — verify RFP scope matches what SPS offers.
- Technical Requirements match SPS capabilities: Always REVIEW — verify SPS can meet all specs.
- Compliance with Industry Standards: Always REVIEW — verify SPS follows required standards.
- Security Requirements: Always REVIEW — verify SPS can meet data protection and encryption needs.
- Integration Needs: Always REVIEW — verify SPS can support required system integrations.

STATUS DEFINITIONS:
- GO: Requirement is clearly met based on the rules above.
- NO-GO: Requirement cannot be met or is a dealbreaker based on the rules above.
- REVIEW: Requires human review or verification before a final decision can be made.

Now analyze the following RFP document and return ONLY a valid JSON object with exactly this structure. No extra text, no markdown, no explanation, just the raw JSON:

{
  "summary": {
    "issuingAgency": "name of the agency or organization issuing the RFP",
    "projectTitle": "title of the project",
    "contractValue": "estimated contract value if mentioned, otherwise null",
    "submissionDeadline": "submission deadline if mentioned, otherwise null",
    "projectDuration": "duration of the project if mentioned, otherwise null",
    "rfpNumber": "RFP reference number if mentioned, otherwise null"
  },
  "deliverables": [
    "deliverable 1",
    "deliverable 2"
  ],
  "evaluationCriteria": [
    "criterion 1 with weight or score if mentioned",
    "criterion 2 with weight or score if mentioned"
  ],
  "complianceChecklist": {
    "financial": [
      { "task": "task description", "status": "GO or NO-GO or REVIEW", "reason": "one sentence explaining why this status was assigned" }
    ],
    "legal": [
      { "task": "task description", "status": "GO or NO-GO or REVIEW", "reason": "one sentence explaining why this status was assigned" }
    ],
    "operations": [
      { "task": "task description", "status": "GO or NO-GO or REVIEW", "reason": "one sentence explaining why this status was assigned" }
    ],
    "technical": [
      { "task": "task description", "status": "GO or NO-GO or REVIEW", "reason": "one sentence explaining why this status was assigned" }
    ]
  }
}

RFP Document:
${rfpText}
`

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'You are an expert RFP analyst for a company called SPS. You always respond with valid JSON only. No markdown, no explanation, no code blocks, just the raw JSON object.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 3000,
    })

    const rawResponse = completion.choices[0].message.content

    let analysis
    try {
      analysis = JSON.parse(rawResponse)
    } catch {
      return res.status(500).json({
        error: 'AI returned invalid JSON',
        raw: rawResponse
      })
    }

    return res.status(200).json(analysis)

  } catch (error) {
    console.error('Analysis error:', error)
    return res.status(500).json({ error: error.message })
  }
}
