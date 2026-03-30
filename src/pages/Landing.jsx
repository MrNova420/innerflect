import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { motion, useInView } from 'framer-motion'
import Aurora from '../components/Aurora'
import SpotlightCard from '../components/SpotlightCard'
import { useGhostSlayer } from '../hooks/useGhostSlayer'

function CountUp({ end, suffix = '', duration = 2 }) {
  const ref = useRef()
  const isInView = useInView(ref, { once: true })
  const countRef = useRef(null)

  useEffect(() => {
    if (!isInView) return
    let start = 0
    const step = end / (duration * 60)
    const timer = setInterval(() => {
      start += step
      if (start >= end) {
        start = end
        clearInterval(timer)
      }
      if (countRef.current) countRef.current.textContent = Math.floor(start) + suffix
    }, 1000 / 60)
    return () => clearInterval(timer)
  }, [isInView, end, suffix, duration])

  return <span ref={ref}><span ref={countRef}>0{suffix}</span></span>
}

function ScrollVelocityText({ text }) {
  const repeated = text.repeat(6)
  return (
    <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', padding: '1.5rem 0', width: '100%' }}>
      <motion.div
        animate={{ x: ['0%', '-50%'] }}
        transition={{ duration: 22, repeat: Infinity, ease: 'linear' }}
        style={{ display: 'inline-block', fontSize: '1.1rem', fontWeight: 700, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.15)', width: 'max-content' }}
      >
        {repeated}{repeated}
      </motion.div>
    </div>
  )
}

const gradientText = {
  background: 'linear-gradient(135deg, #a78bfa, #06b6d4)',
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  backgroundClip: 'text',
}

const steps = [
  {
    icon: '💬',
    title: 'Type how you\'re feeling',
    desc: 'Just say what\'s on your mind — no prompts, no format, no right answer. Start wherever you are.',
  },
  {
    icon: '🤖',
    title: 'The AI responds',
    desc: 'A warm, thoughtful reply — no judgment. It listens, reflects, and gently helps you think things through.',
  },
  {
    icon: '🔒',
    title: 'Nothing is ever saved',
    desc: 'Close the tab and it\'s all gone. No server. No logs. No one reads your words — not even us.',
  },
]

const whyCards = [
  {
    icon: '🛡️',
    title: 'Your conversations stay yours',
    desc: 'The AI runs directly in your browser. Nothing is sent anywhere. Not encrypted on a server — just never sent at all.',
  },
  {
    icon: '⚡',
    title: 'No account needed to start',
    desc: 'Open the app and start talking — no signup, no email, no credit card. The AI downloads once, then works instantly every visit.',
  },
  {
    icon: '📴',
    title: 'Works even offline',
    desc: 'Once downloaded, the AI model lives in your browser cache. No internet? No problem. It\'s always there when you need it.',
  },
]

const tiers = [
  {
    name: 'Anonymous',
    price: 'Free',
    highlight: false,
    badge: null,
    limit: '30 min / day',
    features: [
      'No account required',
      '30 minutes per day',
      'Full AI conversation',
      'No data saved anywhere',
    ],
    cta: 'Start now',
  },
  {
    name: 'Free Account',
    price: 'Free',
    highlight: true,
    badge: 'Most Popular',
    limit: '60 min / day',
    features: [
      'Free account (email only)',
      '60 minutes per day',
      'Chat history saved locally',
      'No data leaves your device',
    ],
    cta: 'Create free account',
  },
  {
    name: 'Pro',
    price: '$4.99',
    priceSub: '/ month',
    highlight: false,
    badge: 'Coming soon',
    limit: 'Unlimited',
    features: [
      'Unlimited daily usage',
      'Persistent chat history',
      'Priority model access',
      'More features on the way',
    ],
    cta: 'Get Pro',
    disabled: true,
  },
]

export default function Landing() {
  const { trackImpression } = useGhostSlayer()

  useEffect(() => {
    document.title = 'Innerflect — Private AI Therapy Companion'
    document.querySelector('meta[name="description"]')?.setAttribute('content',
      'Your conversations stay on your device. Innerflect is a private, secure AI therapy companion that runs entirely in your browser with no data ever leaving your device.')
    trackImpression('landing-page')
  }, [])

  return (
    <div style={{ paddingTop: '64px' }}>
      <style>{`
        @media (max-width: 480px) {
          .hero-cta-wrap { flex-direction: column !important; align-items: stretch !important; }
          .hero-cta-wrap a { text-align: center; }
        }
      `}</style>

      {/* ── Hero ─────────────────────────────────────────────── */}
      <section style={{ position: 'relative', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <Aurora colors={['#7c3aed', '#06b6d4', '#1e1b4b', '#4f46e5']} />
        <div style={{ position: 'relative', zIndex: 1, textAlign: 'center', padding: '2rem', maxWidth: '820px' }}>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.15 }}
          >
            <div style={{
              display: 'inline-block',
              background: 'rgba(124,58,237,0.2)',
              border: '1px solid rgba(124,58,237,0.4)',
              borderRadius: '100px',
              padding: '0.4rem 1.1rem',
              fontSize: '0.8rem',
              color: '#a78bfa',
              marginBottom: '1.8rem',
              letterSpacing: '0.06em',
            }}>
              🔒 Runs on your device — nothing ever sent online
            </div>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.3 }}
            style={{
              fontSize: 'clamp(2.6rem, 7vw, 5.2rem)',
              fontWeight: 900,
              lineHeight: 1.08,
              letterSpacing: '-0.03em',
              marginBottom: '1.2rem',
              background: 'linear-gradient(135deg, #f1f5f9 0%, #a78bfa 55%, #06b6d4 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            A safe place<br />to think out loud.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.5 }}
            style={{
              fontSize: 'clamp(1.05rem, 2.2vw, 1.25rem)',
              color: '#94a3b8',
              maxWidth: '540px',
              margin: '0 auto 0.9rem',
              lineHeight: 1.75,
            }}
          >
            Innerflect is a free, private AI companion you can talk to anytime.
            It runs entirely on your device — <span style={{ color: '#a78bfa' }}>no server, no tracking, no account needed.</span>
          </motion.p>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.7 }}
            style={{ fontSize: '0.85rem', color: '#475569', marginBottom: '2.4rem' }}
          >
            Works on Chrome or Edge · Android & Desktop · Free to start
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.8 }}
            style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}
            className="hero-cta-wrap"
          >
            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
              <Link
                to="/therapy"
                style={{
                  display: 'inline-block',
                  background: 'linear-gradient(135deg, #7c3aed, #06b6d4)',
                  color: '#fff',
                  padding: '1rem 2.6rem',
                  borderRadius: '12px',
                  fontSize: '1.05rem',
                  fontWeight: 700,
                  textDecoration: 'none',
                  boxShadow: '0 0 40px rgba(124,58,237,0.45)',
                }}
              >
                Start talking →
              </Link>
            </motion.div>
            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
              <Link
                to="/about"
                style={{
                  display: 'inline-block',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: '#94a3b8',
                  padding: '1rem 2.6rem',
                  borderRadius: '12px',
                  fontSize: '1.05rem',
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                Learn more
              </Link>
            </motion.div>
          </motion.div>
        </div>

        <motion.div
          animate={{ y: [0, 10, 0] }}
          transition={{ duration: 2, repeat: Infinity }}
          style={{ position: 'absolute', bottom: '2rem', left: '50%', transform: 'translateX(-50%)', color: '#334155', fontSize: '1.4rem' }}
        >
          ↓
        </motion.div>
      </section>

      <ScrollVelocityText text="PRIVATE · NO SERVER · FREE · YOUR DEVICE · NO TRACKING · " />

      {/* ── How It Works ─────────────────────────────────────── */}
      <section style={{ padding: '5rem clamp(1rem, 4vw, 2rem) 6rem', maxWidth: '900px', margin: '0 auto' }}>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          style={{ textAlign: 'center', marginBottom: '3.5rem' }}
        >
          <h2 style={{ fontSize: 'clamp(1.9rem, 4vw, 2.7rem)', fontWeight: 800, marginBottom: '0.75rem', letterSpacing: '-0.02em' }}>
            Here's <span style={gradientText}>what happens</span>
          </h2>
          <p style={{ color: '#64748b', fontSize: '1.05rem', maxWidth: '460px', margin: '0 auto' }}>
            No setup. No learning curve. Just open it and talk.
          </p>
        </motion.div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.5rem' }}>
          {steps.map((s, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.15 }}
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: '16px',
                padding: '2rem',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '2.6rem', marginBottom: '1rem' }}>{s.icon}</div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#f1f5f9', marginBottom: '0.6rem' }}>{s.title}</h3>
              <p style={{ color: '#64748b', fontSize: '0.95rem', lineHeight: 1.7 }}>{s.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ── Why It's Different ───────────────────────────────── */}
      <section style={{ padding: '5rem clamp(1rem, 4vw, 2rem) 6rem', background: 'rgba(18,18,26,0.6)' }}>
        <div style={{ maxWidth: '1050px', margin: '0 auto' }}>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            style={{ textAlign: 'center', marginBottom: '3.5rem' }}
          >
            <h2 style={{ fontSize: 'clamp(1.9rem, 4vw, 2.7rem)', fontWeight: 800, marginBottom: '0.75rem', letterSpacing: '-0.02em' }}>
              Why <span style={gradientText}>Innerflect</span> is different
            </h2>
            <p style={{ color: '#64748b', fontSize: '1.05rem', maxWidth: '480px', margin: '0 auto' }}>
              Mental wellness tools should respect you — not monetize your feelings.
            </p>
          </motion.div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
            {whyCards.map((c, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.15 }}
              >
                <SpotlightCard style={{ height: '100%' }}>
                  <div style={{ fontSize: '2.4rem', marginBottom: '1rem' }}>{c.icon}</div>
                  <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#f1f5f9', marginBottom: '0.65rem' }}>{c.title}</h3>
                  <p style={{ color: '#64748b', lineHeight: 1.7, fontSize: '0.95rem' }}>{c.desc}</p>
                </SpotlightCard>
              </motion.div>
            ))}
          </div>

          {/* Privacy statement */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.3 }}
            style={{
              marginTop: '3rem',
              padding: '1.5rem 2rem',
              borderRadius: '14px',
              border: '1px solid rgba(124,58,237,0.25)',
              background: 'rgba(124,58,237,0.08)',
              textAlign: 'center',
              maxWidth: '640px',
              margin: '3rem auto 0',
            }}
          >
            <p style={{ color: '#a78bfa', fontWeight: 600, fontSize: '1.05rem', margin: 0 }}>
              🔐 Your conversations never leave your device. Not even to us.
            </p>
          </motion.div>
        </div>
      </section>

      <ScrollVelocityText text="FREE · PRIVATE · ALWAYS AVAILABLE · NO ACCOUNT · ZERO TRACKING · " />

      {/* ── Pricing ──────────────────────────────────────────── */}
      <section style={{ padding: '5rem clamp(1rem, 4vw, 2rem) 6rem', maxWidth: '1050px', margin: '0 auto' }}>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          style={{ textAlign: 'center', marginBottom: '3.5rem' }}
        >
          <h2 style={{ fontSize: 'clamp(1.9rem, 4vw, 2.7rem)', fontWeight: 800, marginBottom: '0.75rem', letterSpacing: '-0.02em' }}>
            Simple, honest <span style={gradientText}>pricing</span>
          </h2>
          <p style={{ color: '#64748b', fontSize: '1.05rem', maxWidth: '440px', margin: '0 auto' }}>
            Start for free — no card, no catch. Upgrade only if you want more time.
          </p>
        </motion.div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: '1.5rem', alignItems: 'start' }}>
          {tiers.map((t, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.12 }}
            >
              <div style={{
                borderRadius: '18px',
                padding: '2rem',
                border: t.highlight
                  ? '1.5px solid rgba(124,58,237,0.6)'
                  : '1px solid rgba(255,255,255,0.08)',
                background: t.highlight
                  ? 'linear-gradient(160deg, rgba(124,58,237,0.15), rgba(6,182,212,0.07))'
                  : 'rgba(255,255,255,0.03)',
                position: 'relative',
              }}>
                {t.badge && (
                  <div style={{
                    position: 'absolute',
                    top: '-0.65rem',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: t.highlight ? 'linear-gradient(135deg, #7c3aed, #06b6d4)' : 'rgba(255,255,255,0.1)',
                    color: '#fff',
                    borderRadius: '100px',
                    padding: '0.2rem 0.9rem',
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    letterSpacing: '0.05em',
                    whiteSpace: 'nowrap',
                  }}>
                    {t.badge}
                  </div>
                )}

                <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#f1f5f9', marginBottom: '0.4rem' }}>{t.name}</h3>

                <div style={{ marginBottom: '0.3rem' }}>
                  <span style={{ fontSize: '2.2rem', fontWeight: 900, color: '#f1f5f9' }}>{t.price}</span>
                  {t.priceSub && <span style={{ color: '#64748b', fontSize: '0.9rem', marginLeft: '0.3rem' }}>{t.priceSub}</span>}
                </div>

                <div style={{
                  display: 'inline-block',
                  background: 'rgba(124,58,237,0.15)',
                  border: '1px solid rgba(124,58,237,0.25)',
                  borderRadius: '6px',
                  padding: '0.2rem 0.7rem',
                  fontSize: '0.78rem',
                  color: '#a78bfa',
                  fontWeight: 600,
                  marginBottom: '1.4rem',
                }}>
                  {t.limit}
                </div>

                <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1.6rem', display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
                  {t.features.map((f, fi) => (
                    <li key={fi} style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', color: '#94a3b8', fontSize: '0.92rem' }}>
                      <span style={{ color: '#06b6d4', fontSize: '0.8rem' }}>✓</span>
                      {f}
                    </li>
                  ))}
                </ul>

                <motion.div whileHover={t.disabled ? {} : { scale: 1.03 }} whileTap={t.disabled ? {} : { scale: 0.97 }}>
                  <Link
                    to={t.disabled ? '#' : '/therapy'}
                    onClick={e => t.disabled && e.preventDefault()}
                    style={{
                      display: 'block',
                      textAlign: 'center',
                      padding: '0.8rem',
                      borderRadius: '10px',
                      fontWeight: 700,
                      fontSize: '0.95rem',
                      textDecoration: 'none',
                      cursor: t.disabled ? 'not-allowed' : 'pointer',
                      ...(t.highlight
                        ? { background: 'linear-gradient(135deg, #7c3aed, #06b6d4)', color: '#fff' }
                        : t.disabled
                          ? { background: 'rgba(255,255,255,0.04)', color: '#475569', border: '1px solid rgba(255,255,255,0.07)' }
                          : { background: 'rgba(255,255,255,0.06)', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.3)' }),
                    }}
                  >
                    {t.cta}
                  </Link>
                </motion.div>
              </div>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ── Ready to Talk CTA ─────────────────────────────────── */}
      <section style={{ padding: '5rem clamp(1rem, 4vw, 2rem) 6rem', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(ellipse at center, rgba(124,58,237,0.12) 0%, transparent 70%)',
          pointerEvents: 'none',
        }} />
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7 }}
          style={{ position: 'relative', zIndex: 1 }}
        >
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🌿</div>
          <h2 style={{ fontSize: 'clamp(2rem, 4.5vw, 3.2rem)', fontWeight: 900, marginBottom: '1rem', letterSpacing: '-0.02em' }}>
            Ready to talk?
          </h2>
          <p style={{ color: '#64748b', marginBottom: '0.5rem', fontSize: '1.1rem', maxWidth: '440px', margin: '0 auto 0.6rem' }}>
            No signup. No waiting. Nothing stored.
          </p>
          <p style={{ color: '#475569', fontSize: '0.85rem', marginBottom: '2.5rem' }}>
            Works best on Chrome or Edge on a desktop or laptop.
          </p>
          <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} style={{ display: 'inline-block' }}>
            <Link
              to="/therapy"
              style={{
                display: 'inline-block',
                background: 'linear-gradient(135deg, #7c3aed, #06b6d4)',
                color: '#fff',
                padding: '1.1rem 3.2rem',
                borderRadius: '12px',
                fontSize: '1.1rem',
                fontWeight: 700,
                textDecoration: 'none',
                boxShadow: '0 0 60px rgba(124,58,237,0.45)',
              }}
            >
              Talk to Innerflect →
            </Link>
          </motion.div>
        </motion.div>
        <div style={{ marginTop: '3rem' }}>
          <ScrollVelocityText text="YOUR THOUGHTS · YOUR DEVICE · YOUR PRIVACY · " />
        </div>
      </section>

    </div>
  )
}
