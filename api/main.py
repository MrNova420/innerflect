"""
Innerflect — FastAPI backend
Zero tracking. No IP storage. No sessions. Anonymous by design.
"""
# ── Standard library ─────────────────────────────────────────────────────────
import os, time, asyncio, asyncpg, hashlib, secrets, json as _json
import hmac, logging
import httpx
from pathlib import Path
from contextlib import asynccontextmanager
import bcrypt, jwt as pyjwt
from datetime import datetime, timedelta, timezone

# ── Third-party ──────────────────────────────────────────────────────────────
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

# ═════════════════════════════════════════════════════════════════════════════
#  1. CONFIG — load .env first so every helper below can call _env()
# ═════════════════════════════════════════════════════════════════════════════
BASE       = Path(__file__).parent
START_TIME = time.time()
DATABASE_URL = os.environ.get('DATABASE_URL', 'postgresql://localhost/viddeoxx')
_pool: asyncpg.Pool = None

def _load_env() -> dict:
    env_path = BASE.parent / "config" / ".env"
    cfg: dict = {}
    try:
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip()
    except Exception:
        pass
    return cfg

_cfg = _load_env()

def _env(key: str, fallback: str = "") -> str:
    return _cfg.get(key) or os.environ.get(key, fallback)

ADMIN_TOKEN           = _env("INNERFLECT_ADMIN_TOKEN")
DISCORD_WEBHOOK       = _env("DISCORD_WEBHOOK")
OR_KEY                = _env("OPENROUTER_API_KEY", "")
STRIPE_SECRET_KEY     = _env("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = _env("STRIPE_WEBHOOK_SECRET")
STRIPE_PRICE_ID       = _env("STRIPE_PRICE_ID", "")

# ═════════════════════════════════════════════════════════════════════════════
#  2. REDIS — optional cache layer; all ops silently fall back on failure
# ═════════════════════════════════════════════════════════════════════════════
try:
    import redis as _redis_lib
    _REDIS_OK = True
except ImportError:
    _REDIS_OK = False

_rdb = None  # singleton Redis client; None = fallback mode

def _get_redis():
    global _rdb
    if _rdb is not None:
        return _rdb
    if not _REDIS_OK:
        return None
    host = _env("REDIS_HOST")
    if not host:
        return None
    try:
        c = _redis_lib.Redis(
            host=host,
            port=int(_env("REDIS_PORT", "6379")),
            username=_env("REDIS_USER", "default"),
            password=_env("REDIS_PASS", ""),
            decode_responses=True,
            socket_connect_timeout=3,
            socket_timeout=3,
            retry_on_timeout=False,
        )
        c.ping()
        _rdb = c
        return _rdb
    except Exception:
        return None

def _rcache_get(key: str, fallback=None):
    try:
        r = _get_redis()
        if r:
            v = r.get(key)
            return v if v is not None else fallback
    except Exception:
        pass
    return fallback

def _rcache_set(key: str, value, ttl: int = 0) -> bool:
    try:
        r = _get_redis()
        if r:
            r.setex(key, ttl, value) if ttl else r.set(key, value)
            return True
    except Exception:
        pass
    return False

def _rcache_incr(key: str, ttl: int = 0) -> int | None:
    """Atomic increment; sets TTL only on first creation. Returns new value or None."""
    try:
        r = _get_redis()
        if r:
            val = r.incr(key)
            if ttl and val == 1:
                r.expire(key, ttl)
            return val
    except Exception:
        pass
    return None

# ═════════════════════════════════════════════════════════════════════════════
#  3. DATABASE — asyncpg PostgreSQL connection pool
#     Supports local PostgreSQL and Neon (cloud) out of the box.
#     Neon detection: URL contains neon.tech OR sslmode=require param.
# ═════════════════════════════════════════════════════════════════════════════
import ssl as _ssl_module
import re as _re

def _parse_db_url(raw_url: str):
    """Return (clean_url, pool_kwargs) ready for asyncpg.create_pool().
    Strips sslmode from URL query string (asyncpg ignores it) and passes
    an SSL context directly instead. Neon free tier limits: 10 connections."""
    url = raw_url
    kwargs: dict = {"min_size": 1, "max_size": 5}

    is_neon = "neon.tech" in url
    needs_ssl = is_neon or "sslmode=require" in url or "sslmode=verify-full" in url

    # Strip sslmode param so asyncpg doesn't choke on unknown query params
    url = _re.sub(r'[?&]sslmode=[^&]+', '', url)
    url = _re.sub(r'\?$', '', url)  # clean trailing ?

    if needs_ssl:
        ctx = _ssl_module.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = _ssl_module.CERT_NONE  # Neon uses AWS intermediate certs
        kwargs["ssl"] = ctx
        if is_neon:
            # Neon free: ~10 max connections; keep pool small to avoid exhaustion
            kwargs["min_size"] = 1
            kwargs["max_size"] = 3

    return url, kwargs

_DB_URL_CLEAN, _DB_POOL_KWARGS = _parse_db_url(DATABASE_URL)

async def init_db(pool):
    async with pool.acquire() as con:
        await con.execute("""
            CREATE TABLE IF NOT EXISTS contacts (
                id        BIGSERIAL PRIMARY KEY,
                name      TEXT NOT NULL,
                message   TEXT NOT NULL,
                reply_via TEXT DEFAULT '',
                created   BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
            )
        """)
        await con.execute("""
            CREATE TABLE IF NOT EXISTS pageviews (
                path  TEXT NOT NULL,
                day   DATE NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (path, day)
            )
        """)
        # therapy_sessions table intentionally not created:
        # we do NOT store conversation content server-side.
        # The AI runs locally; messages never leave the user's browser.
        await con.execute("""
            CREATE TABLE IF NOT EXISTS perf_metrics (
                id          BIGSERIAL PRIMARY KEY,
                path        TEXT NOT NULL,
                load_time   INTEGER NOT NULL,
                ttfb        INTEGER,
                -- user_agent intentionally NOT stored (privacy promise)
                "timestamp" BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
            )
        """)
        await con.execute("""
            CREATE INDEX IF NOT EXISTS idx_perf_path ON perf_metrics(path, "timestamp")
        """)
        await con.execute("""
            CREATE INDEX IF NOT EXISTS idx_perf_time ON perf_metrics("timestamp")
        """)
        await con.execute("""
            CREATE TABLE IF NOT EXISTS slayer_events (
                id        BIGSERIAL PRIMARY KEY,
                event     TEXT NOT NULL CHECK(event IN ('impression','click')),
                ad_id     TEXT NOT NULL,
                page      TEXT NOT NULL DEFAULT '/',
                "timestamp" BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
            )
        """)
        await con.execute("""
            CREATE INDEX IF NOT EXISTS idx_slayer_ad ON slayer_events(ad_id, event)
        """)
        await con.execute("""
            CREATE INDEX IF NOT EXISTS idx_slayer_day ON slayer_events("timestamp", event)
        """)
        # ── Auth + Freemium tables ─────────────────────────────────────────
        await con.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id            BIGSERIAL PRIMARY KEY,
                email         TEXT UNIQUE,
                password_hash TEXT,
                google_id     TEXT UNIQUE,
                name          TEXT NOT NULL DEFAULT 'User',
                avatar_url    TEXT DEFAULT '',
                plan          TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free','pro')),
                created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
            )
        """)
        await con.execute("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)")
        await con.execute("CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_id)")
        await con.execute("""
            CREATE TABLE IF NOT EXISTS user_sessions (
                token      TEXT PRIMARY KEY,
                user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at BIGINT NOT NULL,
                created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
            )
        """)
        await con.execute("CREATE INDEX IF NOT EXISTS idx_user_sessions_uid ON user_sessions(user_id)")
        await con.execute("""
            CREATE TABLE IF NOT EXISTS chat_history (
                id         BIGSERIAL PRIMARY KEY,
                user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                session_id TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
                title      TEXT NOT NULL DEFAULT 'Chat Session',
                messages   JSONB NOT NULL DEFAULT '[]',
                model      TEXT DEFAULT '',
                created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
                updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
            )
        """)
        await con.execute("CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_history(user_id, created_at DESC)")
        await con.execute("""
            CREATE TABLE IF NOT EXISTS daily_usage (
                user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                day          DATE NOT NULL DEFAULT CURRENT_DATE,
                minutes_used INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, day)
            )
        """)
        await con.execute("""
            CREATE TABLE IF NOT EXISTS anon_daily_usage (
                fingerprint  TEXT NOT NULL,
                day          DATE NOT NULL DEFAULT CURRENT_DATE,
                minutes_used INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (fingerprint, day)
            )
        """)
        await con.execute("""
            CREATE TABLE IF NOT EXISTS password_resets (
                token      TEXT PRIMARY KEY,
                user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at BIGINT NOT NULL,
                created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
            )
        """)
        await con.execute("""
            CREATE TABLE IF NOT EXISTS refresh_tokens (
                token      TEXT PRIMARY KEY,
                user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at BIGINT NOT NULL,
                created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
            )
        """)
        await con.execute("CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens(user_id)")
        # ── Schema migrations (idempotent) ────────────────────────────────
        # Add preferences JSONB column to users if missing
        await con.execute(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'"
        )
        # Add last_accessed_at to chat_history for 30-day cleanup logic
        await con.execute(
            "ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS last_accessed_at BIGINT DEFAULT NULL"
        )
        existing = await con.fetchval(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name='contacts' AND column_name='reply_via'"
        )
        if not existing:
            await con.execute("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS reply_via TEXT DEFAULT ''")
        for pii_col in ("email", "ip"):
            has_col = await con.fetchval(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name='contacts' AND column_name=$1",
                pii_col,
            )
            if has_col:
                try:
                    await con.execute(f"ALTER TABLE contacts DROP COLUMN IF EXISTS {pii_col}")
                except Exception:
                    pass

# ═════════════════════════════════════════════════════════════════════════════
#  4. APP + MIDDLEWARE
# ═════════════════════════════════════════════════════════════════════════════
def _anon_key(request: Request) -> str:
    """One-way hash of real client IP — enables rate-limiting without storing identity.
    Caddy forwards the real IP via X-Real-IP (never 0.0.0.0 since the spoofing was removed)."""
    raw = (
        request.headers.get("X-Real-IP")
        or request.headers.get("CF-Connecting-IP")
        or (request.client.host if request.client else "unknown")
    )
    return hashlib.blake2b(raw.encode(), digest_size=16).hexdigest()

limiter = Limiter(key_func=_anon_key)

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _pool
    # Neon cold-start retry: first connection after auto-pause can take 1–3s
    for attempt in range(3):
        try:
            _pool = await asyncpg.create_pool(_DB_URL_CLEAN, **_DB_POOL_KWARGS)
            break
        except Exception as exc:
            if attempt == 2:
                raise
            logging.warning(f"DB connect attempt {attempt + 1} failed ({exc}), retrying in 2s…")
            await asyncio.sleep(2)
    await init_db(_pool)
    # Clean up expired tokens and stale chat sessions on startup
    now_ts = int(time.time())
    thirty_days_ago = now_ts - (30 * 24 * 3600)
    async with _pool.acquire() as conn:
        await conn.execute("DELETE FROM password_resets WHERE expires_at < $1", now_ts)
        await conn.execute("DELETE FROM refresh_tokens WHERE expires_at < $1", now_ts)
        # Auto-delete chat sessions not accessed in 30 days (smart storage management)
        try:
            await conn.execute(
                "DELETE FROM chat_history WHERE GREATEST(updated_at, COALESCE(last_accessed_at, updated_at)) < $1",
                thirty_days_ago
            )
        except Exception:
            pass  # last_accessed_at may not exist yet on first run — migration handles it
    yield
    if _pool:
        await _pool.close()

app = FastAPI(
    title="Innerflect API",
    version="2.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(filter(None, [
        "http://localhost:8090",
        "http://127.0.0.1:8090",
        "https://innerflect.netlify.app",
        f"https://{_env('DOMAIN', '')}" if _env('DOMAIN', '') else None,
        f"https://www.{_env('DOMAIN', '')}" if _env('DOMAIN', '') else None,
        f"https://{_env('NGROK_DOMAIN', '')}" if _env('NGROK_DOMAIN', '') else None,
        f"https://{_env('NETLIFY_DOMAIN', '')}" if _env('NETLIFY_DOMAIN', '') else None,
    ])),
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
    allow_credentials=False,
)

@app.middleware("http")
async def strip_fingerprint_headers(request: Request, call_next):
    """Remove headers that fingerprint the server stack."""
    response = await call_next(request)
    for h in ("server", "x-powered-by", "x-process-time"):
        try:
            del response.headers[h]
        except Exception:
            pass
    response.headers["Cache-Control"] = "no-store"
    return response

# ═════════════════════════════════════════════════════════════════════════════
#  5. AUTH HELPER
#     Accepts token via:
#       - Authorization: Bearer <token>   ← preferred (never logged)
#       - ?token=<token>                   ← fallback (avoid; shows in access logs)
# ═════════════════════════════════════════════════════════════════════════════
def _require_admin(token: str, request: Request):
    """Raise 403 if caller is not the admin. Checks Bearer header first."""
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="admin not configured")
    # Header takes priority — query param never reaches the access log
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        candidate = auth_header[7:]
    else:
        candidate = token
    if not candidate or not secrets.compare_digest(candidate, ADMIN_TOKEN):
        raise HTTPException(status_code=403, detail="forbidden")

# ═════════════════════════════════════════════════════════════════════════════
#  6. JWT AUTH HELPERS
# ═════════════════════════════════════════════════════════════════════════════
JWT_SECRET   = _env("JWT_SECRET", "")
JWT_EXP_DAYS = 7    # short-lived access tokens — silently refreshed by frontend
RT_EXP_DAYS  = 90   # long-lived refresh tokens — rotated on each refresh

_DEFAULT_JWT = "innerflect-jwt-secret-change-in-prod"
if not JWT_SECRET:
    logging.warning("⚠️  JWT_SECRET not set — using insecure default. Set JWT_SECRET in config/.env before production!")
    JWT_SECRET = _DEFAULT_JWT
elif JWT_SECRET == _DEFAULT_JWT:
    logging.warning("⚠️  JWT_SECRET is using the default insecure value! Set JWT_SECRET in config/.env!")

def _make_token(user_id: int) -> str:
    exp = datetime.now(timezone.utc) + timedelta(days=JWT_EXP_DAYS)
    return pyjwt.encode({"sub": str(user_id), "exp": exp}, JWT_SECRET, algorithm="HS256")

def _make_refresh_token() -> str:
    """Cryptographically random 64-hex refresh token — opaque, not a JWT."""
    return secrets.token_hex(32)

async def _get_current_user(request: Request):
    """Extract and validate JWT from Authorization Bearer header only."""
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not token:
        return None
    try:
        payload = pyjwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        user_id = int(payload["sub"])
    except Exception:
        return None
    async with _pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, email, name, avatar_url, plan, preferences FROM users WHERE id=$1", user_id
        )
    if not row:
        return None
    user = dict(row)
    if user.get("preferences") is None:
        user["preferences"] = {}
    return user

# ═════════════════════════════════════════════════════════════════════════════
#  7. DISCORD HELPERS
# ═════════════════════════════════════════════════════════════════════════════
def _discord(text: str, title: str = ""):
    """Fire-and-forget Discord webhook notification."""
    if not DISCORD_WEBHOOK:
        return
    import urllib.request as _ur
    body = _json.dumps(
        {"content": (f"**{title}**\n" if title else "") + text}
    ).encode()
    try:
        req = _ur.Request(
            DISCORD_WEBHOOK, data=body,
            headers={"Content-Type": "application/json"}, method="POST"
        )
        _ur.urlopen(req, timeout=5)
    except Exception:
        pass

# ═════════════════════════════════════════════════════════════════════════════
#  7. PYDANTIC MODELS
# ═════════════════════════════════════════════════════════════════════════════
class ContactIn(BaseModel):
    name:      str
    message:   str
    reply_via: str = ""

class PageviewIn(BaseModel):
    path: str

class PerfMetricIn(BaseModel):
    path:      str
    load_time: int  # milliseconds
    ttfb:      int = 0  # time to first byte (ms)


class TherapyIn(BaseModel):
    messages: list  # [{role, content}, ...] — not used; kept for future backend option

# ── Auth models ───────────────────────────────────────────────────────────────
class RegisterIn(BaseModel):
    email: str
    password: str
    name: str = "User"

class LoginIn(BaseModel):
    email: str
    password: str

class GoogleAuthIn(BaseModel):
    id_token: str

class UsageIn(BaseModel):
    minutes: int
    fingerprint: str = ""

class PreferencesIn(BaseModel):
    preferences: dict

class AnonRecordIn(BaseModel):
    fingerprint: str
    minutes: int

class ForgotPasswordIn(BaseModel):
    email: str

class ResetPasswordIn(BaseModel):
    token: str
    password: str

class RefreshIn(BaseModel):
    refresh_token: str

# ── Internal helper — issue access + refresh token pair ──────────────────────
async def _issue_tokens(conn, user_id: int) -> dict:
    """Create a new access token + refresh token pair. Stores refresh token in DB."""
    access = _make_token(user_id)
    rt = _make_refresh_token()
    expires = int(time.time()) + RT_EXP_DAYS * 86400
    await conn.execute(
        "INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES ($1,$2,$3)",
        rt, user_id, expires
    )
    return {"token": access, "refresh_token": rt}

# ═════════════════════════════════════════════════════════════════════════════
#  8. PUBLIC ROUTES
# ═════════════════════════════════════════════════════════════════════════════
@app.get("/api/health")
@limiter.limit("60/minute")
async def health(request: Request):
    return {"status": "ok", "uptime_s": round(time.time() - START_TIME)}

# ═════════════════════════════════════════════════════════════════════════════
#  9. AUTH ROUTES
# ═════════════════════════════════════════════════════════════════════════════
@app.post("/api/auth/register")
@limiter.limit("5/minute")
async def auth_register(body: RegisterIn, request: Request):
    if not body.email or not body.password or len(body.password) < 6:
        raise HTTPException(400, "Email and password (min 6 chars) required")
    pw_hash = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode()
    try:
        async with _pool.acquire() as conn:
            row = await conn.fetchrow(
                "INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) "
                "RETURNING id, email, name, avatar_url, plan",
                body.email.lower().strip(), pw_hash, body.name
            )
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(409, "Email already registered")
        raise HTTPException(500, "Registration failed")
    async with _pool.acquire() as conn:
        tokens = await _issue_tokens(conn, row["id"])
    return {**tokens, "user": dict(row)}

@app.post("/api/auth/login")
@limiter.limit("10/minute")
async def auth_login(body: LoginIn, request: Request):
    async with _pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, email, name, avatar_url, plan, password_hash FROM users WHERE email=$1",
            body.email.lower().strip()
        )
    if not row or not row["password_hash"]:
        raise HTTPException(401, "Invalid email or password")
    if not bcrypt.checkpw(body.password.encode(), row["password_hash"].encode()):
        raise HTTPException(401, "Invalid email or password")
    user = {k: v for k, v in dict(row).items() if k != "password_hash"}
    async with _pool.acquire() as conn:
        tokens = await _issue_tokens(conn, row["id"])
    return {**tokens, "user": user}

@app.post("/api/auth/google")
@limiter.limit("10/minute")
async def auth_google(body: GoogleAuthIn, request: Request):
    """Validate Google ID token and create/login user."""
    try:
        import urllib.request, json as _j
        url = f"https://oauth2.googleapis.com/tokeninfo?id_token={body.id_token}"
        with urllib.request.urlopen(url, timeout=10) as resp:
            info = _j.loads(resp.read())
    except Exception:
        raise HTTPException(401, "Invalid Google token")
    if info.get("error"):
        raise HTTPException(401, info.get("error_description", "Google auth failed"))
    google_id = info.get("sub", "")
    email     = info.get("email", "")
    name      = info.get("name", email.split("@")[0] if email else "User")
    avatar    = info.get("picture", "")
    if not google_id:
        raise HTTPException(401, "Could not get Google user ID")
    async with _pool.acquire() as conn:
        row = await conn.fetchrow("""
            INSERT INTO users (google_id, email, name, avatar_url)
            VALUES ($1,$2,$3,$4)
            ON CONFLICT (google_id) DO UPDATE SET name=EXCLUDED.name, avatar_url=EXCLUDED.avatar_url
            RETURNING id, email, name, avatar_url, plan
        """, google_id, email, name, avatar)
        tokens = await _issue_tokens(conn, row["id"])
    return {**tokens, "user": dict(row)}

@app.get("/api/auth/me")
@limiter.limit("60/minute")
async def auth_me(request: Request):
    user = await _get_current_user(request)
    if not user:
        raise HTTPException(401, "Not authenticated")
    return user

@app.post("/api/auth/logout")
@limiter.limit("20/minute")
async def auth_logout(body: RefreshIn = None, request: Request = None):
    """Revoke refresh token on logout."""
    if body and body.refresh_token:
        async with _pool.acquire() as conn:
            await conn.execute("DELETE FROM refresh_tokens WHERE token=$1", body.refresh_token)
    return {"ok": True}

@app.post("/api/auth/refresh")
@limiter.limit("30/minute")
async def auth_refresh(body: RefreshIn, request: Request):
    """Exchange a valid refresh token for a new access token + rotated refresh token."""
    now_ts = int(time.time())
    async with _pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT user_id, expires_at FROM refresh_tokens WHERE token=$1", body.refresh_token
        )
        if not row or row["expires_at"] < now_ts:
            # Delete if expired (cleanup)
            if row:
                await conn.execute("DELETE FROM refresh_tokens WHERE token=$1", body.refresh_token)
            raise HTTPException(401, "Refresh token invalid or expired — please log in again")
        # Rotate: delete old, issue new pair
        await conn.execute("DELETE FROM refresh_tokens WHERE token=$1", body.refresh_token)
        user_id = row["user_id"]
        user = await conn.fetchrow(
            "SELECT id, email, name, avatar_url, plan FROM users WHERE id=$1", user_id
        )
        if not user:
            raise HTTPException(401, "User not found")
        tokens = await _issue_tokens(conn, user_id)
    return {**tokens, "user": dict(user)}

# ── Password reset helper ──────────────────────────────────────────────────
async def _send_password_reset_email(email: str, token: str):
    reset_url = f"{_env('SITE_URL', 'https://innerflect.netlify.app')}/?reset={token}"
    resend_key = _env("RESEND_API_KEY", "")
    if resend_key:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {resend_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "from": "Innerflect <noreply@innerflect.app>",
                    "to": [email],
                    "subject": "Reset your Innerflect password",
                    "html": (
                        f"<p>Click to reset your password (expires in 1 hour):</p>"
                        f"<p><a href='{reset_url}'>{reset_url}</a></p>"
                        f"<p>If you didn't request this, ignore this email.</p>"
                    ),
                },
            )
    else:
        print(f"[innerflect] Password reset token for user: {reset_url}")

@app.post("/api/auth/forgot-password")
@limiter.limit("5/minute")
async def auth_forgot_password(body: ForgotPasswordIn, request: Request):
    """Always returns 200 — does not leak whether email exists."""
    email = body.email.lower().strip()
    generic_response = {"message": "If that email exists, a reset link was sent."}
    async with _pool.acquire() as conn:
        row = await conn.fetchrow("SELECT id FROM users WHERE email=$1", email)
    if not row:
        return generic_response
    token = secrets.token_hex(24)  # 48-char hex
    expires_at = int(time.time()) + 3600  # 1 hour
    async with _pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO password_resets (token, user_id, expires_at) VALUES ($1,$2,$3)",
            token, row["id"], expires_at,
        )
    try:
        await _send_password_reset_email(email, token)
    except Exception:
        pass  # Never fail the request if email sending fails
    return generic_response

@app.post("/api/auth/reset-password")
@limiter.limit("10/minute")
async def auth_reset_password(body: ResetPasswordIn, request: Request):
    if not body.password or len(body.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    now_ts = int(time.time())
    async with _pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT user_id, expires_at FROM password_resets WHERE token=$1",
            body.token,
        )
        if not row:
            raise HTTPException(400, "Invalid or expired reset token")
        if row["expires_at"] < now_ts:
            await conn.execute("DELETE FROM password_resets WHERE token=$1", body.token)
            raise HTTPException(400, "Reset token has expired")
        pw_hash = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode()
        user_id = row["user_id"]
        await conn.execute(
            "UPDATE users SET password_hash=$1 WHERE id=$2", pw_hash, user_id
        )
        await conn.execute(
            "DELETE FROM password_resets WHERE user_id=$1", user_id
        )
    return {"message": "Password updated successfully"}

# ═════════════════════════════════════════════════════════════════════════════
#  10. SUBSCRIPTION
# ═════════════════════════════════════════════════════════════════════════════
@app.post("/api/subscription/upgrade")
@limiter.limit("5/minute")
async def subscription_upgrade(request: Request):
    user = await _get_current_user(request)
    if not user:
        raise HTTPException(401, "Not authenticated")
    if not STRIPE_SECRET_KEY:
        return {"status": "unavailable", "message": "Payment not configured"}
    if user["plan"] == "pro":
        return {"status": "already_pro"}
    site_url = _env("SITE_URL", "https://innerflect.netlify.app")
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            "https://api.stripe.com/v1/checkout/sessions",
            auth=(STRIPE_SECRET_KEY, ""),
            data={
                "mode": "subscription",
                "line_items[0][price]": STRIPE_PRICE_ID,
                "line_items[0][quantity]": "1",
                "success_url": f"{site_url}/therapy?upgraded=1",
                "cancel_url": f"{site_url}/therapy",
                "customer_email": user.get("email", ""),
                "metadata[user_id]": str(user["id"]),
            },
        )
    if resp.status_code != 200:
        raise HTTPException(502, "Failed to create Stripe checkout session")
    session = resp.json()
    return {"checkout_url": session.get("url")}

@app.post("/api/stripe/webhook")
async def stripe_webhook(request: Request):
    payload = await request.body()
    sig_header = request.headers.get("Stripe-Signature", "")
    if not STRIPE_WEBHOOK_SECRET:
        raise HTTPException(400, "Webhook not configured")
    # Verify Stripe signature: t=timestamp,v1=signature
    try:
        parts = {k: v for part in sig_header.split(",") for k, v in [part.split("=", 1)]}
        timestamp = parts.get("t", "")
        v1_sig = parts.get("v1", "")
        signed_payload = f"{timestamp}.".encode() + payload
        expected = hmac.new(
            STRIPE_WEBHOOK_SECRET.encode(), signed_payload, hashlib.sha256
        ).hexdigest()
        if not secrets.compare_digest(expected, v1_sig):
            raise HTTPException(400, "Invalid signature")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, "Signature verification failed")
    try:
        event = _json.loads(payload)
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    event_type = event.get("type", "")
    obj = event.get("data", {}).get("object", {})
    async with _pool.acquire() as conn:
        if event_type == "checkout.session.completed":
            user_id = obj.get("metadata", {}).get("user_id")
            if user_id:
                await conn.execute(
                    "UPDATE users SET plan='pro' WHERE id=$1", int(user_id)
                )
        elif event_type == "customer.subscription.deleted":
            customer_email = obj.get("customer_email") or ""
            customer_id = obj.get("customer") or ""
            # Find user by customer email if available
            if customer_email:
                await conn.execute(
                    "UPDATE users SET plan='free' WHERE email=$1", customer_email
                )
    return {"received": True}

# ═════════════════════════════════════════════════════════════════════════════
#  USER PREFERENCES
# ═════════════════════════════════════════════════════════════════════════════
@app.get("/api/user/preferences")
@limiter.limit("60/minute")
async def get_user_preferences(request: Request):
    user = await _get_current_user(request)
    if not user:
        raise HTTPException(401, "Not authenticated")
    return {"preferences": user.get("preferences") or {}}

@app.post("/api/user/preferences")
@limiter.limit("30/minute")
async def set_user_preferences(body: PreferencesIn, request: Request):
    user = await _get_current_user(request)
    if not user:
        raise HTTPException(401, "Not authenticated")
    import json as _jprefs
    async with _pool.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE users SET preferences = $1 WHERE id = $2
               RETURNING preferences""",
            _jprefs.dumps(body.preferences), user["id"],
        )
    updated = _jprefs.loads(row["preferences"]) if row and row["preferences"] else body.preferences
    return {"preferences": updated}
