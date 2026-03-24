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
  visible_flaws?: string
  images: string[]
  image_types?: string[]
  output_folder: string
  processed_at?: string
  batch_index?: number
  description?: string
  hashtags?: string
  done?: boolean
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

interface PipelineProgress {
  id: string
  type: 'classification' | 'comparison' | 'item_complete'
  timestamp: number
  image?: string
  image_data?: string
  classification?: string
  caption?: string
  reason?: string
  reference_image?: string
  current_image?: string
  is_same?: boolean
  reasoning?: string
  confidence?: number
  item_title?: string
}

interface ImageClassificationData {
  image: string
  image_data?: string
  type: string
  caption?: string
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

interface ModelInfo {
  current: string
  available: string[]
}

// API functions
const API_BASE = 'http://localhost:8000'

async function getState(): Promise<PipelineState> {
  const res = await fetch(`${API_BASE}/api/state`)
  return res.json()
}

async function refreshState(): Promise<{ message: string; count: number }> {
  const res = await fetch(`${API_BASE}/api/refresh`, { method: 'POST' })
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
      measurements: item.measurements ?? {},
      visible_flaws: item.visible_flaws ?? '',
      description: item.description ?? '',
      done: !!item.done,
      images: item.images ?? []
    })
  })
  const data = await res.json()
  if (!res.ok || data?.status === 'error') {
    throw new Error(data?.detail || data?.message || 'Save failed')
  }
  return data
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

async function getModels(): Promise<ModelInfo> {
  const res = await fetch(`${API_BASE}/api/models`)
  return res.json()
}

