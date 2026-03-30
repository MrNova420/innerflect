import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import GlassSurface from '../components/GlassSurface'
import Aurora from '../components/Aurora'
import SessionTimer from '../components/SessionTimer'
import SessionGateModal from '../components/SessionGateModal'
import UpgradeModal from '../components/UpgradeModal'
import { MODELS, STORAGE_KEY, detectBestModel, shouldProgressiveLoad, markFirstVisitDone, getQuickModelId, getCompatibleModels } from '../hooks/useModelDetect'
import { useSessionLimit } from '../hooks/useSessionLimit'
import { checkServerAIAvailable, sendServerMessage } from '../hooks/useServerAI'
import { useAuth } from '../context/AuthContext'
import { encryptMessages, decryptMessages } from '../utils/crypto'

const API_BASE = () =>
  (typeof window !== 'undefined' && (window.API_BASE || window.INNERFLECT_API_BASE)) || ''

const SYSTEM_PROMPT = `You are a compassionate, thoughtful AI therapy companion. You listen carefully, ask thoughtful follow-up questions, and provide gentle, evidence-based support. You never diagnose, never prescribe, and always encourage professional help when needed. You are warm, patient, and non-judgmental. Keep responses conversational and concise.`

const MODEL_MAX_TOKENS = {
  'SmolLM2-135M-Instruct-q0f16-MLC': 256,
  'SmolLM2-360M-Instruct-q4f16_1-MLC': 256,
  'Llama-3.2-1B-Instruct-q4f16_1-MLC': 384,
  'gemma-2-2b-it-q4f16_1-MLC': 448,
  'Phi-3.5-mini-instruct-q4f16_1-MLC': 512,
  'Phi-3.5-mini-instruct-q4f32_1-MLC': 512,
}

const LOADING_TIPS = [
  "All processing happens in your browser — nothing leaves your device",
  "Your model is cached permanently — no re-download on future visits",
  "The AI runs entirely offline after first download",
  "Your conversations are never stored anywhere",
  "WebGPU enables near-native AI performance in your browser",
]

function LoadingScreen({ progress, status, fromCache, modelId, detectReason, speed, eta }) {
  const model = MODELS.find(m => m.id === modelId)
  const [tipIdx, setTipIdx] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTipIdx(i => (i + 1) % LOADING_TIPS.length), 4000)
    return () => clearInterval(id)
  }, [])

  const stepLabel = progress < 5
    ? 'Checking device'
    : progress < 30
      ? 'Loading AI runtime'
      : progress < 90
        ? 'Downloading model'
        : 'Warming up...'

  return (
    <div style={{
      position: 'relative',
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    }}>
      <Aurora colors={['#1e1b4b', '#7c3aed', '#0e7490']} />
      <div style={{ position: 'relative', zIndex: 1, textAlign: 'center', padding: '2rem', maxWidth: '520px', width: '100%' }}>
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
          style={{
            width: '80px', height: '80px',
            borderRadius: '50%',
            border: '3px solid rgba(124,58,237,0.2)',
            borderTop: '3px solid #7c3aed',
            margin: '0 auto 2rem',
          }}
        />
        <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem', color: '#f1f5f9' }}>
          {fromCache ? '⚡ Loading from Cache' : 'Preparing Your Space'}
        </h2>
        <p style={{ color: '#64748b', marginBottom: '0.5rem', fontSize: '0.9rem', lineHeight: 1.6 }}>
          {status || 'Initializing...'}
        </p>

        {/* Step indicator */}
        <p style={{ color: '#7c3aed', fontSize: '0.78rem', fontWeight: 600, marginBottom: '1.25rem', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {stepLabel}
        </p>

        {/* Active model pill */}
        {model && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.35rem 0.85rem', borderRadius: '100px', marginBottom: '1.5rem',
            background: 'rgba(124,58,237,0.15)', border: '1px solid rgba(124,58,237,0.3)',
            fontSize: '0.8rem',
          }}>
            <span style={{ color: '#a78bfa', fontWeight: 700 }}>{model.badge}</span>
            <span style={{ color: '#cbd5e1' }}>{model.label}</span>
            <span style={{ color: '#475569' }}>· {model.size}</span>
          </div>
        )}

        {/* Progress bar */}
        <div style={{
          background: 'rgba(255,255,255,0.06)',
          borderRadius: '100px',
          height: '6px',
          overflow: 'hidden',
          marginBottom: '0.5rem',
        }}>
          <motion.div
            initial={{ width: fromCache ? 40 : 0 }}
            animate={{ width: `${Math.max(2, progress)}%` }}
            transition={{ duration: 0.3 }}
            style={{
              height: '100%',
              background: fromCache
                ? 'linear-gradient(90deg, #06b6d4, #10b981)'
                : 'linear-gradient(90deg, #7c3aed, #06b6d4)',
              borderRadius: '100px',
            }}
          />
        </div>
        <p style={{ color: '#334155', fontSize: '0.8rem', marginBottom: '0.5rem' }}>{Math.floor(progress)}%</p>

        {/* Speed / ETA */}
        {(speed || eta) && (
          <p style={{ color: '#475569', fontSize: '0.78rem', marginBottom: '1.25rem' }}>
            {[speed, eta ? `${eta} remaining` : null].filter(Boolean).join(' · ')}
          </p>
        )}
        {!(speed || eta) && <div style={{ marginBottom: '1.25rem' }} />}

        <div style={{
          padding: '1rem',
          background: fromCache ? 'rgba(6,182,212,0.1)' : 'rgba(124,58,237,0.1)',
          border: `1px solid ${fromCache ? 'rgba(6,182,212,0.25)' : 'rgba(124,58,237,0.2)'}`,
          borderRadius: '12px',
          marginBottom: '1rem',
        }}>
          <p style={{ color: fromCache ? '#67e8f9' : '#8b5cf6', fontSize: '0.8rem', lineHeight: 1.7 }}>
            {fromCache ? (
              <>⚡ Already on your device — no download needed<br />
              <span style={{ color: '#475569' }}>Cached permanently in your browser</span></>
            ) : (
              <>📦 First time download — {model?.size || ''}<br />
              <span style={{ color: '#475569' }}>Cached permanently after this — never downloads again</span></>
            )}
          </p>
          {detectReason && (
            <p style={{ color: '#334155', fontSize: '0.75rem', marginTop: '0.6rem', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '0.6rem' }}>
              🤖 {detectReason}
            </p>
          )}
        </div>

        {/* Rotating tip */}
        <AnimatePresence mode="wait">
          <motion.p
            key={tipIdx}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.4 }}
            style={{ color: '#334155', fontSize: '0.78rem', lineHeight: 1.6, fontStyle: 'italic' }}
          >
            💡 {LOADING_TIPS[tipIdx]}
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  )
}

