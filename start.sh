#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════
#  Innerflect — start.sh  (safe to run multiple times)
#  Hosting modes:
#    A) Netlify frontend + Android backend via Tailscale  ← recommended
#    B) Netlify frontend + Android backend via ngrok      ← optional
#    C) Full self-host on Android via Tailscale
#  Tunnel priority: Tailscale > ngrok (if both configured, Tailscale wins)
# ═══════════════════════════════════════════════════════
SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SITE_DIR/config/.env" ] && . "$SITE_DIR/config/.env"

API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-8090}"
TAILSCALE_URL="${TAILSCALE_URL:-}"
NGROK_DOMAIN="${NGROK_DOMAIN:-}"

PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
NGROK="$(command -v ngrok 2>/dev/null \
  || ls "$SITE_DIR/bin/ngrok" "$HOME/.local/bin/ngrok" 2>/dev/null | head -1)"

mkdir -p "$SITE_DIR/logs"
cd "$SITE_DIR"

# Sync GOOGLE_CLIENT_ID (and API base) from config/.env → www/config.js + public/config.js
# so there is only ONE place to set them. Silent — errors don't block startup.
bash "$SITE_DIR/bin/manage-secrets.sh" sync-config 2>/dev/null || true

_api_up()    { curl -sf --connect-timeout 3 "http://127.0.0.1:${API_PORT}/api/health" >/dev/null 2>&1; }
_port_used() { ss -tlnp 2>/dev/null | grep -q ":$1 " || netstat -tlnp 2>/dev/null | grep -q ":$1 "; }
_ts_up()     { ps aux 2>/dev/null | grep -v grep | grep -q 'tailscale.*funnel'; }
_ngrok_up()  { ps aux 2>/dev/null | grep -v grep | grep -q '[n]grok'; }
_pg_up() {
  pg_isready -q 2>/dev/null && return 0
  pg_ctl -D "${PREFIX:-/usr}/var/lib/postgresql" status >/dev/null 2>&1
}

echo "[innerflect] Starting services..."

# ── PostgreSQL ───────────────────────────────────────────────────────────────
if ! _pg_up; then
  # Try system service first (Ubuntu/Debian PC)
  if command -v service >/dev/null 2>&1 && service postgresql status >/dev/null 2>&1; then
    service postgresql start 2>/dev/null || true
  elif command -v pg_ctl >/dev/null 2>&1; then
    # Termux / manual install
    PG_DATA="${PREFIX:-/usr}/var/lib/postgresql"
    pg_ctl -D "$PG_DATA" -l "$SITE_DIR/logs/postgres.log" start 2>/dev/null
  fi
  sleep 2
  _pg_up && echo "[innerflect] ✓ PostgreSQL" \
         || echo "[innerflect] ✗ PostgreSQL failed — API may not work"
else
  echo "[innerflect] ✓ PostgreSQL (already running)"
fi

# Set DATABASE_URL if not already in environment
if [ -z "$DATABASE_URL" ]; then
  # Try to read from config/.env
  if grep -q "DATABASE_URL" "$SITE_DIR/config/.env" 2>/dev/null; then
    export DATABASE_URL=$(grep "^DATABASE_URL" "$SITE_DIR/config/.env" | cut -d= -f2-)
  else
    # Default local dev URL
    export DATABASE_URL="postgresql://innerflect:innerflect_dev@localhost:5432/innerflect"
    echo "[innerflect] ℹ Using default DATABASE_URL (localhost)"
  fi
fi

# ── FastAPI ──────────────────────────────────────────────────────────────────
if ! _api_up; then
  DATABASE_URL="$DATABASE_URL" nohup "$PY" -m uvicorn api.main:app \
    --host 0.0.0.0 --port "$API_PORT" --log-level warning \
    > "$SITE_DIR/logs/api.log" 2>&1 &
  echo $! > "$SITE_DIR/logs/api.pid"
  echo "[innerflect] ✓ API starting (PID $!)"
else
  echo "[innerflect] ✓ API (already running)"
fi

# ── Caddy ─────────────────────────────────────────────────────────────────────
if ! _port_used "$WEB_PORT"; then
  SITE_DIR="$SITE_DIR" WEB_PORT="$WEB_PORT" API_PORT="$API_PORT" \
  nohup "$SITE_DIR/caddy" run \
    --config "$SITE_DIR/Caddyfile" --adapter caddyfile \
    > "$SITE_DIR/logs/caddy.log" 2>&1 &
  echo $! > "$SITE_DIR/logs/caddy.pid"
  echo "[innerflect] ✓ Caddy starting (PID $!)"
else
  echo "[innerflect] ✓ Caddy (already running)"
fi

# ── Tunnel ────────────────────────────────────────────────────────────────────
# Tailscale is preferred — if configured and available, use it.
# ngrok is used only if Tailscale is not configured/available.

if command -v tailscale >/dev/null 2>&1; then
  if ! _ts_up; then
    tailscale funnel --bg "$WEB_PORT" >/dev/null 2>&1 \
      && echo "[innerflect] ✓ Tailscale Funnel → ${TAILSCALE_URL:-run 'tailscale funnel status' for URL}" \
      || echo "[innerflect] ✗ Tailscale Funnel: open the app, sign in, enable Funnel"
  else
    echo "[innerflect] ✓ Tailscale Funnel (already up) → ${TAILSCALE_URL:-see app}"
  fi

elif [ -n "$NGROK_DOMAIN" ] && [ -x "$NGROK" ]; then
  # ngrok fallback — only used if Tailscale not installed
  if ! _ngrok_up; then
    nohup "$NGROK" http --url="$NGROK_DOMAIN" "$WEB_PORT" --log=stdout \
      > "$SITE_DIR/logs/tunnel.log" 2>&1 &
    echo $! > "$SITE_DIR/logs/tunnel.pid"
    for _i in $(seq 1 15); do
      grep -q "started tunnel" "$SITE_DIR/logs/tunnel.log" 2>/dev/null && break
      sleep 1
    done
    grep -q "started tunnel" "$SITE_DIR/logs/tunnel.log" 2>/dev/null \
      && echo "[innerflect] ✓ ngrok → https://$NGROK_DOMAIN" \
      || echo "[innerflect] ✗ ngrok failed (logs/tunnel.log)"
  else
    echo "[innerflect] ✓ ngrok (already up) → https://$NGROK_DOMAIN"
  fi

else
  echo "[innerflect] ⚠ No tunnel — local only at http://localhost:$WEB_PORT"
  echo "[innerflect]   Install Tailscale or set NGROK_DOMAIN in config/.env"
fi