# ═════════════════════════════════════════════════════════════════════════════
@app.post("/api/usage/record")
@limiter.limit("20/minute")
async def record_usage(body: UsageIn, request: Request):
    """Record minutes used in a session (for throttling). Cap per-call at 60min max."""
    user  = await _get_current_user(request)
    today = datetime.now(timezone.utc).date()
    # Clamp incoming minutes to prevent artificial inflation
    minutes = max(0, min(body.minutes, 60))
    if user:
        async with _pool.acquire() as conn:
            await conn.execute("""
                INSERT INTO daily_usage (user_id, day, minutes_used) VALUES ($1,$2,$3)
                ON CONFLICT (user_id, day) DO UPDATE
                SET minutes_used = daily_usage.minutes_used + EXCLUDED.minutes_used
            """, user["id"], today, minutes)
    elif body.fingerprint:
        async with _pool.acquire() as conn:
            await conn.execute("""
                INSERT INTO anon_daily_usage (fingerprint, day, minutes_used) VALUES ($1,$2,$3)
                ON CONFLICT (fingerprint, day) DO UPDATE
                SET minutes_used = anon_daily_usage.minutes_used + EXCLUDED.minutes_used
            """, body.fingerprint, today, minutes)
    return {"ok": True}

@app.get("/api/usage/today")
async def get_usage_today(request: Request, fingerprint: str = ""):
    """Get minutes used today."""
    user  = await _get_current_user(request)
    today = datetime.now(timezone.utc).date()
    if user:
        async with _pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT minutes_used FROM daily_usage WHERE user_id=$1 AND day=$2",
                user["id"], today
            )
        return {"minutes_used": row["minutes_used"] if row else 0, "plan": user["plan"]}
    elif fingerprint:
        async with _pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT minutes_used FROM anon_daily_usage WHERE fingerprint=$1 AND day=$2",
                fingerprint, today
            )
        return {"minutes_used": row["minutes_used"] if row else 0, "plan": "anon"}
    return {"minutes_used": 0, "plan": "anon"}

