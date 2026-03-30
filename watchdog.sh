#!/usr/bin/env bash
# Innerflect — watchdog.sh  (cron: * * * * *)
# Auto-restarts PostgreSQL, API, Caddy, and whichever tunnel is configured.

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SITE_DIR/config/.env" ] && . "$SITE_DIR/config/.env"

WEB_PORT="${WEB_PORT:-8090}"
API_PORT="${API_PORT:-8000}"
TAILSCALE_URL="${TAILSCALE_URL:-}"
NGROK_DOMAIN="${NGROK_DOMAIN:-}"
LOG="$SITE_DIR/logs/watchdog.log"
mkdir -p "$SITE_DIR/logs"

TS="[$(date '+%Y-%m-%d %H:%M:%S')]"
log()   { echo "$TS $*" >> "$LOG"; }
alert() {
  [ -n "${DISCORD_WEBHOOK:-}" ] || return 0
  curl -sf -X POST "$DISCORD_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "{\"content\":\"🔧 **Innerflect:** $*\"}" >/dev/null 2>&1 || true
}

[ -f "/tmp/innerflect-watchdog-disabled" ] && exit 0

LOCK=/tmp/innerflect-watchdog.lock
if [ -f "$LOCK" ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y "$LOCK" 2>/dev/null || echo 0) ))
  [ "$AGE" -lt 90 ] && exit 0
fi
touch "$LOCK"; trap "rm -f $LOCK" EXIT

PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
NGROK="$(command -v ngrok 2>/dev/null \
  || ls "$SITE_DIR/bin/ngrok" "$HOME/.local/bin/ngrok" 2>/dev/null | head -1)"

_http_ok() { curl -sf --connect-timeout 3 "http://127.0.0.1:$1$2" >/dev/null 2>&1; }
_ts_up()   { ps aux 2>/dev/null | grep -v grep | grep -q 'tailscale.*funnel'; }
_ngrok_up(){ ps aux 2>/dev/null | grep -v grep | grep -q '[n]grok'; }
# Use $PREFIX for Termux (same as setup-termux.sh); fall back to /usr for generic Linux
_PG_DATA="${PGDATA:-${PREFIX:-/usr}/var/lib/postgresql}"
_pg_up()   { pg_ctl -D "$_PG_DATA" status >/dev/null 2>&1; }

# ── PostgreSQL ────────────────────────────────────────────────────────────────
if command -v pg_ctl >/dev/null 2>&1; then
  if ! _pg_up; then
    log "PostgreSQL DOWN — restarting"
    pg_ctl -D "$_PG_DATA" -l "$SITE_DIR/logs/postgres.log" start 2>/dev/null
    sleep 3
    _pg_up \
      && { log "PostgreSQL OK"; alert "PostgreSQL auto-restarted ✅"; } \
      || { log "PostgreSQL FAILED"; alert "⚠️ PostgreSQL won't start"; }
  fi
fi

# ── FastAPI ───────────────────────────────────────────────────────────────────
if ! _http_ok "$API_PORT" "/api/health"; then
  log "API DOWN — restarting"
  cd "$SITE_DIR"
  nohup "$PY" -m uvicorn api.main:app \
    --host 0.0.0.0 --port "$API_PORT" --workers 1 --log-level warning \
    >> "$SITE_DIR/logs/api.log" 2>&1 &
  echo $! > "$SITE_DIR/logs/api.pid"
  sleep 4
  _http_ok "$API_PORT" "/api/health" \
    && { log "API OK"; alert "API auto-restarted ✅"; } \
    || { log "API FAILED"; alert "⚠️ API won't start"; }
fi

# ── Caddy ─────────────────────────────────────────────────────────────────────
if ! _http_ok "$WEB_PORT" "/health"; then
  log "Caddy DOWN — restarting"
  SITE_DIR="$SITE_DIR" WEB_PORT="$WEB_PORT" API_PORT="$API_PORT" \
  nohup "$SITE_DIR/caddy" run \
    --config "$SITE_DIR/Caddyfile" --adapter caddyfile \
    >> "$SITE_DIR/logs/caddy.log" 2>&1 &
  echo $! > "$SITE_DIR/logs/caddy.pid"
  sleep 3
  _http_ok "$WEB_PORT" "/health" \
    && { log "Caddy OK"; alert "Caddy auto-restarted ✅"; } \
    || { log "Caddy FAILED"; alert "⚠️ Caddy won't start"; }
fi

# ── Tunnel ────────────────────────────────────────────────────────────────────
if command -v tailscale >/dev/null 2>&1; then
  if ! _ts_up; then
    log "Tailscale Funnel DOWN — restarting"
    tailscale funnel --bg "$WEB_PORT" >/dev/null 2>&1
    sleep 3
    _ts_up \
      && { log "Tailscale OK"; alert "Tailscale back ✅ → ${TAILSCALE_URL}"; } \
      || { log "Tailscale FAILED"; alert "⚠️ Tailscale Funnel won't restart"; }
  fi

elif [ -n "$NGROK_DOMAIN" ] && [ -x "$NGROK" ]; then
  if ! _ngrok_up; then
    log "ngrok DOWN — restarting"
    true > "$SITE_DIR/logs/tunnel.log"
    nohup "$NGROK" http --url="$NGROK_DOMAIN" "$WEB_PORT" --log=stdout \
      >> "$SITE_DIR/logs/tunnel.log" 2>&1 &
    echo $! > "$SITE_DIR/logs/tunnel.pid"
    for _i in $(seq 1 15); do
      grep -q "started tunnel" "$SITE_DIR/logs/tunnel.log" 2>/dev/null && break
      sleep 1
    done
    grep -q "started tunnel" "$SITE_DIR/logs/tunnel.log" 2>/dev/null \
      && { log "ngrok OK"; alert "ngrok back ✅ → https://$NGROK_DOMAIN"; } \
      || { log "ngrok FAILED"; alert "⚠️ ngrok won't restart"; }
  fi
fi

# ── Trim log ──────────────────────────────────────────────────────────────────
[ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 3000 ] \
  && { tail -1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; }
