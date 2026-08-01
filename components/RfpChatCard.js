import { useState, useRef, useEffect } from 'react'

// A1 — ask questions about this RFP in plain language.
//
// COSTS TOKENS, and only on an explicit send. There is no auto-load, no
// question fired on mount, and no follow-up call the user did not press —
// the same contract §6.5's judge button and §8.3's draft button keep.
//
// Answers are grounded: the route hands the model a few labelled pages and
// requires it to cite them, so every answer here arrives with the page
// numbers it came from. An answer with no pages is shown as not found rather
// than dressed up as knowledge.
//
// Nothing is persisted. The thread lives in component state and is gone on
// reload, which is why this needs no table.

/** Rough per-question cost: 6 pages of context plus the answer. */
const EST_TOKENS_PER_QUESTION = 3500

const SUGGESTIONS = [
  'When is the submission deadline?',
  'What insurance limits are required?',
  'Is a proposal bond required, and how much?',
  'How should the proposal be organized?',
]

function formatTokens(value) {
  return value >= 1000 ? `~${Math.round(value / 1000)}k` : `~${value}`
}

function Bubble({ turn }) {
  if (turn.role === 'user') {
    return (
      <div className="d-flex justify-content-end mb-2">
        <div
          className="bg-primary text-white rounded px-3 py-2"
          style={{ maxWidth: '85%', fontSize: '0.88rem' }}
        >
          {turn.text}
        </div>
      </div>
    )
  }

  const notFound = turn.found === false

  return (
    <div className="d-flex justify-content-start mb-3">
      <div
        className={`rounded px-3 py-2 border ${
          notFound ? 'bg-light border-warning border-opacity-50' : 'bg-light'
        }`}
        style={{ maxWidth: '85%', fontSize: '0.88rem' }}
      >
        <div className="text-dark" style={{ whiteSpace: 'pre-wrap' }}>
          {turn.text}
        </div>

        {turn.pages?.length > 0 ? (
          <div className="mt-2 d-flex flex-wrap gap-1 align-items-center">
            <span className="text-muted" style={{ fontSize: '0.72rem' }}>
              From
            </span>
            {turn.pages.map((page) => (
              <span
                key={page}
                className="badge bg-white text-dark border"
                style={{ fontSize: '0.7rem' }}
              >
                p.{page}
              </span>
            ))}
          </div>
        ) : notFound ? (
          <div className="text-muted mt-2" style={{ fontSize: '0.72rem' }}>
            Not stated in the pages searched — no citation to give.
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default function RfpChatCard({ rfpId }) {
  const [turns, setTurns] = useState([])
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState(null)

  const threadRef = useRef(null)

  useEffect(() => {
    // Keep the newest answer in view without yanking the whole page around.
    threadRef.current?.scrollTo({
      top: threadRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [turns, asking])

  async function ask(text) {
    const trimmed = String(text || '').trim()

    if (!trimmed || asking || !rfpId) {
      return
    }

    setQuestion('')
    setError(null)
    setAsking(true)
    setTurns((previous) => [...previous, { role: 'user', text: trimmed }])

    try {
      const response = await fetch('/api/chat/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rfp_id: rfpId, question: trimmed }),
      })

      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        setError(payload.error || 'That question could not be answered.')

        return
      }

      setTurns((previous) => [
        ...previous,
        {
          role: 'assistant',
          text: payload.answer || 'No answer was returned.',
          pages: payload.pages || [],
          found: payload.found,
          searched: payload.context?.pages_supplied?.length || 0,
          total: payload.context?.pages_total || 0,
        },
      ])
    } catch (err) {
      setError(err?.message || 'Could not reach the answering service.')
    } finally {
      setAsking(false)
    }
  }

  if (!rfpId) {
    return null
  }

  const lastAnswer = [...turns].reverse().find((turn) => turn.role === 'assistant')

  return (
    <div className="card mb-4 shadow-sm border-0">
      <div className="card-header bg-transparent border-bottom d-flex justify-content-between align-items-center flex-wrap gap-2">
        <h5 className="mb-0 fw-bold text-primary">💬 Ask this RFP</h5>
        <span className="badge bg-light text-dark border">
          {formatTokens(EST_TOKENS_PER_QUESTION)} tokens / question
        </span>
      </div>

      <div className="card-body">
        {turns.length === 0 && (
          <div className="alert alert-secondary py-2" style={{ fontSize: '0.85rem' }}>
            Answers come only from this document's stored text, with the page
            numbers they were read from. If the document does not say, the
            answer will say that rather than guess. Each question is a separate
            AI call costing roughly{' '}
            <strong>{formatTokens(EST_TOKENS_PER_QUESTION)} tokens</strong> —
            nothing is sent until you press Ask.
          </div>
        )}

        {turns.length > 0 && (
          <div
            ref={threadRef}
            className="mb-3 pe-1"
            style={{ maxHeight: 340, overflowY: 'auto' }}
          >
            {turns.map((turn, index) => (
              <Bubble key={index} turn={turn} />
            ))}

            {asking && (
              <div className="text-muted" style={{ fontSize: '0.82rem' }}>
                <span
                  className="spinner-border spinner-border-sm me-2"
                  role="status"
                />
                Reading the document…
              </div>
            )}
          </div>
        )}

        {error && <div className="alert alert-warning py-2">{error}</div>}

        <div className="d-flex gap-2 flex-wrap">
          <input
            className="form-control"
            style={{ minWidth: 240, flex: 1 }}
            placeholder="e.g. What are the insurance requirements?"
            value={question}
            maxLength={500}
            disabled={asking}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                ask(question)
              }
            }}
          />
          <button
            className="btn btn-primary fw-semibold"
            onClick={() => ask(question)}
            disabled={asking || !question.trim()}
          >
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </div>

        {turns.length === 0 && (
          <div className="mt-2 d-flex flex-wrap gap-1">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                className="btn btn-sm btn-outline-secondary"
                style={{ fontSize: '0.75rem' }}
                disabled={asking}
                onClick={() => ask(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        <div
          className="text-muted mt-3 pt-3 border-top"
          style={{ fontSize: '0.78rem', lineHeight: '1.6' }}
        >
          {lastAnswer?.total > 0 ? (
            <>
              The last question searched {lastAnswer.searched} of{' '}
              {lastAnswer.total} pages, chosen by keyword match — so a fact
              buried in wording unlike your question can be missed. Ask again
              using the document's own terms if an answer looks thin.
            </>
          ) : (
            <>
              Questions are matched to the most relevant pages first, so the
              whole document is not re-read (and re-charged) every time. Answers
              are not legal advice and are not a substitute for reading the
              cited pages.
            </>
          )}
        </div>
      </div>
    </div>
  )
}
