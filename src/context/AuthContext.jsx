import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import {
  deriveEncryptionKey,
  persistKey,
  loadPersistedKey,
  clearPersistedKey,
  CRYPTO_AVAILABLE,
} from '../utils/crypto'

const AuthContext = createContext(null)

const TOKEN_KEY   = 'innerflect_auth'
const RT_KEY      = 'innerflect_rt'          // refresh token
const TOKEN_KEY_LEGACY = 'Innerflect_auth'   // migrate old key
const API = () => window.API_BASE || window.INNERFLECT_API_BASE || ''

// How many ms before JWT expiry to proactively refresh (1 day)
const REFRESH_MARGIN_MS = 86_400_000

function _parseJwtExp(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return payload.exp ? payload.exp * 1000 : null
  } catch { return null }
}

function _isTokenExpired(token) {
  const exp = _parseJwtExp(token)
  return exp ? Date.now() >= exp : true
}

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [encKey, setEncKey]   = useState(null) // CryptoKey — never leaves memory/localStorage
  const refreshTimerRef       = useRef(null)

  // One-time migration: rename old token key
  useEffect(() => {
    const old = localStorage.getItem(TOKEN_KEY_LEGACY)
    if (old && !localStorage.getItem(TOKEN_KEY)) {
      localStorage.setItem(TOKEN_KEY, old)
      localStorage.removeItem(TOKEN_KEY_LEGACY)
    }
  }, [])

  // Schedule a proactive silent refresh (1 day before expiry)
  function _scheduleRefresh(token) {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    const exp = _parseJwtExp(token)
    if (!exp) return
    const delay = Math.max(0, exp - Date.now() - REFRESH_MARGIN_MS)
    refreshTimerRef.current = setTimeout(() => _silentRefresh(), delay)
  }

  // Silently exchange refresh token for a fresh pair (token rotation)
  async function _silentRefresh() {
    const rt = localStorage.getItem(RT_KEY)
    if (!rt) { _forceLogout(); return }
    try {
      const r = await fetch(`${API()}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt })
      })
      if (!r.ok) { _forceLogout(); return }
      const { token, refresh_token: newRt, user: u } = await r.json()
      localStorage.setItem(TOKEN_KEY, token)
      localStorage.setItem(RT_KEY, newRt)
      setUser(prev => ({ ...prev, ...u, token }))
      _scheduleRefresh(token)
    } catch { /* network error — keep existing tokens, retry on next page load */ }
  }

  function _forceLogout() {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(RT_KEY)
    clearPersistedKey()
    setUser(null)
    setEncKey(null)
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
  }

  // Restore session on mount — auto-refresh if access token expired but refresh token exists
  useEffect(() => {
    async function restore() {
      const token = localStorage.getItem(TOKEN_KEY)
      const rt    = localStorage.getItem(RT_KEY)

      if (!token && !rt) { setLoading(false); return }

      // If access token is expired but we have a refresh token — try silent refresh first
      if ((!token || _isTokenExpired(token)) && rt) {
        try {
          const r = await fetch(`${API()}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: rt })
          })
          if (r.ok) {
            const { token: newTok, refresh_token: newRt, user: u } = await r.json()
            localStorage.setItem(TOKEN_KEY, newTok)
            localStorage.setItem(RT_KEY, newRt)
            setUser({ ...u, token: newTok })
            _scheduleRefresh(newTok)
            if (CRYPTO_AVAILABLE) {
              const key = await loadPersistedKey()
              if (key) setEncKey(key)
            }
            setLoading(false); return
          }
        } catch { /* fall through to force logout */ }
        _forceLogout()
        setLoading(false); return
      }

      if (!token) { setLoading(false); return }

      // Access token still valid — verify with /me
      try {
        const r = await fetch(`${API()}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        if (r.ok) {
          const u = await r.json()
          setUser({ ...u, token })
          _scheduleRefresh(token)
          if (CRYPTO_AVAILABLE) {
            const key = await loadPersistedKey()
            if (key) setEncKey(key)
          }
        } else if (r.status === 401 && rt) {
          // Token rejected — try refresh
          await _silentRefresh()
        } else {
          _forceLogout()
        }
      } catch { /* network error — keep state, retry on next interaction */ }
      finally { setLoading(false) }
    }
    restore()
    return () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Derive and persist encryption key from plaintext credentials (called before API login)
  async function _deriveAndSetKey(email, password) {
    if (!CRYPTO_AVAILABLE) return
    try {
      const key = await deriveEncryptionKey(password, email)
      await persistKey(key)
      setEncKey(key)
    } catch { /* crypto unavailable — no encryption, still functional */ }
  }

  // Authenticated fetch — auto-refreshes on 401
  const authFetch = useCallback(async (url, opts = {}) => {
    const token = localStorage.getItem(TOKEN_KEY)
    const headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` }
    let r = await fetch(url, { ...opts, headers })
    if (r.status === 401) {
      await _silentRefresh()
      const newToken = localStorage.getItem(TOKEN_KEY)
      if (newToken) {
        r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${newToken}` } })
      }
    }
    return r
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const login = useCallback(async (email, password) => {
    await _deriveAndSetKey(email, password)
    const r = await fetch(`${API()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    if (!r.ok) { const e = await r.json(); throw new Error(e.detail || 'Login failed') }
    const { token, refresh_token: rt, user: u } = await r.json()
    localStorage.setItem(TOKEN_KEY, token)
    if (rt) localStorage.setItem(RT_KEY, rt)
    setUser({ ...u, token })
    _scheduleRefresh(token)
    return u
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const register = useCallback(async (email, password, name) => {
    await _deriveAndSetKey(email, password)
    const r = await fetch(`${API()}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name })
    })
    if (!r.ok) { const e = await r.json(); throw new Error(e.detail || 'Registration failed') }
    const { token, refresh_token: rt, user: u } = await r.json()
    localStorage.setItem(TOKEN_KEY, token)
    if (rt) localStorage.setItem(RT_KEY, rt)
    setUser({ ...u, token })
    _scheduleRefresh(token)
    return u
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const googleLogin = useCallback(async (idToken) => {
    const r = await fetch(`${API()}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: idToken })
    })
    if (!r.ok) { const e = await r.json(); throw new Error(e.detail || 'Google login failed') }
    const { token, refresh_token: rt, user: u } = await r.json()
    localStorage.setItem(TOKEN_KEY, token)
    if (rt) localStorage.setItem(RT_KEY, rt)
    setUser({ ...u, token })
    _scheduleRefresh(token)
    // Google users: try to restore a previously persisted key (no password to derive from)
    if (CRYPTO_AVAILABLE) {
      const key = await loadPersistedKey()
      if (key) setEncKey(key)
    }
    return u
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const logout = useCallback(async () => {
    const rt = localStorage.getItem(RT_KEY)
    if (rt) {
      // Best-effort — revoke refresh token server-side
      fetch(`${API()}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt })
      }).catch(() => {})
    }
    _forceLogout()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refresh user data from /api/auth/me — called after email verification
  const refreshUser = useCallback(async () => {
    const token = localStorage.getItem(TOKEN_KEY)
    if (!token) return
    try {
      const r = await fetch(`${API()}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (r.ok) {
        const u = await r.json()
        setUser(prev => ({ ...prev, ...u }))
      }
    } catch { /* silent */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Expose refreshUser globally so App.jsx can call it after email verification
  useEffect(() => { window.__refreshAuth = refreshUser }, [refreshUser])

  return (
    <AuthContext.Provider value={{ user, loading, encKey, login, register, googleLogin, logout, authFetch, refreshUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
