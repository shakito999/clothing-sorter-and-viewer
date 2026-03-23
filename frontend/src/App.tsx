import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

// Types
interface LogEntry {
  time: string
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
}

interface ExtractedItem {
  title: string
  brand: string
  size: string
  condition: string
  material: string
  color: string
  item_type?: string
  measurements: Record<string, string>
  visible_flaws: string
  images: string[]
  image_types?: string[]
  output_folder: string
  processed_at?: string
  batch_index?: number
  description?: string
}

interface PipelineState {
  is_running: boolean
  phase: string
  current_batch: number
  total_batches: number
  current_operation: string
  stats: {
    total_images: number
    total_garments: number
    successful: number
    failed: number
  }
  extracted_data: ExtractedItem[]
  logs: LogEntry[]
  started_at?: string
  ended_at?: string
  elapsed_seconds?: number
}

interface WSMessage {
  type: 'state' | 'log' | 'welcome' | 'pong' | 'image_classification' | 'item_complete' | 'comparison_result'
  data?: PipelineState | LogEntry | { server_version: string; timestamp: string } | ImageClassificationData | ExtractedItem | ComparisonResultData
}

interface ImageClassificationData {
  image: string
  image_data?: string
  type: string
  garment?: number
  total_garments?: number
  image_index?: number
  total_images?: number
  batch?: number
  reason?: string
}

interface ComparisonResultData {
  reference: string
  reference_image?: string
  current: string
  current_image?: string
  is_same: boolean
  reasoning: string
  confidence: number
  time_diff_seconds: number
  batch_index?: number
}

interface DeletedPhotoUndo {
  trash_path: string
  original_path: string
  parent_dir: string
  filename: string
  index?: number
  removed_type?: string
  removed_caption?: string
}

// API functions
const API_BASE = 'http://localhost:8000'

async function getState(): Promise<PipelineState> {
  const res = await fetch(`${API_BASE}/api/state`)
  return res.json()
}

async function getImages(): Promise<{ count: number; images: string[] }> {
  const res = await fetch(`${API_BASE}/api/images`)
  return res.json()
}

async function startPipeline() {
  await fetch(`${API_BASE}/api/start`, { method: 'POST' })
}

async function stopPipeline() {
  await fetch(`${API_BASE}/api/stop`, { method: 'POST' })
}

async function saveItemEdits(item: ExtractedItem) {
  const res = await fetch(`${API_BASE}/api/save-item`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      item_folder: item.output_folder,
      title: item.title,
      brand: item.brand,
      size: item.size,
      condition: item.condition,
      material: item.material,
      color: item.color,
      measurements: item.measurements,
      visible_flaws: item.visible_flaws,
      description: item.description
    })
  })
  return res.json()
}

async function openInputFolder() {
  try {
    await fetch(`${API_BASE}/api/open-input-folder`)
  } catch (e) {
    console.error('Failed to open input folder:', e)
  }
}

async function openOutputFolder() {
  try {
    await fetch(`${API_BASE}/api/open-output-folder`)
  } catch (e) {
    console.error('Failed to open output folder:', e)
  }
}

async function deleteItemPhoto(path: string) {
  const res = await fetch(`${API_BASE}/api/item-photo?path=${encodeURIComponent(path)}`, {
    method: 'DELETE'
  })
  return res.json()
}

