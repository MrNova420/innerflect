-- ═════════════════════════════════════════════════════════════════════════════
--  Innerflect — PostgreSQL Schema
--  Authoritative schema matching api/main.py init_db()
--
--  Run once:  psql innerflect < api/schema.sql
--  Or:        DATABASE_URL=... python3 -c "import asyncio; from api.main import init_db, _pool; ..."
--  Note: FastAPI runs this automatically on startup via init_db()
-- ═════════════════════════════════════════════════════════════════════════════

-- Enable UUID generation (required for chat_history.session_id)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Contacts ──────────────────────────────────────────────────────────────────
-- Contact form submissions. PII (email, IP) intentionally NOT stored.
CREATE TABLE IF NOT EXISTS contacts (
    id        BIGSERIAL PRIMARY KEY,
    name      TEXT NOT NULL,
    message   TEXT NOT NULL,
    reply_via TEXT DEFAULT '',
    created   BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
);

-- ── Page Analytics ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pageviews (
    path  TEXT NOT NULL,
    day   DATE NOT NULL DEFAULT CURRENT_DATE,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (path, day)
);

-- ── Performance Metrics ───────────────────────────────────────────────────────
-- user_agent intentionally NOT stored (privacy promise)
CREATE TABLE IF NOT EXISTS perf_metrics (
    id          BIGSERIAL PRIMARY KEY,
    path        TEXT NOT NULL,
    load_time   INTEGER NOT NULL,
    ttfb        INTEGER,
    "timestamp" BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
);
CREATE INDEX IF NOT EXISTS idx_perf_path ON perf_metrics(path, "timestamp");
CREATE INDEX IF NOT EXISTS idx_perf_time ON perf_metrics("timestamp");

-- ── Ad / Slayer Events ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS slayer_events (
    id          BIGSERIAL PRIMARY KEY,
    event       TEXT NOT NULL CHECK(event IN ('impression','click')),
    ad_id       TEXT NOT NULL,
    page        TEXT NOT NULL DEFAULT '/',
    "timestamp" BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
);
CREATE INDEX IF NOT EXISTS idx_slayer_ad  ON slayer_events(ad_id, event);
CREATE INDEX IF NOT EXISTS idx_slayer_day ON slayer_events("timestamp", event);

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    email           TEXT UNIQUE,
    password_hash   TEXT,
    google_id       TEXT UNIQUE,
    name            TEXT NOT NULL DEFAULT 'User',
    avatar_url      TEXT DEFAULT '',
    plan            TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free','pro')),
    preferences     JSONB DEFAULT '{}',
    email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_id);

-- Idempotent migration: add email_verified to existing deployments
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
-- Google-linked accounts are already email-verified (Google validates emails)
UPDATE users SET email_verified = TRUE WHERE google_id IS NOT NULL AND email_verified = FALSE;

-- ── Legacy Session Tokens (replaced by refresh_tokens) ────────────────────────
CREATE TABLE IF NOT EXISTS user_sessions (
    token      TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_uid ON user_sessions(user_id);

-- ── Refresh Tokens (JWT rotation) ─────────────────────────────────────────────
-- Opaque 90-day tokens. Rotated on each use. Revoked on logout.
CREATE TABLE IF NOT EXISTS refresh_tokens (
    token      TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens(user_id);

-- ── Password Reset Tokens ─────────────────────────────────────────────────────
-- Ephemeral 1-hour tokens, consumed on use.
CREATE TABLE IF NOT EXISTS password_resets (
    token      TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

-- ── Email Verification Tokens ─────────────────────────────────────────────────
-- 3-day tokens, consumed on successful verification.
CREATE TABLE IF NOT EXISTS email_verifications (
    token      TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_ev_user ON email_verifications(user_id);

-- ── Chat History (Pro users only, E2E encrypted) ──────────────────────────────
-- Content is AES-256-GCM encrypted client-side. Server sees only ciphertext.
-- therapy_sessions table is NOT used — AI conversations never leave the browser.
CREATE TABLE IF NOT EXISTS chat_history (
    id               BIGSERIAL PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id       TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
    title            TEXT NOT NULL DEFAULT 'Chat Session',
    messages         JSONB NOT NULL DEFAULT '[]',
    model            TEXT DEFAULT '',
    created_at       BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    updated_at       BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    last_accessed_at BIGINT DEFAULT NULL  -- tracks last open; sessions idle 30d are auto-deleted
);
CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_history(user_id, created_at DESC);

-- ── Usage Tracking ────────────────────────────────────────────────────────────
-- Per-user daily session minutes (logged-in users)
CREATE TABLE IF NOT EXISTS daily_usage (
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day          DATE NOT NULL DEFAULT CURRENT_DATE,
    minutes_used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);

-- Per-fingerprint daily usage (anonymous users — fingerprint only, no PII)
CREATE TABLE IF NOT EXISTS anon_daily_usage (
    fingerprint  TEXT NOT NULL,
    day          DATE NOT NULL DEFAULT CURRENT_DATE,
    minutes_used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (fingerprint, day)
);

-- ═════════════════════════════════════════════════════════════════════════════
--  Idempotent migrations (safe to re-run)
-- ═════════════════════════════════════════════════════════════════════════════

-- Add preferences column if upgrading from older schema
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}';

-- Add last_accessed_at for 30-day auto-cleanup (sessions idle >30 days are deleted on startup)
ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS last_accessed_at BIGINT DEFAULT NULL;

-- Remove PII columns from contacts if they exist (old schema cleanup)
ALTER TABLE contacts DROP COLUMN IF EXISTS email;
ALTER TABLE contacts DROP COLUMN IF EXISTS ip;