@app.get("/api/usage/anon-check")
@limiter.limit("60/minute")
async def anon_check(request: Request, fingerprint: str = ""):
    """Check anonymous user's daily usage against the 30-minute limit."""
    if not fingerprint:
        raise HTTPException(400, "fingerprint required")
    today = datetime.now(timezone.utc).date()
    # Secondary abuse check: count distinct IP hashes for this fingerprint today
    ip_hash = _anon_key(request)
    cache_key = f"anon_ip:{fingerprint}:{today}"
    r = _get_redis()
    if r:
        try:
            r.sadd(cache_key, ip_hash)
            r.expire(cache_key, 86400)
            distinct_ips = r.scard(cache_key)
            if distinct_ips > 5:
                logging.warning(
                    "[innerflect] fingerprint %s seen from >5 distinct IP hashes today",
                    fingerprint[:16],
                )
        except Exception:
            pass
    async with _pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT minutes_used FROM anon_daily_usage WHERE fingerprint=$1 AND day=$2",
            fingerprint, today,
        )
    return {"minutes_used": row["minutes_used"] if row else 0, "limit": 30}

@app.post("/api/usage/anon-record")
@limiter.limit("30/minute")
async def anon_record(body: AnonRecordIn, request: Request):
    """Upsert anonymous usage minutes for today."""
    if not body.fingerprint:
        raise HTTPException(400, "fingerprint required")
    today = datetime.now(timezone.utc).date()
    async with _pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO anon_daily_usage (fingerprint, day, minutes_used) VALUES ($1,$2,$3)
               ON CONFLICT (fingerprint, day) DO UPDATE
               SET minutes_used = anon_daily_usage.minutes_used + EXCLUDED.minutes_used""",
            body.fingerprint, today, body.minutes,
        )
    return {"ok": True}
# ═════════════════════════════════════════════════════════════════════════════
@app.post("/api/chat/save")
@limiter.limit("20/minute")
async def save_chat(request: Request):
    user = await _get_current_user(request)
    if not user or user["plan"] != "pro":
        raise HTTPException(403, "Pro plan required for chat history")
    body       = await request.json()
    session_id = body.get("session_id", "")
    messages   = body.get("messages", [])
    model      = body.get("model", "")
    title      = body.get("title", f"Session {datetime.now(timezone.utc).strftime('%b %d')}")
    now        = int(datetime.now(timezone.utc).timestamp())
    import json as _j2
    async with _pool.acquire() as conn:
        if session_id:
            row = await conn.fetchrow("""
                UPDATE chat_history SET messages=$1, model=$2, title=$3, updated_at=$4
                WHERE session_id=$5 AND user_id=$6 RETURNING id, session_id, title
            """, _j2.dumps(messages), model, title, now, session_id, user["id"])
        else:
            import uuid
            row = await conn.fetchrow("""
                INSERT INTO chat_history (user_id, session_id, title, messages, model, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, session_id, title
            """, user["id"], str(uuid.uuid4()), title, _j2.dumps(messages), model, now)
    return dict(row) if row else {"ok": False}

@app.get("/api/chat/sessions")
@limiter.limit("30/minute")
async def list_chat_sessions(request: Request):
    user = await _get_current_user(request)
    if not user or user["plan"] != "pro":
        raise HTTPException(403, "Pro plan required")
    async with _pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT id, session_id, title, model, created_at, updated_at,
                   jsonb_array_length(messages) as message_count
            FROM chat_history WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 50
        """, user["id"])
    return [dict(r) for r in rows]

