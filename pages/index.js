import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import ResultsPanel from '../components/ResultsPanel'
import { exportReportPdf } from '../utils/exportReportPdf'
import { supabase } from '../lib/supabase/client'

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}


function exportToExcel(results) {
  import('xlsx').then((XLSX) => {
    const workbook = XLSX.utils.book_new()

    const summaryData = [
      ['Field', 'Value'],
      ['Issuing Agency', results.summary?.issuingAgency || ''],
      ['Project Title', results.summary?.projectTitle || ''],
      ['RFP Number', results.summary?.rfpNumber || ''],
      ['Contract Value', results.summary?.contractValue || ''],
      ['Submission Deadline', results.summary?.submissionDeadline || ''],
      ['Project Duration', results.summary?.projectDuration || ''],
    ]
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData)
    summarySheet['!cols'] = [{ wch: 25 }, { wch: 50 }]
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary')

    const deliverableData = [
      ['#', 'Deliverable'],
      ...(results.deliverables || []).map((item, i) => [i + 1, item])
    ]
    const deliverableSheet = XLSX.utils.aoa_to_sheet(deliverableData)
    deliverableSheet['!cols'] = [{ wch: 5 }, { wch: 80 }]
    XLSX.utils.book_append_sheet(workbook, deliverableSheet, 'Deliverables')

    const criteriaData = [
      ['#', 'Evaluation Criterion'],
      ...(results.evaluationCriteria || []).map((item, i) => [i + 1, item])
    ]
    const criteriaSheet = XLSX.utils.aoa_to_sheet(criteriaData)
    criteriaSheet['!cols'] = [{ wch: 5 }, { wch: 80 }]
    XLSX.utils.book_append_sheet(workbook, criteriaSheet, 'Evaluation Criteria')

    for (const dept of ['financial', 'legal', 'operations', 'technical']) {
      const items = results.complianceChecklist?.[dept] || []
      const sheetData = [
        ['Task', 'Status', 'Reason'],
        ...items.map(item => [item.task, item.status, item.reason || ''])
      ]
      const sheet = XLSX.utils.aoa_to_sheet(sheetData)
      sheet['!cols'] = [{ wch: 50 }, { wch: 12 }, { wch: 70 }]
      XLSX.utils.book_append_sheet(workbook, sheet, dept.charAt(0).toUpperCase() + dept.slice(1))
    }

    XLSX.writeFile(workbook, 'BidLens_RFP_Analysis.xlsx')
  })
}