function ModelPicker({ selectedId, onSelect, disabled }) {
  const [open, setOpen] = useState(false)
  const current = MODELS.find(m => m.id === selectedId) || MODELS[0]
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title={disabled ? 'Cannot change model while session is active' : 'Choose AI model'}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '8px', padding: '0.4rem 0.75rem', color: '#94a3b8',
          cursor: disabled ? 'not-allowed' : 'pointer', fontSize: '0.78rem',
          opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
        }}
      >
        🤖 {current.label.split(' (')[0]} <span style={{ color: '#475569' }}>▾</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            style={{
              position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 100,
              background: '#12121a', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '12px', padding: '0.5rem', minWidth: '280px',
              boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            }}
          >
            {MODELS.map(m => (
              <button
                key={m.id}
                onClick={() => { onSelect(m.id); setOpen(false) }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: m.id === selectedId ? 'rgba(124,58,237,0.15)' : 'transparent',
                  border: m.id === selectedId ? '1px solid rgba(124,58,237,0.3)' : '1px solid transparent',
                  borderRadius: '8px', padding: '0.75rem', cursor: 'pointer', marginBottom: '0.25rem',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                  <span style={{ color: '#f1f5f9', fontSize: '0.85rem', fontWeight: 600 }}>{m.label}</span>
                  <span style={{ fontSize: '0.7rem', background: 'rgba(124,58,237,0.2)', color: '#a78bfa', borderRadius: '4px', padding: '1px 6px' }}>{m.badge}</span>
                </div>
                <div style={{ color: '#475569', fontSize: '0.75rem' }}>{m.desc}</div>
                <div style={{ color: '#334155', fontSize: '0.72rem', marginTop: '0.2rem' }}>Size: {m.size}</div>
              </button>
            ))}
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', padding: '0.5rem 0.5rem 0.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#334155', fontSize: '0.72rem' }}>Model cached permanently after first download</span>
              <button
                onClick={() => { localStorage.removeItem(STORAGE_KEY); setOpen(false); window.location.reload() }}
                style={{ background: 'none', border: 'none', color: '#475569', fontSize: '0.7rem', cursor: 'pointer', textDecoration: 'underline' }}
              >
                reset auto-detect
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function ActiveModelBadge({ modelId, fromCache, serverMode }) {
  if (serverMode) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.4rem',
        padding: '0.3rem 0.75rem', borderRadius: '100px',
        background: 'rgba(16,185,129,0.1)',
        border: '1px solid rgba(16,185,129,0.2)',
        fontSize: '0.75rem',
        color: '#6ee7b7',
      }}>
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', display: 'inline-block', flexShrink: 0 }} />
        ☁️ Server Mode
      </div>
    )
  }
  const model = MODELS.find(m => m.id === modelId) || MODELS[0]
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '0.4rem',
      padding: '0.3rem 0.75rem', borderRadius: '100px',
      background: fromCache ? 'rgba(16,185,129,0.1)' : 'rgba(124,58,237,0.1)',
      border: `1px solid ${fromCache ? 'rgba(16,185,129,0.2)' : 'rgba(124,58,237,0.2)'}`,
      fontSize: '0.75rem',
      color: fromCache ? '#6ee7b7' : '#a78bfa',
    }}>
      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: fromCache ? '#10b981' : '#7c3aed', display: 'inline-block', flexShrink: 0 }} />
      {model.label.split(' (')[0]} · {fromCache ? '⚡ cached' : model.size}
    </div>
  )
}