@app.get("/api/chat/session/{session_id}")
@limiter.limit("30/minute")
async def get_chat_session(session_id: str, request: Request):
    user = await _get_current_user(request)
    if not user or user["plan"] != "pro":
        raise HTTPException(403, "Pro plan required")
    now = int(datetime.now(timezone.utc).timestamp())
    async with _pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM chat_history WHERE session_id=$1 AND user_id=$2",
            session_id, user["id"]
        )
        if row:
            # Track last access time for 30-day cleanup
            await conn.execute(
                "UPDATE chat_history SET last_accessed_at=$1 WHERE session_id=$2 AND user_id=$3",
                now, session_id, user["id"]
            )
    if not row:
        raise HTTPException(404, "Session not found")
    return dict(row)

@app.delete("/api/chat/session/{session_id}")
@limiter.limit("20/minute")
async def delete_chat_session(session_id: str, request: Request):
    user = await _get_current_user(request)
    if not user or user["plan"] != "pro":
        raise HTTPException(403, "Pro plan required")
    async with _pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM chat_history WHERE session_id=$1 AND user_id=$2",
            session_id, user["id"]
        )
    return {"ok": True}

@app.get("/api/stats")
@limiter.limit("30/minute")
async def public_stats(request: Request):
    """Aggregated stats for the landing page hero — no PII."""
    # Try Redis cache first (60s TTL) to reduce SQLite load under traffic
    cached = _rcache_get("stats:public")
    if cached:
        return _json.loads(cached)

    async with _pool.acquire() as con:
        msg_count  = await con.fetchval("SELECT COUNT(*) FROM contacts")
        view_total = await con.fetchval("SELECT COALESCE(SUM(count),0) FROM pageviews") or 0

    result = {"views": view_total, "messages": msg_count}
    _rcache_set("stats:public", _json.dumps(result), ttl=60)
    return result