export default function Home() {
  const router = useRouter()
  const [session, setSession] = useState(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState(null)
  // The id of the rfps row this analysis was saved to. ResultsPanel needs it
  // to load the shredded requirements for its Traceability Matrix, and it is
  // only known after the insert below succeeds.
  const [rfpId, setRfpId] = useState(null)
  const [error, setError] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [progress, setProgress] = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const [showToast, setShowToast] = useState(false)

  // §7.1 — additional files bundled into the same RFP package. The base file
  // above is still the one that gets analyzed; these only contribute text.
  const [attachments, setAttachments] = useState([])
  const attachmentInputRef = useRef(null)

  const fileInputRef = useRef(null)
  const resultsRef = useRef(null)
  const toastTimerRef = useRef(null)
  const progressTimerRef = useRef(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        router.push('/login')
      } else {
        setSession(data.session)
        setCheckingSession(false)
      }
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!newSession) {
        router.push('/login')
      } else {
        setSession(newSession)
      }
    })
    return () => listener.subscription.unsubscribe()
  }, [router])

  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  function handleFileChange(e) {
    const selected = e.target.files[0]
    if (selected && selected.type === 'application/pdf') {
      setFile(selected)
      setResults(null)
      setRfpId(null)
      setError(null)
      setSaveError(null)
      setShowToast(false)
      setProgress(0)
      setProgressLabel('')
    } else {
      setError('Please select a valid PDF file.')
    }
  }

  function handleRemoveFile(e) {
    e.stopPropagation()
    setFile(null)
    // Attachments belong to the base file they were bundled with; keeping them
    // after it is removed would silently attach them to the next upload.
    setAttachments([])
    setResults(null)
    setRfpId(null)
    setError(null)
    setSaveError(null)
    setShowToast(false)
    setProgress(0)
    setProgressLabel('')
    fileInputRef.current.value = ''
  }

  function handleZoneClick() {
    fileInputRef.current.click()
  }

  // §7.1 — attachment handling. Deliberately separate from the base file:
  // exhibits and wage determinations belong to the same solicitation, but only
  // the base document is worth spending an AI analysis on.
  function handleAttachmentsChange(e) {
    const picked = Array.from(e.target.files || []).filter(
      (candidate) => candidate.type === 'application/pdf'
    )

    if (picked.length !== (e.target.files?.length || 0)) {
      setError('Only PDF attachments are supported; non-PDF files were ignored.')
    }

    setAttachments((previous) => {
      const seen = new Set(previous.map((entry) => entry.name))

      return [...previous, ...picked.filter((entry) => !seen.has(entry.name))]
    })

    e.target.value = ''
  }

  function removeAttachment(name) {
    setAttachments((previous) => previous.filter((entry) => entry.name !== name))
  }

  function handleDragOver(e) {
    e.preventDefault()
  }

  function handleDrop(e) {
    e.preventDefault()
    const dropped = e.dataTransfer.files[0]
    if (dropped && dropped.type === 'application/pdf') {
      setFile(dropped)
      setResults(null)
      setRfpId(null)
      setError(null)
      setSaveError(null)
      setShowToast(false)
      setProgress(0)
      setProgressLabel('')
    } else {
      setError('Please drop a valid PDF file.')
    }
  }

  function startProgressSimulation() {
    const stages = [
      { pct: 15, label: 'Reading PDF text...' },
      { pct: 35, label: 'Connecting to Groq AI...' },
      { pct: 60, label: 'Analyzing document...' },
      { pct: 80, label: 'Applying compliance rules...' },
      { pct: 92, label: 'Parsing results...' },
    ]
    let stageIndex = 0
    setProgress(5)
    setProgressLabel('Starting analysis...')

    progressTimerRef.current = setInterval(() => {
      if (stageIndex < stages.length) {
        setProgress(stages[stageIndex].pct)
        setProgressLabel(stages[stageIndex].label)
        stageIndex++
      } else {
        clearInterval(progressTimerRef.current)
      }
    }, 2000)
  }

  function stopProgressSimulation(success) {
    clearInterval(progressTimerRef.current)
    if (success) {
      setProgress(100)
      setProgressLabel('Analysis complete!')
    } else {
      setProgress(0)
      setProgressLabel('')
    }
  }

  // §7.1 — extracts an attachment's text WITHOUT an AI call.
  //
  // The base solicitation still goes to /api/analyze exactly as before: one
  // Groq call per upload, unchanged. Attachments go to /api/package/extract,
  // which only parses PDF text. Sending five files through /api/analyze would
  // quintuple the cost of an upload, which is not what attaching exhibits
  // should mean.
  async function extractAttachment(attachment) {
    const formData = new FormData()
    formData.append('file', attachment)

    const response = await fetch('/api/package/extract', {
      method: 'POST',
      body: formData,
    })

    const payload = await response.json().catch(() => ({}))

    if (!response.ok) {
      throw new Error(`${attachment.name}: ${payload.error || 'extraction failed'}`)
    }

    return payload
  }

  async function handleAnalyze() {
    if (!file) return
    setLoading(true)
    setResults(null)
    setRfpId(null)
    setError(null)
    setSaveError(null)
    setShowToast(false)
    setProgress(0)

    startProgressSimulation()

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 90000)

    try {
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch('/api/analyze', {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      })

      const data = await response.json()

      if (!response.ok) {
        stopProgressSimulation(false)
        setError(data.error || 'Something went wrong. Please try again.')
        return
      }

      stopProgressSimulation(true)
      setResults(data)

      // Save to Supabase (rfps + analyses), replacing the old localStorage write
      try {
        // /api/analyze returns the document text alongside the analysis:
        // sourceText as one string, pages as one string per page. Both belong
        // on the rfps row only — splitting them off here keeps a second copy
        // out of the analyses row.
        const { sourceText, pages: pageTexts, ...analysis } = data

        // §7.1 — pull in any attachments' text before the insert, so the
        // package is stored as one document from the start.
        //
        // rfps.raw_text / rfps.pages remain the WHOLE package concatenated,
        // base file first. That is what keeps the shredder, the risk scan and
        // the fit check working with no changes at all — they read those two
        // columns and neither knows nor cares how many files produced them.
        const basePages = Array.isArray(pageTexts) ? pageTexts : []

        const filePlan = [
          {
            filename: file.name,
            role: 'base',
            raw_text: sourceText ?? null,
            pages: basePages,
          },
        ]

        for (const attachment of attachments) {
          setProgressLabel(`Extracting ${attachment.name}…`)

          const extracted = await extractAttachment(attachment)

          filePlan.push({
            filename: extracted.filename || attachment.name,
            role: 'attachment',
            raw_text: extracted.raw_text ?? null,
            pages: Array.isArray(extracted.pages) ? extracted.pages : [],
          })
        }

        const combinedPages = filePlan.flatMap((entry) => entry.pages)
        const combinedText = filePlan
          .map((entry) => entry.raw_text)
          .filter(Boolean)
          .join('\n\n')

        const { data: rfpRow, error: rfpError } = await supabase
          .from('rfps')
          .insert({
            owner_id: session.user.id,
            title: file.name,
            original_filename: file.name,
            status: 'analyzed',
            raw_text: combinedText || sourceText || null,
            pages: combinedPages.length > 0 ? combinedPages : null,
          })
          .select()
          .single()

        if (rfpError) {
          setSaveError('Analysis complete, but saving to history failed: ' + rfpError.message)
        } else {
          // §7.1 — record what the package was made of. Only written when
          // there IS a package: a lone file leaves this empty, which is
          // exactly the state every RFP uploaded before this feature is in,
          // and readers treat "no rows" as "single file".
          if (filePlan.length > 1) {
            let offset = 0

            const fileRows = filePlan.map((entry, index) => {
              const row = {
                rfp_id: rfpRow.id,
                filename: entry.filename,
                role: entry.role,
                sort_order: index,
                raw_text: entry.raw_text,
                pages: entry.pages.length > 0 ? entry.pages : null,
                page_offset: offset,
                page_count: entry.pages.length,
              }

              offset += entry.pages.length

              return row
            })

            const { error: filesError } = await supabase
              .from('rfp_files')
              .insert(fileRows)

            if (filesError) {
              setSaveError(
                'Analysis saved, but the per-file breakdown failed: ' +
                  filesError.message +
                  ' Cross-file contradiction checks will be unavailable.'
              )
            }
          }

          // Published only once rfp_files is written. The cards that take an
          // rfpId fetch the moment they receive one, and §7.2's cross-file
          // check reads rfp_files — handing out the id any earlier races that
          // insert and the check sees a package with no files in it.
          setRfpId(rfpRow.id)

          const { error: analysisError } = await supabase
            .from('analyses')
            .insert({
              rfp_id: rfpRow.id,
              owner_id: session.user.id,
              result: analysis,
            })

          if (analysisError) {
            setSaveError('Analysis complete, but saving to history failed: ' + analysisError.message)
          }
        }
      } catch (saveErr) {
        setSaveError('Analysis complete, but saving to history failed: ' + saveErr.message)
      }

      // Show toast
      setShowToast(true)
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      toastTimerRef.current = setTimeout(() => setShowToast(false), 3000)

      // Auto-scroll to results after React renders
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth' })
      }, 100)

    } catch (err) {
      stopProgressSimulation(false)
      if (err.name === 'AbortError') {
        setError('The analysis is taking longer than expected. Please try again - if this keeps happening, the RFP may be too large or complex.')
      } else {
        setError('Network error. Make sure the server is running.')
      }
    } finally {
      clearTimeout(timeoutId)
      setLoading(false)
    }
  }

  if (checkingSession) {
    return <div className="container py-5">Loading...</div>
  }

  return (
    <>
      {/* Toast Notification */}
      {showToast && (
        <div className="toast-container">
          <div className="toast-box">
            ✅ Analysis complete!
          </div>
        </div>
      )}

      {/* Navbar */}
      <nav className="navbar navbar-dark bg-dark px-4">
        <span className="navbar-brand fw-bold fs-4">
          Bid<span>Lens</span>
        </span>
        <div className="d-flex align-items-center gap-3">
          <span className="text-secondary small">{session?.user?.email}</span>
          <Link href="/dashboard" className="btn btn-outline-light btn-sm">📊 Dashboard</Link>
          <Link href="/company-profile" className="btn btn-outline-light btn-sm">🏢 Company Profile</Link>
          <Link href="/content-library" className="btn btn-outline-light btn-sm">📚 Content Library</Link>
          <button className="btn btn-outline-light btn-sm" onClick={handleSignOut}>Sign out</button>
        </div>
      </nav>

      {/* Main Container */}
      <div className="container py-5" style={{ maxWidth: '860px' }}>

        <div className="text-center mb-5">
          <h1 className="fw-bold">Analyze Your RFP</h1>
          <p className="text-muted">
            Upload a Request for Proposal PDF and BidLens will automatically extract
            deliverables, evaluation criteria, and a department-wise compliance checklist.
          </p>
        </div>

        {/* Upload Zone */}
        <div
          className="upload-zone mb-3"
          onClick={handleZoneClick}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <input
            type="file"
            accept="application/pdf"
            ref={fileInputRef}
            onChange={handleFileChange}
          />
          <div className="mb-2" style={{ fontSize: '2.5rem' }}>📄</div>
          {file ? (
            <div className="file-info-card" onClick={e => e.stopPropagation()}>
              <div className="file-info-details">
                <span className="file-info-name">{file.name}</span>
                <span className="file-info-size">{formatFileSize(file.size)}</span>
              </div>
              <button
                className="btn btn-sm btn-outline-danger"
                onClick={handleRemoveFile}
              >
                ✕ Remove
              </button>
            </div>
          ) : (
            <>
              <p className="mb-1 fw-semibold">Click to upload or drag and drop</p>
              <p className="text-muted small mb-0">PDF files only</p>
            </>
          )}
        </div>

        {/* §7.1 — attachments. Only offered once a base file is chosen, so the
            two roles cannot be confused: the base document is what gets
            analyzed, these are bundled with it. */}
        {file && (
          <div className="card border-0 shadow-sm mb-3">
            <div className="card-body py-3">
              <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
                <div>
                  <span className="fw-semibold text-dark">
                    📎 Attachments{' '}
                    {attachments.length > 0 && (
                      <span className="badge bg-light text-dark border">
                        {attachments.length}
                      </span>
                    )}
                  </span>
                  <div className="text-muted" style={{ fontSize: '0.78rem' }}>
                    Exhibits, wage determinations, pricing sheets, Q&amp;A. Their
                    text joins the same package — no extra AI cost.
                  </div>
                </div>

                <button
                  type="button"
                  className="btn btn-sm btn-outline-primary fw-semibold"
                  onClick={() => attachmentInputRef.current?.click()}
                  disabled={loading}
                >
                  + Add files
                </button>

                <input
                  type="file"
                  accept="application/pdf"
                  multiple
                  ref={attachmentInputRef}
                  onChange={handleAttachmentsChange}
                  style={{ display: 'none' }}
                />
              </div>

              {attachments.length > 0 && (
                <ul className="list-group list-group-flush mt-3">
                  {attachments.map((attachment) => (
                    <li
                      key={attachment.name}
                      className="list-group-item d-flex justify-content-between align-items-center px-0 py-2"
                    >
                      <span style={{ fontSize: '0.85rem' }}>
                        {attachment.name}{' '}
                        <span className="text-muted">
                          {formatFileSize(attachment.size)}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() => removeAttachment(attachment.name)}
                        disabled={loading}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="alert alert-danger" role="alert">
            {error}
          </div>
        )}

        {/* Save Warning (analysis succeeded, but persisting it failed) */}
        {saveError && (
          <div className="alert alert-warning" role="alert">
            {saveError}
          </div>
        )}

        {/* Analyze Button */}
        <div className="d-grid mb-3">
          <button
            className="btn btn-primary btn-lg"
            onClick={handleAnalyze}
            disabled={!file || loading}
          >
            {loading ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" role="status" />
                Analyzing with AI...
              </>
            ) : (
              '🔍 Analyze RFP'
            )}
          </button>
        </div>

        {/* Progress Bar */}
        {loading && (
          <div className="mb-4">
            <div className="d-flex justify-content-between mb-1">
              <small className="text-muted">{progressLabel}</small>
              <small className="text-muted">{progress}%</small>
            </div>
            <div className="progress" style={{ height: '8px' }}>
              <div
                className="progress-bar progress-bar-striped progress-bar-animated bg-primary"
                role="progressbar"
                style={{ width: `${progress}%`, transition: 'width 0.8s ease' }}
              />
            </div>
          </div>
        )}

        {/* Results */}
        <div ref={resultsRef}>
          {results && (
            <ResultsPanel
              data={results}
              rfpId={rfpId}
              // A3 — the same button, now producing the full report (cover,
              // summary, risks, fit, requirements) instead of a bare table
              // dump. rfpId enables the fit section; without it that section
              // says so rather than being silently omitted.
              onExportPDF={() => exportReportPdf(results, { rfpId })}
              onExportExcel={() => exportToExcel(results)}
            />
          )}
        </div>

      </div>
    </>
  )
}
