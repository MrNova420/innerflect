import { lazy, Suspense, useState, useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import Nav from './components/Nav'
import Footer from './components/Footer'
import { AuthProvider } from './context/AuthContext'
import AuthModal from './components/AuthModal'
import UpgradeModal from './components/UpgradeModal'
import ResetPasswordModal from './components/ResetPasswordModal'
import ErrorBoundary from './components/ErrorBoundary'

// Lazy-load heavy pages so the initial bundle stays tiny
const Landing     = lazy(() => import('./pages/Landing'))
const TherapySpace = lazy(() => import('./pages/TherapySpace'))
const About       = lazy(() => import('./pages/About'))
const FAQ         = lazy(() => import('./pages/FAQ'))
const Privacy     = lazy(() => import('./pages/Privacy'))
const NotFound    = lazy(() => import('./pages/NotFound'))

function PageLoader() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: 'calc(100vh - 64px)', color: '#64748b', fontSize: '0.9rem',
      gap: '0.75rem'
    }}>
      <span style={{
        width: 20, height: 20, borderRadius: '50%',
        border: '2px solid #7c3aed', borderTopColor: 'transparent',
        animation: 'spin 0.8s linear infinite', display: 'inline-block'
      }} />
      Loading...
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

export default function App() {
  const [showAuth, setShowAuth]     = useState(false)
  const [authMode, setAuthMode]     = useState('login')
  const [showUpgrade, setShowUpgrade] = useState(false)
  const [resetToken, setResetToken] = useState('')
  const [showReset, setShowReset]   = useState(false)
  const [verifyStatus, setVerifyStatus] = useState(null) // null | 'pending' | 'ok' | 'error'
  const [verifyMsg, setVerifyMsg]   = useState('')

  // Handle ?reset=<token> links from password reset emails
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('reset')
    if (token) {
      setResetToken(token)
      setShowReset(true)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  // Handle ?verify=<token> links from email verification emails
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('verify')
    if (!token) return
    window.history.replaceState({}, '', window.location.pathname)
    setVerifyStatus('pending')
    const api = window.INNERFLECT_API_BASE || ''
    fetch(`${api}/api/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          setVerifyStatus('ok')
          setVerifyMsg(data.message || 'Email verified!')
          // Refresh auth state so email_verified updates in the UI
          window.__refreshAuth?.()
        } else {
          setVerifyStatus('error')
          setVerifyMsg(data.detail || 'Verification failed. The link may have expired.')
        }
      })
      .catch(() => { setVerifyStatus('error'); setVerifyMsg('Network error — please try again.') })
  }, [])

  // Expose modal openers globally so Nav and pages can trigger them easily
  useEffect(() => {
    window.__openAuth = (mode = 'login') => { setAuthMode(mode); setShowAuth(true) }
    window.__openUpgrade = () => setShowUpgrade(true)
  }, [])

  return (
    <AuthProvider>
      <Nav onSignIn={() => { setAuthMode('login'); setShowAuth(true) }} />

      {/* Email verification toast */}
      {verifyStatus && verifyStatus !== 'pending' && (
        <div style={{
          position: 'fixed', top: '72px', left: '50%', transform: 'translateX(-50%)',
          zIndex: 9999, padding: '0.75rem 1.5rem', borderRadius: '12px', fontSize: '0.9rem',
          fontWeight: 600, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          background: verifyStatus === 'ok' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
          border: `1px solid ${verifyStatus === 'ok' ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)'}`,
          color: verifyStatus === 'ok' ? '#6ee7b7' : '#fca5a5',
          display: 'flex', alignItems: 'center', gap: '0.6rem',
          backdropFilter: 'blur(12px)',
        }}>
          {verifyStatus === 'ok' ? '✅' : '❌'} {verifyMsg}
          <button onClick={() => setVerifyStatus(null)} style={{
            background: 'none', border: 'none', color: 'inherit', cursor: 'pointer',
            marginLeft: '0.5rem', opacity: 0.6, fontSize: '1rem', padding: 0,
          }}>×</button>
        </div>
      )}
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/"        element={<Landing />} />
            <Route path="/therapy" element={<ErrorBoundary><TherapySpace /></ErrorBoundary>} />
            <Route path="/about"   element={<About />} />
            <Route path="/faq"     element={<FAQ />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="*"        element={<NotFound />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
      <Footer />

      {showAuth && (
        <AuthModal
          mode={authMode}
          onClose={() => setShowAuth(false)}
        />
      )}
      {showUpgrade && (
        <UpgradeModal
          onClose={() => setShowUpgrade(false)}
          onLogin={() => { setShowUpgrade(false); setAuthMode('login'); setShowAuth(true) }}
          onRegister={() => { setShowUpgrade(false); setAuthMode('signup'); setShowAuth(true) }}
        />
      )}
      {showReset && (
        <ResetPasswordModal
          token={resetToken}
          onClose={() => { setShowReset(false); setAuthMode('login'); setShowAuth(true) }}
        />
      )}
    </AuthProvider>
  )
}
