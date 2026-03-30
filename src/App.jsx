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

  // Handle ?reset=<token> links from password reset emails
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('reset')
    if (token) {
      setResetToken(token)
      setShowReset(true)
      // Clean URL without reload
      const clean = window.location.pathname
      window.history.replaceState({}, '', clean)
    }
  }, [])

  // Expose modal openers globally so Nav and pages can trigger them easily
  useEffect(() => {
    window.__openAuth = (mode = 'login') => { setAuthMode(mode); setShowAuth(true) }
    window.__openUpgrade = () => setShowUpgrade(true)
  }, [])

  return (
    <AuthProvider>
      <Nav onSignIn={() => { setAuthMode('login'); setShowAuth(true) }} />
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