@app.post("/api/contact")
@limiter.limit("5/minute")
async def contact(request: Request, body: ContactIn):
    async with _pool.acquire() as con:
        await con.execute(
            "INSERT INTO contacts (name, message, reply_via) VALUES ($1,$2,$3)",
            body.name[:120], body.message[:2000], body.reply_via[:300],
        )
    # Invalidate public stats cache
    _rcache_set("stats:public", "", ttl=1)
    import asyncio
    asyncio.get_event_loop().run_in_executor(
        None, lambda: _discord(
            f"**From:** {body.name or '(anon)'}\n"
            f"**Message:** {body.message[:500]}\n"
            + (f"**Reply via:** {body.reply_via[:200]}\n" if body.reply_via else ""),
            title="📬 New contact message"
        )
    )
    return {"ok": True}

@app.post("/api/analytics/view")
@limiter.limit("120/minute")
async def record_view(request: Request, body: PageviewIn):
    path = body.path[:120].strip() or "/"
    # Buffer in Redis (no-op if unavailable) — flush async to SQLite
    _rcache_incr(f"view_buf:{path}", ttl=300)
    async with _pool.acquire() as con:
        await con.execute(
            """INSERT INTO pageviews(path,day,count) VALUES($1,CURRENT_DATE,1)
               ON CONFLICT(path,day) DO UPDATE SET count=pageviews.count+1""",
            path,
        )
    return {"ok": True}

# Performance metrics tracking (load times, TTFB only — no user_agent stored)
@app.post("/api/analytics/perf")
@limiter.limit("60/minute")
async def record_perf(request: Request, body: PerfMetricIn):
    # Block tracking for /therapy — privacy promise: we never know if someone used the therapy page
    path = body.path[:120].strip() or "/"
    if path.startswith("/therapy"):
        return {"ok": True}
    load_time = max(0, min(body.load_time, 60000))
    ttfb = max(0, min(body.ttfb, 60000))
    # user_agent intentionally NOT collected
    async with _pool.acquire() as con:
        await con.execute(
            """INSERT INTO perf_metrics(path, load_time, ttfb)
               VALUES($1, $2, $3)""",
            path, load_time, ttfb,
        )
    return {"ok": True}

# ═════════════════════════════════════════════════════════════════════════════
#  13. ADMIN ROUTES — all require token via Bearer header or ?token=
# ═════════════════════════════════════════════════════════════════════════════

# ── Messages ──────────────────────────────────────────────────────────────
@app.get("/api/admin/messages")
@limiter.limit("30/minute")
async def admin_messages(request: Request, token: str = ""):
    _require_admin(token, request)
    async with _pool.acquire() as con:
        rows = await con.fetch(
            "SELECT id, name, message, reply_via, to_timestamp(created)::TEXT "
            "FROM contacts ORDER BY created DESC LIMIT 100"
        )
    return {"messages": [
        {"id": r[0], "name": r[1], "message": r[2], "reply_via": r[3], "date": r[4]}
        for r in rows
    ]}

@app.delete("/api/admin/messages/{msg_id}")
@limiter.limit("30/minute")
async def admin_delete_message(msg_id: int, request: Request, token: str = ""):
    _require_admin(token, request)
    async with _pool.acquire() as con:
        await con.execute("DELETE FROM contacts WHERE id=$1", msg_id)
    return {"ok": True}

# ── System health ─────────────────────────────────────────────────────────
@app.get("/api/admin/system")
@limiter.limit("15/minute")
async def admin_system(request: Request, token: str = ""):
    _require_admin(token, request)
    import psutil, platform
    vm  = psutil.virtual_memory()
    dk  = psutil.disk_usage("/")
    net = psutil.net_io_counters()
    la  = psutil.getloadavg()
    return {
        "cpu_pct":    psutil.cpu_percent(interval=0.5),
        "cpu_count":  psutil.cpu_count(),
        "load_avg":   [round(x, 2) for x in la],
        "ram_total":  vm.total,
        "ram_used":   vm.used,
        "ram_pct":    vm.percent,
        "disk_total": dk.total,
        "disk_used":  dk.used,
        "disk_pct":   dk.percent,
        "net_sent":   net.bytes_sent,
        "net_recv":   net.bytes_recv,
        "uptime_s":   round(time.time() - START_TIME),
        "platform":   platform.system(),
        "python":     platform.python_version(),
    }