function UpgradeToast({ model, onAccept, onDismiss }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 60, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 40, scale: 0.95 }}
      transition={{ type: 'spring', damping: 20 }}
      style={{
        position: 'fixed', bottom: '5.5rem', left: '50%', transform: 'translateX(-50%)',
        zIndex: 200, maxWidth: '420px', width: 'calc(100vw - 2rem)',
        background: 'rgba(18,18,26,0.95)', backdropFilter: 'blur(20px)',
        border: '1px solid rgba(124,58,237,0.4)', borderRadius: '16px',
        padding: '1rem 1.25rem', boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
        <span style={{ fontSize: '1.4rem', flexShrink: 0 }}>✨</span>
        <div style={{ flex: 1 }}>
          <p style={{ color: '#f1f5f9', fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.25rem' }}>
            Better model ready: {model?.label}
          </p>
          <p style={{ color: '#64748b', fontSize: '0.8rem', lineHeight: 1.5 }}>
            {model?.size} · {model?.desc?.split('.')[0]}. Switch for better responses?
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
            <button onClick={onAccept} style={{
              flex: 1, padding: '0.5rem', borderRadius: '8px', border: 'none', cursor: 'pointer',
              background: 'linear-gradient(135deg, #7c3aed, #06b6d4)', color: '#fff', fontWeight: 600, fontSize: '0.82rem',
            }}>
              Switch Now
            </button>
            <button onClick={onDismiss} style={{
              flex: 1, padding: '0.5rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)',
              cursor: 'pointer', background: 'transparent', color: '#64748b', fontSize: '0.82rem',
            }}>
              Keep Current
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  )
}

function TypingIndicator() {
  return (
    <div style={{ display: 'flex', gap: '4px', padding: '0.75rem 1rem', alignItems: 'center' }}>
      {[0, 1, 2].map(i => (
        <motion.div
          key={i}
          animate={{ scale: [1, 1.4, 1], opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
          style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#7c3aed' }}
        />
      ))}
    </div>
  )
}

function ChatHistoryDrawer({ open, onClose, authFetch, encKey, setMessages, setSessionId, currentSessionId }) {
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [loadingSessionId, setLoadingSessionId] = useState(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    authFetch(API_BASE() + '/api/chat/sessions')
      .then(r => r.json())
      .then(data => { if (!cancelled) setSessions(Array.isArray(data) ? data : []) })
      .catch(() => { if (!cancelled) setError('Failed to load history') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open])

  async function loadSession(session_id) {
    setLoadingSessionId(session_id)
    try {
      const r = await authFetch(API_BASE() + `/api/chat/session/${session_id}`)
      const data = await r.json()
      const msgs = await decryptMessages(encKey, data.messages)
      setMessages(msgs)
      setSessionId(session_id)
      onClose()
    } catch { /* silent */ } finally { setLoadingSessionId(null) }
  }

  async function deleteSession(session_id, e) {
    e.stopPropagation()
    setDeletingId(session_id)
    try {
      await authFetch(API_BASE() + `/api/chat/session/${session_id}`, { method: 'DELETE' })
      setSessions(prev => prev.filter(s => s.session_id !== session_id))
    } catch { /* silent */ } finally { setDeletingId(null) }
  }

  function newChat() {
    setMessages([])
    setSessionId(null)
    onClose()
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="history-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
          />
          <motion.div
            key="history-drawer"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 220 }}
            style={{
              position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 301,
              width: 'min(380px, 100vw)',
              background: 'rgba(10,10,20,0.97)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '16px 0 0 16px',
              display: 'flex', flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* Header */}
            <div style={{ padding: '1.25rem 1.25rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ color: '#e2e8f0', fontWeight: 700, fontSize: '1rem' }}>Chat History</span>
                {encKey && (
                  <span style={{ fontSize: '0.7rem', padding: '1px 7px', borderRadius: '100px', background: 'rgba(124,58,237,0.2)', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.3)' }}>
                    🔒 E2E Encrypted
                  </span>
                )}
              </div>
              <button
                onClick={onClose}
                style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '1.4rem', padding: '0.25rem', lineHeight: 1 }}
              >×</button>
            </div>

            {/* New chat */}
            <div style={{ padding: '0.75rem 1.25rem', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
              <button
                onClick={newChat}
                style={{ width: '100%', padding: '0.6rem', borderRadius: '10px', background: 'rgba(124,58,237,0.15)', border: '1px solid rgba(124,58,237,0.3)', color: '#a78bfa', fontWeight: 600, cursor: 'pointer', fontSize: '0.85rem' }}
              >
                + New Chat
              </button>
            </div>

            {/* Session list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {loading && [0, 1, 2, 3].map(i => (
                <div key={i} style={{ height: '70px', borderRadius: '10px', background: 'rgba(255,255,255,0.04)', opacity: 1 - i * 0.15 }} />
              ))}
              {error && (
                <p style={{ color: '#f87171', fontSize: '0.85rem', textAlign: 'center', paddingTop: '2rem' }}>{error}</p>
              )}
              {!loading && !error && sessions.length === 0 && (
                <p style={{ color: '#475569', fontSize: '0.85rem', textAlign: 'center', paddingTop: '2rem' }}>No saved chats yet</p>
              )}
              {!loading && sessions.map(s => (
                <div
                  key={s.session_id}
                  onClick={() => !loadingSessionId && loadSession(s.session_id)}
                  style={{
                    padding: '0.75rem 0.875rem',
                    borderRadius: '10px',
                    background: currentSessionId === s.session_id ? 'rgba(124,58,237,0.12)' : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${currentSessionId === s.session_id ? 'rgba(124,58,237,0.3)' : 'rgba(255,255,255,0.06)'}`,
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem',
                    opacity: loadingSessionId === s.session_id ? 0.6 : 1,
                    transition: 'background 0.15s, border-color 0.15s',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: '#e2e8f0', fontSize: '0.88rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.title || 'Untitled'}
                    </div>
                    <div style={{ color: '#475569', fontSize: '0.75rem', marginTop: '0.2rem' }}>
                      {s.model?.split('-')[0] || 'AI'} · {new Date(s.updated_at || s.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                      {s.message_count ? ` · ${s.message_count} msgs` : ''}
                    </div>
                  </div>
                  <button
                    onClick={e => deleteSession(s.session_id, e)}
                    disabled={deletingId === s.session_id}
                    title="Delete session"
                    style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: '1rem', padding: '0.25rem', flexShrink: 0, lineHeight: 1, opacity: deletingId === s.session_id ? 0.4 : 1 }}
                  >🗑</button>
                </div>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

export default function TherapySpace() {
  const [engine, setEngine] = useState(null)
  const [isReady, setIsReady] = useState(false)
  const [loadProgress, setLoadProgress] = useState(0)
  const [loadStatus, setLoadStatus] = useState('Checking WebGPU support...')
  const [webGPUError, setWebGPUError] = useState(false)
  const [loadError, setLoadError] = useState('') // non-WebGPU recoverable error
  const [fromCache, setFromCache] = useState(false)
  const [activeModel, setActiveModel] = useState(() => localStorage.getItem(STORAGE_KEY) || MODELS[4].id)
  const [detectReason, setDetectReason] = useState('')
  const [pendingModel, setPendingModel] = useState(null)
  const [upgradeReady, setUpgradeReady] = useState(null) // { engine, modelId } when bg model is ready
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [canStop, setCanStop] = useState(false)
  const [loadSpeed, setLoadSpeed] = useState('')
  const [loadETA, setLoadETA] = useState('')
  const [showGate, setShowGate] = useState(false)
  const [showUpgradeModal, setShowUpgradeModal] = useState(false)
  const [serverMode, setServerMode] = useState(false)
  const [serverAIAvailable, setServerAIAvailable] = useState(false)
  const [sessionId, setSessionId] = useState(null)
  const [anonBlocked, setAnonBlocked] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const messagesEndRef = useRef(null)
  const engineRef = useRef(null)
  const bgEngineRef = useRef(null) // background engine loading in parallel
  const streamBufRef = useRef('')
  const rafRef = useRef(null)
  const abortRef = useRef(null)
  const lastBytesRef = useRef({ bytes: 0, time: Date.now() })
  const latestMessagesRef = useRef([]) // always current — used for auto-save
  const prevGeneratingRef = useRef(false) // tracks isGenerating transitions

  const {
    plan,
    isUnlimited,
    isExpired,
    showNudge,
    dismissNudge,
    timerVisible,
    getTimeRemaining,
    startSession,
    stopSession,
  } = useSessionLimit()

  const { user, encKey, authFetch } = useAuth() || {}
  const autoSaveEnabled = user?.plan === 'pro'

  // Hard-block chat when either limit fires — only cleared by signing in
  const isBlocked = isExpired || showNudge

  // Start session timer when engine becomes ready OR server mode activates
  useEffect(() => {
    if (isReady || serverMode) startSession()
  }, [isReady, serverMode])

  // Show gate modal when session expires or nudge fires — keep it up until user acts
  useEffect(() => {
    if (isExpired || showNudge) setShowGate(true)
  }, [isExpired, showNudge])

  useEffect(() => {
    // NOTE: No impression tracking on the therapy page — privacy promise
    // Anon server-side rate limit check
    if (!user) {
      const fp = localStorage.getItem('innerflect_fp')
      if (fp) {
        fetch(`${API_BASE()}/api/usage/anon-check?fingerprint=${encodeURIComponent(fp)}`)
          .then(r => r.json())
          .then(data => { if (data.allowed === false) setAnonBlocked(true) })
          .catch(() => {}) // silent — don't block if check fails
      }
    }
    // Check server AI availability in parallel (used as WebGPU fallback)
    document.title = 'Your Session — Innerflect'
    document.querySelector('meta[name="description"]')?.setAttribute('content',
      'Private AI therapy session — all conversation stays on your device. No data leaves your browser.')
    checkServerAIAvailable(API_BASE()).then(available => setServerAIAvailable(available))
    initEngine()
    return () => {
      engineRef.current?.unload?.().catch(() => {})
      bgEngineRef.current?.unload?.().catch(() => {})
      stopSession()
    }
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Keep latestMessagesRef in sync so _autoSave can access current messages
  useEffect(() => { latestMessagesRef.current = messages }, [messages])

  function _generateTitle(msgs) {
    const first = msgs.find(m => m.role === 'user')
    if (!first?.content) return 'Chat Session'
    return first.content.slice(0, 60)
  }

  async function _autoSave(msgs) {
    if (!autoSaveEnabled || !authFetch) return
    try {
      const payload = encKey ? await encryptMessages(encKey, msgs) : msgs
      const res = await authFetch(API_BASE() + '/api/chat/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(sessionId ? { session_id: sessionId } : {}),
          title: _generateTitle(msgs),
          messages: payload,
          model: activeModel,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.session_id) setSessionId(data.session_id)
      }
    } catch { /* silent — never interrupt the user */ }
  }

  // Trigger auto-save when generation transitions from active → complete
  useEffect(() => {
    if (prevGeneratingRef.current && !isGenerating && autoSaveEnabled && latestMessagesRef.current.length > 1) {
      _autoSave(latestMessagesRef.current)
    }
    prevGeneratingRef.current = isGenerating
  })

  async function initEngine(forceModelId = null, stepDownDepth = 0) {
    // Check WebGPU availability — including null adapter (GPU not exposed to browser)
    if (!navigator.gpu) {
      setWebGPUError(true)
      return
    }
    try {
      const adapter = await navigator.gpu.requestAdapter()
      if (!adapter) { setWebGPUError(true); return }
    } catch { setWebGPUError(true); return }

    setLoadError('')
    setLoadStatus('Checking device...')
    setIsReady(false)
    setLoadProgress(0)
    try {
      const webllm = await import('@mlc-ai/web-llm')

      // Auto-detect best model + GPU features (including shader-f16 support)
      let modelId = forceModelId
      let reason = ''
      let supportsF16 = true // assume modern GPU by default
      if (!modelId) {
        const detection = await detectBestModel(webllm)
        modelId = detection.modelId
        reason = detection.reason
        supportsF16 = detection.supportsF16 ?? true
        setDetectReason(reason)
        setActiveModel(modelId)
      } else {
        reason = 'Your selection'
        setDetectReason(reason)
      }

      // ── Progressive loading: load quick model first on first visit ──────────
      const quickModelId = getQuickModelId(supportsF16)
      const doProgressive = !forceModelId && await shouldProgressiveLoad(webllm, modelId, supportsF16)
      if (doProgressive) {
        setDetectReason('Loading quick model to get you started...')
        await loadModel(webllm, quickModelId, true)
        loadModelInBackground(webllm, modelId, reason)
        return
      }
      // ────────────────────────────────────────────────────────────────────────

      // Check if already cached
      let cached = false
      try { cached = await webllm.hasModelInCache(modelId) } catch (_) {}
      setFromCache(cached)
      await loadModel(webllm, modelId, false)
    } catch (err) {
      console.error('WebLLM init error:', err)
      const msg = err.message || ''
      if (msg.includes('WebGPU') || msg.includes('gpu') || msg.includes('GPU')) {
        setWebGPUError(true)
        return
      }
      // Step down to a lighter COMPATIBLE model (respects shader-f16 support)
      // Use getCompatibleModels to only step down to models the device can run
      const compatible = getCompatibleModels(true) // conservative: include all for step-down
      const currentIdx = compatible.findIndex(m => m.id === modelId)
      if (currentIdx > 0 && stepDownDepth < 2) {
        const lighter = compatible[currentIdx - 1]
        setDetectReason(`Trying lighter model — ${lighter.label}`)
        setLoadStatus(`Switching to ${lighter.label}...`)
        setLoadProgress(0)
        await initEngine(lighter.id, stepDownDepth + 1)
        return
      }
      // All step-downs exhausted — show recoverable error with retry
      const friendly = msg.includes('fetch') || msg.includes('network')
        ? 'Network error while downloading. Check your connection and try again.'
        : msg.includes('Out of memory') || msg.includes('memory') || msg.includes('VRAM')
          ? 'Not enough GPU memory. Try a smaller model below.'
          : msg.includes('shader-f16') || msg.includes('feature')
            ? 'Your GPU doesn\'t support this model. Try "Use Smallest Model" below.'
            : 'Couldn\'t load AI model. Please try again.'
      setLoadError(friendly)
      setLoadStatus('')
    }
  }

  // Shared helper: load a model and wire up state
  async function loadModel(webllm, modelId, isQuick = false) {
    let cached = false
    try { cached = await webllm.hasModelInCache(modelId) } catch (_) {}
    setFromCache(cached)
    setActiveModel(modelId)
    if (cached) setLoadProgress(10)
    setLoadStatus(isQuick
      ? '⚡ Loading quick model — you can start chatting in seconds...'
      : cached ? '⚡ Loading from your device cache...' : 'Downloading model...'
    )
    const modelObj = MODELS.find(m => m.id === modelId)
    const modelSizeMB = modelObj?.sizeMB || 0
    lastBytesRef.current = { bytes: 0, time: Date.now() }
    const eng = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (p) => {
        const pct = (p.progress || 0) * 100

        // When progress hits ~100%, WebLLM still compiles shaders + loads GPU memory.
        // Show a clear "finalizing" status so users know it's still working (not hung).
        if (pct >= 99) {
          setLoadProgress(99)
          setLoadStatus('⚙️ Finalizing — loading into GPU memory...')
          setLoadSpeed('')
          setLoadETA('')
          return
        }

        setLoadProgress(pct)
        setLoadStatus(p.text || (cached ? 'Loading...' : 'Downloading...'))

        if (modelSizeMB > 0 && p.progress > 0 && p.progress < 0.99) {
          const totalBytes = modelSizeMB * 1024 * 1024
          const bytesNow = p.progress * totalBytes
          const prev = lastBytesRef.current
          const deltaBytes = bytesNow - prev.bytes
          const deltaSec = (Date.now() - prev.time) / 1000
          if (deltaSec > 0.5 && deltaBytes > 0) {
            const bytesPerSec = deltaBytes / deltaSec
            const mbPerSec = bytesPerSec / (1024 * 1024)
            const remaining = totalBytes - bytesNow
            const etaSec = Math.round(remaining / bytesPerSec)
            setLoadSpeed(`${mbPerSec.toFixed(1)} MB/s`)
            if (etaSec >= 60) {
              const m = Math.floor(etaSec / 60)
              const s = etaSec % 60
              setLoadETA(`~${m}m ${s}s`)
            } else {
              setLoadETA(`~${etaSec}s`)
            }
            lastBytesRef.current = { bytes: bytesNow, time: Date.now() }
          }
        }
      }
    })
    // CreateMLCEngine has fully resolved — model is loaded and warm in GPU memory
    setLoadProgress(100)
    setLoadStatus('✅ Ready!')
    setLoadSpeed('')
    setLoadETA('')
    if (isQuick) {
      setDetectReason(`Quick start with ${MODELS.find(m => m.id === modelId)?.label || modelId} — better model loading in background`)
    } else {
      localStorage.setItem(STORAGE_KEY, modelId)
    }
    engineRef.current = eng
    setEngine(eng)
    setIsReady(true)
    setMessages([{
      role: 'assistant',
      content: isQuick
        ? "Hello 👋 I'm here and ready to listen. A better AI model is loading in the background — I'll let you know when it's ready to give you even richer responses."
        : "Hello 👋 I'm your private AI companion. I'm here to listen — no judgments, no records, just a safe space to talk. What's on your mind today?"
    }])
  }

  // Load best model silently in background while quick model is in use
  // Retries once after 10s on failure (transient network issues)
  async function loadModelInBackground(webllm, bestModelId, reason, attempt = 0) {
    try {
      const eng = await webllm.CreateMLCEngine(bestModelId, {
        initProgressCallback: () => {} // silent — don't interrupt the active session
      })
      bgEngineRef.current = eng
      setUpgradeReady({ engine: eng, modelId: bestModelId, reason })
    } catch (err) {
      if (attempt === 0) {
        // Retry once after 10s — handles transient network hiccups
        console.warn('[Innerflect] Background model load failed, retrying in 10s…', err)
        setTimeout(() => loadModelInBackground(webllm, bestModelId, reason, 1), 10_000)
      } else {
        // Both attempts failed — user keeps the quick model silently
        console.warn('[Innerflect] Background model load failed after retry, skipping upgrade')
      }
    }
  }

  function acceptUpgrade() {
    if (!upgradeReady) return
    const { engine: newEng, modelId } = upgradeReady
    engineRef.current?.unload?.().catch(() => {})
    engineRef.current = newEng
    bgEngineRef.current = null
    setEngine(newEng)
    setActiveModel(modelId)
    localStorage.setItem(STORAGE_KEY, modelId)
    markFirstVisitDone()
    setUpgradeReady(null)
    setDetectReason('Upgraded to best model for your device')
    setMessages(prev => [...prev, {
      role: 'assistant',
      content: `✨ I've been upgraded to **${MODELS.find(m => m.id === modelId)?.label}**. My responses will be more thoughtful from here on. Want to continue where we left off?`
    }])
  }

  function dismissUpgrade() {
    bgEngineRef.current?.unload?.().catch(() => {})
    bgEngineRef.current = null
    markFirstVisitDone()
    localStorage.setItem(STORAGE_KEY, activeModel) // save the quick model as preference
    setUpgradeReady(null)
  }

  async function switchModel(newModelId) {
    if (newModelId === activeModel && isReady) return
    if (engineRef.current) {
      await engineRef.current.unload?.().catch(() => {})
      engineRef.current = null
    }
    setEngine(null)
    setMessages([])
    setPendingModel(null)
    // Save choice so auto-detect respects it next visit
    localStorage.setItem(STORAGE_KEY, newModelId)
    await initEngine(newModelId)
  }

  async function sendMessage() {
    if (!input.trim() || isGenerating) return
    if (serverMode) {
      const abortController = new AbortController()
      abortRef.current = abortController
      setIsGenerating(true)
      setCanStop(true)
      const userMsg = { role: 'user', content: input.trim() }
      setMessages(prev => [...prev, userMsg, { role: 'assistant', content: '' }])
      setInput('')
      markFirstVisitDone()
      try {
        await sendServerMessage(
          API_BASE(),
          [...messages, userMsg],
          (chunk) => {
            setMessages(prev => {
              const updated = [...prev]
              updated[updated.length - 1] = {
                ...updated[updated.length - 1],
                content: (updated[updated.length - 1].content || '') + chunk,
              }
              return updated
            })
          },
          abortController.signal,
        )
      } catch (err) {
        if (err.name !== 'AbortError') {
          setMessages(prev => {
            const updated = [...prev]
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              content: "Sorry, something went wrong. Please try again.",
            }
            return updated
          })
        }
      } finally {
        setIsGenerating(false)
        setCanStop(false)
      }
      return
    }
    if (!engine) return
    const userMsg = { role: 'user', content: input.trim() }
    const MAX_HISTORY = 12
    const history = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages.slice(-MAX_HISTORY),
      userMsg
    ]
    setMessages(prev => [...prev, userMsg, { role: 'assistant', content: '' }])
    setInput('')
    setIsGenerating(true)
    // Mark first visit complete when user sends their first message
    markFirstVisitDone()
    abortRef.current = new AbortController()
    setCanStop(true)
    streamBufRef.current = ''
    try {
      const stream = await engine.chat.completions.create({
        messages: history,
        stream: true,
        temperature: 0.8,
        max_tokens: MODEL_MAX_TOKENS[activeModel] || 384,
        signal: abortRef.current.signal,
      })
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || ''
        if (delta) {
          streamBufRef.current += delta
          if (!rafRef.current) {
            rafRef.current = requestAnimationFrame(() => {
              const buffered = streamBufRef.current
              streamBufRef.current = ''
              rafRef.current = null
              if (buffered) {
                setMessages(prev => {
                  const updated = [...prev]
                  updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    content: updated[updated.length - 1].content + buffered
                  }
                  return updated
                })
              }
            })
          }
        }
      }
      // Flush any remaining buffer after stream ends
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (streamBufRef.current) {
        const remaining = streamBufRef.current
        streamBufRef.current = ''
        setMessages(prev => {
          const updated = [...prev]
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            content: updated[updated.length - 1].content + remaining
          }
          return updated
        })
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // User stopped generation — leave partial response as-is
      } else {
        console.error('Generation error:', err)
        setMessages(prev => {
          const updated = [...prev]
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            content: "I'm sorry, I encountered an error. Please try again."
          }
          return updated
        })
      }
    } finally {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      streamBufRef.current = ''
      setIsGenerating(false)
      setCanStop(false)
    }
  }

  if (webGPUError) {
    return (
      <div style={{ paddingTop: '64px', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div style={{ textAlign: 'center', maxWidth: '540px' }}>
          <div style={{ fontSize: '4rem', marginBottom: '1.5rem' }}>⚠️</div>
          <h2 style={{ fontSize: '1.6rem', fontWeight: 700, marginBottom: '1rem', color: '#f1f5f9' }}>
            Browser Not Supported
          </h2>
          <p style={{ color: '#64748b', lineHeight: 1.7, marginBottom: '1.5rem' }}>
            Innerflect normally runs AI entirely in your browser using WebGPU — but your browser doesn't support it yet.
          </p>

          {/* Server mode option — show if available */}
          {serverAIAvailable && (
            <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '16px', padding: '1.5rem', marginBottom: '1.5rem', textAlign: 'left' }}>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#34d399', marginBottom: '0.5rem' }}>✨ Server Mode Available</div>
              <p style={{ color: '#94a3b8', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '1rem' }}>
                We can run the AI on our server instead. Your messages travel to our server to generate a response — slightly less private than in-browser mode, but works on any device.
              </p>
              <button
                onClick={() => {
                  setServerMode(true)
                  setWebGPUError(false)
                  setIsReady(true)
                  setMessages([{
                    role: 'assistant',
                    content: "Hello 👋 I'm running in Server Mode — your messages are processed on our server. I'm here to listen, no judgments. What's on your mind today?"
                  }])
                }}
                style={{ background: 'linear-gradient(135deg, #059669, #0891b2)', color: '#fff', border: 'none', borderRadius: '10px', padding: '0.75rem 1.75rem', fontWeight: 700, cursor: 'pointer', fontSize: '0.95rem' }}
              >
                Continue with Server Mode →
              </button>
            </div>
          )}

          <div style={{ padding: '1.25rem', background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.2)', borderRadius: '14px', fontSize: '0.88rem', color: '#94a3b8', lineHeight: 2, textAlign: 'left' }}>
            <div style={{ fontWeight: 600, color: '#f1f5f9', marginBottom: '0.5rem' }}>Or switch to a supported browser:</div>
            <div>✅ <strong style={{ color: '#f1f5f9' }}>Chrome 113+</strong> — Windows, Mac, Linux, Android</div>
            <div>✅ <strong style={{ color: '#f1f5f9' }}>Edge 113+</strong> — Windows, Mac</div>
            <div>✅ <strong style={{ color: '#f1f5f9' }}>Safari 18+</strong> — macOS Sonoma / iOS 18+</div>
            <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              ⚠️ <strong style={{ color: '#f1f5f9' }}>Firefox</strong> — enable at{' '}
              <code style={{ fontSize: '0.8rem', background: 'rgba(255,255,255,0.07)', padding: '1px 5px', borderRadius: '4px' }}>about:config</code>
              {' '}→ <code style={{ fontSize: '0.8rem', background: 'rgba(255,255,255,0.07)', padding: '1px 5px', borderRadius: '4px' }}>dom.webgpu.enabled = true</code>
            </div>
          </div>
          <a href="https://www.google.com/chrome/" target="_blank" rel="noreferrer"
            style={{ display: 'inline-block', marginTop: '1.5rem', background: 'linear-gradient(135deg, #7c3aed, #06b6d4)', color: '#fff', borderRadius: '12px', padding: '0.875rem 2.5rem', fontWeight: 700, fontSize: '1rem', textDecoration: 'none' }}>
            Download Chrome (Free)
          </a>
        </div>
      </div>
    )
  }

  // Recoverable load error — show retry button
  if (loadError) {
    return (
      <div style={{ paddingTop: '64px', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div style={{ textAlign: 'center', maxWidth: '460px' }}>
          <div style={{ fontSize: '3.5rem', marginBottom: '1.5rem' }}>😔</div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.75rem', color: '#f1f5f9' }}>Couldn't Load Model</h2>
          <p style={{ color: '#64748b', lineHeight: 1.7, marginBottom: '2rem' }}>{loadError}</p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={() => { setLoadError(''); initEngine() }}
              style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)', color: '#fff', border: 'none', borderRadius: '12px', padding: '0.875rem 2rem', fontSize: '1rem', fontWeight: 700, cursor: 'pointer' }}
            >
              Try Again
            </button>
            <button
              onClick={() => { setLoadError(''); initEngine(MODELS[0].id) }}
              style={{ background: 'rgba(255,255,255,0.06)', color: '#94a3b8', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '0.875rem 2rem', fontSize: '1rem', fontWeight: 600, cursor: 'pointer' }}
            >
              Try Smallest Model
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!isReady) {
    return (
      <div style={{ paddingTop: '64px' }}>
        <LoadingScreen progress={loadProgress} status={loadStatus} fromCache={fromCache} modelId={activeModel} detectReason={detectReason} speed={loadSpeed} eta={loadETA} />
      </div>
    )
  }

  return (
    <div style={{ paddingTop: '64px', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        @media (max-width: 480px) {
          .chat-privacy-full { display: none; }
          .chat-privacy-notice { flex: none !important; }
        }
      `}</style>
      <div style={{ flex: 1, maxWidth: '800px', width: '100%', margin: '0 auto', padding: 'clamp(0.5rem, 3vw, 1.5rem)', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Top bar: privacy notice + model info */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: '1rem', flexWrap: 'wrap',
          }}
        >
          <div className="chat-privacy-notice" style={{
            padding: '0.6rem 1rem',
            background: serverMode ? 'rgba(14,116,144,0.1)' : 'rgba(16,185,129,0.1)',
            border: `1px solid ${serverMode ? 'rgba(14,116,144,0.25)' : 'rgba(16,185,129,0.2)'}`,
            borderRadius: '10px', fontSize: '0.8rem', color: serverMode ? '#67e8f9' : '#6ee7b7',
            display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1,
            minWidth: 0,
          }}>
            {serverMode ? '☁️' : '🔒'} <span className="chat-privacy-text">{serverMode ? 'Server Mode' : 'Private'}</span>
            <span className="chat-privacy-full">
              {serverMode
                ? ' — AI runs on our server. Messages are processed server-side and not stored.'
                : ' — This conversation exists only in your browser. Nothing is stored or transmitted.'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {user?.plan === 'pro' && (
              <button
                onClick={() => setShowHistory(true)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.4rem',
                  padding: '0.3rem 0.75rem', borderRadius: '100px',
                  background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.25)',
                  color: '#a78bfa', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                📂 History
              </button>
            )}
            <ActiveModelBadge modelId={activeModel} fromCache={fromCache} serverMode={serverMode} />
            {!serverMode && <ModelPicker selectedId={activeModel} onSelect={switchModel} disabled={isGenerating} />}
          </div>
        </motion.div>

        {/* Chat window */}
        <GlassSurface style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', height: 0, minHeight: 'min(calc(100vh - 280px), 70vh)' }}>
          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <AnimatePresence>
              {messages.map((msg, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 10, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.3 }}
                  style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}
                >
                  <div style={{
                    maxWidth: 'min(85%, 600px)',
                    padding: '0.85rem 1.1rem',
                    borderRadius: msg.role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                    background: msg.role === 'user'
                      ? 'linear-gradient(135deg, #7c3aed, #6d28d9)'
                      : 'rgba(255,255,255,0.06)',
                    border: msg.role === 'assistant' ? '1px solid rgba(255,255,255,0.08)' : 'none',
                    color: '#f1f5f9',
                    fontSize: '0.95rem',
                    lineHeight: 1.65,
                    wordBreak: 'break-word',
                  }}>
                    {msg.content || (isGenerating && i === messages.length - 1 && <TypingIndicator />)}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            {isGenerating && messages[messages.length - 1]?.content === '' && <TypingIndicator />}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={{
            borderTop: '1px solid rgba(255,255,255,0.06)',
            padding: 'clamp(0.6rem, 2vw, 1rem) clamp(0.75rem, 3vw, 1.5rem)',
            display: 'flex',
            gap: '0.75rem',
            alignItems: 'flex-end',
          }}>
            {anonBlocked ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0' }}>
                <p style={{ color: '#94a3b8', fontSize: '0.9rem', textAlign: 'center', margin: 0 }}>
                  Daily limit reached — sign up free for 60 min/day
                </p>
                <button
                  onClick={() => window.__openAuth?.('signup')}
                  style={{ padding: '0.6rem 1.5rem', borderRadius: '10px', background: 'linear-gradient(135deg, #7c3aed, #06b6d4)', color: '#fff', border: 'none', fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem' }}
                >
                  Sign up free
                </button>
              </div>
            ) : (
              <>
                <textarea
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
                  placeholder={isBlocked ? 'Daily limit reached' : 'What\'s on your mind...'}
                  rows={2}
                  style={{
                    flex: 1,
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '12px',
                    padding: '0.85rem 1rem',
                    color: '#f1f5f9',
                    fontSize: '0.95rem',
                    resize: 'none',
                    outline: 'none',
                    fontFamily: 'inherit',
                    lineHeight: 1.5,
                    transition: 'border-color 0.2s',
                    opacity: isBlocked ? 0.4 : 1,
                  }}
                  onFocus={e => !isBlocked && (e.target.style.borderColor = 'rgba(124,58,237,0.5)')}
                  onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.08)'}
                  disabled={isGenerating || isBlocked}
                />
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={sendMessage}
                  disabled={isGenerating || !input.trim() || isBlocked}
                  style={{
                    background: input.trim() && !isGenerating && !isBlocked ? 'linear-gradient(135deg, #7c3aed, #06b6d4)' : 'rgba(255,255,255,0.06)',
                    border: 'none',
                    borderRadius: '12px',
                    width: '48px',
                    height: '48px',
                    cursor: input.trim() && !isGenerating && !isBlocked ? 'pointer' : 'not-allowed',
                    fontSize: '1.2rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'background 0.2s',
                    flexShrink: 0,
                  }}
                >
                  ↑
                </motion.button>
                {isGenerating && canStop && (
                  <motion.button
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.85 }}
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => { abortRef.current?.abort(); setIsGenerating(false) }}
                    style={{
                      background: 'rgba(239,68,68,0.15)',
                      border: '1px solid rgba(239,68,68,0.4)',
                      borderRadius: '100px',
                      padding: '0 1rem',
                      height: '48px',
                      cursor: 'pointer',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  color: '#f87171',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  flexShrink: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                🛑 Stop
              </motion.button>
            )}
              </>
            )}
          </div>
        </GlassSurface>
      </div>

      {/* Chat history drawer — Pro users only */}
      <ChatHistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        authFetch={authFetch}
        encKey={encKey}
        setMessages={setMessages}
        setSessionId={setSessionId}
        currentSessionId={sessionId}
      />

      {/* Upgrade toast — shown when background model finishes loading */}
      {upgradeReady && (
        <UpgradeToast
          model={MODELS.find(m => m.id === upgradeReady.modelId)}
          onAccept={acceptUpgrade}
          onDismiss={dismissUpgrade}
        />
      )}

      {/* Session timer — only shown to free-account users when < 10 min remain (never to anon) */}
      <SessionTimer
        getTimeRemaining={getTimeRemaining}
        isUnlimited={!timerVisible || isUnlimited}
        onUpgradeClick={() => setShowUpgradeModal(true)}
      />

      {/* Session gate — hard block for free accounts; stealth nudge for anon */}
      {showGate && (
        <SessionGateModal
          plan={plan}
          isNudge={showNudge && !isExpired}
          onUpgrade={() => { setShowGate(false); setShowUpgradeModal(true) }}
          onLogin={() => { setShowGate(false); window.__openAuth?.('signup') }}
          onDismiss={() => { setShowGate(false); dismissNudge?.() }}
        />
      )}

      {/* Upgrade/pricing modal */}
      {showUpgradeModal && (
        <UpgradeModal
          onClose={() => setShowUpgradeModal(false)}
          onLogin={() => { setShowUpgradeModal(false); window.__openAuth?.('login') }}
          onRegister={() => { setShowUpgradeModal(false); window.__openAuth?.('signup') }}
        />
      )}
    </div>
  )
}
