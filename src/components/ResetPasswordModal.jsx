import { useState, useEffect } from 'react'

const API = () => window.API_BASE || window.INNERFLECT_API_BASE || ''

export default function ResetPasswordModal({ token, onClose }) {
  const [password, setPassword]   = useState('')
  const [confirm, setConfirm]     = useState('')
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  const [success, setSuccess]     = useState(false)

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (password.length < 6) { setError('Password must be at least 6 characters'); return }
    if (password !== confirm) { setError('Passwords do not match'); return }
    setLoading(true)
    try {
      const r = await fetch(`${API()}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.detail || 'Reset failed — link may have expired.'); return }
      setSuccess(true)
    } catch { setError('Network error — please try again.') }
    finally { setLoading(false) }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reset password"
      onClick={onClose}
      style={{ position:'fixed',inset:0,zIndex:700,background:'rgba(10,10,15,0.9)',backdropFilter:'blur(20px)',display:'flex',alignItems:'center',justifyContent:'center',padding:'1rem' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background:'rgba(15,15,25,0.98)',border:'1px solid rgba(124,58,237,0.3)',borderRadius:'24px',padding:'2rem',maxWidth:'380px',width:'100%',fontFamily:'Inter,sans-serif' }}
      >
        <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'1.5rem' }}>
          <div>
            <h2 style={{ color:'#f1f5f9',fontSize:'1.3rem',fontWeight:700,margin:0 }}>Set new password</h2>
            <p style={{ color:'#64748b',fontSize:'0.8rem',margin:'0.25rem 0 0' }}>Choose a strong password for your account</p>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.1)',color:'#94a3b8',borderRadius:'50%',width:'32px',height:'32px',cursor:'pointer',fontSize:'1rem' }}>×</button>
        </div>

        {success ? (
          <div style={{ textAlign:'center' }}>
            <div style={{ fontSize:'2.5rem',marginBottom:'1rem' }}>✅</div>
            <p style={{ color:'#6ee7b7',fontSize:'0.95rem',lineHeight:1.6,marginBottom:'1.5rem' }}>
              Password updated successfully! You can now sign in with your new password.
            </p>
            <button
              onClick={onClose}
              style={{ background:'linear-gradient(135deg,#7c3aed,#06b6d4)',color:'#fff',border:'none',borderRadius:'12px',padding:'0.75rem 2rem',fontSize:'0.95rem',fontWeight:700,cursor:'pointer' }}
            >
              Sign in →
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display:'flex',flexDirection:'column',gap:'0.75rem' }}>
            <input
              type="password"
              placeholder="New password (min 6 characters)"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoFocus
              style={inputStyle}
            />
            <input
              type="password"
              placeholder="Confirm new password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              style={inputStyle}
            />
            {error && (
              <p style={{ color:'#f87171',fontSize:'0.82rem',margin:0,padding:'0.5rem 0.75rem',background:'rgba(239,68,68,0.08)',borderRadius:'8px',border:'1px solid rgba(239,68,68,0.2)' }}>
                ⚠ {error}
              </p>
            )}
            <button
              type="submit"
              disabled={loading}
              style={{ background:loading?'rgba(124,58,237,0.3)':'linear-gradient(135deg,#7c3aed,#06b6d4)',color:'#fff',border:'none',borderRadius:'12px',padding:'0.875rem',fontSize:'0.95rem',fontWeight:700,cursor:loading?'not-allowed':'pointer',marginTop:'0.25rem' }}
            >
              {loading ? 'Updating…' : 'Set new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

const inputStyle = {
  background:'rgba(255,255,255,0.04)',
  border:'1px solid rgba(255,255,255,0.1)',
  borderRadius:'10px',
  padding:'0.75rem 1rem',
  color:'#f1f5f9',
  fontSize:'0.9rem',
  outline:'none',
  fontFamily:'inherit',
  width:'100%',
  boxSizing:'border-box',
}