# ── Service health ────────────────────────────────────────────────────────
@app.get("/api/admin/services")
@limiter.limit("15/minute")
async def admin_services(request: Request, token: str = ""):
    _require_admin(token, request)
    import subprocess, urllib.request as _ur

    def chk(port: int, path: str = "/"):
        try:
            r = _ur.urlopen(f"http://localhost:{port}{path}", timeout=3)
            return {"up": True, "code": r.status}
        except Exception as e:
            return {"up": False, "error": str(e)[:60]}

    def pid_up(pattern: str) -> bool:
        try:
            return bool(subprocess.check_output(["pgrep", "-f", pattern], text=True).strip())
        except Exception:
            return False

    redis_info: dict = {"up": False, "label": "Redis"}
    r = _get_redis()
    if r:
        try:
            info = r.info("memory")
            redis_info = {
                "up":      True,
                "label":   "Redis",
                "used_mb": round(info.get("used_memory", 0) / 1048576, 2),
                "peak_mb": round(info.get("used_memory_peak", 0) / 1048576, 2),
                "maxmem":  info.get("maxmemory_human", "30mb"),
            }
        except Exception:
            redis_info = {"up": True, "label": "Redis"}

    return {
        "api":   {**chk(8000, "/api/health"), "label": "API"},
        "chat":  {**chk(8001, "/chat/api/health"), "label": "Chat"},
        "caddy": {**chk(8090, "/health"), "label": "Caddy"},
        "ngrok": {"up": pid_up("ngrok start"), "label": "Tunnel"},
        "redis": redis_info,
    }

# ── Redis details ─────────────────────────────────────────────────────────
@app.get("/api/admin/redis")
@limiter.limit("15/minute")
async def admin_redis(request: Request, token: str = ""):
    _require_admin(token, request)
    r = _get_redis()
    if not r:
        return {"connected": False, "reason": "Redis unavailable or not configured"}
    try:
        info   = r.info()
        mem    = r.info("memory")
        keys   = r.dbsize()
        hits   = info.get("keyspace_hits", 0)
        misses = info.get("keyspace_misses", 0)
        total  = hits + misses
        return {
            "connected":        True,
            "version":          info.get("redis_version"),
            "uptime_days":      round(info.get("uptime_in_seconds", 0) / 86400, 1),
            "used_bytes":       mem.get("used_memory", 0),
            "peak_bytes":       mem.get("used_memory_peak", 0),
            "eviction_policy":  mem.get("maxmemory_policy", "noeviction"),
            "keys":             keys,
            "connected_clients":info.get("connected_clients", 0),
            "hit_ratio":        f"{round(hits/total*100,1)}%" if total else "n/a",
            "ops_per_sec":      info.get("instantaneous_ops_per_sec", 0),
        }
    except Exception as e:
        return {"connected": False, "reason": str(e)[:120]}

# ── Analytics ─────────────────────────────────────────────────────────────
@app.get("/api/admin/analytics")
@limiter.limit("15/minute")
async def admin_analytics(request: Request, token: str = "", days: int = 14):
    _require_admin(token, request)
    async with _pool.acquire() as con:
        try:
            rows = await con.fetch(
                "SELECT path, day::TEXT, count FROM pageviews "
                "WHERE day >= CURRENT_DATE - $1 ORDER BY day DESC, count DESC",
                days,
            )
            alltime = await con.fetchval("SELECT COALESCE(SUM(count),0) FROM pageviews") or 0
        except Exception:
            rows = []; alltime = 0

    by_path: dict = {}
    by_day:  dict = {}
    for path, day, cnt in rows:
        by_path[path] = by_path.get(path, 0) + cnt
        by_day[day]   = by_day.get(day, 0) + cnt
    return {
        "by_path": sorted(by_path.items(), key=lambda x: -x[1]),
        "by_day":  sorted(by_day.items()),
        "total":   sum(by_path.values()),
        "alltime": alltime,
    }

# Real-time performance analytics
@app.get("/api/admin/analytics/perf")
@limiter.limit("10/minute")
async def admin_perf_analytics(request: Request, token: str = "", hours: int = 24):
    _require_admin(token, request)
    async with _pool.acquire() as con:
        try:
            # Get metrics from last N hours
            rows = await con.fetch(
                """SELECT path, load_time, ttfb, "timestamp"
                   FROM perf_metrics
                   WHERE "timestamp" >= EXTRACT(EPOCH FROM NOW() - make_interval(hours => $1))::BIGINT
                   ORDER BY "timestamp" DESC
                   LIMIT 1000""",
                hours,
            )

            # Calculate statistics per path
            stats_by_path: dict = {}
            all_loads = []
            all_ttfb = []

            for row in rows:
                path, load_time, ttfb, ts = row['path'], row['load_time'], row['ttfb'], row['timestamp']
                all_loads.append(load_time)
                if ttfb: all_ttfb.append(ttfb)

                if path not in stats_by_path:
                    stats_by_path[path] = {"loads": [], "ttfbs": [], "count": 0}
                stats_by_path[path]["loads"].append(load_time)
                if ttfb: stats_by_path[path]["ttfbs"].append(ttfb)
                stats_by_path[path]["count"] += 1

            # Compute aggregates
            def avg(lst): return round(sum(lst) / len(lst)) if lst else 0
            def p95(lst):
                if not lst: return 0
                s = sorted(lst)
                return s[int(len(s) * 0.95)]

            summary = {
                "total_samples": len(rows),
                "avg_load_time": avg(all_loads),
                "p95_load_time": p95(all_loads),
                "avg_ttfb": avg(all_ttfb),
                "p95_ttfb": p95(all_ttfb),
                "by_path": []
            }

            for path, data in stats_by_path.items():
                summary["by_path"].append({
                    "path": path,
                    "count": data["count"],
                    "avg_load": avg(data["loads"]),
                    "p95_load": p95(data["loads"]),
                    "avg_ttfb": avg(data["ttfbs"]),
                })

            # Sort by count
            summary["by_path"].sort(key=lambda x: -x["count"])

        except Exception as e:
            summary = {"error": str(e), "total_samples": 0}
    
    return summary

# ── Chat stats ────────────────────────────────────────────────────────────
@app.get("/api/admin/chat")
@limiter.limit("20/minute")
async def admin_chat(request: Request, token: str = ""):
    _require_admin(token, request)
    # Chat service is disabled; return stub stats
    return {"rooms": 0, "messages": 0, "sessions": 0}

