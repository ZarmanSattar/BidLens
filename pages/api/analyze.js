const pdfParse = require('pdf-parse')

const {
  callGroqWithValidation,
  getErrorStatus,
} = require('../../lib/ai/groqHelper')

const { extractPages } = require('../../lib/shredder/extractPages')

export const config = {
  api: {
    bodyParser: false,
  },
}

export const maxDuration = 60

const NOT_SPECIFIED = 'Not specified in RFP'
const MAX_RFP_TEXT_LENGTH = 18000

const CHECKLIST_DEFINITIONS = {
  financial: [
    {
      id: 'paymentTerms',
      task: 'Payment Terms',
      aliases: ['payment terms', 'prompt payment', 'net 30', 'net30'],
      description: 'Invoice payment period, NET terms, and payment timing.',
      missingReason: 'The RFP does not specify payment terms.',
    },
    {
      id: 'financialStability',
      task: 'Financial Stability',
      aliases: ['financial stability', 'proof of financial stability'],
      description:
        'Audited or unaudited financial statements, financial records, or proof of financial stability.',
      missingReason:
        'The RFP does not require financial statements or other proof of financial stability.',
    },
    {
      id: 'insurance',
      task: 'Insurance',
      aliases: ['insurance', 'insurance requirements', 'liability insurance'],
      description:
        'Required insurance types, limits, aggregates, and coverage amounts.',
      missingReason: 'The RFP does not specify insurance requirements.',
    },
    {
      id: 'profitability',
      task: 'Profitability Analysis',
      aliases: [
        'profitability',
        'profitability analysis',
        'cost analysis',
        'margin analysis',
      ],
      description:
        'Internal cost, pricing, margin, and profitability assessment.',
      missingReason:
        'The RFP does not provide enough information to complete an internal profitability analysis.',
    },
    {
      id: 'bidBond',
      task: 'Bid Bond',
      aliases: ['bid bond', 'proposal bond', 'performance bond'],
      description:
        'Proposal, bid, or performance bond requirements, thresholds, percentages, and caps.',
      missingReason:
        'The RFP does not specify a bid or proposal bond requirement.',
    },
  ],

  legal: [
    {
      id: 'relevantExperience',
      task: 'Relevant Experience',
      aliases: ['relevant experience', 'prior experience', 'past performance'],
      description:
        'Required years, projects, references, or past performance. Vendor registration or Master Contractor status does not count as experience.',
      missingReason:
        'The RFP does not specify a relevant-experience requirement.',
    },
    {
      id: 'registrationRequirement',
      task: 'Registration Requirement',
      aliases: [
        'registration requirement',
        'vendor eligibility',
        'master contractor',
        'business registration',
      ],
      description:
        'Vendor eligibility, licenses, registrations, certifications, or Master Contractor status.',
      missingReason:
        'The RFP does not specify a vendor registration or eligibility requirement.',
    },
    {
      id: 'financialStatementPreviousYear',
      task: 'Financial Statement of Previous Year',
      aliases: [
        'financial statement of previous year',
        'previous year financial statement',
        'prior year financial statement',
      ],
      description: 'A prior-year financial-statement requirement.',
      missingReason:
        'The RFP does not require a financial statement from the previous year.',
    },
    {
      id: 'qualifiedPersonnel',
      task: 'Qualified Personnel',
      aliases: [
        'qualified personnel',
        'key personnel',
        'staff qualifications',
      ],
      description:
        'Named roles, resumes, certifications, staffing levels, or personnel qualifications.',
      missingReason:
        'The RFP does not specify qualified-personnel requirements.',
    },
    {
      id: 'technicalKnowhow',
      task: 'Technical Knowhow',
      aliases: [
        'technical knowhow',
        'technical knowledge',
        'technical expertise',
      ],
      description:
        'Required expertise, methods, certifications, or technical experience.',
      missingReason:
        'The RFP does not specify a technical-knowhow requirement.',
    },
    {
      id: 'complianceOfLaw',
      task: 'Compliance of Law',
      aliases: [
        'compliance of law',
        'compliance with law',
        'applicable laws',
      ],
      description:
        'Statutes, regulations, legal compliance, debarment, conflicts, or governing-law clauses.',
      missingReason:
        'The RFP does not specify an applicable-law compliance requirement.',
    },
    {
      id: 'stateRegistration',
      task: 'State Registration',
      aliases: [
        'state registration',
        'state corporation commission',
        'scc registration',
      ],
      description:
        'Registration or authorization to do business in the issuing state.',
      missingReason:
        'The RFP does not specify a state-registration requirement.',
    },
    {
      id: 'eVerify',
      task: 'E-Verify',
      aliases: ['e-verify', 'everify'],
      description:
        'E-Verify enrollment or workforce-verification requirements.',
      missingReason: 'The RFP does not specify an E-Verify requirement.',
    },
    {
      id: 'contractualObligations',
      task: 'Contractual Obligations',
      aliases: [
        'contractual obligations',
        'contract terms',
        'termination',
        'disputes',
      ],
      description:
        'Material contract terms, termination, disputes, claims, indemnity, or continuing obligations.',
      missingReason:
        'The RFP does not specify material contractual obligations for this checklist item.',
    },
  ],

  operations: [
    {
      id: 'requiredForms',
      task: 'Required Forms (Tax ID, Owner Name, ownership percentage)',
      aliases: [
        'required forms',
        'tax id',
        'owner name',
        'ownership percentage',
      ],
      description:
        'Mandatory forms and ownership or tax-identification disclosures.',
      missingReason:
        'The RFP does not specify the required ownership or Tax ID forms.',
    },
    {
      id: 'smallBusiness',
      task: 'Small Business or MBE certification',
      aliases: [
        'small business or mbe certification',
        'small business certification',
        'mbe certification',
        'swam certification',
        'sbr',
      ],
      description:
        'Small-business, MBE, WBE, SWaM, SBR, or similar participation or certification requirements.',
      missingReason:
        'The RFP does not specify a small-business or MBE certification requirement.',
    },
    {
      id: 'workersCompensation',
      task: 'Workers Compensation Insurance',
      aliases: [
        'workers compensation insurance',
        "workers' compensation insurance",
        'workers compensation',
      ],
      description:
        'Workers compensation insurance or statutory employee coverage.',
      missingReason:
        'The RFP does not specify workers compensation insurance requirements.',
    },
    {
      id: 'iranDisclosure',
      task: 'Business with Iran disclosure',
      aliases: [
        'business with iran disclosure',
        'iran disclosure',
        'business with iran',
      ],
      description:
        'Disclosure or certification concerning business activities with Iran.',
      missingReason:
        'The RFP does not specify a Business with Iran disclosure requirement.',
    },
    {
      id: 'submissionDeadlines',
      task: 'Submission Deadlines',
      aliases: [
        'submission deadlines',
        'submission deadline',
        'due date',
        'closing date',
        'bid due date',
      ],
      description:
        'Proposal due date, question deadline, closing time, and other submission milestones.',
      missingReason:
        'The RFP does not specify a submission deadline.',
    },
    {
      id: 'documentCompliance',
      task: 'Document Compliance',
      aliases: [
        'document compliance',
        'submission instructions',
        'proposal format',
        'password protected',
      ],
      description:
        'Submission method, file protection, format, page limits, required packaging, and document instructions.',
      missingReason:
        'The RFP does not specify document-compliance or submission-format requirements.',
    },
    {
      id: 'signatoryAuthority',
      task: 'Signatory Authority',
      aliases: [
        'signatory authority',
        'authorized signature',
        'authorized signatory',
      ],
      description:
        'Authorized signer, signature, attestation, or binding-authority requirements.',
      missingReason:
        'The RFP does not specify signatory-authority requirements.',
    },
    {
      id: 'vendorRegistration',
      task: 'Vendor Registration',
      aliases: [
        'vendor registration',
        'supplier registration',
        'procurement portal registration',
        'eva registration',
      ],
      description:
        'Registration in the procurement portal or vendor system.',
      missingReason:
        'The RFP does not specify a vendor-system registration requirement.',
    },
  ],

  technical: [
    {
      id: 'scopeAlignment',
      task: 'Scope of Services alignment with SPS',
      aliases: [
        'scope of services alignment with sps',
        'scope of services',
        'scope alignment',
      ],
      description:
        'Whether the stated scope and required services align with SPS offerings.',
      missingReason:
        'The RFP does not provide enough scope detail to assess alignment with SPS.',
    },
    {
      id: 'technicalCapabilities',
      task: 'Technical Requirements match SPS capabilities',
      aliases: [
        'technical requirements match sps capabilities',
        'technical requirements',
        'technical capabilities',
      ],
      description:
        'Required platforms, functions, tools, staffing, and technical capabilities.',
      missingReason:
        'The RFP does not specify enough technical requirements to compare against SPS capabilities.',
    },
    {
      id: 'industryStandards',
      task: 'Compliance with Industry Standards',
      aliases: [
        'compliance with industry standards',
        'industry standards',
        'standards compliance',
      ],
      description:
        'Named industry standards, accessibility standards, frameworks, or certifications.',
      missingReason:
        'The RFP does not specify an industry-standard compliance requirement.',
    },
    {
      id: 'securityRequirements',
      task: 'Security Requirements',
      aliases: [
        'security requirements',
        'data security',
        'cybersecurity',
        'security breach',
      ],
      description:
        'Cybersecurity, privacy, encryption, breach notification, access control, and data-protection requirements.',
      missingReason:
        'The RFP does not specify detailed security requirements.',
    },
    {
      id: 'integrationNeeds',
      task: 'Integration Needs',
      aliases: [
        'integration needs',
        'integration requirements',
        'api integration',
        'interface requirements',
      ],
      description:
        'Required integrations, interfaces, APIs, data exchange, or interoperability.',
      missingReason:
        'The RFP does not specify integration requirements.',
    },
  ],
}

