<div align="center">

# 🔍 BidLens

### AI-Powered RFP Compliance Analyzer

*It reads the 100-page RFP so you don't have to.*

**Turn a dense Request for Proposal into a clear GO / NO-GO / ESCALATE call in under 30 seconds — with a real quote from the document behind every decision.**

[![Next.js](https://img.shields.io/badge/Next.js-Pages%20Router-000000?style=flat-square&logo=next.js)](https://nextjs.org/)
[![Groq](https://img.shields.io/badge/AI-LLaMA%203.3%2070B%20via%20Groq-F55036?style=flat-square)](https://groq.com/)
[![Bootstrap](https://img.shields.io/badge/UI-Bootstrap%205-7952B3?style=flat-square&logo=bootstrap)](https://getbootstrap.com/)
[![Made for SPS](https://img.shields.io/badge/Made%20for-SPS-0A66C2?style=flat-square)]()
[![Exports](https://img.shields.io/badge/Exports-JSON%20%C2%B7%20PDF%20%C2%B7%20Excel-2EA043?style=flat-square)]()
[![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)]()
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)]()

</div>

---

## 📌 Overview

**BidLens** is an internal tool built for the **Software Productivity Strategists (SPS)** proposal team. It reads uploaded RFP (Request for Proposal) documents and automatically produces a structured, evidence-backed compliance breakdown — plus an executive summary, a risk register, a timeline, and a weighted go/no-go call — so the team can decide whether to bid without manually combing through dozens of pages of legal and financial fine print.

Every decision the AI makes is **backed by a real quote pulled directly from the RFP** — not a guess, not boilerplate.

> ### ✨ What's New
>
> BidLens no longer stops at the compliance table. Recent releases added:
>
> - 📝 **Executive Summary** — a plain-language read on the whole opportunity, up top.
> - 🧭 **Go/No-Go Assessment** — a separate weighted **0–100 score + verdict** with the reasoning that drove it.
> - 🧩 **Per-Item Strategy** — every checklist row now carries a **Risk Level**, a **Mitigation Strategy**, and a **Bid Impact** note.
> - ⚠️ **Risk Register & 🗓️ Timeline** — project-level risks and key dates, extracted automatically.
> - 🧾 **Export as JSON** — one click for a full, machine-readable copy of the entire analysis.

---

## ✨ What It Does

| Feature | What you get |
|---|---|
| 📤 **Drag & Drop Upload** | Drop in any RFP PDF and watch a live, staged progress indicator do its thing |
| 🧠 **Section-Aware Extraction** | Hunts down compliance-relevant clauses *anywhere* in the document — including buried exhibits — instead of blindly truncating long files |
| 🧾 **Evidence Engine** | The AI must quote exact/near-exact RFP text with section labels to justify every single call |
| 📊 **4-Column Compliance Table** | Checklist Item · Decision · Reason · Evidence — across Financial, Legal, Operations & Technical |
| 🚦 **GO / NO-GO / ESCALATE Routing** | Financial items are checked against hard SPS thresholds (NET30, $5M insurance cap, bid-bond sanity); verification-only items route to ESCALATE |
| 🧩 **Per-Item Risk & Strategy** | Each checklist row also gets a **Risk Level**, a suggested **Mitigation Strategy**, and an **Impact on Bid Strategy** note |
| 📝 **Executive Summary** | A 2–3 sentence, plain-language overview of the RFP and the opportunity |
| 📌 **Key Requirements** | The top-line "you must do X" items a bidder can't miss, as a clean flat list |
| ⚠️ **Risk Register** | Project-level risks with **category · description · severity** (Low / Medium / High) |
| 🗓️ **Timeline Extraction** | Key dates — issue, pre-bid conference, questions, closing, contract term, invoicing |
| 🧭 **Go/No-Go Assessment** | A weighted **0–100 score**, a **Go / No-Go / Review** verdict, and the factors behind it |
| 🗂️ **Deliverables Accordion** | Deliverables grouped into a clean parent → child hierarchy, expandable on demand |
| 🎯 **Bid Decision Score** | A single **/100** score summarizing bid strength at a glance |
| 🚩 **Risk Flag Summary** | Surfaces NO-GO and high-priority ESCALATE items immediately |
| 🔀 **Side-by-Side Compare** | Stack multiple analyzed RFPs to spot the best opportunity fast |
| 📁 **JSON / PDF / Excel Export** | One-click export of the full report — human-readable *or* machine-readable |

---

## 🧠 Under the Hood

```
              📄 RFP Upload
                    │
                    ▼
        pdf-parse text extraction
                    │
                    ▼
     Section-Aware Extraction (keyword hunt)   ← Payment Terms, Insurance,
                    │                              Bid Bond, etc. — anywhere
                    ▼
         LLaMA 3.3 70B via Groq
       (forced to quote real evidence)
                    │
                    ▼
   ┌──────────────────────────────────────────┐
   │             Full Analysis Bundle          │
   │  • Compliance table + per-item risk /     │
   │    mitigation / bid impact                │
   │  • Executive summary & key requirements   │
   │  • Risk register & timeline               │
   │  • Go/No-Go verdict + Bid Decision Score  │
   └──────────────────────────────────────────┘
```

<details>
<summary>🔬 The step-by-step flow (click to expand)</summary>

1. **Upload** — a PDF is dropped into the browser and streamed to `/api/analyze`.
2. **Parse** — `pdf-parse` pulls raw text out of the document.
3. **Section-Aware Extraction** — rather than truncating long RFPs, a keyword/tier system locates the passages that actually matter (payment terms, insurance, bonds, deadlines, evaluation criteria, scope, and more) so they survive into the AI prompt even when they're buried on page 87.
4. **Analyze** — LLaMA 3.3 70B (via Groq) is prompted to return strict JSON and is required to quote real RFP text as evidence for each conclusion.
5. **Normalize & enforce** — the backend applies SPS's hard financial thresholds, forces verification-only departments to ESCALATE, backfills safe defaults, and shapes everything into a stable schema. Alongside the compliance table, the AI also produces the **executive summary, key requirements, risk register, timeline, and go/no-go assessment**.
6. **Render** — the results panel shows the compliance table, deliverables, scores, and flags — all exportable to JSON, PDF, or Excel.

</details>

---

## 🧾 Export as JSON

Hit **Export JSON** in the results panel and BidLens downloads `BidLens_RFP_Analysis.json` — a complete, machine-readable snapshot of the analysis (great for archiving, diffing, or feeding another system). No server round-trip; it's built in the browser.

<details>
<summary>📦 Full JSON export schema (click to expand)</summary>

```jsonc
{
  "summary": "string — the executive summary",
  "compliance": {
    // one representative reason per department
    // (priority: a NO-GO item → a High risk_level item → the first item)
    "Financial": "string",
    "Legal": "string",
    "Operations": "string",
    "Technical": "string"
  },
  "deliverables": [
    {
      "deliverable": "string",
      "page_number": "",
      "reference": "",
      "sub_deliverables": [
        { "name": "string", "page_number": "", "reference": "string" }
      ]
    }
  ],
  "evaluation_criteria": ["string"],
  "go_nogo": {
    "score": 0,
    "verdict": "Go | No-Go | Review",
    "summary": "string",
    "reasons": [{ "factor": "string", "weight": 0, "detail": "string" }]
  },
  "key_requirements": ["string"],
  "risks": [
    { "category": "string", "description": "string", "severity": "Low | Medium | High" }
  ],
  "sections_analyzed": ["string"],
  "strategic_checklist": {
    "executive_summary": "string",
    "financial": [
      {
        "item": "string",
        "status": "GO | ESCALATE | NO-GO",
        "risk_level": "Low | Medium | High",
        "reasoning": "string",
        "rfp_evidence": "string",
        "mitigation_strategy": "string",
        "impact_on_bid_strategy": "string"
      }
    ],
    "legal":      [ "… same item shape as financial …" ],
    "operations": [ "… same item shape …" ],
    "technical":  [ "… same item shape …" ]
  },
  "timeline": [
    { "date_reference": "string", "milestone": "string" }
  ]
}
```

</details>

---

## 🛠️ Tech Stack

- **Framework:** Next.js (Pages Router)
- **UI:** Bootstrap 5 + custom styling
- **AI:** Groq API — LLaMA 3.3 70B
- **PDF Parsing:** `pdf-parse` v1.1.1
- **Export:** jsPDF + jspdf-autotable, SheetJS (xlsx), and native browser JSON export
- **Storage:** localStorage (single-user tool)
- **Deployment:** Vercel

---

## 🚦 Status Legend

| Status | Meaning |
|---|---|
| 🟢 **GO** | Within acceptable limits — safe to proceed |
| 🟡 **ESCALATE** | Requires human review before a final call |
| 🔴 **NO-GO** | Violates a hard threshold — do not bid |

---

## 🏆 Bid Decision Score

```
GO        → 2 points
ESCALATE  → 1 point
NO-GO     → 0 points

Score = (earned points ÷ max possible points) × 100
```

| Score | Verdict |
|---|---|
| 🟢 80–100 | Strong Bid |
| 🟡 60–79 | Bid with Caution |
| 🔴 0–59 | Do Not Bid |

---

## 🚀 Getting Started

```bash
# Clone the repo
git clone https://github.com/ZarmanSattar/BidLens.git
cd bidlens

# Install dependencies
npm install

# Add your Groq API key
echo "GROQ_API_KEY=your_key_here" > .env.local

# Run locally
npm run dev
```

Then open **http://localhost:3000** 🎉

---

## 📂 Project Structure

```
bidlens/
├── pages/
│   ├── index.js           → Upload UI + export controls
│   ├── dashboard.js        → History, stats, deadline tracker
│   ├── compare.js          → Side-by-side RFP comparison
│   └── api/analyze.js      → AI brain — Groq integration + normalization
├── components/
│   └── ResultsPanel.js     → Compliance table + deliverables view
├── utils/
│   └── exportToJson.js     → JSON export transform + download
├── styles/globals.css      → Custom styling on top of Bootstrap
└── .env.local               → GROQ_API_KEY (never commit)
```

---

## 🗺️ Roadmap

- [x] Section-aware extraction (no more truncation on long RFPs)
- [x] Evidence-backed 4-column compliance table
- [x] GO / NO-GO / ESCALATE routing
- [x] Deliverables accordion + side-by-side compare
- [x] Executive summary, key requirements, risk register & timeline extraction
- [x] Go/No-Go assessment + per-item risk level / mitigation / bid impact
- [x] Export as JSON
- [ ] Live deployment on Vercel
- [ ] Multi-user accounts (Supabase Auth + Postgres)
- [ ] Retry logic for AI rate limits

---

<div align="center">

Built with ☕ and a lot of debugging by **Zarman Sattar**
SPS Internship Deliverable · 2026

</div>