async function restoreDeletedPhoto(undo: DeletedPhotoUndo) {
  const res = await fetch(`${API_BASE}/api/item-photo/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(undo)
  })
  return res.json()
}

// WebSocket hook
function useWebSocket(url: string, onMessage: (msg: WSMessage) => void) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected')
  
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    setStatus('connecting')
    const ws = new WebSocket(url)
    ws.onopen = () => setStatus('connected')
    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data)
        onMessage(msg)
      } catch (e) { console.error(e) }
    }
    ws.onclose = () => {
      setStatus('disconnected')
      reconnectTimeoutRef.current = setTimeout(connect, 2000)
    }
    ws.onerror = (error) => { console.error(error); ws.close() }
    wsRef.current = ws
  }, [url, onMessage])
  
  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current)
      wsRef.current?.close()
    }
  }, [connect])
  return { status }
}

// Premium SVG Icons
const Icons = {
  Dashboard: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
  ),
  Editor: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
  ),
  Undo: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
  ),
  Save: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
  ),
  Check: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
  ),
  Sync: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2v6h-6"></path><path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path><path d="M3 22v-6h6"></path><path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path></svg>
  ),
  Folder: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
  ),
  Search: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
  ),
  Layout: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>
  ),
  Trash: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
  )
}

export default function App() {
  const [state, setState] = useState<PipelineState | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [activeTab, setActiveTab] = useState<'dashboard' | 'editor'>('dashboard')
  const [imageCount, setImageCount] = useState(0)
  const [comparisons, setComparisons] = useState<ComparisonResultData[]>([])
  const logEndRef = useRef<HTMLDivElement>(null)
  
  // Editor State
  const [selectedIdx, setSelectedIdx] = useState<number>(-1)
  const [editItem, setEditItem] = useState<ExtractedItem | null>(null)
  const [undoStack, setUndoStack] = useState<ExtractedItem[]>([])
  const [isDirty, setIsDirty] = useState(false)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [lastDeletedUndo, setLastDeletedUndo] = useState<DeletedPhotoUndo | null>(null)

  const normalizedEditImages = useMemo(() => {
    if (!editItem?.images) return []
    const seen = new Set<string>()
    const deduped: string[] = []
    for (const raw of editItem.images) {
      const base = raw.includes('/') || raw.includes('\\')
        ? raw.split(/[\\/]/).pop() || raw
        : raw
      const key = base.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        deduped.push(base)
      }
    }
    return deduped
  }, [editItem])

  const imagePathForDisplay = useCallback((img: string) => {
    if (!editItem) return img
    return img.includes('/') || img.includes('\\') ? img : `${editItem.output_folder}/${img}`
  }, [editItem])

  // Handle WebSocket messages
  const handleWSMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'state') {
      const pipelineState = msg.data as PipelineState
      setState(pipelineState)
      if (pipelineState.logs) setLogs(pipelineState.logs)
    } else if (msg.type === 'log') {
      setLogs(prev => [...prev.slice(-499), msg.data as LogEntry])
    } else if (msg.type === 'comparison_result') {
      setComparisons(prev => [...prev, msg.data as ComparisonResultData])
    }
  }, [])
  
  const { status: wsStatus } = useWebSocket('ws://localhost:8000/ws', handleWSMessage)
  
  useEffect(() => {
    getImages().then(data => setImageCount(data.count)).catch(() => {})
    getState().then(setState).catch(() => {})
  }, [])

  // Auto-save on exit/switch
  const saveCurrent = useCallback(async () => {
    if (!editItem || !isDirty) return
    setIsSaving(true)
    try {
      await saveItemEdits(editItem)
      setIsDirty(false)
      // Update the main state list so the sidebar reflects changes
      if (state && selectedIdx !== -1) {
        const newData = [...state.extracted_data]
        newData[selectedIdx] = { ...editItem }
        setState({ ...state, extracted_data: newData })
      }
    } catch (e) {
      console.error('Save failed', e)
    } finally {
      setIsSaving(false)
    }
  }, [editItem, isDirty, state, selectedIdx])

  const handleSelectIdx = (idx: number) => {
    if (isDirty) saveCurrent()
    setSelectedIdx(idx)
    const item = state?.extracted_data[idx] || null
    setEditItem(item ? { ...item } : null)
    setUndoStack([])
    setIsDirty(false)
    setPreviewImage(item?.images[0] || null)
  }

  const handleEditChange = (field: keyof ExtractedItem, value: any) => {
    if (!editItem) return
    setUndoStack(prev => [...prev, { ...editItem }].slice(-20)) // Keep last 20 undos
    setEditItem({ ...editItem, [field]: value })
    setIsDirty(true)
  }

  const resolvePreviewIndex = useCallback((images: string[], preview: string | null) => {
    if (!images.length) return -1
    if (!preview) return 0
    const direct = images.indexOf(preview)
    if (direct >= 0) return direct
    const byBase = images.findIndex(img => preview.endsWith(`/${img}`) || preview.endsWith(`\\${img}`))
    return byBase >= 0 ? byBase : 0
  }, [])

  const handleUndo = () => {
    if (undoStack.length === 0) return
    const prev = undoStack[undoStack.length - 1]
    setUndoStack(prevStack => prevStack.slice(0, -1))
    setEditItem(prev)
    setIsDirty(true)
  }

  const goToPreviousImage = useCallback(() => {
    if (!editItem || normalizedEditImages.length === 0) return
    const current = resolvePreviewIndex(normalizedEditImages, previewImage)
    const nextIndex = current <= 0 ? normalizedEditImages.length - 1 : current - 1
    setPreviewImage(normalizedEditImages[nextIndex])
  }, [editItem, normalizedEditImages, previewImage, resolvePreviewIndex])

  const goToNextImage = useCallback(() => {
    if (!editItem || normalizedEditImages.length === 0) return
    const current = resolvePreviewIndex(normalizedEditImages, previewImage)
    const nextIndex = (current + 1) % normalizedEditImages.length
    setPreviewImage(normalizedEditImages[nextIndex])
  }, [editItem, normalizedEditImages, previewImage, resolvePreviewIndex])

  const handleDeleteImage = async (img?: string) => {
    if (!editItem) return
    const imageToDelete = img || previewImage
    if (!imageToDelete) return
    if (!window.confirm("Delete this image permanently?")) return

    const imgPath = imageToDelete.includes('/') || imageToDelete.includes('\\') ? imageToDelete : `${editItem.output_folder}/${imageToDelete}`
    try {
      const response = await deleteItemPhoto(imgPath)
      if (response?.undo) setLastDeletedUndo(response.undo as DeletedPhotoUndo)

      // Update local state
      const deletedBase = imageToDelete.includes('/') || imageToDelete.includes('\\')
        ? imageToDelete.split(/[\\/]/).pop() || imageToDelete
        : imageToDelete
      const deletedIndex = resolvePreviewIndex(editItem.images, imageToDelete)
      const newImages = editItem.images.filter((img, index) => {
        if (index === deletedIndex) return false
        const base = img.includes('/') || img.includes('\\') ? (img.split(/[\\/]/).pop() || img) : img
        return base !== deletedBase
      })
      const newEditItem = { ...editItem, images: newImages }

      // If we deleted the currently previewed image, switch to the first available or null
      if (previewImage === imageToDelete) {
        if (newImages.length === 0) {
          setPreviewImage(null)
        } else {
          const nextIndex = Math.min(deletedIndex, newImages.length - 1)
          setPreviewImage(newImages[nextIndex])
        }
      }

      setEditItem(newEditItem)

      // Also update global state
      if (state && selectedIdx !== -1) {
        const newData = [...state.extracted_data]
        newData[selectedIdx] = newEditItem
        setState({ ...state, extracted_data: newData })
      }
    } catch (e) {
      console.error("Failed to delete image", e)
    }
  }

  const handleUndoDelete = async () => {
    if (!lastDeletedUndo || !editItem) return
    try {
      await restoreDeletedPhoto(lastDeletedUndo)
      const restoredName = lastDeletedUndo.filename
      const insertionIndex = typeof lastDeletedUndo.index === 'number'
        ? Math.max(0, Math.min(lastDeletedUndo.index, editItem.images.length))
        : editItem.images.length

      const restoredImages = [...editItem.images]
      restoredImages.splice(insertionIndex, 0, restoredName)
      const updated = { ...editItem, images: restoredImages }

      setEditItem(updated)
      setPreviewImage(restoredName)
      setLastDeletedUndo(null)

      if (state && selectedIdx !== -1) {
        const newData = [...state.extracted_data]
        newData[selectedIdx] = updated
        setState({ ...state, extracted_data: newData })
      }
    } catch (e) {
      console.error('Failed to restore deleted image', e)
    }
  }

  // Debounced auto-save while editing metadata fields
  useEffect(() => {
    if (!isDirty || !editItem) return
    const timer = setTimeout(() => {
      saveCurrent()
    }, 900)
    return () => clearTimeout(timer)
  }, [editItem, isDirty, saveCurrent])

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        saveCurrent()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault()
        if (lastDeletedUndo) {
          handleUndoDelete()
        } else {
          handleUndo()
        }
      }
      const target = e.target as HTMLElement | null
      const isTypingTarget = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )
      if (isTypingTarget) return

      if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'a') {
        e.preventDefault()
        goToPreviousImage()
      }
      if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'd') {
        e.preventDefault()
        goToNextImage()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [saveCurrent, handleUndo, lastDeletedUndo, handleUndoDelete, goToPreviousImage, goToNextImage])

  const isRunning = state?.is_running ?? false
  // Dashboard Renderer (Restores the "Premium" Spacious Layout)
  const renderDashboard = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', flex: 1, overflow: 'hidden' }}>
      {/* Stat Cards - Big & Spacious */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
        <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
          <div style={{ fontSize: '24px', fontWeight: 800 }}>{imageCount}</div>
          <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px', letterSpacing: '1px' }}>IMAGES</div>
        </div>
        <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: '#818cf8' }}>{state?.stats.total_garments ?? 0}</div>
          <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px', letterSpacing: '1px' }}>GARMENTS</div>
        </div>
        <div className="card" style={{ padding: '16px', textAlign: 'center' }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: '#10b981' }}>{state?.stats.successful ?? 0}</div>
          <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px', letterSpacing: '1px' }}>DONE</div>
        </div>
      </div>

      {/* Progress Bar Container */}
      {isRunning && (
        <div className="card" style={{ padding: '16px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: '#94a3b8', marginBottom: '8px' }}>
            <span style={{ fontWeight: 600, color: '#818cf8', display: 'flex', alignItems: 'center', gap: '8px' }}><Icons.Search /> {state?.current_operation}</span>
            <span>{state?.current_batch} / {state?.total_batches}</span>
          </div>
          <div className="progress-bar" style={{ height: '8px' }}>
            <div className="progress-bar-fill" style={{ width: `${(state?.current_batch || 0) / (state?.total_batches || 1) * 100}%` }} />
          </div>
        </div>
      )}

      {/* Main Grid: 70/30 or 65/35 Split */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.8fr 1fr', gap: '20px', flex: 1, minHeight: 0 }}>
        {/* Left Aspect: Analysis & Results */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', overflow: 'hidden' }}>
          {/* Live Analysis Card */}
          <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid #334155', background: 'rgba(129, 140, 248, 0.05)', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <Icons.Layout />
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#f1f5f9' }}>Live Analysis</span>
            </div>
            <div style={{ flex: 1, padding: '24px', overflowY: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {comparisons.length > 0 ? (
                <div style={{ width: '100%', maxWidth: '700px' }}>
                  {comparisons.slice(-1).map((comp, i) => (
                    <div key={i} className="animate-fade-in">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '30px' }}>
                        <div style={{ flex: 1, textAlign: 'center' }}>
                           <div style={{ aspectRatio: '4/5', height: '180px', margin: '0 auto', background: '#000', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 10px 25px rgba(0,0,0,0.5)', border: '2px solid #334155' }}>
                            <img src={`data:image/jpeg;base64,${comp.reference_image}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          </div>
                          <div style={{ fontSize: '11px', color: '#64748b', marginTop: '6px', textTransform: 'uppercase' }}>Reference</div>
                        </div>
                        
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
                          <div style={{ fontSize: '24px', color: '#334155' }}>→</div>
                          <div style={{ 
                            fontSize: '12px', 
                            fontWeight: 800, 
                            padding: '6px 16px', 
                            borderRadius: '100px',
                            background: comp.is_same ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                            color: comp.is_same ? '#10b981' : '#ef4444',
                            border: `1px solid ${comp.is_same ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`
                          }}>
                            {comp.is_same ? 'SAME GARMENT' : 'NEW GARMENT'}
                          </div>
                        </div>

                        <div style={{ flex: 1, textAlign: 'center' }}>
                          <div style={{ 
                            aspectRatio: '4/5', 
                            height: '180px',
                            margin: '0 auto',
                            background: '#000', 
                            borderRadius: '12px', 
                            overflow: 'hidden', 
                            boxShadow: '0 10px 25px rgba(0,0,0,0.5)', 
                            border: `2px solid ${comp.is_same ? '#10b981' : '#ef4444'}` 
                          }}>
                            <img src={`data:image/jpeg;base64,${comp.current_image}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          </div>
                          <div style={{ fontSize: '11px', color: '#64748b', marginTop: '6px', textTransform: 'uppercase' }}>Current</div>
                        </div>
                      </div>
                      
                      <div style={{ marginTop: '30px', padding: '20px', background: 'rgba(0,0,0,0.2)', borderRadius: '12px', border: '1px solid #334155' }}>
                        <div style={{ fontSize: '18px', fontWeight: 800, color: comp.is_same ? '#10b981' : '#ef4444', marginBottom: '8px' }}>
                          {comp.confidence}% confidence
                        </div>
                        <div style={{ fontSize: '14px', color: '#94a3b8', lineHeight: '1.6', fontStyle: 'italic' }}>
                          {comp.reasoning}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: '#475569', textAlign: 'center', padding: '60px' }}>
                  <div style={{ fontSize: '40px', marginBottom: '20px', opacity: 0.3 }}>🔭</div>
                  <div style={{ fontSize: '16px', fontWeight: 600 }}>Waiting for pipeline input...</div>
                  <div style={{ fontSize: '12px', opacity: 0.5, marginTop: '8px' }}>Live visual analysis will appear here.</div>
                </div>
              )}
            </div>
          </div>

          {/* Recently Extracted List */}
          <div className="card" style={{ height: '300px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid #334155', fontWeight: 600, fontSize: '14px' }}>
              Extracted Listings ({state?.extracted_data.length ?? 0})
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px' }}>
                {state?.extracted_data.slice().reverse().map((item, i) => (
                  <div key={i} className="listing-card" style={{ padding: '8px', display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <div style={{ width: '40px', height: '40px', borderRadius: '6px', background: '#000', overflow: 'hidden', flexShrink: 0 }}>
                      <img src={`${API_BASE}/api/item-photo?path=${encodeURIComponent(item.output_folder + '/' + item.images[0])}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '12px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</div>
                      <div style={{ display: 'flex', gap: '6px', marginTop: '2px' }}>
                        <span style={{ fontSize: '9px', background: 'rgba(129, 140, 248, 0.1)', color: '#818cf8', padding: '1px 5px', borderRadius: '4px' }}>{item.brand}</span>
                        <span style={{ fontSize: '9px', background: 'rgba(255,255,255,0.05)', color: '#94a3b8', padding: '1px 5px', borderRadius: '4px' }}>{item.size}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {state?.extracted_data.length === 0 && (
                  <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '60px', opacity: 0.3, fontStyle: 'italic' }}>
                    No listings extracted yet.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Aspect: Live Logs */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '12px 20px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '14px', fontWeight: 600, color: '#f1f5f9' }}>Live Logs</span>
            <span style={{ fontSize: '11px', color: '#64748b' }}>{logs.length} entries</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px', background: 'rgba(0,0,0,0.15)', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
             {logs.slice().reverse().map((log, i) => (
              <div key={i} className={`log-entry ${log.level}`} style={{ padding: '4px 8px', marginBottom: '2px', borderRadius: '4px' }}>
                <span style={{ opacity: 0.4, marginRight: '8px' }}>[{log.time}]</span>
                <span>{log.message}</span>
              </div>
            ))}
            {logs.length === 0 && <div style={{ textAlign: "center", marginTop: "100px", opacity: 0.2 }}>Waiting for pipeline signals...</div>}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </div>
  )

  // Editor Renderer (Enhanced Beauty)
  const renderEditor = () => (
    <div style={{ display: 'flex', gap: '20px', flex: 1, overflow: 'hidden' }}>
      {/* Sidebar: Item List */}
      <div className="card" style={{ width: '320px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #334155', fontWeight: 800, fontSize: '14px', letterSpacing: '0.5px' }}>
          GARMENTS ({state?.extracted_data.length ?? 0})
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
          {state?.extracted_data.map((item, i) => (
            <div 
              key={i} 
              onClick={() => handleSelectIdx(i)}
              className={`editor-sidebar-item ${selectedIdx === i ? 'active' : ''}`}
              style={{ 
                padding: '12px', 
                borderRadius: '8px',
                marginBottom: '4px',
                cursor: 'pointer',
                display: 'flex',
                gap: '12px',
                alignItems: 'center',
                transition: 'all 0.2s',
                background: selectedIdx === i ? 'rgba(129, 140, 248, 0.15)' : 'transparent'
              }}
            >
              <div style={{ width: '40px', height: '40px', borderRadius: '4px', background: '#000', overflow: 'hidden', border: '1px solid #334155' }}>
                <img src={`${API_BASE}/api/item-photo?path=${encodeURIComponent(item.output_folder + '/' + item.images[0])}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: selectedIdx === i ? '#fff' : '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</div>
                <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px' }}>{item.brand} • {item.size}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Main Content Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px', overflow: 'hidden' }}>
        {editItem ? (
          <>
            <div style={{ display: 'flex', gap: '14px', flex: 1, overflow: 'hidden' }}>
              {/* Left: Interactive Preview - Slimmer for phone photos */}
              <div className="card" style={{ width: '560px', minWidth: '520px', maxWidth: '620px', aspectRatio: '3 / 4', maxHeight: '100%', position: 'relative', background: '#000', borderRadius: '16px', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div
                  onClick={goToPreviousImage}
                  title="Previous image (A / Left Arrow)"
                  style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '22%', cursor: 'w-resize', zIndex: 2 }}
                />
                <div
                  onClick={goToNextImage}
                  title="Next image (D / Right Arrow)"
                  style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '22%', cursor: 'e-resize', zIndex: 2 }}
                />
                {previewImage ? (
                  <img 
                    src={`${API_BASE}/api/item-photo?path=${encodeURIComponent(imagePathForDisplay(previewImage))}`} 
                    alt="Preview" 
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <div style={{ color: '#334155', fontWeight: 700 }}>PREVIEW AREA</div>
                )}

                <button
                  onClick={() => handleDeleteImage()}
                  disabled={!previewImage}
                  title="Delete current preview image"
                  style={{ position: 'absolute', top: '12px', right: '12px', background: 'rgba(239, 68, 68, 0.95)', border: 'none', borderRadius: '8px', padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: previewImage ? 'pointer' : 'not-allowed', color: 'white', zIndex: 3, opacity: previewImage ? 1 : 0.5 }}
                >
                  <Icons.Trash />
                </button>

                <button
                  onClick={goToPreviousImage}
                  title="Previous image (A / Left Arrow)"
                  style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', background: 'rgba(100, 116, 139, 0.36)', border: 'none', color: '#cbd5e1', borderRadius: '7px', width: '26px', height: '58px', cursor: 'pointer', zIndex: 3 }}
                >
                  ‹
                </button>
                <button
                  onClick={goToNextImage}
                  title="Next image (D / Right Arrow)"
                  style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'rgba(100, 116, 139, 0.36)', border: 'none', color: '#cbd5e1', borderRadius: '7px', width: '26px', height: '58px', cursor: 'pointer', zIndex: 3 }}
                >
                  ›
                </button>

                {/* Floating Action Bar */}
                <div style={{ position: 'absolute', bottom: '18px', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '10px', background: 'rgba(15, 23, 42, 0.85)', padding: '8px 14px', borderRadius: '100px', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(12px)', boxShadow: '0 10px 40px rgba(0,0,0,0.6)', alignItems: 'center', zIndex: 3 }}>
                  <button onClick={handleUndo} disabled={undoStack.length === 0} className="btn-icon" title="Undo (Ctrl+Z)" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: undoStack.length > 0 ? '#fff' : '#475569' }}>
                    <Icons.Undo />
                  </button>
                  <button onClick={handleUndoDelete} disabled={!lastDeletedUndo} className="btn-icon" title="Undo last deletion" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: lastDeletedUndo ? '#facc15' : '#475569' }}>
                    ↺
                  </button>
                  <div style={{ width: '1px', height: '20px', background: '#334155', margin: '0 2px' }}></div>
                  <button onClick={saveCurrent} disabled={!isDirty || isSaving} className={`btn-primary ${isDirty ? 'pulsate' : ''}`} style={{ padding: '7px 16px', borderRadius: '100px', fontSize: '11px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {isSaving ? 'SAVING...' : (isDirty ? 'SAVE CHANGES' : 'ALL SYNCED')}
                  </button>
                </div>
              </div>

              {/* Right: Data Management Panel - More space */}
              <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#1e293b' }}>
                <div style={{ padding: '12px 14px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 800, fontSize: '13px', color: '#818cf8', letterSpacing: '1px' }}>GARMENT METADATA</span>
                  {isDirty && <span style={{ fontSize: '10px', color: '#fbbf24', fontWeight: 800 }}>• AUTO-SAVING</span>}
                </div>

                <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div className="field-group">
                    <label>LISTING TITLE</label>
                    <input type="text" value={editItem.title ?? ''} onChange={(e) => handleEditChange('title', e.target.value)} />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: '8px' }}>
                    <div className="field-group">
                      <label>BRAND</label>
                      <input type="text" value={editItem.brand ?? ''} onChange={(e) => handleEditChange('brand', e.target.value)} />
                    </div>
                    <div className="field-group">
                      <label>SIZE</label>
                      <input type="text" value={editItem.size ?? ''} onChange={(e) => handleEditChange('size', e.target.value)} />
                    </div>
                    <div className="field-group">
                      <label>COLOR</label>
                      <input type="text" value={editItem.color ?? ''} onChange={(e) => handleEditChange('color', e.target.value)} />
                    </div>
                    <div className="field-group">
                      <label>CONDITION</label>
                      <input type="text" value={editItem.condition ?? ''} onChange={(e) => handleEditChange('condition', e.target.value)} />
                    </div>
                    <div className="field-group">
                      <label>MATERIAL</label>
                      <input type="text" value={editItem.material ?? ''} onChange={(e) => handleEditChange('material', e.target.value)} />
                    </div>
                  </div>

                  <div className="field-group" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: '520px' }}>
                    <label>ENHANCED DESCRIPTION / NOTES</label>
                    <textarea 
                      style={{ flex: 1, resize: 'none', fontSize: '14px', lineHeight: '1.55', height: '100%' }}
                      value={editItem.description ?? ''} 
                      onChange={(e) => handleEditChange('description', e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Thumbnail Navigation Strip */}
            <div className="card" style={{ height: '110px', padding: '10px', display: 'flex', gap: '8px', overflowX: 'auto', background: '#0f172a', flexShrink: 0 }}>
              {normalizedEditImages.map((img, i) => (
                <div 
                  key={i} 
                  className={`thumbnail-nav-item ${previewImage === img ? 'active' : ''}`}
                  style={{ position: 'relative', minWidth: '80px' }}
                >
                  <img 
                    onClick={() => setPreviewImage(img)}
                    src={`${API_BASE}/api/item-photo?path=${encodeURIComponent(imagePathForDisplay(img))}`} 
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }} 
                  />
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', opacity: 0.5 }}>
            <div style={{ fontSize: '60px', marginBottom: '20px' }}>📝</div>
            <div style={{ fontSize: '18px', fontWeight: 700 }}>Select a garment to start the review process</div>
            <div style={{ fontSize: '13px', marginTop: '8px' }}>Directly edit metadata, measurements, and generated descriptions here.</div>
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0f172a', color: '#f1f5f9', overflow: 'hidden' }}>
      {/* Header */}
      <header className="header" style={{ flexShrink: 0, borderBottom: '1px solid #1e293b', background: 'rgba(15, 23, 42, 0.8)', backdropFilter: 'blur(10px)', position: 'sticky', top: 0, zIndex: 100 }}>
        <div className="main-container">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: '70px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '32px' }}>
              <h1 style={{ fontSize: '24px', fontWeight: 900, margin: 0, background: 'linear-gradient(135deg, #fff 0%, #818cf8 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', letterSpacing: '-0.5px' }}>
                VENDORA
              </h1>
              <nav style={{ display: 'flex', gap: '8px', background: 'rgba(0,0,0,0.3)', padding: '5px', borderRadius: '12px', border: '1px solid #334155' }}>
                <button 
                  onClick={() => setActiveTab('dashboard')} 
                  className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
                >
                  <Icons.Dashboard /> Dashboard
                </button>
                <button 
                  onClick={() => setActiveTab('editor')} 
                  className={`tab-btn ${activeTab === 'editor' ? 'active' : ''}`}
                >
                  <Icons.Editor /> Quick Review {state?.extracted_data.length ? <span style={{ marginLeft: '6px', opacity: 0.6 }}>{state.extracted_data.length}</span> : ''}
                </button>
              </nav>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button className="folder-btn" onClick={openInputFolder} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Icons.Folder /> Input: {imageCount}</button>
                <button className="folder-btn" onClick={openOutputFolder} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Icons.Folder /> Output: {state?.stats.successful ?? 0}</button>
              </div>
              <div style={{ width: '1px', height: '24px', background: '#334155' }}></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                 <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: wsStatus === 'connected' ? '#10b981' : '#ef4444', boxShadow: wsStatus === 'connected' ? '0 0 10px #10b981' : 'none' }}></div>
                 <span style={{ fontSize: '10px', fontWeight: 800, color: '#94a3b8', letterSpacing: '1px' }}>{wsStatus === 'connected' ? 'LIVE' : 'DISCONNECTED'}</span>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={startPipeline} disabled={isRunning} className="btn-success-small">START</button>
                <button onClick={stopPipeline} disabled={!isRunning} className="btn-danger-small">STOP</button>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="main-container" style={{ flex: 1, padding: '16px 0', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'dashboard' ? renderDashboard() : renderEditor()}
      </main>

      <style>{`
        :root {
          --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
        }
        body {
          background: #0f172a;
          margin: 0;
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
        }
        .main-container {
          width: 95%;
          max-width: 1600px;
          margin: 0 auto;
        }
        .card {
          background: #1e293b;
          border-radius: 16px;
          border: 1px solid #334155;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        }
        .tab-btn {
          padding: 8px 18px;
          border-radius: 8px;
          border: none;
          background: transparent;
          color: #94a3b8;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .tab-btn:hover {
          color: #f1f5f9;
        }
        .tab-btn.active {
          background: #334155;
          color: #fff;
          box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        .folder-btn {
          background: rgba(255,255,255,0.03);
          border: 1px solid #334155;
          color: #94a3b8;
          padding: 6px 12px;
          border-radius: 8px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }
        .folder-btn:hover {
          background: rgba(255,255,255,0.08);
          color: #fff;
          border-color: #818cf8;
        }
        .btn-success-small {
          background: #10b981;
          color: white;
          border: none;
          padding: 6px 16px;
          border-radius: 6px;
          font-size: 11px;
          font-weight: 900;
          cursor: pointer;
          letter-spacing: 0.5px;
        }
        .btn-danger-small {
          background: #ef4444;
          color: white;
          border: none;
          padding: 6px 16px;
          border-radius: 6px;
          font-size: 11px;
          font-weight: 900;
          cursor: pointer;
          letter-spacing: 0.5px;
        }
        .progress-bar {
          width: 100%;
          background: #0f172a;
          border-radius: 100px;
          overflow: hidden;
        }
        .progress-bar-fill {
          height: 100%;
          background: linear-gradient(90deg, #818cf8, #6366f1);
          transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 0 15px rgba(99, 102, 241, 0.5);
        }
        .listing-card {
          background: rgba(255,255,255,0.02);
          border: 1px solid #334155;
          border-radius: 12px;
          transition: all 0.2s;
        }
        .listing-card:hover {
          background: rgba(255,255,255,0.05);
          border-color: #475569;
        }
        .log-entry.success { border-left: 3px solid #10b981; background: rgba(16, 185, 129, 0.05); }
        .log-entry.error { border-left: 3px solid #ef4444; background: rgba(239, 68, 68, 0.05); color: #fca5a5; }
        .log-entry.warning { border-left: 3px solid #f59e0b; background: rgba(245, 158, 11, 0.05); color: #fcd34d; }
        .log-entry.info { border-left: 3px solid #3b82f6; background: rgba(59, 130, 246, 0.05); }

        .field-group label {
          display: block;
          font-size: 10px;
          font-weight: 800;
          color: #94a3b8;
          margin-bottom: 8px;
          letter-spacing: 1px;
        }
        .field-group input, .field-group textarea {
          width: 100%;
          background: #0f172a;
          border: 1px solid #334155;
          border-radius: 8px;
          padding: 12px 16px;
          color: #f1f5f9;
          font-size: 13px;
          outline: none;
          transition: border-color 0.2s;
        }
        .field-group input:focus, .field-group textarea:focus {
          border-color: #818cf8;
        }
        .mini-input {
          flex: 1;
          background: #0f172a;
          border: 1px solid #334155;
          border-radius: 4px;
          padding: 4px 8px;
          color: #f1f5f9;
          font-size: 11px;
          outline: none;
        }
        .thumbnail-nav-item {
          height: 100%;
          aspect-ratio: 1;
          border-radius: 8px;
          overflow: hidden;
          cursor: pointer;
          border: 2px solid transparent;
          opacity: 0.5;
          transition: all 0.2s;
        }
        .thumbnail-nav-item.active {
          opacity: 1;
          border-color: #818cf8;
        }
        .btn-icon {
          background: none;
          border: none;
          font-size: 18px;
          cursor: pointer;
          padding: 4px 12px;
          border-radius: 8px;
          transition: background 0.2s;
        }
        .btn-icon:hover { background: rgba(255,255,255,0.1); }
        .btn-primary {
          background: #818cf8;
          color: white;
          border: none;
          cursor: pointer;
          transition: all 0.2s;
        }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        
        .pulsate {
          animation: pulsate 2s infinite;
        }
        @keyframes pulsate {
          0% { box-shadow: 0 0 0 0 rgba(129, 140, 248, 0.4); }
          70% { box-shadow: 0 0 0 15px rgba(129, 140, 248, 0); }
          100% { box-shadow: 0 0 0 0 rgba(129, 140, 248, 0); }
        }
        .animate-fade-in {
          animation: fadeIn 0.4s ease-out forwards;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