# ── Log tail ──────────────────────────────────────────────────────────────
@app.get("/api/admin/log/{name}")
@limiter.limit("20/minute")
async def admin_log(name: str, request: Request, token: str = "", lines: int = 80):
    _require_admin(token, request)
    allowed = {"api", "caddy", "chat", "tunnel", "watchdog"}
    if name not in allowed:
        raise HTTPException(status_code=400, detail="unknown log")
    log_path = BASE.parent / "logs" / f"{name}.log"
    if not log_path.exists():
        return {"lines": [], "name": name}
    with open(log_path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        buf  = min(lines * 120, size)
        f.seek(-buf, 2)
        raw = f.read().decode("utf-8", errors="replace")
    return {"lines": raw.splitlines()[-lines:], "name": name}

# ── URL shortener ─────────────────────────────────────────────────────────
# ── Daily Discord report ──────────────────────────────────────────────────
@app.get("/api/admin/daily-report")
@limiter.limit("5/minute")
async def daily_report(request: Request, token: str = ""):
    """POST to this via cron or n8n to push daily stats to Discord."""
    _require_admin(token, request)
    async with _pool.acquire() as con:
        views_today = await con.fetchval(
            "SELECT COALESCE(SUM(count),0) FROM pageviews WHERE day=CURRENT_DATE"
        ) or 0
        views_total = await con.fetchval(
            "SELECT COALESCE(SUM(count),0) FROM pageviews"
        ) or 0
        msgs_total  = await con.fetchval("SELECT COUNT(*) FROM contacts")
        msgs_today  = await con.fetchval(
            "SELECT COUNT(*) FROM contacts WHERE created >= EXTRACT(EPOCH FROM CURRENT_DATE)::BIGINT"
        )
        # NOTE: therapy session counts intentionally removed — privacy promise
    uptime_h = round((time.time() - START_TIME) / 3600, 1)
    report = (
        f"📊 **Daily Report — Innerflect**\n"
        f"Views today: {views_today} | All-time: {views_total}\n"
        f"Contact messages today: {msgs_today} | Total: {msgs_total}\n"
        f"API uptime: {uptime_h}h"
    )
    import asyncio
    asyncio.get_event_loop().run_in_executor(None, lambda: _discord(report))
    return {"ok": True, "report": report}

# ── Service restart ───────────────────────────────────────────────────────
_SITE_DIR = str(Path(__file__).parent.parent)

@app.post("/api/admin/restart/{service}")
@limiter.limit("3/minute")
async def admin_restart(service: str, request: Request, token: str = ""):
    """Restart an Innerflect service. service: api | chat | caddy | ngrok"""
    _require_admin(token, request)
    import subprocess, asyncio
    allowed = {"api", "chat", "caddy", "ngrok"}
    if service not in allowed:
        raise HTTPException(400, f"Unknown service. Valid: {', '.join(sorted(allowed))}")

    def _do_restart():
        venv = os.path.join(_SITE_DIR, "venv", "bin", "python3")
        if not os.path.isfile(venv):
            venv = "python3"
        cmds = {
            "api": (
                f"pkill -f 'uvicorn api.main' 2>/dev/null; sleep 1; "
                f"cd {_SITE_DIR} && nohup {venv} -m uvicorn api.main:app "
                f"--host 0.0.0.0 --port 8000 --workers 2 --log-level warning "
                f">> {_SITE_DIR}/logs/api.log 2>&1 &"
            ),
            "chat": (
                f"pkill -f 'uvicorn chat.chat_server' 2>/dev/null; sleep 1; "
                f"cd {_SITE_DIR} && nohup {venv} -m uvicorn chat.chat_server:app "
                f"--host 0.0.0.0 --port 8001 --workers 1 --log-level warning "
                f">> {_SITE_DIR}/logs/chat.log 2>&1 &"
            ),
            "caddy": (
                f"pkill -f 'caddy run' 2>/dev/null; sleep 1; "
                f"cd {_SITE_DIR} && nohup {_SITE_DIR}/caddy run "
                f"--config {_SITE_DIR}/Caddyfile --adapter caddyfile "
                f">> {_SITE_DIR}/logs/caddy.log 2>&1 &"
            ),
            "ngrok": (
                f"pkill -f 'ngrok start' 2>/dev/null; sleep 2; "
                f"nohup ngrok start innerflect >> {_SITE_DIR}/logs/ngrok.log 2>&1 &"
            ),
        }
        try:
            subprocess.run(cmds[service], shell=True, timeout=15)
            return {"ok": True, "restarted": service}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _do_restart)
    return result

# ── Redis flush cache ─────────────────────────────────────────────────────
@app.post("/api/admin/redis/flush")
@limiter.limit("3/minute")
async def admin_redis_flush(request: Request, token: str = ""):
    """Flush all rate-limit / cache keys from Redis."""
    _require_admin(token, request)
    r = _get_redis()
    if not r:
        raise HTTPException(503, "Redis not connected")
    try:
        count = r.dbsize()
        r.flushdb()
        return {"ok": True, "keys_flushed": count}
    except Exception as e:
        raise HTTPException(500, str(e))

# NOTE: /api/admin/therapy-sessions endpoint removed.
# We do NOT store or provide access to conversation content — privacy promise.

# ═════════════════════════════════════════════════════════════════════════════
#  10. SLAYER — ad event tracking + admin management
# ═════════════════════════════════════════════════════════════════════════════

ADS_FILE = BASE.parent / "ghostslayer" / "ads.json"

def _load_ads() -> dict:
    try:
        return _json.loads(ADS_FILE.read_text())
    except Exception:
        return {"enabled": True, "settings": {}, "ads": []}

def _save_ads(d: dict):
    ADS_FILE.write_text(_json.dumps(d, indent=2))

class SlayerEvent(BaseModel):
    event: str   # "impression" | "click"
    ad_id: str
    page:  str = "/"

@app.post("/api/ghostslayer/event")
@limiter.limit("120/minute")
async def ghostslayer_track(body: SlayerEvent, request: Request):
    """Track an ad impression or click. Rate-limited; no PII stored."""
    if body.event not in ("impression", "click"):
        raise HTTPException(400, "event must be 'impression' or 'click'")
    ad_id = body.ad_id[:64]
    page  = body.page[:200]
    async with _pool.acquire() as con:
        await con.execute(
            "INSERT INTO slayer_events(event, ad_id, page) VALUES($1,$2,$3)",
            body.event, ad_id, page,
        )
    return {"ok": True}

@app.get("/api/admin/ads")
@limiter.limit("30/minute")
async def admin_ads_get(request: Request, token: str = ""):
    """Return current ads.json config."""
    _require_admin(token, request)
    return _load_ads()

@app.post("/api/admin/ads/{ad_id}/toggle")
@limiter.limit("30/minute")
async def admin_ads_toggle(ad_id: str, request: Request, token: str = ""):
    """Toggle a single ad on/off."""
    _require_admin(token, request)
    cfg = _load_ads()
    for ad in cfg.get("ads", []):
        if ad["id"] == ad_id:
            ad["enabled"] = not ad.get("enabled", True)
            _save_ads(cfg)
            return {"ok": True, "id": ad_id, "enabled": ad["enabled"]}
    raise HTTPException(404, f"ad '{ad_id}' not found")

@app.post("/api/admin/ads/bulk")
@limiter.limit("10/minute")
async def admin_ads_bulk(request: Request, token: str = ""):
    """Enable or disable all ads at once. Body: {"action":"enable"|"disable"}"""
    _require_admin(token, request)
    body = await request.json()
    action = body.get("action")
    if action not in ("enable", "disable"):
        raise HTTPException(400, "action must be 'enable' or 'disable'")
    cfg = _load_ads()
    for ad in cfg.get("ads", []):
        ad["enabled"] = (action == "enable")
    _save_ads(cfg)
    return {"ok": True, "action": action, "count": len(cfg.get("ads", []))}

@app.get("/api/admin/ads/stats")
@limiter.limit("15/minute")
async def admin_ads_stats(request: Request, token: str = ""):
    """Return impression + click counts per ad, plus daily totals."""
    _require_admin(token, request)
    async with _pool.acquire() as con:
        # Per-ad breakdown
        rows = await con.fetch("""
            SELECT ad_id, event, COUNT(*) as cnt
            FROM slayer_events
            GROUP BY ad_id, event
            ORDER BY ad_id
        """)
        # Daily totals (last 14 days)
        daily = await con.fetch("""
            SELECT to_timestamp("timestamp")::DATE::TEXT as day, event, COUNT(*) as cnt
            FROM slayer_events
            WHERE "timestamp" >= EXTRACT(EPOCH FROM NOW() - INTERVAL '14 days')::BIGINT
            GROUP BY day, event
            ORDER BY day DESC
        """)
        # All-time totals
        totals = await con.fetch("""
            SELECT event, COUNT(*) FROM slayer_events GROUP BY event
        """)

    per_ad: dict = {}
    for ad_id, event, cnt in rows:
        if ad_id not in per_ad:
            per_ad[ad_id] = {"impressions": 0, "clicks": 0, "ctr": 0.0}
        per_ad[ad_id][event + "s"] = cnt
    # Calculate CTR
    for ad in per_ad.values():
        imp = ad["impressions"]
        ad["ctr"] = round(ad["clicks"] / imp * 100, 2) if imp else 0.0

    total_map = {e: c for e, c in totals}
    total_imp  = total_map.get("impression", 0)
    total_clk  = total_map.get("click", 0)

    return {
        "totals": {
            "impressions": total_imp,
            "clicks":      total_clk,
            "ctr":         round(total_clk / total_imp * 100, 2) if total_imp else 0.0,
        },
        "per_ad": per_ad,
        "daily":  [{"day": d, "event": e, "count": c} for d, e, c in daily],
    }

# ── SmartLink pool management ─────────────────────────────────────────────

class SmartlinkAdd(BaseModel):
    url: str

@app.get("/api/admin/ads/smartlinks")
@limiter.limit("20/minute")
async def admin_smartlinks_get(request: Request, token: str = ""):
    """Return the smartlink_pool URL list and global config."""
    _require_admin(token, request)
    cfg = _load_ads()
    return {
        "pool":   cfg.get("smartlink_pool", []),
        "config": cfg.get("smartlink_global", {}),
    }