const SECTION_GROUPS = [
  {
    tier: 'priority',
    department: 'financial',
    label: 'Payment Terms',
    maxBlocks: 2,
    keywords: [
      'PAYMENT TERMS',
      'PROMPT PAYMENT',
      'NET 30',
      'NET30',
      'INVOICE PAYMENT',
      'PAYMENT WITHIN',
      'PAYMENT PROVISIONS',
    ],
  },
  {
    tier: 'priority',
    department: 'financial',
    label: 'Insurance',
    maxBlocks: 3,
    keywords: [
      'B. INSURANCE',
      'INSURANCE REQUIREMENTS',
      'CYBER SECURITY LIABILITY',
      'CYBER LIABILITY',
      'COMMERCIAL GENERAL LIABILITY',
      'GENERAL LIABILITY',
      'EMPLOYERS LIABILITY',
      'WORKERS COMPENSATION',
      "WORKERS' COMPENSATION",
      'AUTOMOBILE LIABILITY',
      'AUTO LIABILITY',
    ],
  },
  {
    tier: 'priority',
    department: 'financial',
    label: 'Bid Bond',
    maxBlocks: 2,
    keywords: [
      'BID BOND',
      'PROPOSAL BOND',
      'PROPOSAL BONDS',
      'PERFORMANCE BOND',
      'BOND REQUIREMENT',
    ],
  },
  {
    tier: 'priority',
    department: 'financial',
    label: 'Financial Stability',
    maxBlocks: 2,
    keywords: [
      'FINANCIAL STABILITY',
      'AUDITED FINANCIAL',
      'UNAUDITED FINANCIAL',
      'FINANCIAL STATEMENT',
    ],
  },
  {
    tier: 'priority',
    department: 'financial',
    label: 'Profitability and Pricing',
    maxBlocks: 1,
    keywords: [
      'PROFITABILITY',
      'COST PROPOSAL',
      'PRICING SCHEDULE',
      'PRICE PROPOSAL',
      'FEES AND PRICING',
    ],
  },

  {
    tier: 'secondary',
    department: 'general',
    label: 'Evaluation Criteria',
    maxBlocks: 2,
    keywords: [
      'EVALUATION CRITERIA',
      'EVALUATION FACTORS',
      'SCORING CRITERIA',
      'POINT ALLOCATION',
      'BASIS OF AWARD',
      'ASSOCIATED WEIGHTS',
    ],
  },
  {
    tier: 'secondary',
    department: 'general',
    label: 'Scope and Deliverables',
    maxBlocks: 2,
    keywords: [
      'STATEMENT OF NEEDS',
      'SCOPE OF WORK',
      'SCOPE OF SERVICES',
      'STATEMENT OF WORK',
      'DELIVERABLES',
      'REQUIRED SERVICES',
    ],
  },
  {
    tier: 'secondary',
    department: 'legal',
    label: 'Registration and Eligibility',
    maxBlocks: 2,
    keywords: [
      'ONLY MASTER CONTRACTORS',
      'MASTER CONTRACTOR',
      'VENDOR ELIGIBILITY',
      'REGISTRATION REQUIREMENT',
      'BUSINESS LICENSE',
      'ELIGIBLE TO SUBMIT',
    ],
  },
  {
    tier: 'secondary',
    department: 'legal',
    label: 'State Registration',
    maxBlocks: 1,
    keywords: [
      'STATE CORPORATION COMMISSION',
      'STATE REGISTRATION',
      'AUTHORIZED TO DO BUSINESS',
    ],
  },
  {
    tier: 'secondary',
    department: 'legal',
    label: 'Experience and Personnel',
    maxBlocks: 3,
    keywords: [
      'EXPERIENCE AND REFERENCES',
      'RELEVANT EXPERIENCE',
      'PAST PERFORMANCE',
      'CAPABILITY AND SKILL',
      'QUALIFIED PERSONNEL',
      'KEY PERSONNEL',
      'STAFF QUALIFICATIONS',
      'PROVIDE RESUMES',
      'TECHNICAL KNOWHOW',
    ],
  },
  {
    tier: 'secondary',
    department: 'legal',
    label: 'Applicable Law and Contract Terms',
    maxBlocks: 2,
    keywords: [
      'APPLICABLE LAWS AND COURTS',
      'APPLICABLE LEGISLATION',
      'COMPLIANCE WITH LAW',
      'GOVERNING LAW',
      'CONFLICT OF INTEREST',
      'DEBARRED',
      'ANTITRUST',
      'INDEMNIFICATION',
      'TERMINATION WITH CAUSE',
      'DISPUTES',
      'CONTRACTUAL CLAIMS',
    ],
  },
  {
    tier: 'secondary',
    department: 'legal',
    label: 'E-Verify',
    maxBlocks: 1,
    keywords: ['E-VERIFY', 'EVERIFY'],
  },
  {
    tier: 'secondary',
    department: 'operations',
    label: 'Required Forms',
    maxBlocks: 2,
    keywords: [
      'SUBMISSION OF PROPOSALS',
      'REQUIRED FORMS',
      'CONTRACTOR DATA SHEET',
      'SUBSTITUTE W-9',
      'TAX ID',
      'OWNER NAME',
      'OWNERSHIP PERCENTAGE',
    ],
  },
  {
    tier: 'secondary',
    department: 'operations',
    label: 'Small Business Certification',
    maxBlocks: 2,
    keywords: [
      'SMALL BUSINESS RESERVE',
      'SMALL BUSINESS',
      'CERTIFIED SMALL BUSINESS',
      'SBR',
      'MBE',
      'MINORITY-OWNED',
      'WOMEN-OWNED',
      'SWAM',
      'GOSBA',
    ],
  },
  {
    tier: 'secondary',
    department: 'operations',
    label: 'Workers Compensation',
    maxBlocks: 1,
    keywords: [
      'WORKERS COMPENSATION',
      "WORKERS' COMPENSATION",
      'STATUTORY LIMITS',
    ],
  },
  {
    tier: 'secondary',
    department: 'operations',
    label: 'Submission Deadlines',
    maxBlocks: 2,
    keywords: [
      'DUE DATE AND TIME',
      'DUE / CLOSE DATE',
      'SUBMISSION DEADLINE',
      'PROPOSAL DUE',
      'BID DUE',
      'QUESTIONS DUE',
      'CLOSING DATE',
      'ALL INQUIRIES AND QUESTIONS',
    ],
  },
  {
    tier: 'secondary',
    department: 'operations',
    label: 'Document Compliance',
    maxBlocks: 2,
    keywords: [
      'PROPOSAL PREPARATION AND SUBMISSION REQUIREMENTS',
      'ADDITIONAL INSTRUCTIONS',
      'SUBMISSION INSTRUCTIONS',
      'PASSWORD PROTECTED',
      'PROPOSAL FORMAT',
      'TABLE OF CONTENTS',
    ],
  },
  {
    tier: 'secondary',
    department: 'operations',
    label: 'Signatory Authority',
    maxBlocks: 1,
    keywords: [
      'AUTHORIZED TO BIND',
      'AUTHORIZED REPRESENTATIVE',
      'AUTHORIZED SIGNATURE',
      'SIGNATORY',
    ],
  },
  {
    tier: 'secondary',
    department: 'operations',
    label: 'Vendor Registration',
    maxBlocks: 1,
    keywords: [
      'VENDOR REGISTRATION',
      'SUPPLIER REGISTRATION',
      'MUST REGISTER IN EVA',
      'EVA REGISTRATION',
      'PROCUREMENT PORTAL REGISTRATION',
    ],
  },
  {
    tier: 'secondary',
    department: 'operations',
    label: 'Operational Disclosures',
    maxBlocks: 1,
    keywords: [
      'BUSINESS WITH IRAN',
      'IRAN DISCLOSURE',
      'BACKGROUND CHECK',
    ],
  },
  {
    tier: 'secondary',
    department: 'technical',
    label: 'Technical Requirements',
    maxBlocks: 2,
    keywords: [
      'AI-ENHANCED SEARCH',
      'TECHNICAL REQUIREMENTS',
      'TECHNICAL SPECIFICATIONS',
      'FUNCTIONAL REQUIREMENTS',
      'SYSTEM REQUIREMENTS',
      'TECHNICAL FIT',
    ],
  },
  {
    tier: 'secondary',
    department: 'technical',
    label: 'Industry Standards and Accessibility',
    maxBlocks: 2,
    keywords: [
      'INDUSTRY STANDARDS',
      'ACCESSIBILITY',
      'SECTION 508',
      'WCAG',
      'NONVISUAL ACCESS',
      'CERTIFICATION REQUIREMENTS',
    ],
  },
  {
    tier: 'secondary',
    department: 'technical',
    label: 'Security and Privacy',
    maxBlocks: 2,
    keywords: [
      'SECURITY AND AUTHENTICATION',
      'DATA SECURITY',
      'SECURITY REQUIREMENTS',
      'CYBERSECURITY',
      'ENCRYPTION',
      'DATA PRIVACY',
      'SECURITY BREACH',
      'BREACH NOTIFICATION',
      'GRAMM-LEACH-BLILEY',
    ],
  },
  {
    tier: 'secondary',
    department: 'technical',
    label: 'Integration',
    maxBlocks: 2,
    keywords: [
      'INTEGRATION AND TECHNICAL FIT',
      'INTEGRATION',
      'INTEROPERABILITY',
      'INTERFACE REQUIREMENTS',
      'API',
      'DATA EXCHANGE',
      'DRUPAL',
    ],
  },
]