async function setModel(model: string): Promise<ModelInfo> {
  const res = await fetch(`${API_BASE}/api/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model })
  })
  return res.json()
}

async function recombineItems(itemFolders: string[]): Promise<{ success: boolean; merged_folder?: string; title?: string; error?: string }> {
  const res = await fetch(`${API_BASE}/api/recombine-items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item_folders: itemFolders })
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
  const [, setComparisons] = useState<ComparisonResultData[]>([])
  const [progress, setProgress] = useState<PipelineProgress[]>([])
  const logEndRef = useRef<HTMLDivElement>(null)
  
  // Editor State
  const [selectedIdx, setSelectedIdx] = useState<number>(-1)
  const [editItem, setEditItem] = useState<ExtractedItem | null>(null)
  const [undoStack, setUndoStack] = useState<ExtractedItem[]>([])
  const [isDirty, setIsDirty] = useState(false)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [magnifierZoom, setMagnifierZoom] = useState(1)
  const [showMagnifier, setShowMagnifier] = useState(false)
  const [magnifierPos, setMagnifierPos] = useState({ x: 0, y: 0 })
  const [lastDeletedUndo, setLastDeletedUndo] = useState<DeletedPhotoUndo | null>(null)
  const [modelInfo, setModelInfo] = useState<ModelInfo>({ current: 'qwen3.5-4b', available: ['qwen3.5-4b', 'qwen3.5-9b'] })
  const [itemFilter, setItemFilter] = useState<'active' | 'done' | 'all'>('active')
  const [selectedForCombine, setSelectedForCombine] = useState<number[]>([])
  const [isCombining, setIsCombining] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const [combineDialogOpen, setCombineDialogOpen] = useState(false)
  const [isGeneratingHashtags, setIsGeneratingHashtags] = useState(false)
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)

  const getImageBaseName = useCallback((raw: string) => {
    if (!raw) return raw
    return raw.includes('/') || raw.includes('\\') ? (raw.split(/[\\/]/).pop() || raw) : raw
  }, [])

  const normalizedEditImages = useMemo(() => {
    if (!editItem?.images) return []
    const seen = new Set<string>()
    const deduped: string[] = []
    for (const raw of editItem.images) {
      const base = getImageBaseName(raw)
      const key = base.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        deduped.push(base)
      }
    }
    return deduped
  }, [editItem, getImageBaseName])

  const imagePathForDisplay = useCallback((img: string) => {
    if (!editItem) return img
    return img.includes('/') || img.includes('\\') ? img : `${editItem.output_folder}/${img}`
  }, [editItem])

  const getPrimaryImagePath = useCallback((item: ExtractedItem): string | null => {
    if (!item.images || item.images.length === 0) return null
    return `${item.output_folder}/${getImageBaseName(item.images[0])}`
  }, [getImageBaseName])

  // Handle WebSocket messages
  const handleWSMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'state') {
      const pipelineState = msg.data as PipelineState
      setState(pipelineState)
      if (pipelineState.logs) setLogs(pipelineState.logs)
    } else if (msg.type === 'log') {
      setLogs(prev => [...prev.slice(-499), msg.data as LogEntry])
    } else if (msg.type === 'comparison_result') {
      const comp = msg.data as ComparisonResultData
      setComparisons(prev => [...prev, comp])
      // Also add to progress
      setProgress(prev => [...prev.slice(-20), {
        id: `comp-${Date.now()}`,
        type: 'comparison',
        timestamp: Date.now(),
        reference_image: comp.reference_image,
        current_image: comp.current_image,
        is_same: comp.is_same,
        reasoning: comp.reasoning,
        confidence: comp.confidence
      }])
    } else if (msg.type === 'image_classification') {
      const cls = msg.data as ImageClassificationData
      // Add classification to progress
      setProgress(prev => [...prev.slice(-20), {
        id: `cls-${Date.now()}`,
        type: 'classification',
        timestamp: Date.now(),
        image: cls.image,
        image_data: cls.image_data,
        classification: cls.type,
        caption: cls.caption,
        reason: cls.reason
      }])
    } else if (msg.type === 'item_complete') {
      const item = msg.data as ExtractedItem
      setProgress(prev => [...prev.slice(-20), {
        id: `item-${Date.now()}`,
        type: 'item_complete',
        timestamp: Date.now(),
        item_title: item.title
      }])
    }
  }, [])
  
  const { status: wsStatus } = useWebSocket('ws://localhost:8000/ws', handleWSMessage)
  
  useEffect(() => {
    // Refresh state from disk to sync with filesystem (handles external deletions)
    refreshState().then(() => getState().then(setState)).catch(() => getState().then(setState))
    getImages().then(data => setImageCount(data.count)).catch(() => {})
    getModels().then(setModelInfo).catch(() => {})
  }, [])

  // Auto-save on exit/switch
  const saveCurrentRef = useRef<() => Promise<void>>()
  
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
  
  // Keep ref in sync with callback
  saveCurrentRef.current = saveCurrent

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

    if (!window.confirm('Are you sure you want to delete this photo?')) return

    try {
      const imgPath = imageToDelete.includes(':8000') 
        ? decodeURIComponent(imageToDelete.split('path=')[1]) 
        : imageToDelete

      // 1. Optimistic Update
      const deletedIndex = resolvePreviewIndex(editItem.images, imageToDelete)
      if (deletedIndex === -1) return
      
      const newImages = editItem.images.filter((_, index) => index !== deletedIndex)
      const newEditItem = { ...editItem, images: newImages }
      
      setEditItem(newEditItem)
      if (previewImage === imageToDelete) {
        setPreviewImage(newImages.length > 0 ? newImages[0] : null)
      }

      if (state) {
        setState({
          ...state,
          extracted_data: state.extracted_data.map(it => 
            it.output_folder === editItem.output_folder ? newEditItem : it
          )
        })
      }

      // 2. Backend Persistence
      const response = await deleteItemPhoto(imgPath)
      if (response?.undo) setLastDeletedUndo(response.undo as DeletedPhotoUndo)

      // Sync the JSON metadata (mandatory to avoid race conditions with auto-save)
      await saveItemEdits(newEditItem)

    } catch (err) {
      console.error('Delete error:', err)
      alert('Failed to delete image fully. Please refresh.')
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

  const handleModelChange = async (model: string) => {
    try {
      const updated = await setModel(model)
      setModelInfo(prev => ({ ...prev, current: updated.current }))
    } catch (e) {
      console.error('Failed to switch model', e)
    }
  }

  const handleCombineConfirm = async () => {
    if (selectedForCombine.length < 2 || !state) return
    setCombineDialogOpen(false)
    setIsCombining(true)
    try {
      const folders = selectedForCombine.map(i => state.extracted_data[i].output_folder)
      const result = await recombineItems(folders)
      
      if (result.success && result.merged_folder) {
        // Refresh state from backend
        const newState = await getState()
        setState(newState)
        setSelectedForCombine([])
        // Select the newly merged item
        const newIdx = newState.extracted_data.findIndex(item => item.output_folder === result.merged_folder)
        if (newIdx !== -1) {
          handleSelectIdx(newIdx)
        }
      } else {
        alert(result.error || 'Failed to recombine items')
      }
    } catch (e) {
      console.error('Recombine failed', e)
      alert('Failed to recombine items')
    } finally {
      setIsCombining(false)
    }
  }

  const handleCombineItems = () => {
    if (selectedForCombine.length < 2) return
    setCombineDialogOpen(true)
  }

  const copyToClipboard = async (text: string, fieldName: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyFeedback(fieldName)
      setTimeout(() => setCopyFeedback(null), 1000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  const generateHashtags = async () => {
    if (!editItem) return
    setIsGeneratingHashtags(true)
    try {
      // Use AI to generate hashtags based on item metadata
      const hashtags = []
      if (editItem.title) {
        const titleWords = editItem.title.split(/\s+/).filter(w => w.length > 2)
        hashtags.push(...titleWords.slice(0, 3).map(w => `#${w.replace(/[^a-zA-Z0-9]/g, '')}`))
      }
      if (editItem.brand) hashtags.push(`#${editItem.brand.replace(/[^a-zA-Z0-9]/g, '')}`)
      if (editItem.item_type) hashtags.push(`#${editItem.item_type.replace(/[^a-zA-Z0-9]/g, '')}`)
      if (editItem.color) hashtags.push(`#${editItem.color.replace(/[^a-zA-Z0-9]/g, '')}`)
      hashtags.push('#VintageFashion', '#SecondHand', '#SustainableStyle')
      const hashtagString = [...new Set(hashtags)].slice(0, 10).join(' ')
      handleEditChange('hashtags' as keyof ExtractedItem, hashtagString)
    } catch (e) {
      console.error('Failed to generate hashtags:', e)
    } finally {
      setIsGeneratingHashtags(false)
    }
  }

  // Handle "Done" checkbox click - auto advance to next garment
  const handleDoneToggle = (item: ExtractedItem, currentIdx: number, newDoneState: boolean) => {
    if (!state) return
    const target = state.extracted_data[currentIdx]
    const updated = { ...target, done: newDoneState }
    setState({ ...state, extracted_data: state.extracted_data.map((it, idx) => idx === currentIdx ? updated : it) })
    if (selectedIdx === currentIdx) setEditItem(prev => prev ? { ...prev, done: updated.done } : prev)
    saveItemEdits(updated).then(() => {
      // Auto-open next garment when marking current as done
      if (newDoneState && !item.done) {
        const nextIdx = currentIdx + 1
        if (nextIdx < state.extracted_data.length) {
          handleSelectIdx(nextIdx)
        }
      }
    }).catch(err => console.error('Failed to save done state', err))
  }

  // Debounced auto-save while editing metadata fields
  useEffect(() => {
    if (!isDirty || !editItem) return
    const timer = setTimeout(() => {
      saveCurrentRef.current?.()
    }, 900)
    return () => clearTimeout(timer)
  }, [editItem, isDirty])

  // Window resize tracking for responsive layout
  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // isCompactMode: true when window is halved (sidebar text gets hidden)
  const isCompactMode = windowWidth < 1100

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        saveCurrentRef.current?.()
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
  const filteredItems = (state?.extracted_data ?? []).filter(item => {
    if (itemFilter === 'all') return true
    if (itemFilter === 'done') return !!item.done
    return !item.done
  })
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
            <div style={{ flex: 1, padding: '16px', overflowY: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {progress.length > 0 ? (
                <div style={{ width: '100%', maxWidth: '900px' }}>
                  {progress.slice(-1).map((item) => (
                    <div key={item.id} className="animate-fade-in">
                      {item.type === 'classification' && (
                        <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                          <div style={{ textAlign: 'center', flexShrink: 0 }}>
                            {item.image_data ? (
                              <div style={{ width: '100px', height: '130px', background: '#000', borderRadius: '8px', overflow: 'hidden', border: '2px solid #818cf8' }}>
                                <img src={`data:image/jpeg;base64,${item.image_data}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              </div>
                            ) : (
                              <div style={{ width: '100px', height: '130px', background: '#1e293b', borderRadius: '8px', border: '2px solid #818cf8', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <Icons.Layout />
                              </div>
                            )}
                            <div style={{ fontSize: '10px', color: '#818cf8', marginTop: '4px', textTransform: 'uppercase' }}>{item.classification}</div>
                          </div>
                          <div style={{ flex: 1, padding: '12px 16px', background: 'rgba(0,0,0,0.2)', borderRadius: '10px', border: '1px solid #334155' }}>
                            <div style={{ fontSize: '12px', fontWeight: 800, color: '#818cf8', marginBottom: '4px' }}>
                              📸 Image Analysis
                            </div>
                            <div style={{ fontSize: '11px', color: '#94a3b8', lineHeight: '1.5' }}>
                              {item.image}
                              {item.caption && <div style={{ marginTop: '4px', color: '#10b981', fontWeight: 500 }}>{item.caption}</div>}
                              {item.reason && <div style={{ marginTop: '4px', fontStyle: 'italic' }}>{item.reason}</div>}
                            </div>
                          </div>
                        </div>
                      )}
                      {item.type === 'comparison' && (
                        <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexShrink: 0 }}>
                            <div style={{ textAlign: 'center' }}>
                              <div style={{ width: '100px', height: '130px', background: '#000', borderRadius: '8px', overflow: 'hidden', border: '2px solid #334155' }}>
                                {item.reference_image && <img src={`data:image/jpeg;base64,${item.reference_image}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                              </div>
                              <div style={{ fontSize: '10px', color: '#64748b', marginTop: '4px', textTransform: 'uppercase' }}>Reference</div>
                            </div>
                            
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                              <div style={{ fontSize: '16px', color: '#334155' }}>→</div>
                              <div style={{
                                fontSize: '9px',
                                fontWeight: 800,
                                padding: '4px 10px',
                                borderRadius: '100px',
                                background: item.is_same ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                                color: item.is_same ? '#10b981' : '#ef4444',
                                border: `1px solid ${item.is_same ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`
                              }}>
                                {item.is_same ? 'SAME' : 'NEW'}
                              </div>
                            </div>

                            <div style={{ textAlign: 'center' }}>
                              <div style={{
                                width: '100px',
                                height: '130px',
                                background: '#000',
                                borderRadius: '8px',
                                overflow: 'hidden',
                                border: `2px solid ${item.is_same ? '#10b981' : '#ef4444'}`
                              }}>
                                {item.current_image && <img src={`data:image/jpeg;base64,${item.current_image}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                              </div>
                              <div style={{ fontSize: '10px', color: '#64748b', marginTop: '4px', textTransform: 'uppercase' }}>Current</div>
                            </div>
                          </div>
                          <div style={{ flex: 1, padding: '12px 16px', background: 'rgba(0,0,0,0.2)', borderRadius: '10px', border: '1px solid #334155' }}>
                            <div style={{ fontSize: '14px', fontWeight: 800, color: item.is_same ? '#10b981' : '#ef4444', marginBottom: '4px' }}>
                              {item.confidence}% confidence
                            </div>
                            <div style={{ fontSize: '11px', color: '#94a3b8', lineHeight: '1.5', fontStyle: 'italic' }}>
                              {item.reasoning}
                            </div>
                          </div>
                        </div>
                      )}
                      {item.type === 'item_complete' && (
                        <div style={{ display: 'flex', gap: '16px', alignItems: 'center', justifyContent: 'center' }}>
                          <div style={{ textAlign: 'center', padding: '20px' }}>
                            <div style={{ fontSize: '40px', marginBottom: '8px' }}>✅</div>
                            <div style={{ fontSize: '14px', fontWeight: 800, color: '#10b981' }}>Item Complete</div>
                            <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{item.item_title}</div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: '#475569', textAlign: 'center', padding: '40px' }}>
                  <div style={{ fontSize: '32px', marginBottom: '12px', opacity: 0.3 }}>🔭</div>
                  <div style={{ fontSize: '14px', fontWeight: 600 }}>Waiting for pipeline input...</div>
                  <div style={{ fontSize: '11px', opacity: 0.5, marginTop: '6px' }}>Live visual analysis will appear here.</div>
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
                      {getPrimaryImagePath(item) ? <img src={`${API_BASE}/api/item-photo?path=${encodeURIComponent(getPrimaryImagePath(item)!)}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
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
    <div style={{ display: 'flex', gap: isCompactMode ? '8px' : '20px', flex: 1, overflow: 'hidden' }}>
      {/* Sidebar: Item List - Thumbnails only in compact mode */}
      <div className="card" style={{
        width: isCompactMode ? '80px' : '320px',
        minWidth: isCompactMode ? '60px' : '320px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}>
        <div style={{ padding: isCompactMode ? '8px 6px' : '16px 20px', borderBottom: '1px solid #334155', fontWeight: 800, fontSize: isCompactMode ? '9px' : '14px', letterSpacing: '0.5px', display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>GARMENTS ({state?.extracted_data.length ?? 0})</span>
          <div style={{ position: 'relative', display: 'inline-block', cursor: 'help' }} title="Ctrl+Click to multi-select. Recombine re-analyzes all images as one garment with AI.">
            <span style={{ fontSize: '11px', color: '#818cf8', fontWeight: 400 }}>ℹ️</span>
          </div>
        </div>
        {!isCompactMode && (
          <div style={{ padding: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <button className={`tab-btn-small ${itemFilter === 'active' ? 'active' : ''}`} onClick={() => setItemFilter('active')}>Active</button>
            <button className={`tab-btn-small ${itemFilter === 'done' ? 'active' : ''}`} onClick={() => setItemFilter('done')}>Done</button>
            <button className={`tab-btn-small ${itemFilter === 'all' ? 'active' : ''}`} onClick={() => setItemFilter('all')}>All</button>
            {selectedForCombine.length >= 2 && (
              <button
                className="tab-btn-small"
                onClick={handleCombineItems}
                disabled={isCombining}
                style={{ background: '#818cf8', color: '#fff', borderColor: '#818cf8' }}
              >
                {isCombining ? 'Recombining...' : `Recombine (${selectedForCombine.length})`}
              </button>
            )}
            {selectedForCombine.length > 0 && (
              <button
                className="tab-btn-small"
                onClick={() => setSelectedForCombine([])}
                style={{ color: '#ef4444' }}
              >
                Clear
              </button>
            )}
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
          {filteredItems.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', opacity: 0.3, fontSize: '12px' }}>
              No {itemFilter} garments found.
            </div>
          ) : filteredItems.map((item) => {
            const i = state?.extracted_data.findIndex(x => x.output_folder === item.output_folder) ?? -1
            const isSelectedForCombine = selectedForCombine.includes(i)
            return (
              <div
                key={item.output_folder || i}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey) {
                    // Multi-select mode
                    e.preventDefault()
                    setSelectedForCombine(prev =>
                      prev.includes(i)
                        ? prev.filter(idx => idx !== i)
                        : [...prev, i]
                    )
                  } else {
                    handleSelectIdx(i)
                  }
                }}
                className={`editor-sidebar-item ${selectedIdx === i ? 'active' : ''}`}
                style={{
                  padding: '10px',
                  borderRadius: '12px',
                  marginBottom: '6px',
                  cursor: 'pointer',
                  display: 'flex',
                  gap: '12px',
                  alignItems: 'center',
                  transition: 'all 0.2s',
                  background: isSelectedForCombine
                    ? 'rgba(129, 140, 248, 0.25)'
                    : selectedIdx === i
                      ? 'rgba(129, 140, 248, 0.15)'
                      : 'rgba(255,255,255,0.02)',
                  border: `2px solid ${isSelectedForCombine ? '#818cf8' : selectedIdx === i ? '#818cf8' : 'rgba(255,255,255,0.05)'}`,
                  outline: isSelectedForCombine ? '2px solid #818cf8' : 'none',
                  outlineOffset: '2px'
                }}
              >
                <div style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '6px',
                  background: isSelectedForCombine ? 'rgba(129, 140, 248, 0.3)' : '#000',
                  overflow: 'hidden',
                  border: `1px solid ${isSelectedForCombine ? '#818cf8' : '#334155'}`,
                  position: 'relative'
                }}>
                  {getPrimaryImagePath(item) ? (
                    <img
                      src={`${API_BASE}/api/item-photo?path=${encodeURIComponent(getPrimaryImagePath(item)!)}`}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: item.done ? 0.4 : 1 }}
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none'; // Hide the broken image icon
                        const target = e.target as HTMLElement;
                        const parent = target.parentElement;
                        if (parent) {
                          const errorDiv = document.createElement('div');
                          errorDiv.style.cssText = 'width: 100%; height: 100%; background: #334155; display: flex; align-items: center; justify-content: center; color: #64748b;';
                          errorDiv.innerHTML = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M464 128H272l-64-64H48C21.49 64 0 85.49 0 112v288c0 26.51 21.49 48 48 48h416c26.51 0 48-21.49 48-48V176c0-26.51-21.49-48-48-48zm-96 160c0 4.42-3.58 8-8 8h-56v56c0 4.42-3.58 8-8 8h-48c-4.42 0-8-3.58-8-8v-56h-56c-4.42 0-8-3.58-8-8v-48c0-4.42 3.58-8 8-8h56v-56c0-4.42 3.58-8 8-8h48c4.42 0 8 3.58 8 8v56h56c4.42 0 8 3.58 8 8v48z"></path></svg>'; // Icons.Folder SVG
                          parent.appendChild(errorDiv);
                        }
                      }}
                    />
                  ) : null}
                  {item.done && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#10b981' }}>
                      <Icons.Check />
                    </div>
                  )}
                  {isSelectedForCombine && (
                    <div style={{
                      position: 'absolute',
                      top: '4px',
                      right: '4px',
                      width: '18px',
                      height: '18px',
                      borderRadius: '50%',
                      background: '#818cf8',
                      border: '2px solid #fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      boxShadow: '0 2px 4px rgba(0,0,0,0.3)'
                    }}>
                      <Icons.Check />
                    </div>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0, display: isCompactMode ? 'none' : 'block' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: selectedIdx === i ? '#fff' : '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</div>
                  <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px' }}>{item.brand} • {item.size}</div>
                </div>
                {!isCompactMode && (
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!state || i === -1) return
                      handleDoneToggle(item, i, !item.done)
                    }}
                    style={{
                      width: '20px',
                      height: '20px',
                      borderRadius: '4px',
                      border: `2px solid ${item.done ? '#10b981' : '#334155'}`,
                      background: item.done ? '#10b981' : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'white',
                      cursor: 'pointer'
                    }}
                  >
                    {item.done && <Icons.Check />}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Main Content Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: isCompactMode ? '6px' : '14px', overflow: 'hidden' }}>
        {editItem ? (
          <>
            {/* Compact Mode Layout: Preview + Thumbnail Grid | Metadata Panel */}
            {isCompactMode ? (
              /* COMPACT LAYOUT: Preview/Grid on left, Metadata biggest on right */
              <div style={{ flex: 1, display: 'flex', gap: '6px', overflow: 'hidden' }}>
                {/* Left: Preview + Thumbnail Grid */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '200px', flexShrink: 0 }}>
                  {/* Smaller Preview with preserved aspect ratio */}
                  <div className="card" style={{
                    width: '100%',
                    aspectRatio: '3 / 4',
                    maxHeight: '160px',
                    position: 'relative',
                    background: '#000',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}>
                    <div
                      onClick={goToPreviousImage}
                      style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '30%', cursor: 'w-resize', zIndex: 2 }}
                    />
                    <div
                      onClick={goToNextImage}
                      style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '30%', cursor: 'e-resize', zIndex: 2 }}
                    />
                    {previewImage ? (
                      <div
                        style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
                        onMouseEnter={() => setShowMagnifier(true)}
                        onMouseLeave={() => { setShowMagnifier(false); setMagnifierZoom(1); }}
                        onMouseMove={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setMagnifierPos({
                            x: ((e.clientX - rect.left) / rect.width) * 100,
                            y: ((e.clientY - rect.top) / rect.height) * 100
                          });
                        }}
                        onWheel={(e) => {
                          e.preventDefault();
                          setMagnifierZoom(z => Math.max(1, Math.min(5, z - e.deltaY * 0.005)));
                        }}
                      >
                        <img
                          src={`${API_BASE}/api/item-photo?path=${encodeURIComponent(imagePathForDisplay(previewImage))}`}
                          alt="Preview"
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            transform: `scale(${magnifierZoom})`,
                            transformOrigin: `${magnifierPos.x}% ${magnifierPos.y}%`,
                            transition: magnifierZoom === 1 ? 'transform 0.2s' : 'none'
                          }}
                        />
                        {showMagnifier && magnifierZoom > 1 && (
                          <div style={{
                            position: 'absolute',
                            bottom: '4px',
                            right: '4px',
                            background: 'rgba(0,0,0,0.8)',
                            color: '#fff',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            fontSize: '9px',
                            fontWeight: 700,
                            pointerEvents: 'none'
                          }}>
                            {Math.round(magnifierZoom * 100)}%
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ color: '#334155', fontWeight: 700, fontSize: '10px' }}>PREVIEW</div>
                    )}
                    <button
                      onClick={() => handleDeleteImage()}
                      disabled={!previewImage}
                      style={{ position: 'absolute', top: '6px', right: '6px', background: 'rgba(239, 68, 68, 0.95)', border: 'none', borderRadius: '6px', padding: '5px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: previewImage ? 'pointer' : 'not-allowed', color: 'white', zIndex: 3, opacity: previewImage ? 1 : 0.5 }}
                    >
                      <Icons.Trash />
                    </button>
                  </div>

                  {/* Thumbnail Grid below preview */}
                  <div className="card" style={{
                    flex: 1,
                    padding: '6px',
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: '4px',
                    background: '#0f172a',
                    borderRadius: '10px',
                    overflow: 'hidden'
                  }}>
                    {normalizedEditImages.map((img, i) => (
                      <div
                        key={i}
                        onClick={() => setPreviewImage(img)}
                        className={`thumbnail-nav-item ${previewImage === img ? 'active' : ''}`}
                        style={{
                          position: 'relative',
                          width: '100%',
                          aspectRatio: '1 / 1',
                          cursor: 'pointer',
                          borderRadius: '6px',
                          overflow: 'hidden',
                          border: previewImage === img ? '2px solid #818cf8' : '2px solid transparent'
                        }}
                      >
                        <img
                          src={`${API_BASE}/api/item-photo?path=${encodeURIComponent(imagePathForDisplay(img))}`}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      </div>
                    ))}
                  </div>

                  {/* Compact Action Bar */}
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button onClick={handleUndo} disabled={undoStack.length === 0} className="btn-icon" title="Undo" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: undoStack.length > 0 ? '#fff' : '#475569', padding: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px' }}>
                      <Icons.Undo />
                    </button>
                    <button onClick={saveCurrent} disabled={!isDirty || isSaving} className={`btn-primary ${isDirty ? 'pulsate' : ''}`} style={{ flex: 2, padding: '6px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                      {isSaving ? '...' : (isDirty ? 'SAVE' : 'SYNCED')}
                    </button>
                  </div>
                </div>

                {/* Right: Data Management Panel - BIGGEST SECTION */}
                <div className="card" style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  background: '#1e293b',
                  minWidth: 0
                }}>
                  <div style={{ padding: '10px 12px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 800, fontSize: '12px', color: '#818cf8', letterSpacing: '1px' }}>METADATA</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <label style={{ fontSize: '10px', color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <input type="checkbox" checked={!!editItem.done} onChange={(e) => handleEditChange('done', e.target.checked)} />
                        Done
                      </label>
                      {isDirty && <span style={{ fontSize: '9px', color: '#fbbf24', fontWeight: 800 }}>•</span>}
                    </div>
                  </div>

                  <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div className="field-group">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <label style={{ margin: 0, fontSize: '10px', color: '#94a3b8' }}>TITLE</label>
                        <button onClick={() => copyToClipboard(editItem.title ?? '', 'title')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: copyFeedback === 'title' ? '#10b981' : '#64748b', fontSize: '9px', padding: '2px 4px' }}>
                          {copyFeedback === 'title' ? '✓' : '📋'}
                        </button>
                      </div>
                      <input type="text" value={editItem.title ?? ''} onChange={(e) => handleEditChange('title', e.target.value)} style={{ fontSize: '11px' }} />
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '6px' }}>
                      <div className="field-group">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <label style={{ margin: 0, fontSize: '8px', color: '#94a3b8' }}>BRAND</label>
                          <button onClick={() => copyToClipboard(editItem.brand ?? '', 'brand')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: copyFeedback === 'brand' ? '#10b981' : '#64748b', fontSize: '8px', padding: '1px 2px' }}>📋</button>
                        </div>
                        <input type="text" value={editItem.brand ?? ''} onChange={(e) => handleEditChange('brand', e.target.value)} style={{ fontSize: '10px' }} />
                      </div>
                      <div className="field-group">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <label style={{ margin: 0, fontSize: '8px', color: '#94a3b8' }}>SIZE</label>
                          <button onClick={() => copyToClipboard(editItem.size ?? '', 'size')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: copyFeedback === 'size' ? '#10b981' : '#64748b', fontSize: '8px', padding: '1px 2px' }}>📋</button>
                        </div>
                        <input type="text" value={editItem.size ?? ''} onChange={(e) => handleEditChange('size', e.target.value)} style={{ fontSize: '10px' }} />
                      </div>
                      <div className="field-group">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <label style={{ margin: 0, fontSize: '8px', color: '#94a3b8' }}>COLOR</label>
                          <button onClick={() => copyToClipboard(editItem.color ?? '', 'color')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: copyFeedback === 'color' ? '#10b981' : '#64748b', fontSize: '8px', padding: '1px 2px' }}>📋</button>
                        </div>
                        <input type="text" value={editItem.color ?? ''} onChange={(e) => handleEditChange('color', e.target.value)} style={{ fontSize: '10px' }} />
                      </div>
                      <div className="field-group">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <label style={{ margin: 0, fontSize: '8px', color: '#94a3b8' }}>COND</label>
                          <button onClick={() => copyToClipboard(editItem.condition ?? '', 'condition')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: copyFeedback === 'condition' ? '#10b981' : '#64748b', fontSize: '8px', padding: '1px 2px' }}>📋</button>
                        </div>
                        <input type="text" value={editItem.condition ?? ''} onChange={(e) => handleEditChange('condition', e.target.value)} style={{ fontSize: '10px' }} />
                      </div>
                      <div className="field-group">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <label style={{ margin: 0, fontSize: '8px', color: '#94a3b8' }}>MAT</label>
                          <button onClick={() => copyToClipboard(editItem.material ?? '', 'material')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: copyFeedback === 'material' ? '#10b981' : '#64748b', fontSize: '8px', padding: '1px 2px' }}>📋</button>
                        </div>
                        <input type="text" value={editItem.material ?? ''} onChange={(e) => handleEditChange('material', e.target.value)} style={{ fontSize: '10px' }} />
                      </div>
                    </div>

                    <div className="field-group">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <label style={{ margin: 0, fontSize: '10px', color: '#94a3b8' }}>HASHTAGS</label>
                        <button onClick={generateHashtags} disabled={isGeneratingHashtags} style={{ background: '#818cf8', border: 'none', borderRadius: '4px', padding: '3px 8px', fontSize: '9px', fontWeight: 700, color: '#fff', cursor: isGeneratingHashtags ? 'not-allowed' : 'pointer', opacity: isGeneratingHashtags ? 0.6 : 1 }}>
                          {isGeneratingHashtags ? '...' : '✨'}
                        </button>
                      </div>
                      <input
                        type="text"
                        value={editItem.hashtags ?? ''}
                        onChange={(e) => handleEditChange('hashtags' as keyof ExtractedItem, e.target.value)}
                        placeholder="#hashtag..."
                        style={{ fontSize: '10px' }}
                      />
                    </div>

                    <div className="field-group" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: '100px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <label style={{ margin: 0, fontSize: '10px', color: '#94a3b8' }}>DESCRIPTION</label>
                        <button onClick={() => copyToClipboard(editItem.description ?? '', 'description')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: copyFeedback === 'description' ? '#10b981' : '#64748b', fontSize: '9px', padding: '2px 4px' }}>
                          {copyFeedback === 'description' ? '✓' : '📋'}
                        </button>
                      </div>
                      <textarea
                        style={{ flex: 1, resize: 'none', fontSize: '11px', lineHeight: '1.4', minHeight: '80px' }}
                        value={editItem.description ?? ''}
                        onChange={(e) => handleEditChange('description', e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* NORMAL LAYOUT */
              <>
                {/* Top Row: Preview + Metadata side by side */}
                <div style={{ display: 'flex', flexDirection: 'row', gap: '14px', flex: 1, overflow: 'hidden' }}>
                  {/* Preview Section */}
                  <div className="card" style={{
                    width: '560px',
                    minWidth: '520px',
                    maxWidth: '620px',
                    aspectRatio: '3 / 4',
                    position: 'relative',
                    background: '#000',
                    borderRadius: '16px',
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}>
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
                      <div
                        style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
                        onMouseEnter={() => setShowMagnifier(true)}
                        onMouseLeave={() => setShowMagnifier(false)}
                        onMouseMove={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setMagnifierPos({
                            x: ((e.clientX - rect.left) / rect.width) * 100,
                            y: ((e.clientY - rect.top) / rect.height) * 100
                          });
                        }}
                        onWheel={(e) => {
                          e.preventDefault();
                          setMagnifierZoom(z => Math.max(1, Math.min(5, z - e.deltaY * 0.005)));
                        }}
                      >
                        <img
                          src={`${API_BASE}/api/item-photo?path=${encodeURIComponent(imagePathForDisplay(previewImage))}`}
                          alt="Preview"
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            transform: `scale(${magnifierZoom})`,
                            transformOrigin: `${magnifierPos.x}% ${magnifierPos.y}%`,
                            transition: magnifierZoom === 1 ? 'transform 0.2s' : 'none'
                          }}
                        />
                        {showMagnifier && magnifierZoom > 1 && (
                          <div style={{
                            position: 'absolute',
                            bottom: '10px',
                            right: '10px',
                            background: 'rgba(0,0,0,0.8)',
                            color: '#fff',
                            padding: '4px 8px',
                            borderRadius: '6px',
                            fontSize: '11px',
                            fontWeight: 700,
                            pointerEvents: 'none'
                          }}>
                            {Math.round(magnifierZoom * 100)}%
                          </div>
                        )}
                      </div>
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

                  {/* Right: Data Management Panel */}
                  <div className="card" style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    background: '#1e293b'
                  }}>
                    <div style={{ padding: '12px 14px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 800, fontSize: '13px', color: '#818cf8', letterSpacing: '1px' }}>GARMENT METADATA</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <label style={{ fontSize: '11px', color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <input type="checkbox" checked={!!editItem.done} onChange={(e) => handleEditChange('done', e.target.checked)} />
                          Done
                        </label>
                        {isDirty && <span style={{ fontSize: '10px', color: '#fbbf24', fontWeight: 800 }}>• AUTO-SAVING</span>}
                      </div>
                    </div>

                    <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <div className="field-group">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                          <label style={{ margin: 0 }}>LISTING TITLE</label>
                          <button onClick={() => copyToClipboard(editItem.title ?? '', 'title')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: copyFeedback === 'title' ? '#10b981' : '#64748b', fontSize: '10px', padding: '2px 6px', borderRadius: '4px' }} title="Copy">
                            {copyFeedback === 'title' ? '✓' : '📋'}
                          </button>
                        </div>
                        <input type="text" value={editItem.title ?? ''} onChange={(e) => handleEditChange('title', e.target.value)} />
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.5fr 1fr 1fr 2fr', gap: '8px' }}>
                        <div className="field-group">
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                            <label style={{ margin: 0, fontSize: '10px' }}>BRAND</label>
                            <button onClick={() => copyToClipboard(editItem.brand ?? '', 'brand')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: copyFeedback === 'brand' ? '#10b981' : '#64748b', fontSize: '10px', padding: '2px 4px' }} title="Copy">📋</button>
                          </div>
                          <input type="text" value={editItem.brand ?? ''} onChange={(e) => handleEditChange('brand', e.target.value)} />
                        </div>
                        <div className="field-group">
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                            <label style={{ margin: 0, fontSize: '10px' }}>SIZE</label>
                            <button onClick={() => copyToClipboard(editItem.size ?? '', 'size')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: copyFeedback === 'size' ? '#10b981' : '#64748b', fontSize: '10px', padding: '2px 4px' }} title="Copy">📋</button>
                          </div>
                          <input type="text" value={editItem.size ?? ''} onChange={(e) => handleEditChange('size', e.target.value)} />
                        </div>
                        <div className="field-group">
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                            <label style={{ margin: 0, fontSize: '10px' }}>COLOR</label>
                            <button onClick={() => copyToClipboard(editItem.color ?? '', 'color')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: copyFeedback === 'color' ? '#10b981' : '#64748b', fontSize: '10px', padding: '2px 4px' }} title="Copy">📋</button>
                          </div>
                          <input type="text" value={editItem.color ?? ''} onChange={(e) => handleEditChange('color', e.target.value)} />
                        </div>
                        <div className="field-group">
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                            <label style={{ margin: 0, fontSize: '10px' }}>CONDITION</label>
                            <button onClick={() => copyToClipboard(editItem.condition ?? '', 'condition')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: copyFeedback === 'condition' ? '#10b981' : '#64748b', fontSize: '10px', padding: '2px 4px' }} title="Copy">📋</button>
                          </div>
                          <input type="text" value={editItem.condition ?? ''} onChange={(e) => handleEditChange('condition', e.target.value)} />
                        </div>
                        <div className="field-group">
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                            <label style={{ margin: 0, fontSize: '10px' }}>MATERIAL</label>
                            <button onClick={() => copyToClipboard(editItem.material ?? '', 'material')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: copyFeedback === 'material' ? '#10b981' : '#64748b', fontSize: '10px', padding: '2px 4px' }} title="Copy">📋</button>
                          </div>
                          <input type="text" value={editItem.material ?? ''} onChange={(e) => handleEditChange('material', e.target.value)} />
                        </div>
                      </div>

                      {/* HASHTAGS FIELD */}
                      <div className="field-group">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                          <label style={{ margin: 0 }}>HASHTAGS</label>
                          <button
                            onClick={() => copyToClipboard(editItem.hashtags ?? '', 'hashtags')}
                            className={`copy-btn ${copyFeedback === 'hashtags' ? 'copied' : ''}`}
                            style={{
                              background: copyFeedback === 'hashtags' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255,255,255,0.1)',
                              border: `1px solid ${copyFeedback === 'hashtags' ? 'rgba(16, 185, 129, 0.5)' : 'rgba(255,255,255,0.2)'}`,
                              borderRadius: '6px',
                              padding: '4px 10px',
                              fontSize: '11px',
                              color: copyFeedback === 'hashtags' ? '#10b981' : '#cbd5e1',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              transition: 'all 0.2s ease'
                            }}
                            title="Copy hashtags"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              {copyFeedback === 'hashtags' ? (
                                <polyline points="20 6 9 17 4 12"></polyline>
                              ) : (
                                <>
                                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                </>
                              )}
                            </svg>
                            {copyFeedback === 'hashtags' ? 'Copied!' : 'Copy'}
                          </button>
                        </div>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <input
                            type="text"
                            value={editItem.hashtags ?? ''}
                            onChange={(e) => handleEditChange('hashtags' as keyof ExtractedItem, e.target.value)}
                            placeholder="#hashtag1 #hashtag2..."
                            style={{ flex: 1 }}
                          />
                          <button
                            onClick={generateHashtags}
                            disabled={isGeneratingHashtags}
                            style={{
                              background: '#818cf8',
                              border: 'none',
                              borderRadius: '6px',
                              padding: '8px 12px',
                              fontSize: '11px',
                              fontWeight: 700,
                              color: '#fff',
                              cursor: isGeneratingHashtags ? 'not-allowed' : 'pointer',
                              opacity: isGeneratingHashtags ? 0.6 : 1
                            }}
                            title="Generate hashtags with AI"
                          >
                            {isGeneratingHashtags ? 'Generating...' : '✨ Generate'}
                          </button>
                        </div>
                      </div>

                      {/* DESCRIPTION FIELD */}
                      <div className="field-group" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: '200px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                          <label style={{ margin: 0 }}>ENHANCED DESCRIPTION / NOTES</label>
                          <button
                            onClick={() => copyToClipboard(editItem.description ?? '', 'description')}
                            className={`copy-btn ${copyFeedback === 'description' ? 'copied' : ''}`}
                            style={{
                              background: copyFeedback === 'description' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255,255,255,0.1)',
                              border: `1px solid ${copyFeedback === 'description' ? 'rgba(16, 185, 129, 0.5)' : 'rgba(255,255,255,0.2)'}`,
                              borderRadius: '6px',
                              padding: '4px 10px',
                              fontSize: '11px',
                              color: copyFeedback === 'description' ? '#10b981' : '#cbd5e1',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              transition: 'all 0.2s ease'
                            }}
                            title="Copy to clipboard"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              {copyFeedback === 'description' ? (
                                <polyline points="20 6 9 17 4 12"></polyline>
                              ) : (
                                <>
                                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                </>
                              )}
                            </svg>
                            {copyFeedback === 'description' ? 'Copied!' : 'Copy'}
                          </button>
                        </div>
                        <textarea
                          style={{ flex: 1, resize: 'none', fontSize: '14px', lineHeight: '1.55', height: '100%' }}
                          value={editItem.description ?? ''}
                          onChange={(e) => handleEditChange('description', e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Thumbnail Navigation Strip BELOW both Preview and Metadata */}
                <div className="card" style={{
                  height: '110px',
                  padding: '8px',
                  display: 'flex',
                  gap: '6px',
                  overflowX: 'auto',
                  background: '#0f172a',
                  flexShrink: 0
                }}>
                  {normalizedEditImages.map((img, i) => (
                    <div
                      key={i}
                      className={`thumbnail-nav-item ${previewImage === img ? 'active' : ''}`}
                      style={{ position: 'relative', minWidth: '80px', height: '100%' }}
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
            )}
          </>
        ) : (
          <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', opacity: 0.5 }}>
            <div style={{ fontSize: '60px', marginBottom: '20px' }}>📝</div>
            <div style={{ fontSize: '18px', fontWeight: 700 }}>Select a garment to start the review process</div>
            <div style={{ fontSize: '13px', marginTop: '8px' }}>Directly edit metadata and generated descriptions here.</div>
          </div>
        )}
      </div>
    </div>
  )

  // Combine Dialog Modal
  const renderCombineDialog = () => {
    if (!combineDialogOpen) return null
    const selectedItems = selectedForCombine.map(idx => state?.extracted_data[idx]).filter(Boolean)
    return (
      <div style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}>
        <div style={{
          background: '#1e293b',
          borderRadius: '16px',
          border: '1px solid #334155',
          padding: '24px',
          maxWidth: '500px',
          width: '90%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
        }}>
          <h3 style={{ margin: '0 0 16px 0', color: '#f1f5f9', fontSize: '18px', fontWeight: 800 }}>
            🤖 Recombine {selectedForCombine.length} Garments with AI?
          </h3>
          <p style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '20px', lineHeight: 1.5 }}>
            All images from the selected garments will be re-analyzed as <strong style={{ color: '#818cf8' }}>one combined garment</strong>.
            This process uses AI and may take a moment.
          </p>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
            {selectedItems.map((item, i) => item && (
              <span key={i} style={{
                background: 'rgba(129, 140, 248, 0.15)',
                border: '1px solid #818cf8',
                borderRadius: '6px',
                padding: '4px 10px',
                fontSize: '11px',
                color: '#cbd5e1'
              }}>
                {item.title || item.brand || `Item ${i + 1}`}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
            <button
              onClick={() => setCombineDialogOpen(false)}
              style={{
                background: 'transparent',
                border: '1px solid #334155',
                color: '#94a3b8',
                padding: '10px 20px',
                borderRadius: '8px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleCombineConfirm}
              disabled={isCombining}
              style={{
                background: '#818cf8',
                border: 'none',
                color: '#fff',
                padding: '10px 20px',
                borderRadius: '8px',
                fontSize: '13px',
                fontWeight: 700,
                cursor: isCombining ? 'not-allowed' : 'pointer',
                opacity: isCombining ? 0.6 : 1
              }}
            >
              {isCombining ? 'Processing...' : '✨ Combine with AI'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0f172a', color: '#f1f5f9', overflow: 'hidden' }}>
      {renderCombineDialog()}
      {/* Header */}
      <header className="header" style={{ flexShrink: 0, borderBottom: '1px solid #1e293b', background: 'rgba(15, 23, 42, 0.8)', backdropFilter: 'blur(10px)', position: 'sticky', top: 0, zIndex: 100 }}>
        <div className="main-container">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: isCompactMode ? '50px' : '70px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: isCompactMode ? '12px' : '32px' }}>
              <h1 style={{ fontSize: isCompactMode ? '16px' : '24px', fontWeight: 900, margin: 0, background: 'linear-gradient(135deg, #fff 0%, #818cf8 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', letterSpacing: '-0.5px' }}>
                {isCompactMode ? 'V' : 'VENDORA'}
              </h1>
              <nav style={{ display: 'flex', gap: '8px', background: 'rgba(0,0,0,0.3)', padding: '5px', borderRadius: '12px', border: '1px solid #334155' }}>
                <button
                  onClick={() => setActiveTab('dashboard')}
                  className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
                >
                  <Icons.Dashboard /> {isCompactMode ? '' : 'Dashboard'}
                </button>
                <button
                  onClick={() => setActiveTab('editor')}
                  className={`tab-btn ${activeTab === 'editor' ? 'active' : ''}`}
                >
                  <Icons.Editor /> {isCompactMode ? '' : 'Quick Review'} {state?.extracted_data.length ? <span style={{ marginLeft: '6px', opacity: 0.6 }}>{state.extracted_data.length}</span> : ''}
                </button>
              </nav>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: isCompactMode ? '8px' : '16px' }}>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                <button className="folder-btn" onClick={openInputFolder} style={{ display: 'flex', alignItems: 'center', gap: '4px' }} title="Input folder"><Icons.Folder /> {isCompactMode ? '' : `${imageCount}`}</button>
                <button className="folder-btn" onClick={openOutputFolder} style={{ display: 'flex', alignItems: 'center', gap: '4px' }} title="Output folder"><Icons.Folder /> {isCompactMode ? '' : `${state?.stats.successful ?? 0}`}</button>
                <button className="folder-btn" onClick={async () => { await refreshState(); getState().then(setState); }} style={{ display: 'flex', alignItems: 'center', gap: '4px' }} title="Sync with filesystem">↻</button>
              </div>
              <select
                value={modelInfo.current}
                onChange={(e) => handleModelChange(e.target.value)}
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid #334155', color: '#cbd5e1', padding: '4px 6px', borderRadius: '8px', fontSize: '10px', fontWeight: 700 }}
              >
                {(modelInfo.available || ['qwen3.5-4b', 'qwen3.5-9b']).map(model => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
              {isCompactMode && <div style={{ width: '1px', height: '24px', background: '#334155' }}></div>}
              <div style={{ display: isCompactMode ? 'none' : 'flex', alignItems: 'center', gap: '8px' }}>
                 <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: wsStatus === 'connected' ? '#10b981' : '#ef4444', boxShadow: wsStatus === 'connected' ? '0 0 10px #10b981' : 'none' }}></div>
                 <span style={{ fontSize: '10px', fontWeight: 800, color: '#94a3b8', letterSpacing: '1px' }}>{wsStatus === 'connected' ? 'LIVE' : 'DISCONNECTED'}</span>
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
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
        .tab-btn-small {
          flex: 1;
          padding: 6px;
          border-radius: 6px;
          border: 1px solid #334155;
          background: rgba(0,0,0,0.2);
          color: #94a3b8;
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.2s;
        }
        .tab-btn-small:hover {
          color: #fff;
          border-color: #475569;
        }
        .tab-btn-small.active {
          background: #334155;
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