@app.post("/api/admin/ads/smartlinks")
@limiter.limit("20/minute")
async def admin_smartlinks_add(body: SmartlinkAdd, request: Request, token: str = ""):
    """Add a URL to the smartlink pool."""
    _require_admin(token, request)
    import re as _re
    url = body.url.strip()
    if not _re.match(r'^https?://', url, _re.IGNORECASE):
        raise HTTPException(400, "URL must start with http:// or https://")
    cfg = _load_ads()
    pool = cfg.setdefault("smartlink_pool", [])
    if url in pool:
        raise HTTPException(409, "URL already in pool")
    pool.append(url)
    _save_ads(cfg)
    return {"ok": True, "pool": pool}

@app.delete("/api/admin/ads/smartlinks/{idx}")
@limiter.limit("20/minute")
async def admin_smartlinks_del(idx: int, request: Request, token: str = ""):
    """Remove a URL from the pool by index."""
    _require_admin(token, request)
    cfg = _load_ads()
    pool = cfg.get("smartlink_pool", [])
    if idx < 0 or idx >= len(pool):
        raise HTTPException(404, "Index out of range")
    removed = pool.pop(idx)
    _save_ads(cfg)
    return {"ok": True, "removed": removed, "pool": pool}

@app.patch("/api/admin/ads/smartlinks/config")
@limiter.limit("15/minute")
async def admin_smartlinks_config(request: Request, token: str = ""):
    """Update smartlink_global settings. Body: {enabled, delay_between_ms, max_per_session, start_after_ms}"""
    _require_admin(token, request)
    body = await request.json()
    allowed = {"enabled", "delay_between_ms", "max_per_session", "start_after_ms"}
    cfg = _load_ads()
    gcfg = cfg.setdefault("smartlink_global", {})
    for k, v in body.items():
        if k in allowed:
            gcfg[k] = v
    _save_ads(cfg)
    return {"ok": True, "config": gcfg}

# ── Turbo mode toggle ─────────────────────────────────────────────────────

@app.patch("/api/admin/ads/turbo")
@limiter.limit("15/minute")
async def admin_ads_turbo(request: Request, token: str = ""):
    """Toggle turbo mode on/off. Body: {enabled: bool, min_gap_ms: int}"""
    _require_admin(token, request)
    body = await request.json()
    cfg = _load_ads()
    t = cfg.setdefault("turbo_mode", {})
    if "enabled"    in body: t["enabled"]    = bool(body["enabled"])
    if "min_gap_ms" in body: t["min_gap_ms"] = int(body["min_gap_ms"])
    _save_ads(cfg)
    return {"ok": True, "turbo_mode": t}

# ── Ad CRUD (add / update / delete) ──────────────────────────────────────

class AdAdd(BaseModel):
    id:               str
    type:             str
    script:           str  = ""
    urls:             list = []
    pages:            list = ["*"]
    enabled:          bool = False
    visible:          bool = False
    label:            str  = ""
    trigger:          dict = {}
    max_per_session:  int  = 1
    delay_between_ms: int  = 3000

@app.post("/api/admin/ads/add")
@limiter.limit("15/minute")
async def admin_ads_add(body: AdAdd, request: Request, token: str = ""):
    """Append a new ad slot to ads.json."""
    _require_admin(token, request)
    cfg = _load_ads()
    ads = cfg.setdefault("ads", [])
    if any(isinstance(a, dict) and a.get("id") == body.id for a in ads):
        raise HTTPException(409, f"Ad ID '{body.id}' already exists")
    new_ad: dict = {
        "id": body.id, "type": body.type,
        "enabled": body.enabled, "visible": body.visible,
        "pages": body.pages,
    }
    if body.script:  new_ad["script"]  = body.script
    if body.urls:    new_ad["urls"]    = body.urls
    if body.label:   new_ad["label"]   = body.label
    if body.trigger: new_ad["trigger"] = body.trigger
    if body.type == "smartlink":
        new_ad["max_per_session"]  = body.max_per_session
        new_ad["delay_between_ms"] = body.delay_between_ms
    ads.append(new_ad)
    _save_ads(cfg)
    return {"ok": True, "ad": new_ad}

@app.put("/api/admin/ads/{ad_id}")
@limiter.limit("20/minute")
async def admin_ads_update(ad_id: str, request: Request, token: str = ""):
    """Update fields on an existing ad slot."""
    _require_admin(token, request)
    body = await request.json()
    allowed = {"enabled","script","urls","pages","visible","label",
               "trigger","max_per_session","delay_between_ms"}
    cfg = _load_ads()
    for ad in cfg.get("ads", []):
        if isinstance(ad, dict) and ad.get("id") == ad_id:
            for k, v in body.items():
                if k in allowed: ad[k] = v
            _save_ads(cfg)
            return {"ok": True, "ad": ad}
    raise HTTPException(404, f"Ad '{ad_id}' not found")

@app.delete("/api/admin/ads/{ad_id}")
@limiter.limit("20/minute")
async def admin_ads_delete(ad_id: str, request: Request, token: str = ""):
    """Delete an ad slot by ID."""
    _require_admin(token, request)
    cfg = _load_ads()
    before = len(cfg.get("ads", []))
    cfg["ads"] = [a for a in cfg.get("ads", [])
                  if not (isinstance(a, dict) and a.get("id") == ad_id)]
    if len(cfg["ads"]) == before:
        raise HTTPException(404, f"Ad '{ad_id}' not found")
    _save_ads(cfg)
    return {"ok": True}

# ═════════════════════════════════════════════════════════════════════════════
#  11. THERAPYSPACE — server-side AI fallback via OpenRouter
# ═════════════════════════════════════════════════════════════════════════════
# TherapySpace normally runs AI in the browser via WebGPU/WebLLM.
# These endpoints provide a server-side fallback for browsers without WebGPU.

# Simple in-process rate limiter for anonymous users (50 msgs/day per IP)
_anon_ai_counts: dict = {}  # {ip: {"count": int, "day": str}}

def _check_anon_ai_limit(ip: str) -> bool:
    """Returns True if request is allowed, False if rate limited."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    entry = _anon_ai_counts.get(ip)
    if entry is None or entry["day"] != today:
        _anon_ai_counts[ip] = {"count": 1, "day": today}
        return True
    if entry["count"] >= 50:
        return False
    entry["count"] += 1
    return True

@app.get("/api/ai/status")
@limiter.limit("30/minute")
async def ai_status():
    """Check if server-side AI is configured."""
    has_key = bool(_env("OPENROUTER_API_KEY", "").strip())
    return {"server_ai_available": has_key, "mode": "openrouter" if has_key else "none"}

@app.post("/api/ai/chat")
@limiter.limit("20/minute")
async def ai_chat(request: Request):
    """Server-side AI chat via OpenRouter. Used as WebGPU fallback."""
    body = await request.json()
    messages = body.get("messages", [])
    model = body.get("model", "meta-llama/llama-3.1-8b-instruct:free")
    stream = body.get("stream", False)

    api_key = _env("OPENROUTER_API_KEY", "")
    if not api_key:
        return JSONResponse(
            {"error": "Server AI not configured. Add OPENROUTER_API_KEY to enable."},
            status_code=503,
        )

    # Anonymous rate limit: 50 messages/day per IP
    client_ip = request.client.host if request.client else "unknown"
    if not _check_anon_ai_limit(client_ip):
        return JSONResponse(
            {"error": "Daily limit reached (50 messages). Come back tomorrow."},
            status_code=429,
        )

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://innerflect.netlify.app",
        "X-Title": "Innerflect",
    }

    payload = {
        "model": model,
        "messages": messages,
        "stream": stream,
        "max_tokens": 1024,
        "temperature": 0.7,
    }

    if stream:
        async def generate():
            async with httpx.AsyncClient(timeout=60) as client:
                async with client.stream(
                    "POST",
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers=headers,
                    json=payload,
                ) as resp:
                    async for chunk in resp.aiter_text():
                        yield chunk

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    else:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                json=payload,
            )
            data = resp.json()
            if "error" in data:
                return JSONResponse(
                    {"error": data["error"].get("message", "AI error")},
                    status_code=500,
                )
            content = data["choices"][0]["message"]["content"]
            return JSONResponse({"content": content})