const FINANCIAL_EVIDENCE_PATTERNS = {
  paymentTerms: [
    /\bpayment terms?\b/i,
    /\bprompt payment\b/i,
    /\bNET\s*[- ]?\s*\d{1,3}\b/i,
    /\b(?:pay(?:ment)?|invoice)[^.!?\n]{0,100}\bwithin\s+\d{1,3}\s+(?:calendar\s+|business\s+)?days\b/i,
  ],

  financialStability: [
    /\b(?:audited|unaudited)\s+financial statements?\b/i,
    /\bproof of financial stability\b/i,
    /\bfinancial statements?\s+of\s+(?:the\s+)?(?:previous|prior|last)\s+year\b/i,
  ],

  insurance: [
    /\binsurance requirements?\b/i,
    /\bcommercial general liability\b/i,
    /\bcyber(?:\s+security)? liability\b/i,
    /\bemployers liability\b/i,
    /\bautomobile liability\b/i,
    /\bworkers['’]? compensation\b/i,
  ],

  bidBond: [
    /\bbid bond\b/i,
    /\bproposal bond\b/i,
    /\bperformance bond\b/i,
  ],
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
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(
    String(contentType || '')
  )

  return (match?.[1] || match?.[2] || '').trim() || null
}

function extractFileFromMultipart(buffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`)
  const headerSeparator = Buffer.from('\r\n\r\n')
  let cursor = 0

  while (cursor < buffer.length) {
    const boundaryStart = buffer.indexOf(boundaryBuffer, cursor)

    if (boundaryStart === -1) {
      break
    }

    const partStart = boundaryStart + boundaryBuffer.length
    const nextBoundary = buffer.indexOf(boundaryBuffer, partStart)

    if (nextBoundary === -1) {
      break
    }

    let part = buffer.slice(partStart, nextBoundary)

    if (part.slice(0, 2).toString() === '\r\n') {
      part = part.slice(2)
    }

    const headerEnd = part.indexOf(headerSeparator)

    if (headerEnd !== -1) {
      const headers = part.slice(0, headerEnd).toString('utf8')

      const isFilePart =
        /content-disposition:\s*form-data;[^\r\n]*filename=/i.test(
          headers
        )

      if (isFilePart) {
        let file = part.slice(headerEnd + headerSeparator.length)

        if (file.slice(-2).toString() === '\r\n') {
          file = file.slice(0, -2)
        }

        return file
      }
    }

    cursor = nextBoundary
  }

  return null
}

function cleanText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
      ' '
    )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function createKeywordRegex(keyword) {
  const escaped = escapeRegex(keyword)
  const useWordBoundaries = /^[A-Z0-9]{2,6}$/.test(keyword)

  return new RegExp(
    useWordBoundaries ? `\\b${escaped}\\b` : escaped,
    'gi'
  )
}

function snapStartToBoundary(text, index, maxExpansion = 140) {
  const lowerBound = Math.max(0, index - maxExpansion)

  for (let i = index; i >= lowerBound; i -= 1) {
    if (text[i] === '\n') {
      return i + 1
    }
  }

  for (let i = index; i >= lowerBound; i -= 1) {
    if (/\s/.test(text[i])) {
      return i + 1
    }
  }

  return index
}

function snapEndToBoundary(text, index, maxExpansion = 180) {
  const upperBound = Math.min(text.length, index + maxExpansion)

  for (let i = index; i < upperBound; i += 1) {
    if (text[i] === '\n') {
      return i
    }
  }

  for (let i = index; i < upperBound; i += 1) {
    if (/\s/.test(text[i])) {
      return i
    }
  }

  return index
}

function extractRelevantSections(sourceText) {
  const MAIN_BODY_CAP = 5200
  const CONTEXT_BEFORE = 130
  const CONTEXT_AFTER = 620

  if (sourceText.length <= MAX_RFP_TEXT_LENGTH) {
    return {
      text: sourceText,
      stats: {
        mode: 'full-document',
        sourceLength: sourceText.length,
        sentLength: sourceText.length,
        priorityFound: 0,
        secondaryFound: 0,
        included: [],
      },
    }
  }

  const seenRanges = []

  function collectBlocks(groups) {
    const blocks = []

    for (const group of groups) {
      const candidates = []

      for (const keyword of group.keywords) {
        const regex = createKeywordRegex(keyword)
        let match
        let keywordMatches = 0

        while (
          (match = regex.exec(sourceText)) !== null &&
          keywordMatches < 4
        ) {
          candidates.push({
            keyword,
            index: match.index,
            length: match[0].length,
          })

          keywordMatches += 1
        }
      }

      candidates.sort((a, b) => a.index - b.index)

      let groupCount = 0

      for (const candidate of candidates) {
        if (groupCount >= group.maxBlocks) {
          break
        }

        if (candidate.index < MAIN_BODY_CAP) {
          continue
        }

        const baseStart = Math.max(
          0,
          candidate.index - CONTEXT_BEFORE
        )

        const baseEnd = Math.min(
          sourceText.length,
          candidate.index + candidate.length + CONTEXT_AFTER
        )

        const start = snapStartToBoundary(sourceText, baseStart)
        const end = snapEndToBoundary(sourceText, baseEnd)

        const overlaps = seenRanges.some(
          (range) => start < range.end && end > range.start
        )

        if (overlaps) {
          continue
        }

        seenRanges.push({ start, end })

        blocks.push({
          ...group,
          keyword: candidate.keyword,
          position: candidate.index,
          text: sourceText.slice(start, end).trim(),
        })

        groupCount += 1
      }
    }

    return blocks.sort((a, b) => a.position - b.position)
  }

  const priorityBlocks = collectBlocks(
    SECTION_GROUPS.filter((group) => group.tier === 'priority')
  )

  const secondaryBlocks = collectBlocks(
    SECTION_GROUPS.filter((group) => group.tier === 'secondary')
  )

  const formatBlock = (block) =>
    `=== ${block.department.toUpperCase()}: ${block.label} ` +
    `(matched "${block.keyword}") ===\n` +
    `${block.text}\n\n---\n\n`

  let combined = sourceText.slice(0, MAIN_BODY_CAP)
  const included = []

  if (priorityBlocks.length > 0 || secondaryBlocks.length > 0) {
    combined +=
      '\n\n=== RELEVANT SECTIONS FOUND ELSEWHERE IN THE DOCUMENT ===\n\n'
  }

  for (const block of priorityBlocks) {
    combined += formatBlock(block)
    included.push(`${block.department}:${block.label}`)
  }

  for (const block of secondaryBlocks) {
    const blockText = formatBlock(block)

    if (
      combined.length + blockText.length >
      MAX_RFP_TEXT_LENGTH
    ) {
      continue
    }

    combined += blockText
    included.push(`${block.department}:${block.label}`)
  }

  const finalText = combined.trim()

  return {
    text: finalText,
    stats: {
      mode: 'section-aware',
      sourceLength: sourceText.length,
      sentLength: finalText.length,
      priorityFound: priorityBlocks.length,
      secondaryFound: secondaryBlocks.length,
      included,
    },
  }
}

function normalizeStatus(status) {
  const value = String(status || '').trim().toUpperCase()

  if (
    /\bNO[\s-]?GO\b|\bREJECT(?:ED)?\b|\bDO NOT BID\b/.test(
      value
    )
  ) {
    return 'NO-GO'
  }

  if (/^(GO|PROCEED)$/.test(value)) {
    return 'GO'
  }

  return 'ESCALATE'
}

function normalizeTaskText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getTaskMatchScore(rawTask, definition) {
  const normalizedTask = normalizeTaskText(rawTask)

  if (!normalizedTask) {
    return 0
  }

  const candidates = [
    definition.task,
    ...(definition.aliases || []),
  ].map(normalizeTaskText)

  let score = 0

  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }

    if (normalizedTask === candidate) {
      score = Math.max(score, 100)
    } else if (
      normalizedTask.includes(candidate) ||
      candidate.includes(normalizedTask)
    ) {
      score = Math.max(score, 70)
    }
  }

  return score
}

function findMatchingItem(
  items,
  definition,
  usedIndexes,
  preferredIndex,
  expectedLength
) {
  let bestIndex = -1
  let bestScore = 0

  items.forEach((item, index) => {
    if (usedIndexes.has(index)) {
      return
    }

    const score = getTaskMatchScore(item?.task, definition)

    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  })

  if (bestIndex !== -1 && bestScore >= 70) {
    usedIndexes.add(bestIndex)
    return items[bestIndex]
  }

  if (
    items.length === expectedLength &&
    items.length > preferredIndex &&
    !usedIndexes.has(preferredIndex)
  ) {
    usedIndexes.add(preferredIndex)
    return items[preferredIndex]
  }

  return null
}

function normalizeEvidence(value) {
  if (value === null || value === undefined) {
    return NOT_SPECIFIED
  }

  const text = String(value).replace(/\s+/g, ' ').trim()

  if (!text) {
    return NOT_SPECIFIED
  }

  const missingPatterns = [
    /^(?:null|n\/?a|none|unknown)$/i,
    /^not (?:specified|stated|mentioned|provided|found)(?: in (?:the )?rfp)?\.?$/i,
    /^the rfp (?:does not|doesn't) (?:specify|state|mention|provide|include)\b.*$/i,
    /^no (?:relevant )?(?:information|requirement|details?) (?:is|are) (?:specified|stated|provided|found)\b.*$/i,
  ]

  return missingPatterns.some((pattern) => pattern.test(text))
    ? NOT_SPECIFIED
    : text
}

function isNotSpecified(value) {
  return normalizeEvidence(value) === NOT_SPECIFIED
}

function normalizeReason(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function reasonIsGenericOrContradictory(reason, evidence) {
  if (!reason) {
    return true
  }

  if (
    !isNotSpecified(evidence) &&
    /\bnot (?:specified|stated|provided|mentioned|clear(?:ly stated)?)\b/i.test(
      reason
    )
  ) {
    return true
  }

  return (
    /\brequired for evaluation\b/i.test(reason) ||
    /\bmust be reviewed(?: to ensure compliance)?\b/i.test(
      reason
    ) ||
    /\brequires? (?:human )?review(?: before.*)?\b/i.test(
      reason
    ) ||
    /\bto ensure compliance\b/i.test(reason) ||
    /^always review\b/i.test(reason) ||
    /\bescalate\b/i.test(reason)
  )
}

function makeReviewReason(definition, evidence, currentReason) {
  if (isNotSpecified(evidence)) {
    return definition.missingReason
  }

  const reason = normalizeReason(currentReason)

  if (reasonIsGenericOrContradictory(reason, evidence)) {
    return (
      `The quoted ${definition.task.toLowerCase()} requirement ` +
      'must be verified by SPS before the bid decision.'
    )
  }

  return reason
}

function formatAmount(amount) {
  if (amount >= 1000000) {
    const millions = amount / 1000000

    return `$${Number.isInteger(millions)
      ? millions
      : millions.toFixed(1)}M`
  }

  return `$${Math.round(amount).toLocaleString('en-US')}`
}

function extractDollarAmounts(text) {
  const amounts = []
  const input = String(text || '')

  const pattern =
    /(?:\$|USD\s*)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(billion|million|bn|mm|m|k)?\b/gi

  let match

  while ((match = pattern.exec(input)) !== null) {
    let value = Number(match[1].replace(/,/g, ''))

    if (!Number.isFinite(value)) {
      continue
    }

    const unit = (match[2] || '').toLowerCase()

    if (unit === 'billion' || unit === 'bn') {
      value *= 1000000000
    } else if (
      unit === 'million' ||
      unit === 'mm' ||
      unit === 'm'
    ) {
      value *= 1000000
    } else if (unit === 'k') {
      value *= 1000
    }

    amounts.push(value)
  }

  return [...new Set(amounts)]
}

function extractPercentages(text) {
  const values = []
  const pattern = /\b([0-9]+(?:\.[0-9]+)?)\s*%/g
  let match

  while ((match = pattern.exec(String(text || ''))) !== null) {
    const value = Number(match[1])

    if (Number.isFinite(value)) {
      values.push(value)
    }
  }

  return [...new Set(values)]
}

function paymentWordToNumber(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/-/g, ' ')
    .trim()

  const mapping = {
    fifteen: 15,
    thirty: 30,
    'forty five': 45,
    sixty: 60,
    ninety: 90,
    'one hundred twenty': 120,
  }

  return mapping[normalized] ?? null
}

function extractPaymentDays(text) {
  const input = String(text || '')

  const netNumeric =
    /\bNET\s*[- ]?\s*([0-9]{1,3})\b/i.exec(input)

  if (netNumeric) {
    return Number(netNumeric[1])
  }

  const parenthesized =
    /\b(?:within|net)\s+[a-z-]+\s*\(([0-9]{1,3})\)\s+(?:calendar\s+|business\s+)?days?\b/i.exec(
      input
    )

  if (parenthesized) {
    return Number(parenthesized[1])
  }

  const paymentNumeric =
    /\b(?:pay(?:ment)?|paid|invoice)[^.!?\n]{0,100}\bwithin\s+([0-9]{1,3})\s+(?:calendar\s+|business\s+)?days?\b/i.exec(
      input
    )

  if (paymentNumeric) {
    return Number(paymentNumeric[1])
  }

  const wordMatch =
    /\b(?:NET\s+|within\s+)(fifteen|thirty|forty[- ]five|sixty|ninety|one hundred twenty)\s+(?:calendar\s+|business\s+)?days?\b/i.exec(
      input
    )

  if (wordMatch) {
    return paymentWordToNumber(wordMatch[1])
  }

  return null
}

function splitIntoRequirementSegments(sourceText) {
  return String(sourceText || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function hasFinancialDocumentationRequirement(sourceText) {
  const segments = splitIntoRequirementSegments(sourceText)

  return segments.some((segment) => {
    const mentionsFinancialDocuments =
      /\b(?:audited|unaudited)?\s*financial statements?\b/i.test(
        segment
      ) ||
      /\bproof of financial stability\b/i.test(segment) ||
      /\bfinancial (?:records?|reports?)\b/i.test(segment)

    if (!mentionsFinancialDocuments) {
      return false
    }

    const explicitlyNotRequired =
      /\b(?:is|are|will be|shall be)?\s*not required\b/i.test(
        segment
      ) ||
      /\bno\s+(?:audited\s+|unaudited\s+)?financial statements?\s+(?:are\s+)?required\b/i.test(
        segment
      )

    if (explicitlyNotRequired) {
      return false
    }

    const requirementLanguage =
      /\b(?:must|shall|required|requirement|submit|provide|include|attach|demonstrate|furnish)\b/i.test(
        segment
      )

    return requirementLanguage || segment.length <= 220
  })
}

function sourceSnippetScore(snippet, definitionId) {
  let score = 0

  if (
    /\b(?:must|shall|required|submit|provide|include|attach|eligible|certif(?:y|ied)|register)\b/i.test(
      snippet
    )
  ) {
    score += 4
  }

  if (/\$|USD\s*[0-9]/i.test(snippet)) {
    score += 3
  }

  if (/\b[0-9]+\s*%/i.test(snippet)) {
    score += 2
  }

  if (
    /\b[0-9]{1,3}\s+(?:calendar\s+|business\s+)?days?\b/i.test(
      snippet
    )
  ) {
    score += 2
  }

  if (/\bsection\b|\bexhibit\b|\battachment\b/i.test(snippet)) {
    score += 1
  }

  if (
    definitionId === 'paymentTerms' &&
    /\bNET\s*[- ]?\s*\d+|\bpay\s+within\s+\d+\s+days?/i.test(
      snippet
    )
  ) {
    score += 6
  }

  if (
    definitionId === 'insurance' &&
    /\bliability|insurance|coverage required\b/i.test(snippet)
  ) {
    score += 3
  }

  if (
    definitionId === 'bidBond' &&
    /\b(?:bid|proposal|performance) bonds?\b/i.test(snippet)
  ) {
    score += 4
  }

  return score
}

function extractSourceSection(
  sourceText,
  startPattern,
  endPattern,
  maxLength = 2400
) {
  const startRegex = new RegExp(
    startPattern.source,
    startPattern.flags.replace(/g/g, '')
  )

  const startMatch = startRegex.exec(sourceText)

  if (!startMatch) {
    return null
  }

  const start = startMatch.index
  const searchAfter = start + startMatch[0].length
  let end = Math.min(sourceText.length, start + maxLength)

  if (endPattern) {
    const endRegex = new RegExp(
      endPattern.source,
      endPattern.flags.replace(/g/g, '')
    )

    const endMatch = endRegex.exec(sourceText.slice(searchAfter))

    if (endMatch) {
      end = Math.min(end, searchAfter + endMatch.index)
    }
  }

  const section = sourceText
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .trim()

  return section || null
}

function compactEvidence(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateEvidence(value, maxLength = 1300) {
  const text = compactEvidence(value)

  if (!text || text.length <= maxLength) {
    return text || null
  }

  const sentenceCut = Math.max(
    text.lastIndexOf('. ', maxLength),
    text.lastIndexOf('; ', maxLength),
    text.lastIndexOf(': ', maxLength)
  )

  if (sentenceCut >= Math.floor(maxLength * 0.65)) {
    return `${text.slice(0, sentenceCut + 1).trim()}...`
  }

  const wordCut = text.lastIndexOf(' ', maxLength)
  const cut = wordCut > 0 ? wordCut : maxLength

  return `${text.slice(0, cut).trim()}...`
}

function combineEvidence(parts, maxLength = 1500) {
  const seen = new Set()
  const cleaned = []

  for (const part of parts) {
    const text = compactEvidence(part)

    if (!text) {
      continue
    }

    const key = text.toLowerCase()

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    cleaned.push(text)
  }

  if (cleaned.length === 0) {
    return null
  }

  return truncateEvidence(cleaned.join(' | '), maxLength)
}

function extractPatternSnippet(
  sourceText,
  patterns,
  options = {}
) {
  const {
    before = 140,
    after = 700,
    maxLength = 1050,
    maxMatchesPerPattern = 6,
    definitionId = '',
  } = options

  const candidates = []

  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g')
      ? pattern.flags
      : `${pattern.flags}g`

    const regex = new RegExp(pattern.source, flags)
    let match
    let count = 0

    while (
      (match = regex.exec(sourceText)) !== null &&
      count < maxMatchesPerPattern
    ) {
      const baseStart = Math.max(0, match.index - before)
      const baseEnd = Math.min(
        sourceText.length,
        match.index + match[0].length + after
      )

      const start = snapStartToBoundary(sourceText, baseStart)
      const end = snapEndToBoundary(sourceText, baseEnd)
      const snippet = truncateEvidence(
        sourceText.slice(start, end),
        maxLength
      )

      if (snippet) {
        candidates.push({
          snippet,
          position: match.index,
          score:
            sourceSnippetScore(snippet, definitionId) +
            Math.min(match[0].length / 40, 3),
        })
      }

      count += 1

      if (match[0].length === 0) {
        regex.lastIndex += 1
      }
    }
  }

  if (candidates.length === 0) {
    return null
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.position - b.position
  )

  return candidates[0].snippet
}

function normalizeForSourceComparison(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9$%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function evidenceAppearsInSource(sourceText, evidence) {
  if (isNotSpecified(evidence)) {
    return false
  }

  const source = normalizeForSourceComparison(sourceText)
  const candidate = normalizeForSourceComparison(evidence)

  if (!candidate || candidate.length < 12) {
    return false
  }

  if (source.includes(candidate)) {
    return true
  }

  const stopWords = new Set([
    'the',
    'and',
    'for',
    'with',
    'that',
    'this',
    'from',
    'will',
    'shall',
    'must',
    'their',
    'have',
    'has',
    'are',
    'was',
    'were',
    'into',
    'under',
    'such',
    'any',
    'all',
    'its',
    'they',
    'them',
  ])

  const tokens = candidate
    .split(' ')
    .filter((token) => token.length > 2 && !stopWords.has(token))

  if (tokens.length < 5) {
    return false
  }

  const windowSize = Math.min(7, tokens.length)

  for (let index = 0; index <= tokens.length - windowSize; index += 1) {
    const phrase = tokens
      .slice(index, index + windowSize)
      .join(' ')

    if (source.includes(phrase)) {
      return true
    }
  }

  return false
}

function buildTieredInsuranceEvidence(sourceText) {
  const cyberSection = extractSourceSection(
    sourceText,
    /\b6\.\s*Cyber Security Liability:/i,
    /\b(?:Exhibit C|C\.\s+[A-Z][A-Z ]{3,}:)/i,
    3000
  )

  if (!cyberSection) {
    return null
  }

  const amountRangePattern =
    '(\\$[0-9,.]+\\s*[MBK]?\\s*[–—-]\\s*\\$[0-9,.]+\\s*[MBK]?)'

  const tier1 = new RegExp(
    `Tier 1:[\\s\\S]{0,650}?Minimum Coverage Required:\\s*${amountRangePattern}`,
    'i'
  ).exec(cyberSection)?.[1]

  const tier2 = new RegExp(
    `Tier 2:[\\s\\S]{0,650}?Minimum Coverage Required:\\s*${amountRangePattern}`,
    'i'
  ).exec(cyberSection)?.[1]

  const tier3 = new RegExp(
    `Tier 3:[\\s\\S]{0,650}?Minimum Coverage Required:\\s*${amountRangePattern}`,
    'i'
  ).exec(cyberSection)?.[1]

  if (!tier1 && !tier2 && !tier3) {
    return truncateEvidence(cyberSection, 1500)
  }

  const tierEvidence = []

  if (tier1) {
    tierEvidence.push(`Tier 1: ${tier1}`)
  }

  if (tier2) {
    tierEvidence.push(`Tier 2: ${tier2}`)
  }

  if (tier3) {
    tierEvidence.push(`Tier 3: ${tier3}`)
  }

  return (
    'B. INSURANCE, 6. Cyber Security Liability - ' +
    'coverage is based on the contractor\'s level of data access; ' +
    `${tierEvidence.join('; ')}.`
  )
}

function findBestSourceSnippet(sourceText, definitionId) {
  if (definitionId === 'paymentTerms') {
    const paymentSection = extractPatternSnippet(
      sourceText,
      [
        /\b(?:the university|agency|customer)\s+will\s+pay\s+within\s+\d{1,3}\s+(?:calendar\s+|business\s+)?days?\b/i,
        /\bpayment terms?\b/i,
        /\bprompt payment discounts?\b/i,
        /\bNET\s*[- ]?\s*\d{1,3}\b/i,
      ],
      {
        before: 120,
        after: 650,
        maxLength: 1050,
        definitionId,
      }
    )

    if (paymentSection) {
      return paymentSection
    }
  }

  if (definitionId === 'bidBond') {
    const bidBondSection = extractSourceSection(
      sourceText,
      /\bN\.\s*Proposal Bonds?:/i,
      /\bO\.\s*Alternative Forms of Security:/i,
      1800
    )

    if (bidBondSection) {
      return truncateEvidence(bidBondSection, 1300)
    }
  }

  if (definitionId === 'insurance') {
    const tieredEvidence = buildTieredInsuranceEvidence(sourceText)

    if (tieredEvidence) {
      return tieredEvidence
    }

    const insuranceSection = extractSourceSection(
      sourceText,
      /\bB\.\s*INSURANCE:/i,
      /\b(?:Exhibit C|C\.\s+[A-Z][A-Z ]{3,}:)/i,
      3800
    )

    if (insuranceSection) {
      return truncateEvidence(insuranceSection, 1500)
    }
  }

  const patterns = FINANCIAL_EVIDENCE_PATTERNS[definitionId]

  if (!patterns) {
    return null
  }

  return extractPatternSnippet(sourceText, patterns, {
    before: 160,
    after: 700,
    maxLength: 1150,
    definitionId,
  })
}

function findVerificationSourceEvidence(
  sourceText,
  definitionId
) {
  switch (definitionId) {
    case 'relevantExperience': {
      const section = extractSourceSection(
        sourceText,
        /\bA\.\s*Experience and References(?:\s*\([^)]*points?\))?/i,
        /\bB\.\s*Capability and Skill\b/i,
        1900
      )

      return (
        truncateEvidence(section, 1400) ||
        extractPatternSnippet(
          sourceText,
          [
            /\bminimum of\s+(?:five|\(?5\)?)\s+(?:institutions|organizations|references)\b/i,
            /\bdemonstrated (?:ability|experience)[\s\S]{0,160}\b(?:enterprise|site search|past performance|personalization)\b/i,
            /\brelevant experience\b/i,
            /\bpast performance\b/i,
          ],
          {
            before: 120,
            after: 950,
            maxLength: 1300,
            definitionId,
          }
        )
      )
    }

    case 'registrationRequirement':
      return extractPatternSnippet(
        sourceText,
        [
          /\bOnly Master Contractors?[\s\S]{0,500}?eligible to submit (?:a )?bid\b/i,
          /\bMaster Contractor\b/i,
          /\bvendor eligibility\b/i,
          /\b(?:offeror|contractor|vendor)s?\s+must\s+(?:hold|possess|maintain)\s+(?:a|an)\s+(?:valid\s+)?(?:business|professional|occupational)?\s*(?:license|certification)\b/i,
        ],
        {
          before: 100,
          after: 750,
          maxLength: 1050,
          definitionId,
        }
      )

    case 'financialStatementPreviousYear':
      return extractPatternSnippet(
        sourceText,
        [
          /\b(?:previous|prior|last)\s+(?:fiscal\s+)?year(?:'s)?\s+(?:audited\s+|unaudited\s+)?financial statements?\b/i,
          /\bfinancial statements?\s+(?:for|of)\s+(?:the\s+)?(?:previous|prior|last)\s+(?:fiscal\s+)?year\b/i,
          /\b(?:one|two|three|four|five|\d+)\s+years?\s+of\s+(?:audited\s+|unaudited\s+)?financial statements?\b/i,
        ],
        {
          before: 120,
          after: 600,
          maxLength: 900,
          definitionId,
        }
      )

    case 'qualifiedPersonnel': {
      const capabilitySection = extractSourceSection(
        sourceText,
        /\bB\.\s*Capability and Skill(?:\s*\([^)]*points?\))?/i,
        /\bC\.\s*Approach and Methodology\b/i,
        1600
      )

      const personnelStandards = extractSourceSection(
        sourceText,
        /\bA\.\s*COMPANY PERSONNEL STANDARDS:/i,
        /\bB\.\s*INSURANCE:/i,
        1300
      )

      const direct = extractPatternSnippet(
        sourceText,
        [
          /\bidentify roles and responsibilities of key personnel[\s\S]{0,450}?qualifications and work history\b/i,
          /\bprovide resumes?\b/i,
          /\bqualified personnel\b/i,
          /\btrained personnel\b/i,
        ],
        {
          before: 100,
          after: 700,
          maxLength: 1000,
          definitionId,
        }
      )

      return combineEvidence(
        [capabilitySection, personnelStandards, direct],
        1500
      )
    }

    case 'technicalKnowhow':
      return extractPatternSnippet(
        sourceText,
        [
          /\bdemonstrated experience in designing, implementing[\s\S]{0,500}?(?:search|analytics|personalization|accessibility)\b/i,
          /\btechnical expertise\b/i,
          /\btechnical knowhow\b/i,
          /\btechnical knowledge\b/i,
          /\bexperience in (?:designing|implementing|supporting)[\s\S]{0,300}\b/i,
        ],
        {
          before: 120,
          after: 900,
          maxLength: 1200,
          definitionId,
        }
      )

    case 'complianceOfLaw': {
      const lawsSection = extractSourceSection(
        sourceText,
        /\bD\.\s*APPLICABLE LAWS AND COURTS:/i,
        /\bF\.\s*ARBITRATION:/i,
        1700
      )

      const statutory = extractPatternSnippet(
        sourceText,
        [
          /\bState Finance and Procurement Article[\s\S]{0,450}\b/i,
          /\bcontractor(?:'s|s)?\s+certif(?:y|ies)[\s\S]{0,650}\b(?:Civil Rights Act|Immigration Reform|debarred|antitrust)\b/i,
          /\bapplicable laws and courts\b/i,
          /\bgoverned by the laws? of\b/i,
        ],
        {
          before: 100,
          after: 900,
          maxLength: 1200,
          definitionId,
        }
      )

      return combineEvidence([lawsSection, statutory], 1500)
    }

    case 'stateRegistration': {
      const explicitRegistration = extractPatternSnippet(
        sourceText,
        [
          /\b(?:is|are)\s+(?:your|the)\s+(?:firm|company|contractor)\s+registered with[\s\S]{0,180}?State Corporation Commission\b/i,
          /\bmust\s+(?:be\s+)?registered with[\s\S]{0,180}?State Corporation Commission\b/i,
          /\b(?:firm|company|contractor|offeror|vendor)[\s\S]{0,120}?State Corporation Commission[\s\S]{0,120}?(?:registration|identification|ID|number)\b/i,
        ],
        {
          before: 90,
          after: 420,
          maxLength: 750,
          definitionId,
        }
      )

      if (explicitRegistration) {
        return explicitRegistration
      }

      return extractPatternSnippet(
        sourceText,
        [
          /\b(?:contractor|offeror|vendor|firm)\s+(?:must|shall)\s+(?:be\s+)?authorized to do business in\s+[A-Z][A-Za-z ]+\b/i,
          /\bstate registration requirement\b/i,
        ],
        {
          before: 90,
          after: 420,
          maxLength: 750,
          definitionId,
        }
      )
    }

    case 'eVerify':
      return (
        truncateEvidence(
          extractSourceSection(
            sourceText,
            /\bS\.\s*E-VERIFY REQUIREMENT OF ANY CONTRACTOR:/i,
            /\bT\.\s*EXCLUSIVITY:/i,
            1500
          ),
          1200
        ) ||
        extractPatternSnippet(
          sourceText,
          [/\bE-Verify\b/i, /\bEVerify\b/i],
          {
            before: 100,
            after: 900,
            maxLength: 1100,
            definitionId,
          }
        )
      )

    case 'contractualObligations': {
      const claims = extractSourceSection(
        sourceText,
        /\bM\.\s*CONTRACTUAL CLAIMS PROCEDURE:/i,
        /\bN\.\s*DEFAULT:/i,
        1500
      )

      const indemnity = extractSourceSection(
        sourceText,
        /\bY\.\s*INDEMNIFICATION:/i,
        /\bZ\.\s*INDEPENDENT CONTRACTOR:/i,
        1200
      )

      const termination = extractSourceSection(
        sourceText,
        /\bKK\.\s*TERMINATION WITH CAUSE:/i,
        /\bLL\.\s*TERMINATION BY UNIVERSITY FOR CONVENIENCE:/i,
        1500
      )

      const generic = extractPatternSnippet(
        sourceText,
        [
          /\bcontractual obligations?\b/i,
          /\btermination with cause\b/i,
          /\bindemnification\b/i,
          /\bcontractual claims?\b/i,
        ],
        {
          before: 100,
          after: 750,
          maxLength: 1000,
          definitionId,
        }
      )

      return combineEvidence(
        [claims, termination, indemnity, generic],
        1600
      )
    }

    case 'requiredForms': {
      const submissionForms = extractSourceSection(
        sourceText,
        /\bB\.\s*Submission of Proposals:/i,
        /\b5\.\s*Exceptions:/i,
        1900
      )

      const direct = extractPatternSnippet(
        sourceText,
        [
          /\breturn of the RFP cover sheet[\s\S]{0,650}?Substitute W-?9\b/i,
          /\bComplete Pricing Pages, Contractor Data Sheet[\s\S]{0,500}\b/i,
          /\bSubstitute W-?9\b/i,
          /\bFEI\/FIN\s*#\b/i,
          /\bownership percentage\b/i,
        ],
        {
          before: 100,
          after: 800,
          maxLength: 1150,
          definitionId,
        }
      )

      return combineEvidence([submissionForms, direct], 1500)
    }

    case 'smallBusiness': {
      const reserve = extractPatternSnippet(
        sourceText,
        [
          /\bSmall Business Reserve Procurement[\s\S]{0,750}?eligible for the award\b/i,
          /\baward will be limited to certified small business vendors\b/i,
        ],
        {
          before: 80,
          after: 850,
          maxLength: 1200,
          definitionId,
        }
      )

      const swamSection = extractSourceSection(
        sourceText,
        /\bC\.\s*The University(?:'s|’s) SWAM Plan:/i,
        /\bD\.\s*Authorized Contract Participation:/i,
        2300
      )

      const scoredSwam = extractPatternSnippet(
        sourceText,
        [
          /\bSmall, Women-Owned, and Minority-Owned Business Participation Plan[\s\S]{0,950}\b/i,
          /\bSWAM Plan[\s\S]{0,700}?points?\b/i,
        ],
        {
          before: 100,
          after: 1000,
          maxLength: 1300,
          definitionId,
        }
      )

      return combineEvidence(
        [reserve, swamSection, scoredSwam],
        1600
      )
    }

    case 'workersCompensation':
      return (
        truncateEvidence(
          extractSourceSection(
            sourceText,
            /\b1\.\s*Workers[\u2019']? Compensation\s*-/i,
            /\b2\.\s*Employers Liability Insurance\s*-/i,
            1400
          ),
          1150
        ) ||
        extractPatternSnippet(
          sourceText,
          [/\bworkers[\u2019']? compensation insurance\b/i],
          {
            before: 120,
            after: 750,
            maxLength: 1050,
            definitionId,
          }
        )
      )

    case 'iranDisclosure':
      return extractPatternSnippet(
        sourceText,
        [
          /\bBusiness with Iran disclosure\b/i,
          /\bIran disclosure\b/i,
          /\bbusiness activities? with Iran\b/i,
          /\bIran Divestment Act\b/i,
        ],
        {
          before: 100,
          after: 650,
          maxLength: 900,
          definitionId,
        }
      )

    case 'submissionDeadlines': {
      const proposalDeadline = extractPatternSnippet(
        sourceText,
        [
          /\bDue Date and Time:\s*[^\n]{0,160}/i,
          /\bDue\s*\/\s*Close Date\s*[^\n]{0,160}/i,
          /\bsealed proposals[\s\S]{0,280}?until\s+[^.\n]{0,120}/i,
          /\bproposals? (?:are|is) due\s+[^.\n]{0,140}/i,
          /\bsubmission deadline\b/i,
        ],
        {
          before: 60,
          after: 350,
          maxLength: 650,
          definitionId,
        }
      )

      const questionDeadline = extractPatternSnippet(
        sourceText,
        [
          /\bquestions due[\s\S]{0,180}/i,
          /\ball inquir(?:y|ies|es) and questions[\s\S]{0,420}?due\s+[^.\n]{0,160}/i,
          /\bquestion deadline\b/i,
        ],
        {
          before: 60,
          after: 300,
          maxLength: 600,
          definitionId,
        }
      )

      return combineEvidence(
        [proposalDeadline, questionDeadline],
        1050
      )
    }

    case 'documentCompliance': {
      const passwordInstructions = extractSourceSection(
        sourceText,
        /\bAdditional Instructions\b/i,
        /\bQuestions Due\b/i,
        1200
      )

      const proposalRequirements = extractSourceSection(
        sourceText,
        /\bXI\.\s*PROPOSAL PREPARATION AND SUBMISSION REQUIREMENTS:/i,
        /\bXII\.\s*FEES AND PRICING:/i,
        2500
      )

      const direct = extractPatternSnippet(
        sourceText,
        [
          /\ball bids must be password protected[\s\S]{0,650}/i,
          /\bproposals should be organized in the order[\s\S]{0,850}/i,
          /\btable of contents[\s\S]{0,450}/i,
          /\bone electronic response via flash drive[\s\S]{0,500}/i,
        ],
        {
          before: 100,
          after: 900,
          maxLength: 1200,
          definitionId,
        }
      )

      return combineEvidence(
        [passwordInstructions, proposalRequirements, direct],
        1700
      )
    }

    case 'signatoryAuthority':
      return extractPatternSnippet(
        sourceText,
        [
          /\bAn Agent authorized to bind the company[\s\S]{0,180}?shall sign\b/i,
          /\bproposals? shall be signed by an authorized representative\b/i,
          /\bauthorized signatory\b/i,
          /\bauthorized signature\b/i,
        ],
        {
          before: 100,
          after: 500,
          maxLength: 800,
          definitionId,
        }
      )

    case 'vendorRegistration':
      return extractPatternSnippet(
        sourceText,
        [
          /\bAll Contractors desiring to provide goods and\/or services[\s\S]{0,420}?must register (?:here|in eVA)\b/i,
          /\bContractors must register in eVA\b/i,
          /\bmust be registered (?:in|with) (?:the )?(?:vendor|supplier|procurement)\s*(?:portal|system)\b/i,
          /\bvendor registration\b/i,
        ],
        {
          before: 100,
          after: 650,
          maxLength: 950,
          definitionId,
        }
      )

    case 'scopeAlignment':
      return (
        truncateEvidence(
          extractSourceSection(
            sourceText,
            /\bIV\.\s*STATEMENT OF NEEDS:/i,
            /\bV\.\s*CONTRACT AND RENEWAL TERM:/i,
            2400
          ),
          1600
        ) ||
        extractPatternSnippet(
          sourceText,
          [
            /\bscope of services\b/i,
            /\bstatement of work\b/i,
            /\bthe selected contractor shall provide\b/i,
          ],
          {
            before: 100,
            after: 1200,
            maxLength: 1500,
            definitionId,
          }
        )
      )

    case 'technicalCapabilities': {
      const aiSearch = extractPatternSnippet(
        sourceText,
        [
          /\bAI-Enhanced Search:[\s\S]{0,750}/i,
          /\bUnified Search Experience:[\s\S]{0,650}/i,
          /\btechnical requirements\b/i,
        ],
        {
          before: 80,
          after: 850,
          maxLength: 1050,
          definitionId,
        }
      )

      const technicalFit = extractPatternSnippet(
        sourceText,
        [
          /\bIntegration and Technical Fit:[\s\S]{0,800}/i,
          /\bcompatibility with Drupal[\s\S]{0,550}/i,
        ],
        {
          before: 80,
          after: 850,
          maxLength: 1050,
          definitionId,
        }
      )

      return combineEvidence([aiSearch, technicalFit], 1450)
    }

    case 'industryStandards': {
      const wcag = extractPatternSnippet(
        sourceText,
        [
          /\bWCAG\s*2\.1\s*AA[\s\S]{0,500}/i,
          /\baccessibility standards[\s\S]{0,500}/i,
        ],
        {
          before: 90,
          after: 600,
          maxLength: 850,
          definitionId,
        }
      )

      const section508 = extractSourceSection(
        sourceText,
        /\bAA\.\s*INFORMATION TECHNOLOGY ACCESS:/i,
        /\bBB\.\s*IMMIGRATION REFORM/i,
        1800
      )

      return combineEvidence([wcag, section508], 1500)
    }

    case 'securityRequirements': {
      const securityFit = extractPatternSnippet(
        sourceText,
        [
          /\bsecurity and authentication considerations[\s\S]{0,550}/i,
          /\bdata security requirements?\b/i,
          /\bencryption requirements?\b/i,
        ],
        {
          before: 100,
          after: 650,
          maxLength: 900,
          definitionId,
        }
      )

      const glba = extractSourceSection(
        sourceText,
        /\bX\.\s*GRAMM-LEACH-BLILEY ACT:/i,
        /\bY\.\s*INDEMNIFICATION:/i,
        1100
      )

      const cyber = buildTieredInsuranceEvidence(sourceText)

      return combineEvidence([securityFit, glba, cyber], 1600)
    }

    case 'integrationNeeds':
      return extractPatternSnippet(
        sourceText,
        [
          /\bIntegration and Technical Fit:[\s\S]{0,850}/i,
          /\bcompatibility with Drupal[\s\S]{0,650}/i,
          /\bavailable APIs? and modules[\s\S]{0,550}/i,
          /\bintegrat(?:e|ion) with the (?:university|agency)(?:'s|’s) existing[\s\S]{0,450}/i,
          /\binterface requirements?\b/i,
        ],
        {
          before: 100,
          after: 850,
          maxLength: 1150,
          definitionId,
        }
      )

    default:
      return null
  }
}

function buildVerificationReason(
  definition,
  evidence
) {
  if (isNotSpecified(evidence)) {
    return definition.missingReason
  }

  const text = compactEvidence(evidence)

  switch (definition.id) {
    case 'relevantExperience':
      if (
        /\bminimum of\s+(?:five|\(?5\)?)[\s\S]{0,220}\bpast five\s*\(?5\)?\s*years?\b/i.test(
          text
        )
      ) {
        return 'The RFP requires relevant work for at least five comparable institutions or organizations within the past five years, so SPS must verify qualifying projects and references.'
      }

      return 'The RFP requires documented relevant experience or past performance, which SPS must verify against its project history and references.'

    case 'registrationRequirement':
      if (/\bMaster Contractor\b/i.test(text)) {
        return 'Bidding is limited to eligible Master Contractors under the named contract, so SPS must verify that it holds the required eligibility.'
      }

      return 'The RFP imposes a vendor eligibility, license, or certification condition that SPS must verify before bidding.'

    case 'financialStatementPreviousYear':
      return 'The RFP requests prior-year financial statements or equivalent historical financial documentation, so SPS must verify that the required records are available.'

    case 'qualifiedPersonnel':
      if (/\bresumes?|roles and responsibilities|work history\b/i.test(text)) {
        return 'The proposal must identify key personnel and provide their roles, resumes, qualifications, and relevant work history for SPS review.'
      }

      return 'The RFP requires trained or qualified personnel, so SPS must verify staffing, credentials, and availability.'

    case 'technicalKnowhow':
      return 'The RFP requires demonstrated technical expertise relevant to the requested solution, so SPS must verify that its experience and methods satisfy the stated expectations.'

    case 'complianceOfLaw':
      if (/\bVirginia\b/i.test(text)) {
        return 'The resulting contract is governed by Virginia law and includes statutory compliance obligations that require legal review.'
      }

      if (/\bMaryland\b/i.test(text)) {
        return 'The solicitation imposes Maryland statutory eligibility and compliance requirements that require legal verification.'
      }

      return 'The RFP contains applicable-law and regulatory obligations that require SPS legal verification.'

    case 'stateRegistration':
      if (/\b(?:is|are)\s+(?:your|the)\s+(?:firm|company|contractor)\s+registered\b/i.test(text)) {
        return 'The solicitation asks for the firm\'s State Corporation Commission registration status and identifier, so SPS must verify and disclose its current registration.'
      }

      return 'The RFP requires or references authorization to do business in the issuing state, so SPS must verify its state-registration status.'

    case 'eVerify': {
      const employeeThreshold = /\b(?:more than|over|greater than)\s+(?:an average of\s+)?([0-9]+)\s+employees\b/i.exec(
        text
      )?.[1]

      const contractThreshold = extractDollarAmounts(text)[0]

      if (employeeThreshold && contractThreshold) {
        return `E-Verify applies to employers above ${employeeThreshold} employees entering contracts over ${formatAmount(
          contractThreshold
        )}, so SPS must verify whether the condition applies and confirm enrollment.`
      }

      return 'The RFP contains an E-Verify participation requirement that SPS must assess and verify before contract award.'
    }

    case 'contractualObligations':
      return 'The contract includes material claims, termination, indemnification, or continuing-performance obligations that require SPS legal review.'

    case 'requiredForms': {
      const hasTaxInformation = /\bFEI\/FIN|Taxpayer Identification|W-?9\b/i.test(text)
      const hasOwnerName = /\bowner name\b/i.test(text)
      const hasOwnershipPercentage = /\bownership percentage\b/i.test(text)

      if (hasTaxInformation && (!hasOwnerName || !hasOwnershipPercentage)) {
        return 'The RFP requires tax-identification and proposal forms, but owner name and ownership percentage are not both clearly specified, so the bid team must verify the complete form set.'
      }

      if (/\bcover sheet|Pricing Pages|Contractor Data Sheet|SWAM Plan|W-?9\b/i.test(text)) {
        return 'The proposal package must include the signed cover sheet, required pricing and contractor forms, applicable participation plans, and tax documentation.'
      }

      return 'The RFP requires specified forms and identifying information that the bid team must complete and verify.'
    }

    case 'smallBusiness':
      if (/\baward will be limited to certified small business vendors\b/i.test(text)) {
        return 'Award is restricted to certified Small Business Reserve vendors, so SPS must verify that it holds the required certification.'
      }

      if (/\bSWAM\b/i.test(text) && /\bpoints?\b/i.test(text)) {
        return 'The RFP requires SWAM participation information and assigns evaluation points to the participation plan, so SPS must prepare and verify the required plan and certifications.'
      }

      return 'The RFP contains small-business, MBE, WBE, SWaM, or similar participation requirements that the bid team must verify.'

    case 'workersCompensation':
      return 'The contractor must maintain workers compensation coverage in accordance with the stated statutory and contract requirements throughout performance.'

    case 'iranDisclosure':
      return 'The RFP requires a Business with Iran disclosure or certification that the bid team must complete and verify.'

    case 'submissionDeadlines': {
      const dates = text.match(
        /(?:\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}(?:\s+(?:NLT\s+)?\d{1,2}:\d{2}\s*(?:A\.?M\.?|P\.?M\.?|AM|PM|EDT|EST|Local Time)*)?|\b\d{1,2}\/\d{1,2}\/\d{4}(?:\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM|EDT|EST)*)?)/gi
      ) || []

      const uniqueDates = [...new Set(dates.map((date) => compactEvidence(date)))]

      if (uniqueDates.length >= 2) {
        return `The RFP states binding proposal and question deadlines (${uniqueDates.slice(0, 2).join(' and ')}), which the bid team must track and meet exactly.`
      }

      if (uniqueDates.length === 1) {
        return `The RFP states a binding submission deadline of ${uniqueDates[0]}, which the bid team must meet exactly.`
      }

      return 'The RFP states binding proposal and/or question deadlines that the bid team must track and meet exactly.'
    }

    case 'documentCompliance':
      if (/\bpassword protected|DO NOT SEND PASSWORDS|e-mailed separately\b/i.test(text)) {
        return 'The bid must follow the stated password-protection and separate-email submission procedure exactly.'
      }

      return 'The proposal must follow the stated organization, format, copy, attachment, and submission instructions to avoid rejection or reduced scoring.'

    case 'signatoryAuthority':
      return 'The proposal must be signed by an authorized representative or agent who can legally bind the company.'

    case 'vendorRegistration':
      if (/\beVA\b/i.test(text)) {
        return 'Contractors must be registered in eVA and comply with the applicable supplier transaction requirements before doing business with the Commonwealth.'
      }

      return 'The RFP requires registration in the applicable vendor or procurement portal, which SPS must verify before submission.'

    case 'scopeAlignment':
      return 'The RFP defines a substantive scope of services and deliverables that SPS must compare with its actual offerings, resources, and delivery capacity.'

    case 'technicalCapabilities':
      if (/\bDrupal\b/i.test(text)) {
        return 'The solution requires AI-enabled search capabilities, administration and analytics features, and compatibility with Drupal-related technologies; SPS must verify full technical fit.'
      }

      return 'The RFP contains detailed technical and functional requirements that SPS must compare against its current capabilities.'

    case 'industryStandards':
      if (/\bWCAG\s*2\.1\s*AA\b/i.test(text) || /\bSection 508\b/i.test(text)) {
        return 'The solution must support WCAG 2.1 AA, Section 508, or related accessibility standards, so SPS must verify demonstrable compliance.'
      }

      return 'The RFP names industry, accessibility, or technical standards that SPS must verify it can meet.'

    case 'securityRequirements':
      if (/\bGLBA|data breach|ransomware|cyber liability|authentication\b/i.test(text)) {
        return 'The RFP includes authentication, data-protection, breach-response, or cyber-risk requirements that SPS must validate with its security and legal teams.'
      }

      return 'The RFP contains security, privacy, or access-control requirements that SPS must assess before committing.'

    case 'integrationNeeds':
      if (/\bDrupal\b/i.test(text) && /\bAPI/i.test(text)) {
        return 'The solution must support Drupal-related technologies, APIs or modules, cross-site indexing, and integration with the existing digital environment.'
      }

      return 'The RFP specifies integration, interface, API, or interoperability needs that SPS must verify against its solution architecture.'

    default:
      return `The quoted ${definition.task.toLowerCase()} requirement must be verified by SPS before the bid decision.`
  }
}

function applyFinancialDecision(definition, item, sourceText) {
  let evidence = item.evidence

  const sourceEvidence =
    definition.id === 'profitability'
      ? null
      : findBestSourceSnippet(sourceText, definition.id)

  if (
    ['paymentTerms', 'insurance', 'bidBond'].includes(
      definition.id
    ) &&
    sourceEvidence
  ) {
    evidence = sourceEvidence
  } else if (
    isNotSpecified(evidence) &&
    definition.id !== 'profitability' &&
    !(
      definition.id === 'financialStability' &&
      !hasFinancialDocumentationRequirement(sourceText)
    )
  ) {
    evidence = sourceEvidence || NOT_SPECIFIED
  } else if (
    !isNotSpecified(evidence) &&
    !evidenceAppearsInSource(sourceText, evidence) &&
    sourceEvidence
  ) {
    evidence = sourceEvidence
  }

  const combined = `${evidence}\n${item.reason}`

  if (definition.id === 'paymentTerms') {
    if (isNotSpecified(evidence)) {
      return {
        ...item,
        evidence: NOT_SPECIFIED,
        status: 'ESCALATE',
        reason: definition.missingReason,
      }
    }

    const days = extractPaymentDays(combined)

    if (days === null) {
      return {
        ...item,
        evidence,
        status: 'ESCALATE',
        reason:
          'Payment language is present, but a clear NET payment period could not be confirmed automatically.',
      }
    }

    return {
      ...item,
      evidence,
      status: days <= 30 ? 'GO' : 'ESCALATE',
      reason:
        days <= 30
          ? `The RFP states payment terms of ${days} days, which are within the SPS NET30 threshold.`
          : `The RFP states payment terms of ${days} days, which exceed the SPS NET30 threshold and require escalation.`,
    }
  }

  if (definition.id === 'financialStability') {
    const requiresFinancialDocuments =
      hasFinancialDocumentationRequirement(sourceText)

    if (!requiresFinancialDocuments) {
      return {
        ...item,
        status: 'GO',
        evidence: NOT_SPECIFIED,
        reason:
          'The RFP does not require financial statements or other proof of financial stability, so no financial-stability obstacle is identified.',
      }
    }

    const groundedEvidence =
      sourceEvidence ||
      (evidenceAppearsInSource(sourceText, evidence)
        ? evidence
        : NOT_SPECIFIED)

    return {
      ...item,
      status: 'ESCALATE',
      evidence: groundedEvidence,
      reason:
        'The RFP requires financial statements or other proof of financial stability, so SPS must verify that the requested documentation can be provided.',
    }
  }

  if (definition.id === 'insurance') {
    if (isNotSpecified(evidence)) {
      return {
        ...item,
        evidence: NOT_SPECIFIED,
        status: 'ESCALATE',
        reason: definition.missingReason,
      }
    }

    const amounts = extractDollarAmounts(combined)
    const tieredOrVariable =
      /\b(?:tiered?|depending on|based on (?:the |their )?(?:contract value|level of data access)|varies|variable|multiple limits?|schedule of limits?|whichever is greater)\b/i.test(
        combined
      )

    const multipleStructures = amounts.length > 1

    if (
      tieredOrVariable ||
      multipleStructures ||
      amounts.length === 0
    ) {
      const amountSummary = amounts
        .map(formatAmount)
        .join(', ')

      return {
        ...item,
        evidence,
        status: 'ESCALATE',
        reason:
          amounts.length === 0
            ? 'Insurance requirements are present, but the applicable coverage limit could not be determined automatically.'
            : `The RFP uses multiple or tiered insurance limits (${amountSummary}) that depend on the applicable coverage or risk tier, so human review is required.`,
      }
    }

    const amount = amounts[0]

    return {
      ...item,
      evidence,
      status: amount > 5000000 ? 'NO-GO' : 'GO',
      reason:
        amount > 5000000
          ? `The stated insurance limit is ${formatAmount(amount)}, which exceeds the SPS $5M hard threshold.`
          : `The stated insurance limit is ${formatAmount(amount)}, which is within the SPS $5M threshold.`,
    }
  }

  if (definition.id === 'profitability') {
    return {
      ...item,
      status: 'ESCALATE',
      evidence: isNotSpecified(evidence)
        ? NOT_SPECIFIED
        : evidence,
      reason:
        'Profitability must be evaluated internally using SPS pricing, delivery-cost, and margin data.',
    }
  }

  if (definition.id === 'bidBond') {
    if (isNotSpecified(evidence)) {
      return {
        ...item,
        evidence: NOT_SPECIFIED,
        status: 'ESCALATE',
        reason: definition.missingReason,
      }
    }

    const percentages = extractPercentages(combined)
    const dollarAmounts = extractDollarAmounts(combined)
    const ambiguous =
      /\b(?:to be determined|tbd|at the discretion|may require|unspecified|unclear)\b/i.test(
        combined
      )

    const excessivePercentage =
      percentages.length > 0 &&
      Math.max(...percentages) > 5

    const reasonablePercentage =
      percentages.length > 0 &&
      Math.max(...percentages) <= 5

    const definedDollarThresholdOrCap =
      dollarAmounts.length > 0 &&
      /\b(?:cap(?:ped)?|maximum|not to exceed|threshold|above|over|exceeding|greater than)\b/i.test(
        combined
      )

    const standardAndDefined =
      !ambiguous &&
      !excessivePercentage &&
      (reasonablePercentage || definedDollarThresholdOrCap)

    return {
      ...item,
      evidence,
      status: standardAndDefined ? 'GO' : 'ESCALATE',
      reason: standardAndDefined
        ? dollarAmounts.length > 0 && percentages.length > 0
          ? `The RFP requires a proposal bond for responses above ${formatAmount(
              Math.min(...dollarAmounts)
            )} and caps the bond at ${Math.max(
              ...percentages
            )}%, which is a defined and manageable term.`
          : 'The RFP states a defined and manageable proposal-bond threshold, percentage, or cap.'
        : 'The bid-bond language is unusual, excessive, or not defined clearly enough for an automatic GO decision.',
    }
  }

  return item
}

function applyVerificationDecision(
  definition,
  item,
  sourceText
) {
  const sourceEvidence = findVerificationSourceEvidence(
    sourceText,
    definition.id
  )

  const aiEvidence = normalizeEvidence(item.evidence)
  let evidence = sourceEvidence

  if (
    !evidence &&
    !isNotSpecified(aiEvidence) &&
    evidenceAppearsInSource(sourceText, aiEvidence)
  ) {
    evidence = aiEvidence
  }

  evidence = normalizeEvidence(evidence)

  return {
    task: definition.task,
    status: 'ESCALATE',
    evidence,
    reason: buildVerificationReason(
      definition,
      evidence
    ),
  }
}

function normalizeDepartments(checklist, sourceText) {
  const result = {}

  for (
    const [department, definitions] of Object.entries(
      CHECKLIST_DEFINITIONS
    )
  ) {
    const rawItems = Array.isArray(checklist?.[department])
      ? checklist[department]
      : []

    const usedIndexes = new Set()

    result[department] = definitions.map(
      (definition, definitionIndex) => {
        const rawItem =
          findMatchingItem(
            rawItems,
            definition,
            usedIndexes,
            definitionIndex,
            definitions.length
          ) || {}

        const evidence = normalizeEvidence(rawItem.evidence)

        let normalized = {
          task: definition.task,
          status: normalizeStatus(rawItem.status),
          reason: makeReviewReason(
            definition,
            evidence,
            rawItem.reason
          ),
          evidence,
        }

        if (department === 'financial') {
          normalized = applyFinancialDecision(
            definition,
            normalized,
            sourceText
          )
        } else {
          normalized = applyVerificationDecision(
            definition,
            normalized,
            sourceText
          )
        }

        // Additive strategic fields for the JSON export. These never
        // alter task/status/reason/evidence or the decision logic above;
        // safe fallbacks are applied when the AI omits them.
        normalized.risk_level = normalizeRiskLevel(
          rawItem.risk_level
        )

        normalized.mitigation_strategy = normalizeStrategyText(
          rawItem.mitigation_strategy
        )

        normalized.impact_on_bid_strategy = normalizeStrategyText(
          rawItem.impact_on_bid_strategy
        )

        return normalized
      }
    )
  }

  return result
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) {
    return null
  }

  const text = String(value).replace(/\s+/g, ' ').trim()

  if (
    !text ||
    /^(?:null|n\/?a|none|not specified|unknown)$/i.test(text)
  ) {
    return null
  }

  return text
}

function normalizeSummary(summary) {
  return {
    issuingAgency: normalizeNullableString(
      summary?.issuingAgency
    ),

    projectTitle: normalizeNullableString(
      summary?.projectTitle
    ),

    contractValue: normalizeNullableString(
      summary?.contractValue
    ),

    submissionDeadline: normalizeNullableString(
      summary?.submissionDeadline
    ),

    projectDuration: normalizeNullableString(
      summary?.projectDuration
    ),

    rfpNumber: normalizeNullableString(summary?.rfpNumber),
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set()
  const result = []

  for (const item of value) {
    const text = String(item || '')
      .replace(/\s+/g, ' ')
      .trim()

    if (
      !text ||
      /^(?:null|n\/?a|none|not specified)$/i.test(text)
    ) {
      continue
    }

    const key = text.toLowerCase()

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    result.push(text)
  }

  return result
}

function normalizeDeliverables(value, sourceText) {
  const sourceDeliverables = extractDeterministicDeliverables(sourceText)
  
  let rawList = []
  if (sourceDeliverables.length > 0) {
    rawList = [{ parent: 'General Requirements', children: sourceDeliverables }]
  } else if (Array.isArray(value)) {
    rawList = value
  }

  const result = []
  for (const item of rawList) {
    if (typeof item === 'string') {
      result.push({ parent: 'General Requirements', children: [item] })
    } else if (item && typeof item === 'object') {
      const parent = String(item.parent || item.category || 'General Requirements').trim()
      const children = normalizeStringArray(item.children || item.items || [])
      if (children.length > 0) {
        result.push({ parent, children })
      }
    }
  }

  const merged = {}
  for (const item of result) {
    if (!merged[item.parent]) merged[item.parent] = []
    merged[item.parent].push(...item.children)
  }

  return Object.entries(merged).map(([parent, children]) => ({ 
    parent, 
    children: [...new Set(children)] 
  }))
}

function addUniqueResult(results, value) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim()

  if (!text) {
    return
  }

  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return
  }

  const alreadyExists = results.some((existing) => {
    const existingNormalized = existing
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    return (
      existingNormalized === normalized ||
      existingNormalized.includes(normalized) ||
      normalized.includes(existingNormalized)
    )
  })

  if (!alreadyExists) {
    results.push(text)
  }
}

function cleanDeliverableDescription(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(
      /^(?:the\s+)?(?:selected\s+)?contractor\s+(?:shall|must|will|should)\s+/i,
      ''
    )
    .replace(
      /^(?:provide|include|implement|configure|deliver|develop|supply)\s+/i,
      ''
    )
    .replace(/\s+where available\.?$/i, '')
    .replace(/[.;:\s]+$/, '')
    .trim()
}

function extractLabeledDeliverable(
  sourceText,
  label,
  nextLabels
) {
  const escapedLabel = escapeRegex(label)

  const nextLabelPattern = nextLabels.length
    ? nextLabels.map(escapeRegex).join('|')
    : '[A-Z][A-Z .,&/-]{3,}:|\\bV\\.\\s+[A-Z]'

  const regex = new RegExp(
    `\\b${escapedLabel}:\\s*([\\s\\S]{1,1200}?)(?=\\b(?:${nextLabelPattern}):|\\bV\\.\\s+[A-Z]|$)`,
    'i'
  )

  const match = regex.exec(sourceText)

  if (!match) {
    return null
  }

  const description = cleanDeliverableDescription(
    match[1]
      .split(/(?<=[.!?])\s+/)[0]
  )

  if (!description) {
    return null
  }

  return `${label}: ${description}`
}

function extractDeterministicDeliverables(sourceText) {
  const results = []

  const primaryPatterns = [
    /\bthe selected contractor shall provide\s+([^.!?\n]{20,700})[.!?]/i,
    /\bthe contractor shall provide\s+([^.!?\n]{20,700})[.!?]/i,
    /\bthe successful contractor shall provide\s+([^.!?\n]{20,700})[.!?]/i,
    /\bthe purpose of this request for proposal[^.!?\n]{0,180}\bis to solicit proposals[^.!?\n]{0,120}\bfor\s+([^.!?\n]{20,500})[.!?]/i,
  ]

  for (const pattern of primaryPatterns) {
    const match = pattern.exec(sourceText)

    if (!match) {
      continue
    }

    const description = cleanDeliverableDescription(
      match[1]
    )

    if (description) {
      addUniqueResult(results, description)
      break
    }
  }

  const labels = [
    'Unified Search Experience',
    'AI-Enhanced Search',
    'Personalization and Audience Relevance',
    'Search Administration and Governance',
    'Analytics and Reporting',
    'Accessibility and Content Quality',
    'Implementation, Training, and Support',
    'Integration and Technical Fit',
    'Scalability and Future Readiness',
  ]

  labels.forEach((label, index) => {
    const remainingLabels = labels.slice(index + 1)

    const deliverable = extractLabeledDeliverable(
      sourceText,
      label,
      remainingLabels
    )

    if (deliverable) {
      addUniqueResult(results, deliverable)
    }
  })

  const explicitOutputPatterns = [
    {
      regex:
        /\bprovide\s+implementation services,\s*configuration,\s*testing,\s*launch support[^.!?\n]*[.!?]/i,
      prefix: 'Implementation and launch services',
    },
    {
      regex:
        /\bprovide\s+(?:administrator\s+)?training[^.!?\n]*[.!?]/i,
      prefix: 'Training',
    },
    {
      regex:
        /\bprovide\s+(?:end-user\s+)?documentation[^.!?\n]*[.!?]/i,
      prefix: 'Documentation',
    },
    {
      regex:
        /\bprovide\s+(?:ongoing\s+)?(?:customer success and )?technical support[^.!?\n]*[.!?]/i,
      prefix: 'Ongoing support',
    },
    {
      regex:
        /\bprovide\s+analytics dashboards? and reporting[^.!?\n]*[.!?]/i,
      prefix: 'Analytics and reporting',
    },
  ]

  for (const pattern of explicitOutputPatterns) {
    const match = pattern.regex.exec(sourceText)

    if (!match) {
      continue
    }

    const description = cleanDeliverableDescription(
      match[0]
    )

    if (description) {
      addUniqueResult(
        results,
        `${pattern.prefix}: ${description}`
      )
    }
  }

  return results
    .filter(
      (item) =>
        !/\b(?:pricing schedule|price proposal|cost proposal|proposal format|submission instructions|required forms)\b/i.test(
          item
        )
    )
    .slice(0, 12)
}

function cleanEvaluationCriterionLabel(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[A-Z]\.\s*/i, '')
    .replace(
      /^(?:evaluation\s+)?(?:criterion|criteria)\s*[:\-–—]\s*/i,
      ''
    )
    .replace(/[.;:\s]+$/, '')
    .trim()
}

function formatEvaluationNumber(value) {
  const number = Number(value)

  if (!Number.isFinite(number)) {
    return String(value || '').trim()
  }

  return Number.isInteger(number)
    ? String(number)
    : String(number).replace(/\.0+$/, '')
}

function extractEvaluationCriteriaSection(sourceText) {
  const sectionPatterns = [
    {
      start:
        /\bIX\.\s*EVALUATION CRITERIA AND AWARD PROCESS:/i,

      end:
        /\bX\.\s*EVALUATION,\s*NEGOTIATION AND AWARD:/i,
    },
    {
      start:
        /\bEVALUATION CRITERIA AND AWARD PROCESS:/i,

      end:
        /\bEVALUATION,\s*NEGOTIATION AND AWARD:/i,
    },
    {
      start:
        /\bEVALUATION CRITERIA:/i,

      end:
        /\b(?:PROPOSAL PREPARATION AND SUBMISSION REQUIREMENTS|CONTRACT AWARD|TERMS AND CONDITIONS|SCOPE OF WORK):/i,
    },
    {
      start:
        /\bEVALUATION FACTORS:/i,

      end:
        /\b(?:PROPOSAL PREPARATION|CONTRACT AWARD|TERMS AND CONDITIONS):/i,
    },
  ]

  for (const pattern of sectionPatterns) {
    const section = extractSourceSection(
      sourceText,
      pattern.start,
      pattern.end,
      8500
    )

    if (section) {
      return section
    }
  }

  return null
}

function extractDeterministicEvaluationCriteria(
  sourceText
) {
  const results = []
  const seenLabels = new Set()

  const section =
    extractEvaluationCriteriaSection(sourceText)

  if (!section) {
    return results
  }

  function addCriterion(label, value, unit) {
    const cleanedLabel =
      cleanEvaluationCriterionLabel(label)

    if (
      !cleanedLabel ||
      cleanedLabel.length < 2 ||
      cleanedLabel.length > 180
    ) {
      return
    }

    const normalizedLabel = cleanedLabel
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (
      !normalizedLabel ||
      seenLabels.has(normalizedLabel)
    ) {
      return
    }

    const formattedValue =
      formatEvaluationNumber(value)

    let result

    if (
      unit === '%' ||
      /^percent$/i.test(unit)
    ) {
      result =
        `${cleanedLabel} — ${formattedValue}%`
    } else {
      const numericValue = Number(value)

      result =
        `${cleanedLabel} — ${formattedValue} ` +
        `${numericValue === 1 ? 'point' : 'points'}`
    }

    seenLabels.add(normalizedLabel)
    addUniqueResult(results, result)
  }

  const letteredPointsPattern =
    /\b[A-Z]\.\s*([A-Z][A-Za-z0-9&,'’()./+\-–—\s]{2,180}?)\s*\.?\s*\(\s*(\d+(?:\.\d+)?)\s*(points?|pts?)\s*\)/g

  let match

  while (
    (match =
      letteredPointsPattern.exec(section)) !== null
  ) {
    addCriterion(
      match[1],
      match[2],
      match[3]
    )
  }

  const letteredPercentagePattern =
    /\b[A-Z]\.\s*([A-Z][A-Za-z0-9&,'’()./+\-–—\s]{2,180}?)\s*\.?\s*\(\s*(\d+(?:\.\d+)?)\s*(%|percent)\s*\)/gi

  while (
    (match =
      letteredPercentagePattern.exec(section)) !==
    null
  ) {
    addCriterion(
      match[1],
      match[2],
      match[3]
    )
  }

  const weightedPercentagePattern =
    /\b([A-Z][A-Za-z0-9&,'’()./+\-–—\s]{2,180}?)\s*\(\s*weight(?:ed|ing)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(%|percent)\s*\)/gi

  while (
    (match =
      weightedPercentagePattern.exec(section)) !==
    null
  ) {
    addCriterion(
      match[1],
      match[2],
      match[3]
    )
  }

  if (results.length === 0) {
    const separatedMetricPattern =
      /(?:^|[.;]\s+)([A-Z][A-Za-z0-9&,'’()./+\-–—\s]{2,150}?)\s*(?:—|–|-|:)\s*(\d+(?:\.\d+)?)\s*(points?|pts?|%|percent)\b/gi

    while (
      (match =
        separatedMetricPattern.exec(section)) !==
      null
    ) {
      addCriterion(
        match[1],
        match[2],
        match[3]
      )
    }
  }

  return results
    .filter(
      (item) =>
        !/\b(?:total points|evaluation criteria and award process|evaluation negotiation and award)\b/i.test(
          item
        )
    )
    .slice(0, 15)
}
function hasExplicitEvaluationCriteria(sourceText) {
  return /\b(?:evaluation criteria|evaluation factors?|scoring criteria|scoring methodology|point allocation|total points|weighted?|weighting|technical score|price score|basis of award|best value|lowest responsive and responsible|award will be based on)\b/i.test(
    sourceText
  )
}

// ---------------------------------------------------------------------------
// Additive normalizers for the new JSON-export schema fields (Phase 1).
// These only add new fields; they never touch summary/deliverables/
// evaluationCriteria/complianceChecklist decision logic. Function
// declarations are hoisted, so these are available to normalizeDepartments
// above as well.
// ---------------------------------------------------------------------------

function normalizeExecutiveSummary(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()

  if (
    !text ||
    /^(?:null|n\/?a|none|not specified|unknown)$/i.test(text)
  ) {
    return ''
  }

  return text
}

function normalizeRiskLevel(value) {
  const level = String(value || '').trim().toLowerCase()

  if (level === 'high') {
    return 'High'
  }

  if (level === 'low') {
    return 'Low'
  }

  return 'Medium'
}

function normalizeStrategyText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()

  if (
    !text ||
    /^(?:null|n\/?a|none|not specified|unknown)$/i.test(text)
  ) {
    return 'Not specified'
  }

  return text
}

function normalizeSeverity(value) {
  const severity = String(value || '').trim().toLowerCase()

  if (severity === 'high') {
    return 'High'
  }

  if (severity === 'low') {
    return 'Low'
  }

  return 'Medium'
}

function normalizeRisks(value) {
  if (!Array.isArray(value)) {
    return []
  }

  const result = []

  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const category = String(item.category || '')
      .replace(/\s+/g, ' ')
      .trim()

    const description = String(item.description || '')
      .replace(/\s+/g, ' ')
      .trim()

    if (!category && !description) {
      continue
    }

    result.push({
      category: category || 'General',
      description: description || 'Not specified',
      severity: normalizeSeverity(item.severity),
    })
  }

  return result
}

function normalizeTimeline(value) {
  if (!Array.isArray(value)) {
    return []
  }

  const result = []

  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const dateReference = String(item.date_reference || '')
      .replace(/\s+/g, ' ')
      .trim()

    const milestone = String(item.milestone || '')
      .replace(/\s+/g, ' ')
      .trim()

    if (!dateReference && !milestone) {
      continue
    }

    result.push({
      date_reference: dateReference || 'Not specified',
      milestone: milestone || 'Not specified',
    })
  }

  return result
}

function normalizeGoNogo(value) {
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {}

  let score = Number(source.score)

  if (!Number.isFinite(score)) {
    score = 0
  }

  score = Math.max(0, Math.min(100, Math.round(score)))

  const verdictRaw = String(source.verdict || '')
    .trim()
    .toLowerCase()

  let verdict = 'Review'

  if (/no[\s-]?go/.test(verdictRaw)) {
    verdict = 'No-Go'
  } else if (/^(?:go|proceed)$/.test(verdictRaw)) {
    verdict = 'Go'
  }

  const summary = String(source.summary || '')
    .replace(/\s+/g, ' ')
    .trim()

  const reasons = Array.isArray(source.reasons)
    ? source.reasons
        .filter((reason) => reason && typeof reason === 'object')
        .map((reason) => {
          const factor = String(reason.factor || '')
            .replace(/\s+/g, ' ')
            .trim()

          const detail = String(reason.detail || '')
            .replace(/\s+/g, ' ')
            .trim()

          let weight = Number(reason.weight)

          if (!Number.isFinite(weight)) {
            weight = 0
          }

          return {
            factor: factor || 'Not specified',
            weight: Math.max(0, Math.round(weight)),
            detail: detail || 'Not specified',
          }
        })
        .filter(
          (reason) =>
            reason.factor !== 'Not specified' ||
            reason.detail !== 'Not specified' ||
            reason.weight > 0
        )
    : []

  return {
    score,
    verdict,
    summary: summary || 'Not specified',
    reasons,
  }
}

function summaryHasValue(summary) {
  if (!summary || typeof summary !== 'object') {
    return false
  }

  return Object.values(summary).some(
    (value) =>
      value !== null &&
      value !== undefined &&
      String(value).trim() !== ''
  )
}

function buildSectionsAnalyzed(normalized) {
  const sections = []

  if (summaryHasValue(normalized.summary)) {
    sections.push('summary')
  }

  if (normalized.executive_summary) {
    sections.push('executive_summary')
  }

  if (
    Array.isArray(normalized.key_requirements) &&
    normalized.key_requirements.length > 0
  ) {
    sections.push('key_requirements')
  }

  if (
    Array.isArray(normalized.deliverables) &&
    normalized.deliverables.length > 0
  ) {
    sections.push('deliverables')
  }

  if (
    Array.isArray(normalized.evaluationCriteria) &&
    normalized.evaluationCriteria.length > 0
  ) {
    sections.push('evaluation_criteria')
  }

  if (Array.isArray(normalized.risks) && normalized.risks.length > 0) {
    sections.push('risks')
  }

  if (
    Array.isArray(normalized.timeline) &&
    normalized.timeline.length > 0
  ) {
    sections.push('timeline')
  }

  // The compliance checklist is always populated (27 fixed items), and the
  // strategic per-item fields are always attached to every item.
  sections.push('compliance')
  sections.push('strategic_checklist')

  if (normalized.go_nogo && normalized.go_nogo.verdict) {
    sections.push('go_nogo')
  }

  return sections
}

function normalizeAnalysis(analysis, sourceText) {
  const normalized =
    analysis &&
    typeof analysis === 'object' &&
    !Array.isArray(analysis)
      ? analysis
      : {}

  normalized.summary = normalizeSummary(
    normalized.summary
  )

  normalized.deliverables = normalizeDeliverables(
    normalized.deliverables, 
    sourceText
  )

  const aiEvaluationCriteria =
    normalizeStringArray(
      normalized.evaluationCriteria
    )

  const sourceEvaluationCriteria =
    extractDeterministicEvaluationCriteria(
      sourceText
    )

  if (sourceEvaluationCriteria.length > 0) {
    normalized.evaluationCriteria =
      sourceEvaluationCriteria
  } else if (
    hasExplicitEvaluationCriteria(sourceText)
  ) {
    normalized.evaluationCriteria =
      aiEvaluationCriteria
  } else {
    normalized.evaluationCriteria = []
  }

  normalized.complianceChecklist =
    normalizeDepartments(
      normalized.complianceChecklist,
      sourceText
    )

  // Additive JSON-export fields (Phase 1). Safe fallbacks are applied when
  // the AI omits any of these, mirroring the existing fallback pattern.
  normalized.executive_summary = normalizeExecutiveSummary(
    normalized.executive_summary
  )

  normalized.key_requirements = normalizeStringArray(
    normalized.key_requirements
  )

  normalized.risks = normalizeRisks(normalized.risks)

  normalized.timeline = normalizeTimeline(normalized.timeline)

  normalized.go_nogo = normalizeGoNogo(normalized.go_nogo)

  normalized.sections_analyzed = buildSectionsAnalyzed(normalized)

  return normalized
}

function getChecklistSpecification() {
  return Object.entries(CHECKLIST_DEFINITIONS)
    .map(([department, definitions]) => {
      const items = definitions
        .map(
          (definition, index) =>
            `${index + 1}. ${definition.task} - ` +
            definition.description
        )
        .join('\n')

      return (
        `${department.toUpperCase()} ` +
        `(${definitions.length} items):\n${items}`
      )
    })
    .join('\n\n')
}

function buildSystemPrompt() {
  return `You are an expert RFP (Request for Proposal) analyst working for SPS.

SOURCE-ONLY RULES:
- Use only the supplied RFP text.
- Do not invent requirements, dates, values, experience, personnel, forms, standards, or obligations.
- If a requirement is absent, say it is absent.
- Never claim an item is "required for evaluation" unless the RFP explicitly says so.
- Keep every reason to one concise, item-specific sentence.
- Keep every evidence value to the shortest exact or near-exact quote that proves the conclusion.
- Include the section heading or label in evidence when it is available.

CLASSIFICATION RULES:
- Master Contractor status, vendor eligibility, licenses, and business registration belong under Legal > Registration Requirement, not Relevant Experience.
- SBR, MBE, WBE, SWaM, GOSBA, and certified-small-business requirements belong under Operations > Small Business or MBE certification.
- Proposal, bid, question, and closing dates belong under Operations > Submission Deadlines.
- Email submission, password protection, proposal format, page limits, and packaging instructions belong under Operations > Document Compliance.
- A project title alone is not a deliverable, detailed technical requirement, security requirement, industry standard, or integration need.
- Do not reuse evidence for an unrelated checklist item.

SUMMARY RULES:
- Return actual JSON null for missing summary values.
- Never return the string "null".
- Do not infer contract value or project duration when the RFP does not state them.

DELIVERABLES RULES:
- Include only explicit products, services, reports, milestones, or tangible outputs required by the RFP.
- Organize items into a logical two-level parent-child hierarchy (e.g., grouping by phase, category, or section).
- Provide a descriptive "parent" category name and an array of specific "children" items.
- Do not turn the project title into a deliverable unless the document clearly requires that product or service.
- Return [] when no explicit deliverables are stated.

EVALUATION CRITERIA RULES:
- Include only explicit evaluation, scoring, weighting, point-allocation, or basis-of-award criteria.
- Eligibility rules, certifications, registration conditions, submission instructions, deadlines, and general compliance requirements are not evaluation criteria unless the RFP explicitly scores them.
- Return [] when the RFP gives no explicit evaluation or scoring methodology.

STATUS RULES:

FINANCIAL:
- Payment Terms: NET30 or shorter = GO. Longer than NET30 = ESCALATE. Not stated = ESCALATE.
- Financial Stability: no requirement for audited or unaudited financial statements, financial records, or proof of financial stability = GO. Any such documentation requirement = ESCALATE.
- Insurance: one clear insurance limit of $5M or less = GO. One clear limit above $5M = NO-GO. Multiple, tiered, aggregate, or context-dependent limits = ESCALATE. Not stated = ESCALATE.
- Profitability Analysis: always ESCALATE because SPS must evaluate internal cost and margin data.
- Bid Bond: a clearly defined, standard, and reasonable threshold, percentage, or cap = GO. Unusual, excessive, ambiguous, or unstated terms = ESCALATE.

LEGAL, OPERATIONS, AND TECHNICAL:
- Every item in these three departments must be ESCALATE.
- These departments are verification-only sections.
- Evidence changes the reason, but it must never change these statuses to GO or NO-GO.

LEGAL ITEM GUIDANCE:
- Relevant Experience: use only required years, comparable projects, references, or past performance. Do not use registration or certification evidence.
- Registration Requirement: use special bid eligibility, licenses, or designations such as Master Contractor status. Do not use eVA/vendor-portal registration or State Corporation Commission registration here.
- Financial Statement of Previous Year: use only prior-year or multi-year financial-statement requirements.
- Qualified Personnel: use required roles, resumes, staffing, certifications, qualifications, or work history.
- Technical Knowhow: use demonstrated technical expertise, methods, implementation experience, or specialized knowledge.
- Compliance of Law: use statutes, regulations, governing-law clauses, debarment, civil-rights, immigration, antitrust, or similar legal obligations.
- State Registration: use State Corporation Commission or equivalent authorization-to-do-business requirements or disclosures.
- E-Verify: use only explicit E-Verify requirements and any employee or contract-value thresholds.
- Contractual Obligations: use material claims, termination, indemnity, dispute, default, or continuing-performance provisions.

OPERATIONS ITEM GUIDANCE:
- Required Forms: use required cover sheets, pricing forms, contractor data sheets, W-9/tax forms, ownership disclosures, and mandatory attachments.
- Small Business or MBE certification: use SBR, MBE, WBE, SWaM, GOSBA, certification, participation-plan, or subcontracting requirements.
- Workers Compensation Insurance: use only workers compensation or statutory employee-coverage clauses.
- Business with Iran disclosure: use only an explicit Iran disclosure or certification.
- Submission Deadlines: use proposal, bid, closing, and question deadlines.
- Document Compliance: use submission method, password protection, copies, packaging, page numbering, table of contents, organization, and format requirements.
- Signatory Authority: use authorized-signer or authority-to-bind requirements.
- Vendor Registration: use eVA or another procurement/vendor portal; do not use Master Contractor or State Corporation Commission evidence here.

TECHNICAL ITEM GUIDANCE:
- Scope alignment: summarize the actual services and outputs, then state that SPS must verify alignment.
- Technical capabilities: use required platforms, functions, administration tools, analytics, implementation, training, and support capabilities.
- Industry standards: use named standards such as WCAG, Section 508, accessibility, or required certifications.
- Security requirements: use authentication, access control, privacy, safeguards, breach response, encryption, or cyber-risk requirements. A cybersecurity project title alone is not enough.
- Integration needs: use explicit APIs, modules, interfaces, interoperability, Drupal, data exchange, or existing-environment integration requirements.

EVIDENCE RULES:
- Every checklist item must contain an evidence field.
- If relevant text exists, quote it exactly or near-exactly.
- Include its section label when available.
- If relevant text does not exist, set evidence to exactly "${NOT_SPECIFIED}".
- When evidence is "${NOT_SPECIFIED}", the reason must also say the requirement is not specified.
- Do not claim a requirement exists when evidence is "${NOT_SPECIFIED}".
- Never write a reason that contradicts its evidence.

CHECKLIST SHAPE:
- Return exactly the following 27 items.
- Use these exact task labels.
- Use this exact order.
- Do not omit, rename, add, merge, or move checklist items.

${getChecklistSpecification()}

EXECUTIVE SUMMARY RULES:
- Provide "executive_summary" as a 2-3 sentence plain-language overview of the RFP and the bid opportunity.
- This is a separate field from the structured "summary" object; do not merge into it, rename it, or duplicate its values.
- Base it only on the supplied RFP text.

KEY REQUIREMENTS RULES:
- Provide "key_requirements" as a flat array of strings listing the most critical must-do items a bidder must satisfy.
- These are top-line "you must do X" statements and are distinct from deliverables and from the compliance checklist.
- Return [] when no critical must-do items are clearly stated.

RISKS RULES:
- Provide "risks" as an array of general, project-level risk objects, not per-checklist-item risks.
- Each risk object must have "category" (string), "description" (string), and "severity" of exactly "Low", "Medium", or "High".
- Examples: firm-fixed-price exposure, manufacturer-authorization dependency, tight timelines, high insurance caps, single-award restrictions.
- Return [] when no meaningful project-level risks can be identified from the text.

TIMELINE RULES:
- Provide "timeline" as an array of key-date objects extracted from the RFP text.
- Each object must have "date_reference" (the date or date phrase) and "milestone" (what happens on that date).
- Include issue date, pre-bid conference, question deadline, bid closing date, contract term dates, and invoicing timelines when stated.
- Return [] when no dates are stated in the text.

GO/NO-GO RULES:
- Provide "go_nogo" as a separate weighted assessment used only for the JSON export.
- This is NOT the compliance-checklist status logic; do not copy checklist GO/NO-GO/ESCALATE statuses into it.
- "score" is a number from 0 to 100. "verdict" is exactly "Go", "No-Go", or "Review". "summary" is one or two sentences explaining the verdict.
- "reasons" is an array of { "factor": string, "weight": number, "detail": string } objects, where the "weight" values sum to roughly 100.

STRATEGIC CHECKLIST FIELD RULES:
- For every checklist item, in addition to task, status, reason, and evidence, also return three new fields:
  - "risk_level": exactly "Low", "Medium", or "High" for that individual item.
  - "mitigation_strategy": one concrete suggested action to address or satisfy the item.
  - "impact_on_bid_strategy": one sentence describing how this item affects the overall bid approach.
- These three fields must never change the task, status, reason, or evidence values.

SECTIONS ANALYZED RULES:
- Provide "sections_analyzed" as a flat array of strings naming which sections you populated in this response (e.g. "summary", "deliverables", "compliance", "risks", "timeline", "key_requirements", "go_nogo", "strategic_checklist").

OUTPUT RULES:
- Return one valid JSON object only.
- Do not use markdown.
- Do not use code fences.
- Do not include comments.
- Do not include explanatory text outside the JSON.
- Use exactly this top-level structure:

{
  "summary": {
    "issuingAgency": null,
    "projectTitle": null,
    "contractValue": null,
    "submissionDeadline": null,
    "projectDuration": null,
    "rfpNumber": null
  },
  "executive_summary": "string",
  "key_requirements": [
    "string"
  ],
  "deliverables": [
    {
      "parent": "string",
      "children": [
        "string"
      ]
    }
  ],
  "evaluationCriteria": [],
  "risks": [
    {
      "category": "string",
      "description": "string",
      "severity": "Low or Medium or High"
    }
  ],
  "timeline": [
    {
      "date_reference": "string",
      "milestone": "string"
    }
  ],
  "go_nogo": {
    "score": 0,
    "verdict": "Go or No-Go or Review",
    "summary": "string",
    "reasons": [
      {
        "factor": "string",
        "weight": 0,
        "detail": "string"
      }
    ]
  },
  "complianceChecklist": {
    "financial": [
      {
        "task": "string",
        "status": "GO or NO-GO or ESCALATE",
        "reason": "string",
        "evidence": "string",
        "risk_level": "Low or Medium or High",
        "mitigation_strategy": "string",
        "impact_on_bid_strategy": "string"
      }
    ],
    "legal": [
      {
        "task": "string",
        "status": "ESCALATE",
        "reason": "string",
        "evidence": "string",
        "risk_level": "Low or Medium or High",
        "mitigation_strategy": "string",
        "impact_on_bid_strategy": "string"
      }
    ],
    "operations": [
      {
        "task": "string",
        "status": "ESCALATE",
        "reason": "string",
        "evidence": "string",
        "risk_level": "Low or Medium or High",
        "mitigation_strategy": "string",
        "impact_on_bid_strategy": "string"
      }
    ],
    "technical": [
      {
        "task": "string",
        "status": "ESCALATE",
        "reason": "string",
        "evidence": "string",
        "risk_level": "Low or Medium or High",
        "mitigation_strategy": "string",
        "impact_on_bid_strategy": "string"
      }
    ]
  },
  "sections_analyzed": [
    "string"
  ]
}`
}

function stripCodeFences(rawResponse) {
  return String(rawResponse || '')
    .replace(/^\uFEFF/, '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim()
}

function removeTrailingCommas(text) {
  return text.replace(/,\s*([}\]])/g, '$1')
}

function extractBalancedJsonObject(text) {
  const start = text.indexOf('{')

  if (start === -1) {
    return null
  }

  const stack = []
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i += 1) {
    const char = text[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }

      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{' || char === '[') {
      stack.push(char)
      continue
    }

    if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '['

      if (stack[stack.length - 1] !== expected) {
        return null
      }

      stack.pop()

      if (stack.length === 0) {
        return text.slice(start, i + 1)
      }
    }
  }

  return null
}

function closeOpenJson(text) {
  let candidate = text.trim()
  const stack = []
  let inString = false
  let escaped = false

  for (const char of candidate) {
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }

      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{' || char === '[') {
      stack.push(char)
    } else if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '['

      if (stack[stack.length - 1] === expected) {
        stack.pop()
      }
    }
  }

  if (inString) {
    if (escaped && candidate.endsWith('\\')) {
      candidate = candidate.slice(0, -1)
    }

    candidate += '"'
  }

  candidate = candidate.replace(/,\s*$/, '')

  while (stack.length > 0) {
    candidate += stack.pop() === '{' ? '}' : ']'
  }

  return removeTrailingCommas(candidate)
}

function commaPositionsOutsideStrings(text) {
  const positions = []
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }

      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === ',') {
      positions.push(i)
    }
  }

  return positions
}

function parseJsonResponse(rawResponse) {
  const cleaned = stripCodeFences(rawResponse)
  const directCandidates = [cleaned]

  const balanced = extractBalancedJsonObject(cleaned)

  if (balanced && balanced !== cleaned) {
    directCandidates.push(balanced)
  }

  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    directCandidates.push(
      cleaned.slice(firstBrace, lastBrace + 1)
    )
  }

  for (const candidate of directCandidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      try {
        return JSON.parse(removeTrailingCommas(candidate))
      } catch {
        // Continue to truncation recovery.
      }
    }
  }

  if (firstBrace === -1) {
    throw new Error(
      'AI response did not contain a JSON object'
    )
  }

  const truncated = cleaned.slice(firstBrace)

  try {
    return JSON.parse(closeOpenJson(truncated))
  } catch {
    // Remove incomplete trailing properties or array items below.
  }

  const cutPositions =
    commaPositionsOutsideStrings(truncated)

  for (
    let i = cutPositions.length - 1;
    i >= 0 && i >= cutPositions.length - 100;
    i -= 1
  ) {
    const shortened = truncated.slice(0, cutPositions[i])

    try {
      return JSON.parse(closeOpenJson(shortened))
    } catch {
      // Try an earlier complete property or array item.
    }
  }

  throw new Error(
    'AI returned invalid or unrecoverable JSON'
  )
}

// Top-level keys that must be present and correctly typed for the response to
// be a usable RFP analysis at all. Everything else the model returns is left
// out of the schema on purpose: normalizeAnalysis already repairs those fields
// (filling arrays, coercing types, rebuilding all 27 checklist items), so
// rejecting on them here would be stricter than the behavior it replaces.
const ANALYSIS_SCHEMA = {
  summary: 'object',
  complianceChecklist: 'object',
}

export default async function handler(req, res) {
  const requestStart = Date.now()

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')

    return res.status(405).json({
      error: 'Method not allowed',
    })
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({
      error: 'GROQ_API_KEY is not configured',
    })
  }

  const MAX_UPLOAD_BYTES = 15 * 1024 * 1024 // 15MB

  const contentLength = Number(req.headers['content-length'])

  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    return res.status(413).json({
      error: 'File is too large. Please upload a PDF under 15MB.',
    })
  }

  try {
    const rawBody = await getRawBody(req)

    const boundary = getBoundary(
      req.headers['content-type']
    )

    if (!boundary) {
      return res.status(400).json({
        error: 'Invalid multipart form data',
      })
    }

    const fileBuffer = extractFileFromMultipart(
      rawBody,
      boundary
    )

    if (!fileBuffer || fileBuffer.length === 0) {
      return res.status(400).json({
        error: 'Could not extract the uploaded file',
      })
    }

    const pdfHeaderIndex = fileBuffer
      .slice(0, 1024)
      .indexOf(Buffer.from('%PDF-'))

    if (pdfHeaderIndex === -1) {
      return res.status(400).json({
        error: 'Only valid PDF files are supported',
      })
    }

    const pdfData = await pdfParse(fileBuffer)
    console.log('[analyze] pdf parse took', Date.now() - requestStart, 'ms')
    const sourceText = cleanText(pdfData.text)

    // Second, page-tracked parse of the same buffer, purely so the client can
    // persist rfps.pages. The parse above joins every page with the same
    // "\n\n" that separates paragraphs, and page boundaries cannot be
    // recovered from the result afterwards — so the only way to get them is
    // to parse again with a pagerender callback. Measured around half a
    // second on a 44-page RFP, which is noise next to the Groq call.
    //
    // Deliberately non-fatal: this is supplementary persistence data, and an
    // analysis that already succeeded should not fail because of it.
    let pageTexts = null

    try {
      const extracted = await extractPages(fileBuffer)

      pageTexts = extracted.pages.map((entry) => entry.text)

      console.log('[analyze] page-tracked parse took',
        Date.now() - requestStart, 'ms (cumulative),', pageTexts.length, 'pages')
    } catch (pageError) {
      console.error('[analyze] page-tracked parse failed:', pageError?.message)
    }

    if (!sourceText) {
      return res.status(400).json({
        error: 'PDF appears to be empty or unreadable',
      })
    }

    const extraction =
      extractRelevantSections(sourceText)

    const rfpText = extraction.text

    const systemPrompt = buildSystemPrompt()

    const userPrompt =
      'Analyze the following RFP text and return the required JSON object.\n\n' +
      rfpText

    const {
      data: parsedAnalysis,
      usedFallback,
      reason: fallbackReason,
      errors: shapeErrors,
    } = await callGroqWithValidation({
      model: 'llama-3.3-70b-versatile',

      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],

      temperature: 0.1,
      maxTokens: 5000,

      // One retry, matching the previous inline behavior. The 60s function
      // budget does not leave room for more.
      maxRetries: 1,

      schema: ANALYSIS_SCHEMA,

      // parseJsonResponse keeps the truncation-recovery logic the default
      // parser lacks, which matters because max_tokens does truncate real
      // responses on long RFPs.
      parse: parseJsonResponse,

      // Built only if the model output is unusable, since it re-scans the
      // whole source document.
      fallback: () => normalizeAnalysis({}, sourceText),
    })

    console.log('[analyze] groq call took', Date.now() - requestStart, 'ms (cumulative)')

    if (usedFallback) {
      // A structurally unusable response yields an all-"Not specified"
      // analysis. Returning that would look like a completed bid assessment,
      // so surface the failure and let the user re-run instead.
      console.error('[analyze] unusable AI response:', {
        reason: fallbackReason,
        errors: shapeErrors,
      })

      return res.status(502).json({
        error:
          'The AI returned an invalid response. Please run the analysis again.',
      })
    }

    const analysis = normalizeAnalysis(
      parsedAnalysis,
      sourceText
    )

    console.log('[analyze] total request took', Date.now() - requestStart, 'ms')

    // sourceText and pages are for persistence, not for display. sourceText
    // is the FULL extracted document (not the section-trimmed rfpText sent to
    // Groq) and lands in rfps.raw_text; pages is the same document split per
    // page and lands in rfps.pages, which is what gives the shredder real
    // page numbers. Consumers of the analysis itself ignore both keys:
    // ResultsPanel reads named fields and buildJsonExport maps an explicit
    // key list.
    return res.status(200).json({ ...analysis, sourceText, pages: pageTexts })
  } catch (error) {
    const status = getErrorStatus(error)

    console.error('[analyze] request failed:', {
      status,
      message: error?.message,
    })

    if (status === 429) {
      return res.status(429).json({
        error:
          'Groq rate limit reached. Please wait for the limit to reset and try again.',
      })
    }

    if (status === 413) {
      return res.status(413).json({
        error:
          'The RFP is too large for the current Groq request limit.',
      })
    }

    if (
      /invalid or unrecoverable JSON|did not contain a JSON object/i.test(
        error?.message || ''
      )
    ) {
      return res.status(502).json({
        error:
          'The AI returned an invalid response. Please run the analysis again.',
      })
    }

    return res.status(500).json({
      error:
        error?.message || 'Unexpected analysis error',
    })
  }
}