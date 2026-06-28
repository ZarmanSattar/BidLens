import { useState, useRef } from 'react'
import ResultsPanel from '../components/ResultsPanel'

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function exportToPDF(results) {
  import('jspdf').then(({ default: jsPDF }) => {
    import('jspdf-autotable').then(({ default: autoTable }) => {
      const doc = new jsPDF()
      const pageWidth = doc.internal.pageSize.getWidth()

      doc.setFontSize(20)
      doc.setTextColor(13, 110, 253)
      doc.text('BidLens — RFP Analysis Report', pageWidth / 2, 18, { align: 'center' })

      if (results.summary) {
        doc.setFontSize(13)
        doc.setTextColor(33, 37, 41)
        doc.text('RFP Summary', 14, 30)
        autoTable(doc, {
          startY: 34,
          head: [['Field', 'Value']],
          body: [
            ['Issuing Agency', results.summary.issuingAgency || 'N/A'],
            ['Project Title', results.summary.projectTitle || 'N/A'],
            ['RFP Number', results.summary.rfpNumber || 'N/A'],
            ['Contract Value', results.summary.contractValue || 'N/A'],
            ['Submission Deadline', results.summary.submissionDeadline || 'N/A'],
            ['Project Duration', results.summary.projectDuration || 'N/A'],
          ],
          theme: 'grid',
          headStyles: { fillColor: [108, 117, 125] },
          styles: { fontSize: 9 },
        })
      }

      const afterSummary = doc.lastAutoTable.finalY + 8
      doc.setFontSize(13)
      doc.setTextColor(33, 37, 41)
      doc.text('Deliverables', 14, afterSummary)
      autoTable(doc, {
        startY: afterSummary + 4,
        head: [['#', 'Deliverable']],
        body: (results.deliverables || []).map((item, i) => [i + 1, item]),
        theme: 'striped',
        headStyles: { fillColor: [13, 110, 253] },
        styles: { fontSize: 9 },
        columnStyles: { 0: { cellWidth: 10 } },
      })

      const afterDeliverables = doc.lastAutoTable.finalY + 8
      doc.setFontSize(13)
      doc.text('Evaluation Criteria', 14, afterDeliverables)
      autoTable(doc, {
        startY: afterDeliverables + 4,
        head: [['#', 'Criterion']],
        body: (results.evaluationCriteria || []).map((item, i) => [i + 1, item]),
        theme: 'striped',
        headStyles: { fillColor: [13, 202, 240] },
        styles: { fontSize: 9 },
        columnStyles: { 0: { cellWidth: 10 } },
      })

      const departments = [
        { key: 'financial', label: 'Financial', color: [255, 193, 7] },
        { key: 'legal', label: 'Legal', color: [220, 53, 69] },
        { key: 'operations', label: 'Operations', color: [108, 117, 125] },
        { key: 'technical', label: 'Technical', color: [13, 110, 253] },
      ]

      for (const dept of departments) {
        const items = results.complianceChecklist?.[dept.key] || []
        if (items.length === 0) continue
        const startY = doc.lastAutoTable.finalY + 8
        doc.setFontSize(13)
        doc.setTextColor(33, 37, 41)
        doc.text(`Compliance — ${dept.label}`, 14, startY)
        autoTable(doc, {
          startY: startY + 4,
          head: [['Task', 'Status', 'Reason']],
          body: items.map(item => [item.task, item.status, item.reason || '']),
          theme: 'grid',
          headStyles: { fillColor: dept.color },
          styles: { fontSize: 8, cellPadding: 3 },
          columnStyles: {
            0: { cellWidth: 70 },
            1: { cellWidth: 20, halign: 'center' },
            2: { cellWidth: 90 },
          },
        })
      }

      const pageCount = doc.internal.getNumberOfPages()
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i)
        doc.setFontSize(8)
        doc.setTextColor(150)
        doc.text(
          `BidLens RFP Analysis — Page ${i} of ${pageCount}`,
          pageWidth / 2,
          doc.internal.pageSize.getHeight() - 8,
          { align: 'center' }
        )
      }

      doc.save('BidLens_RFP_Analysis.pdf')
    })
  })
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
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const [showToast, setShowToast] = useState(false)

  const fileInputRef = useRef(null)
  const resultsRef = useRef(null)
  const toastTimerRef = useRef(null)
  const progressTimerRef = useRef(null)

  function handleFileChange(e) {
    const selected = e.target.files[0]
    if (selected && selected.type === 'application/pdf') {
      setFile(selected)
      setResults(null)
      setError(null)
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
    setResults(null)
    setError(null)
    setShowToast(false)
    setProgress(0)
    setProgressLabel('')
    fileInputRef.current.value = ''
  }

  function handleZoneClick() {
    fileInputRef.current.click()
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
      setError(null)
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

  async function handleAnalyze() {
    if (!file) return
    setLoading(true)
    setResults(null)
    setError(null)
    setShowToast(false)
    setProgress(0)

    startProgressSimulation()

    try {
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch('/api/analyze', {
        method: 'POST',
        body: formData,
      })

      const data = await response.json()

      if (!response.ok) {
        stopProgressSimulation(false)
        setError(data.error || 'Something went wrong. Please try again.')
        return
      }

      stopProgressSimulation(true)
      setResults(data)

      // Save to localStorage history
      if (typeof window !== 'undefined') {
        const entry = {
          id: Date.now(),
          fileName: file.name,
          analyzedAt: new Date().toISOString(),
          summary: data.summary,
          deliverables: data.deliverables,
          evaluationCriteria: data.evaluationCriteria,
          complianceChecklist: data.complianceChecklist,
        }
        const existing = localStorage.getItem('bidlens_history')
        const history = existing ? JSON.parse(existing) : []
        history.push(entry)
        localStorage.setItem('bidlens_history', JSON.stringify(history))
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
      setError('Network error. Make sure the server is running.')
    } finally {
      setLoading(false)
    }
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
          <span className="text-secondary small">AI-Powered RFP Analyzer</span>
          <a href="/dashboard" className="btn btn-outline-light btn-sm">📊 Dashboard</a>
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

        {/* Error Message */}
        {error && (
          <div className="alert alert-danger" role="alert">
            {error}
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
              onExportPDF={() => exportToPDF(results)}
              onExportExcel={() => exportToExcel(results)}
            />
          )}
        </div>

      </div>
    </>
  )
}
