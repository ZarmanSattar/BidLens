<div align="center">

# 🔍 BidLens

### AI-Powered RFP Compliance Analyzer

**Turn a 100+ page RFP into a clear GO / NO-GO / ESCALATE decision in under 30 seconds.**

[![Next.js](https://img.shields.io/badge/Next.js-Pages%20Router-000000?style=flat-square&logo=next.js)](https://nextjs.org/)
[![Groq](https://img.shields.io/badge/AI-LLaMA%203.3%2070B%20via%20Groq-F55036?style=flat-square)](https://groq.com/)
[![Bootstrap](https://img.shields.io/badge/UI-Bootstrap%205-7952B3?style=flat-square&logo=bootstrap)](https://getbootstrap.com/)
[![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)]()
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)]()

</div>

---

## 📌 Overview

**BidLens** is an internal tool built for the **Software Productivity Strategists (SPS)** proposal team. It reads uploaded RFP (Request for Proposal) documents and automatically produces a structured, evidence-backed compliance breakdown — so the team can decide whether to bid, without manually combing through dozens of pages of legal and financial fine print.

Every decision the AI makes is **backed by a real quote pulled directly from the RFP** — not a guess, not boilerplate.

---

## ✨ Key Features

| Feature | Description |
|---|---|
| 📤 **Drag & Drop Upload** | Upload any RFP PDF with a live, staged progress indicator |
| 🧠 **Section-Aware Extraction** | Hunts down compliance-relevant clauses anywhere in the document — including buried exhibits — instead of blindly truncating long files |
| 🧾 **Evidence Engine** | The AI must quote exact/near-exact RFP text with section labels to justify every decision |
| 📊 **4-Column Compliance Table** | Checklist Item · Decision · Reason · Evidence — for Financial, Legal, Operations & Technical |
| 🚦 **GO / NO-GO / ESCALATE Routing** | Financial items are checked against hard SPS thresholds (e.g. NET30, $5M insurance cap); verification-only items are routed to ESCALATE |
| 🗂️ **Deliverables Accordion** | Deliverables grouped into a clean parent → child hierarchy, expandable on demand |
| 🎯 **Bid Decision Score** | A single /100 score summarizing bid strength at a glance |
| ⚠️ **Risk Flag Summary** | Surfaces NO-GO and high-priority ESCALATE items immediately |
| 🔀 **Side-by-Side Compare** | Stack multiple analyzed RFPs to spot the best opportunity fast |
| 📁 **PDF / Excel Export** | One-click export of the full compliance report, tables and all |

---

## 🧠 How It Works

```
              📄 RFP Upload
                    │
                    ▼
     ┌───────────────────────────┐
     │   pdf-parse extraction     │
     └───────────────────────────┘
                    │
                    ▼
     ┌───────────────────────────┐
     │ Section-Aware Extraction   │  ← finds Payment Terms, Insurance,
     │ (main body + keyword hunt) │     Bid Bond, etc. anywhere in the doc
     └───────────────────────────┘
                    │
                    ▼
     ┌───────────────────────────┐
     │  LLaMA 3.3 70B via Groq    │  ← forced to quote real evidence
     └───────────────────────────┘
                    │
                    ▼
     ┌───────────────────────────┐
     │  Compliance Table + Score  │
     └───────────────────────────┘
```

---

## 🛠️ Tech Stack

- **Framework:** Next.js (Pages Router)
- **UI:** Bootstrap 5 + custom styling
- **AI:** Groq API — LLaMA 3.3 70B
- **PDF Parsing:** `pdf-parse` v1.1.1
- **Export:** jsPDF + jspdf-autotable, SheetJS (xlsx)
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
│   ├── index.js          → Upload UI + export controls
│   ├── dashboard.js       → History, stats, deadline tracker
│   ├── compare.js         → Side-by-side RFP comparison
│   └── api/analyze.js     → AI brain — Groq integration
├── components/
│   └── ResultsPanel.js    → Compliance table + deliverables view
├── styles/globals.css     → Custom styling on top of Bootstrap
└── .env.local              → GROQ_API_KEY (never commit)
```

---

## 🗺️ Roadmap

- [x] Section-aware extraction (no more truncation on long RFPs)
- [x] Evidence-backed 4-column compliance table
- [x] GO / NO-GO / ESCALATE routing
- [x] Deliverables accordion + side-by-side compare
- [ ] Live deployment on Vercel
- [ ] Multi-user accounts (Supabase Auth + Postgres)
- [ ] Retry logic for AI rate limits

---

<div align="center">

Built with ☕ and a lot of debugging by **Zarman Sattar**
SPS Internship Deliverable · 2026

</div>
