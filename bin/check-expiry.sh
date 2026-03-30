#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
#  Innerflect — bin/check-expiry.sh
#  Checks all time-sensitive things: SSL certs, refresh tokens, DB tokens.
#  Run manually:  bash bin/check-expiry.sh
#  Run in cron:   0 6 * * * bash /path/to/public-site/bin/check-expiry.sh
# ═════════════════════════════════════════════════════════════════════════════
set -uo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SITE_DIR/config/.env" ] && . "$SITE_DIR/config/.env" 2>/dev/null || true

R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' B='\033[0;34m' W='\033[1;37m' NC='\033[0m'
ok()   { echo -e "${G}  ✓${NC}  $*"; }
warn() { echo -e "${Y}  ⚠${NC}  $*"; }
err()  { echo -e "${R}  ✗${NC}  $*"; }
info() { echo -e "${B}  →${NC}  $*"; }

WARN_DAYS=14   # warn when fewer than this many days remain
CRIT_DAYS=3    # critical when fewer than this many days remain

HAS_ISSUE=0
HAS_CRITICAL=0

echo ""
echo -e "${W}═══════════════════════════════════════════════════${NC}"
echo -e "${W}  Innerflect — Expiry & Health Check${NC}"
echo -e "${W}  $(date '+%Y-%m-%d %H:%M:%S %Z')${NC}"
echo -e "${W}═══════════════════════════════════════════════════${NC}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 1. SSL CERTIFICATE EXPIRY
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${W}▸ SSL Certificates${NC}"

check_ssl() {
  local host="$1" port="${2:-443}"
  local expiry days
  expiry=$(echo | timeout 5 openssl s_client -connect "${host}:${port}" \
    -servername "$host" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null \
    | cut -d= -f2)
  if [ -z "$expiry" ]; then
    warn "  $host — could not fetch cert (offline or no openssl)"
    return
  fi
  local exp_epoch now_epoch
  exp_epoch=$(date -d "$expiry" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$expiry" +%s 2>/dev/null || echo 0)
  now_epoch=$(date +%s)
  days=$(( (exp_epoch - now_epoch) / 86400 ))

  if [ "$days" -le "$CRIT_DAYS" ]; then
    err "  $host — EXPIRES IN ${days}d  (${expiry})"
    HAS_ISSUE=1; HAS_CRITICAL=1
  elif [ "$days" -le "$WARN_DAYS" ]; then
    warn "  $host — expires in ${days}d  (${expiry})"
    HAS_ISSUE=1
  else
    ok  "  $host — ${days}d remaining  (${expiry})"
  fi
}

# Check all configured domains
DOMAIN="${DOMAIN:-}"
NGROK_DOMAIN="${NGROK_DOMAIN:-}"

[ -n "$DOMAIN" ] && [ "$DOMAIN" != "localhost" ] && check_ssl "$DOMAIN"
[ -n "$NGROK_DOMAIN" ] && [ "$NGROK_DOMAIN" != "$DOMAIN" ] && check_ssl "$NGROK_DOMAIN"
# Always check Netlify deploy domain
check_ssl "innerflect.netlify.app" 2>/dev/null || true

echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 2. CADDY CERT STATUS (local)
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${W}▸ Caddy (local reverse proxy)${NC}"

WEB_PORT="${WEB_PORT:-8090}"
if curl -sf --connect-timeout 2 "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1; then
  ok "  Caddy is running on port ${WEB_PORT}"
else
  warn "  Caddy is NOT responding on port ${WEB_PORT}"
  HAS_ISSUE=1
fi

# Caddy auto-renews Let's Encrypt certs at ~30 days before expiry.
# Check if Caddy data dir has certs and when they were last modified.
CADDY_CERT_DIR="${HOME}/.local/share/caddy/certificates"
if [ -d "$CADDY_CERT_DIR" ]; then
  OLDEST_CERT=$(find "$CADDY_CERT_DIR" -name "*.crt" -printf '%T+ %p\n' 2>/dev/null | sort | head -1)
  if [ -n "$OLDEST_CERT" ]; then
    ok "  Caddy cert store exists — $(find "$CADDY_CERT_DIR" -name '*.crt' | wc -l) cert(s) cached"
  else
    info "  Caddy cert store is empty (using HTTP or Tailscale)"
  fi
else
  info "  Caddy cert store not found (may be using system Caddy or Termux path)"
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 3. API HEALTH + JWT CONFIG
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${W}▸ API & Auth${NC}"

API_PORT="${API_PORT:-8000}"
if curl -sf --connect-timeout 2 "http://127.0.0.1:${API_PORT}/api/health" >/dev/null 2>&1; then
  ok "  FastAPI is running on port ${API_PORT}"
else
  warn "  FastAPI is NOT responding on port ${API_PORT}"
  HAS_ISSUE=1
fi

JWT_SECRET="${JWT_SECRET:-innerflect-jwt-secret-change-in-prod}"
if [ "$JWT_SECRET" = "innerflect-jwt-secret-change-in-prod" ]; then
  err "  JWT_SECRET is using the default insecure value — change it in config/.env!"
  HAS_ISSUE=1; HAS_CRITICAL=1
else
  ok "  JWT_SECRET is set ($(echo -n "$JWT_SECRET" | wc -c) chars)"
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 4. DATABASE REFRESH TOKENS (expiring soon)
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${W}▸ Database Token Health${NC}"

DATABASE_URL="${DATABASE_URL:-}"
PY="$(command -v python3 2>/dev/null || echo '')"

if [ -n "$PY" ] && [ -n "$DATABASE_URL" ]; then
  EXPIRY_CHECK=$($PY - <<PYEOF 2>/dev/null
import asyncio, asyncpg, ssl as _ssl, re, time, os

url = os.environ.get('DATABASE_URL','')
clean_url = re.sub(r'[?&]sslmode=[^&]+', '', url).rstrip('?')
kwargs = {}
if 'neon.tech' in url or 'sslmode=require' in url:
    ctx = _ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = _ssl.CERT_NONE
    kwargs['ssl'] = ctx

async def run():
    now = int(time.time())
    week = now + 7*86400
    month = now + 30*86400
    try:
        pool = await asyncpg.create_pool(clean_url, min_size=1, max_size=1, **kwargs)
        async with pool.acquire() as conn:
            expiring_soon = await conn.fetchval(
                "SELECT COUNT(*) FROM refresh_tokens WHERE expires_at BETWEEN \$1 AND \$2",
                now, week)
            total_rt = await conn.fetchval("SELECT COUNT(*) FROM refresh_tokens")
            expired_rt = await conn.fetchval(
                "SELECT COUNT(*) FROM refresh_tokens WHERE expires_at < \$1", now)
            expiring_month = await conn.fetchval(
                "SELECT COUNT(*) FROM refresh_tokens WHERE expires_at BETWEEN \$1 AND \$2",
                now, month)
            pending_resets = await conn.fetchval(
                "SELECT COUNT(*) FROM password_resets WHERE expires_at > \$1", now)
        await pool.close()
        print(f"RT_TOTAL={total_rt}")
        print(f"RT_EXPIRED={expired_rt}")
        print(f"RT_EXPIRING_WEEK={expiring_soon}")
        print(f"RT_EXPIRING_MONTH={expiring_month}")
        print(f"PENDING_RESETS={pending_resets}")
        print("DB_OK=1")
    except Exception as e:
        print(f"DB_ERR={e}")

asyncio.run(run())
PYEOF
)
  if echo "$EXPIRY_CHECK" | grep -q "DB_OK=1"; then
    eval "$(echo "$EXPIRY_CHECK")"
    ok "  Database reachable"
    ok "  Refresh tokens: ${RT_TOTAL} total"
    [ "${RT_EXPIRED:-0}" -gt 0 ] && warn "  ${RT_EXPIRED} expired tokens still in DB (will auto-clean on next restart)" || true
    if [ "${RT_EXPIRING_WEEK:-0}" -gt 0 ]; then
      warn "  ${RT_EXPIRING_WEEK} refresh token(s) expire within 7 days (users will be asked to re-login)"
      HAS_ISSUE=1
    else
      ok "  No refresh tokens expiring in next 7 days"
    fi
    [ "${PENDING_RESETS:-0}" -gt 0 ] && info "  ${PENDING_RESETS} active password reset request(s)" || true
  elif echo "$EXPIRY_CHECK" | grep -q "DB_ERR="; then
    DB_ERR=$(echo "$EXPIRY_CHECK" | grep "DB_ERR=" | cut -d= -f2-)
    warn "  Database check failed: ${DB_ERR}"
    HAS_ISSUE=1
  else
    warn "  Could not connect to database — is it running?"
    HAS_ISSUE=1
  fi
else
  info "  Skipping DB check (python3 not found or DATABASE_URL not set)"
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 5. TUNNEL STATUS
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${W}▸ Tunnel${NC}"

if ps aux 2>/dev/null | grep -v grep | grep -q '[n]grok'; then
  NGROK_STATUS=$(curl -sf --connect-timeout 2 "http://127.0.0.1:4040/api/tunnels" 2>/dev/null \
    | $PY -c "import sys,json; d=json.load(sys.stdin); print(d['tunnels'][0]['public_url'] if d.get('tunnels') else 'no tunnels')" 2>/dev/null || echo "running (status unknown)")
  ok "  ngrok is running — $NGROK_STATUS"
elif ps aux 2>/dev/null | grep -v grep | grep -q 'tailscale.*funnel'; then
  ok "  Tailscale funnel is active"
else
  info "  No tunnel detected (OK if using direct domain or self-hosted)"
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 6. SECRETS HEALTH (delegates to manage-secrets.sh check)
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${W}▸ Secrets & API Keys${NC}"

if [ -f "$SITE_DIR/bin/manage-secrets.sh" ]; then
  bash "$SITE_DIR/bin/manage-secrets.sh" check 2>/dev/null || HAS_ISSUE=1
else
  warn "  bin/manage-secrets.sh not found — skipping secrets check"
  HAS_ISSUE=1
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 7. AUTO-RENEW OPTIONS
# ─────────────────────────────────────────────────────────────────────────────
if [ "$HAS_ISSUE" -eq 1 ]; then
  echo -e "${W}▸ Auto-renew options${NC}"
  echo ""

  if [ "$HAS_CRITICAL" -eq 1 ]; then
    echo -e "${R}  ⚠  CRITICAL issues require manual action (see above)${NC}"
    echo ""
  fi

  echo "  What would you like to do?"
  echo "  [1] Clean expired DB tokens now (runs SQL DELETE)"
  echo "  [2] Reload Caddy (re-triggers cert renewal attempt)"
  echo "  [3] Restart API backend"
  echo "  [4] All of the above"
  echo "  [q] Quit / do nothing"
  echo ""

  if [ -t 0 ]; then
    read -r -p "  Choice [1/2/3/4/q]: " CHOICE
    case "$CHOICE" in
      1|4)
        if [ -n "$PY" ] && [ -n "$DATABASE_URL" ]; then
          echo "  Cleaning expired tokens…"
          $PY - <<PYEOF2 2>/dev/null && ok "  Expired tokens cleaned" || warn "  Clean failed"
import asyncio, asyncpg, ssl as _ssl, re, time, os
url = os.environ.get('DATABASE_URL','')
clean = re.sub(r'[?&]sslmode=[^&]+','',url).rstrip('?')
kwargs = {}
if 'neon.tech' in url or 'sslmode=require' in url:
    ctx = _ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=_ssl.CERT_NONE; kwargs['ssl']=ctx
async def run():
    p = await asyncpg.create_pool(clean,min_size=1,max_size=1,**kwargs)
    async with p.acquire() as c:
        now=int(time.time())
        n1=await c.fetchval("DELETE FROM refresh_tokens WHERE expires_at<\$1 RETURNING COUNT(*)",now) or 0
        n2=await c.fetchval("DELETE FROM password_resets WHERE expires_at<\$1 RETURNING COUNT(*)",now) or 0
        print(f"  Removed {n1} refresh token(s), {n2} password reset(s)")
    await p.close()
asyncio.run(run())
PYEOF2
        fi
        ;;&
      2|4)
        if command -v caddy >/dev/null 2>&1; then
          caddy reload --config "$SITE_DIR/Caddyfile" 2>/dev/null && ok "  Caddy reloaded" || warn "  Caddy reload failed"
        elif [ -f "$SITE_DIR/reload-caddy.sh" ]; then
          bash "$SITE_DIR/reload-caddy.sh" && ok "  Caddy reloaded" || warn "  Caddy reload failed"
        else
          warn "  Caddy not found — reload manually"
        fi
        ;;&
      3|4)
        if [ -f "$SITE_DIR/restart-api.sh" ]; then
          bash "$SITE_DIR/restart-api.sh" && ok "  API restarted" || warn "  API restart failed"
        else
          warn "  restart-api.sh not found — restart manually"
        fi
        ;;&
      q|Q|"") info "  No action taken" ;;
    esac
  else
    info "  (Non-interactive mode — run manually to see auto-renew options)"
    info "  Quick fix: bash $SITE_DIR/bin/check-expiry.sh"
  fi
fi

echo ""
if [ "$HAS_CRITICAL" -eq 1 ]; then
  echo -e "${R}  ● Critical issues detected — immediate action required${NC}"
elif [ "$HAS_ISSUE" -eq 1 ]; then
  echo -e "${Y}  ● Warnings detected — review above${NC}"
else
  echo -e "${G}  ✓ All checks passed — everything looks healthy!${NC}"
fi
echo ""
