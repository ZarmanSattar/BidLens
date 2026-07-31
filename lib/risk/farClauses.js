// §5.1 — starter reference list of commonly-encountered risky FAR / DFARS
// clauses, with plain-language descriptions.
//
// ⚠️ THIS IS A STARTING SET, NOT AN EXHAUSTIVE ONE. ⚠️
//
// The FAR alone contains several hundred prescribed clauses and the DFARS
// several hundred more, before any agency supplement (DEAR, VAAR, AGAR, ...)
// or state/local equivalent. What is here is roughly a dozen clauses that show
// up repeatedly in the solicitations this tool is aimed at AND carry real
// commercial exposure. A clause NOT in this list is not "safe" — it is
// unreviewed. clauseRisk.js therefore reports every clause reference it finds,
// and groups the ones absent from this list under an explicit
// "referenced but not in the starter list" finding rather than discarding
// them.
//
// `severity` drives badge colour only. It is a fixed editorial judgement about
// the clause in the abstract, not a reading of this particular RFP — a
// high-severity clause may be entirely routine in context. There is no AI
// here and no attempt to weigh the surrounding text; §5.3 is where that would
// go, and it is deliberately out of scope for this pass.

const SEVERITY = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
}

// Keyed by the bare clause number, which is what the regex in clauseRisk.js
// captures. Alternates ("52.212-4 Alt I") normalize to their base number.
const FAR_CLAUSES = {
  '52.212-4': {
    system: 'FAR',
    title: 'Contract Terms and Conditions — Commercial Products and Commercial Services',
    severity: SEVERITY.MEDIUM,
    description:
      'The standard commercial-items terms block. It bundles acceptance, warranty, termination, and payment terms into one clause, and paragraph (u) lets the agency add further terms by reference. Read the whole clause — the risk is in what it silently incorporates.',
  },
  '52.215-2': {
    system: 'FAR',
    title: 'Audit and Records — Negotiation',
    severity: SEVERITY.MEDIUM,
    description:
      'Gives the government (and the Comptroller General) the right to examine your books and records relating to the contract, generally for 3 years after final payment. Budget for record retention and be sure subcontracts flow it down.',
  },
  '52.227-14': {
    system: 'FAR',
    title: 'Rights in Data — General',
    severity: SEVERITY.HIGH,
    description:
      'Sets what rights the government takes in data you deliver. Without asserting restrictions in the proposal (and marking deliverables correctly), the government gets unlimited rights to reproduce and disclose your data — including to your competitors.',
  },
  '52.232-25': {
    system: 'FAR',
    title: 'Prompt Payment',
    severity: SEVERITY.LOW,
    description:
      'Standard federal payment terms: generally 30 days after receipt of a proper invoice. Note this is 30 days from the invoice being deemed proper, not from work completion — invoice defects restart the clock.',
  },
  '52.243-1': {
    system: 'FAR',
    title: 'Changes — Fixed-Price',
    severity: SEVERITY.HIGH,
    description:
      'Lets the contracting officer unilaterally change the work within the general scope. You must continue performing while an equitable adjustment is negotiated, and the claim must be asserted within 30 days. Cash-flow and scope-creep exposure.',
  },
  '52.245-1': {
    system: 'FAR',
    title: 'Government Property',
    severity: SEVERITY.MEDIUM,
    description:
      'Makes you responsible for managing, tracking, and accounting for government-furnished property under an approved property management system. Carries liability for loss or damage and real administrative overhead.',
  },
  '52.246-2': {
    system: 'FAR',
    title: 'Inspection of Supplies — Fixed-Price',
    severity: SEVERITY.MEDIUM,
    description:
      'Lets the government inspect and reject work at any stage, and require correction or replacement at your expense. Rejected work can also trigger the Default clause.',
  },
  '52.249-2': {
    system: 'FAR',
    title: 'Termination for Convenience of the Government (Fixed-Price)',
    severity: SEVERITY.HIGH,
    description:
      'The government may cancel the contract at any time for its own convenience. You recover allowable incurred costs and a reasonable profit on work done, but NOT anticipated profit on the unperformed balance. Do not stake capacity or hiring on the full contract value.',
  },
  '52.249-8': {
    system: 'FAR',
    title: 'Default (Fixed-Price Supply and Service)',
    severity: SEVERITY.HIGH,
    description:
      'Lets the government terminate for default on failure to deliver or to make progress, and charge you the excess cost of re-procuring from another supplier. A default termination is also a serious past-performance mark.',
  },
  '52.204-21': {
    system: 'FAR',
    title: 'Basic Safeguarding of Covered Contractor Information Systems',
    severity: SEVERITY.MEDIUM,
    description:
      'Imposes 15 baseline cybersecurity controls on any system that processes or stores federal contract information. Modest on its own, but it is the floor — DFARS 252.204-7012 is the heavier version.',
  },
  '52.222-26': {
    system: 'FAR',
    title: 'Equal Opportunity',
    severity: SEVERITY.LOW,
    description:
      'Standard non-discrimination and affirmative-action obligations. Routine, but above certain thresholds it brings written AAP and reporting duties that need an owner.',
  },
}

const DFARS_CLAUSES = {
  '252.204-7012': {
    system: 'DFARS',
    title: 'Safeguarding Covered Defense Information and Cyber Incident Reporting',
    severity: SEVERITY.HIGH,
    description:
      'Requires NIST SP 800-171 security controls on any system holding covered defense information, cloud services meeting FedRAMP Moderate equivalency, incident reporting to DoD within 72 hours, and flow-down to subcontractors. Frequently the single most expensive clause in a DoD solicitation.',
  },
  '252.204-7019': {
    system: 'DFARS',
    title: 'Notice of NIST SP 800-171 DoD Assessment Requirements',
    severity: SEVERITY.MEDIUM,
    description:
      'You must have a current (within 3 years) NIST SP 800-171 self-assessment score posted in SPRS to be eligible for award. This is a go/no-go gate — confirm the score exists before bidding, not after.',
  },
  '252.204-7020': {
    system: 'DFARS',
    title: 'NIST SP 800-171 DoD Assessment Requirements',
    severity: SEVERITY.MEDIUM,
    description:
      'Obliges you to give DoD access to facilities and systems for a Medium or High assessment, and to flow the requirement down to subcontractors.',
  },
  '252.227-7013': {
    system: 'DFARS',
    title: 'Rights in Technical Data — Noncommercial Items',
    severity: SEVERITY.HIGH,
    description:
      'The DoD technical-data counterpart to FAR 52.227-14. Development funded even partly by the government generally yields government purpose rights. Assert and mark restrictions correctly or you lose control of the data.',
  },
  '252.239-7010': {
    system: 'DFARS',
    title: 'Cloud Computing Services',
    severity: SEVERITY.HIGH,
    description:
      'Requires DoD provisional authorization for cloud services, data stored within the United States absent a waiver, incident reporting, and government access to data and forensic images. Materially constrains which platforms you may use.',
  },
  '252.225-7001': {
    system: 'DFARS',
    title: 'Buy American and Balance of Payments Program',
    severity: SEVERITY.MEDIUM,
    description:
      'Restricts supply of foreign end products. Verify country of origin across the whole bill of materials — compliance is judged component by component, not at the finished-product level.',
  },
}

const CLAUSE_LIBRARY = { ...FAR_CLAUSES, ...DFARS_CLAUSES }

module.exports = {
  CLAUSE_LIBRARY,
  FAR_CLAUSES,
  DFARS_CLAUSES,
  SEVERITY,
}
