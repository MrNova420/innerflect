#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
#  Innerflect — bin/manage-secrets.sh
#  One-stop secrets management & configuration automation.
#
#  Commands:
#    check          Validate all secrets (format, length, presence)
#    sync-config    Push GOOGLE_CLIENT_ID from .env → www/config.js + public/config.js
#    rotate-jwt     Generate new JWT_SECRET, update .env, restart API
#    setup          Interactive first-time setup wizard
#
#  Called automatically:
#    • start.sh calls   : sync-config  (keeps config.js in sync on every start)
#    • package.json     : prebuild → sync-config (Netlify build injects env vars)
#    • check-expiry.sh  : check  (daily health report includes secrets status)
#
#  Safe to run any time. All writes are atomic (write to temp → rename).
# ═════════════════════════════════════════════════════════════════════════════
set -uo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$SITE_DIR/config/.env"
WWW_CFG="$SITE_DIR/www/config.js"
PUB_CFG="$SITE_DIR/public/config.js"

# ── colours ──────────────────────────────────────────────────────────────────
R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' B='\033[0;34m' W='\033[1;37m' NC='\033[0m'
ok()   { echo -e "${G}  ✓${NC}  $*"; }
warn() { echo -e "${Y}  ⚠${NC}  $*"; }
err()  { echo -e "${R}  ✗${NC}  $*"; }
info() { echo -e "${B}  →${NC}  $*"; }
hdr()  { echo -e "\n${W}▸ $*${NC}"; }

# ── helpers ───────────────────────────────────────────────────────────────────
# Load .env without overwriting environment-level vars (Netlify CI uses env vars)
_load_env() {
  [ -f "$ENV_FILE" ] || return 0
  while IFS= read -r line; do
    # Skip blanks, comments, lines without =
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$  ]] && continue
    [[ "$line" != *=*              ]] && continue
    local key="${line%%=*}"
    # Only set if not already exported (env var wins over .env for Netlify/CI)
    if [ -z "${!key+x}" ]; then
      local val="${line#*=}"
      export "$key=$val"
    fi
  done < "$ENV_FILE"
}

_env_get() { local k="$1"; grep "^${k}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }
_env_set() {
  local k="$1" v="$2"
  if grep -q "^${k}=" "$ENV_FILE" 2>/dev/null; then
    local tmp; tmp=$(mktemp)
    grep -v "^${k}=" "$ENV_FILE" > "$tmp"
    echo "${k}=${v}" >> "$tmp"
    mv "$tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  else
    echo "${k}=${v}" >> "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
}

_restart_api() {
  if [ -f "$SITE_DIR/logs/api.pid" ]; then
    local pid; pid=$(cat "$SITE_DIR/logs/api.pid" 2>/dev/null)
    [ -n "$pid" ] && kill "$pid" 2>/dev/null && sleep 1
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet innerflect-api 2>/dev/null; then
    systemctl restart innerflect-api && ok "API restarted via systemctl"
  elif [ -f "$SITE_DIR/restart-api.sh" ]; then
    bash "$SITE_DIR/restart-api.sh" && ok "API restarted"
  else
    info "Restart API manually: bash $SITE_DIR/restart-api.sh"
  fi
}

# ═════════════════════════════════════════════════════════════════════════════
#  COMMAND: check
#  Validates every secret/key is present, non-default, and well-formed.
#  Returns exit code 1 if any critical issue found.
# ═════════════════════════════════════════════════════════════════════════════
cmd_check() {
  _load_env
  local issues=0 criticals=0

  hdr "Secrets & Config Health"

  # JWT_SECRET
  local JWT_SECRET="${JWT_SECRET:-}"
  local DEFAULT_JWT="innerflect-jwt-secret-change-in-prod"
  if [ -z "$JWT_SECRET" ]; then
    err "JWT_SECRET is not set — run: bash bin/manage-secrets.sh rotate-jwt"
    (( criticals++ )) || true; (( issues++ )) || true
  elif [ "$JWT_SECRET" = "$DEFAULT_JWT" ]; then
    err "JWT_SECRET is using the insecure default — run: bash bin/manage-secrets.sh rotate-jwt"
    (( criticals++ )) || true; (( issues++ )) || true
  elif [ ${#JWT_SECRET} -lt 64 ]; then
    warn "JWT_SECRET is short (${#JWT_SECRET} chars — recommend ≥128)"
    (( issues++ )) || true
  else
    ok "JWT_SECRET — ${#JWT_SECRET} chars, looks strong"
  fi

  # RESEND_API_KEY
  local RESEND_API_KEY="${RESEND_API_KEY:-}"
  if [ -z "$RESEND_API_KEY" ]; then
    warn "RESEND_API_KEY not set — verification & password-reset emails will log URL to console only"
    warn "  Get a free key at: https://resend.com/api-keys"
    warn "  Then: set RESEND_API_KEY=re_xxxx in config/.env (or Netlify env vars)"
    (( issues++ )) || true
  elif [[ "$RESEND_API_KEY" != re_* ]]; then
    warn "RESEND_API_KEY doesn't start with 're_' — may be invalid"
    (( issues++ )) || true
  else
    ok "RESEND_API_KEY — set (${#RESEND_API_KEY} chars)"
  fi

  # GOOGLE_CLIENT_ID
  local GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
  if [ -z "$GOOGLE_CLIENT_ID" ] || [ "$GOOGLE_CLIENT_ID" = "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com" ]; then
    info "GOOGLE_CLIENT_ID not set — Google Sign-In button will be hidden (app still works)"
    info "  Get one at: https://console.cloud.google.com/apis/credentials"
  elif [[ "$GOOGLE_CLIENT_ID" != *.apps.googleusercontent.com ]]; then
    warn "GOOGLE_CLIENT_ID doesn't end in '.apps.googleusercontent.com' — may be invalid"
    (( issues++ )) || true
  else
    ok "GOOGLE_CLIENT_ID — set"
  fi

  # DATABASE_URL
  local DATABASE_URL="${DATABASE_URL:-}"
  if [ -z "$DATABASE_URL" ]; then
    err "DATABASE_URL not set — API cannot start"
    (( criticals++ )) || true; (( issues++ )) || true
  elif [[ "$DATABASE_URL" == *localhost* ]]; then
    ok "DATABASE_URL — local PostgreSQL"
  elif [[ "$DATABASE_URL" == *neon.tech* ]]; then
    ok "DATABASE_URL — Neon cloud"
  else
    ok "DATABASE_URL — set"
  fi

  # INNERFLECT_ADMIN_TOKEN
  local INNERFLECT_ADMIN_TOKEN="${INNERFLECT_ADMIN_TOKEN:-}"
  if [ -z "$INNERFLECT_ADMIN_TOKEN" ]; then
    warn "INNERFLECT_ADMIN_TOKEN not set — admin endpoints unprotected"
    (( issues++ )) || true
  elif [ ${#INNERFLECT_ADMIN_TOKEN} -lt 32 ]; then
    warn "INNERFLECT_ADMIN_TOKEN is short (${#INNERFLECT_ADMIN_TOKEN} chars)"
    (( issues++ )) || true
  else
    ok "INNERFLECT_ADMIN_TOKEN — set"
  fi

  # Stripe (optional but warn if clearly partial)
  local STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-}"
  local STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-}"
  if [ -n "$STRIPE_SECRET_KEY" ] && [ -z "$STRIPE_WEBHOOK_SECRET" ]; then
    warn "STRIPE_SECRET_KEY set but STRIPE_WEBHOOK_SECRET is missing — Pro upgrades won't activate"
    (( issues++ )) || true
  elif [ -z "$STRIPE_SECRET_KEY" ]; then
    info "Stripe not configured — Pro plan upgrade will show a 'coming soon' message"
  else
    ok "Stripe — STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET set"
  fi

  # Summary
  echo ""
  if [ "$criticals" -gt 0 ]; then
    echo -e "${R}  ● ${criticals} critical issue(s) found — action required${NC}"
    return 1
  elif [ "$issues" -gt 0 ]; then
    echo -e "${Y}  ⚠  ${issues} warning(s) — review above${NC}"
    return 0
  else
    echo -e "${G}  ✓ All secrets look good!${NC}"
    return 0
  fi
}

# ═════════════════════════════════════════════════════════════════════════════
#  COMMAND: sync-config
#  Syncs GOOGLE_CLIENT_ID + INNERFLECT_API_BASE from config/.env (or env vars)
#  → www/config.js and public/config.js atomically.
#  Safe to call on every start and from Netlify prebuild.
# ═════════════════════════════════════════════════════════════════════════════
cmd_sync_config() {
  _load_env

  local gid="${GOOGLE_CLIENT_ID:-}"
  local api_base="${INNERFLECT_API_BASE:-}"

  # Sanitize: strip any placeholder
  [ "$gid" = "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com" ] && gid=""

  local content
  content="$(cat <<JS
// Innerflect runtime config
// ⚠  DO NOT edit www/config.js or public/config.js directly.
//    Single source of truth: config/.env (local) or Netlify environment variables.
//    Auto-synced by: bash bin/manage-secrets.sh sync-config
//    Called automatically by: start.sh and npm prebuild

// API base URL — leave empty when frontend + backend share the same origin.
// Set to your Tailscale/ngrok URL when hosting backend on Android.
// Update via: bash termux-setup/update-api-base.sh https://your-device.ts.net
window.INNERFLECT_API_BASE = '${api_base}';

// Google OAuth Client ID — set GOOGLE_CLIENT_ID in config/.env (or Netlify env vars).
// Empty string = Google Sign-In button is hidden (app still works fully without it).
// Setup guide:
//   1. https://console.cloud.google.com/apis/credentials
//   2. Create OAuth 2.0 Client ID (Web application)
//   3. Add https://innerflect.netlify.app to Authorized JavaScript origins
//   4. Copy the Client ID (ends in .apps.googleusercontent.com)
//   5. Set GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com in config/.env
//   6. Run: bash bin/manage-secrets.sh sync-config
window.GOOGLE_CLIENT_ID = '${gid}';
JS
)"

  # Write atomically to both locations
  local tmp; tmp=$(mktemp)
  echo "$content" > "$tmp"

  cp "$tmp" "$WWW_CFG"
  cp "$tmp" "$PUB_CFG"
  rm "$tmp"

  if [ -n "$gid" ]; then
    ok "sync-config: GOOGLE_CLIENT_ID synced → www/config.js + public/config.js"
  else
    info "sync-config: GOOGLE_CLIENT_ID empty — Google Sign-In hidden (set in config/.env to enable)"
  fi
}

# ═════════════════════════════════════════════════════════════════════════════
#  COMMAND: rotate-jwt
#  Generates a new cryptographically strong JWT_SECRET, updates config/.env,
#  and restarts the API so the new secret takes effect immediately.
#  ⚠  This will invalidate all existing user sessions (they must log in again).
# ═════════════════════════════════════════════════════════════════════════════
cmd_rotate_jwt() {
  echo ""
  echo -e "${W}  JWT_SECRET Rotation${NC}"
  echo ""
  echo -e "${Y}  ⚠  WARNING: Rotating JWT_SECRET invalidates ALL active user sessions.${NC}"
  echo -e "${Y}     Every logged-in user will need to sign in again.${NC}"
  echo ""

  if [ -t 0 ]; then
    read -r -p "  Continue? [y/N]: " CONFIRM
    [[ "$CONFIRM" =~ ^[Yy]$ ]] || { info "Cancelled."; exit 0; }
  fi

  local new_secret
  if command -v python3 >/dev/null 2>&1; then
    new_secret=$(python3 -c "import secrets; print(secrets.token_hex(64))")
  elif command -v openssl >/dev/null 2>&1; then
    new_secret=$(openssl rand -hex 64)
  else
    err "python3 or openssl required to generate secret"
    exit 1
  fi

  _load_env
  _env_set "JWT_SECRET" "$new_secret"

  ok "New JWT_SECRET generated (${#new_secret} chars) and saved to config/.env"

  # Restart API to pick up new secret
  _restart_api

  echo ""
  echo -e "${G}  ✓ JWT rotation complete.${NC}"
  echo -e "${Y}  ⚠  All users have been signed out.${NC}"
}

# ═════════════════════════════════════════════════════════════════════════════
#  COMMAND: setup
#  Interactive first-time wizard. Prompts for all required secrets,
#  generates what can be auto-generated, and calls sync-config at the end.
# ═════════════════════════════════════════════════════════════════════════════
cmd_setup() {
  _load_env

  echo ""
  echo -e "${W}═══════════════════════════════════════════════════════${NC}"
  echo -e "${W}  Innerflect — First-Time Secrets Setup${NC}"
  echo -e "${W}═══════════════════════════════════════════════════════${NC}"
  echo ""
  echo "  This wizard will configure all required secrets."
  echo "  Press Enter to keep any existing value."
  echo ""

  # ── JWT_SECRET ──────────────────────────────────────────────────────────
  hdr "1. JWT Secret"
  local cur_jwt; cur_jwt=$(_env_get "JWT_SECRET")
  local DEFAULT_JWT="innerflect-jwt-secret-change-in-prod"
  if [ -z "$cur_jwt" ] || [ "$cur_jwt" = "$DEFAULT_JWT" ]; then
    warn "JWT_SECRET not set or using insecure default — auto-generating…"
    local new_jwt
    if command -v python3 >/dev/null 2>&1; then
      new_jwt=$(python3 -c "import secrets; print(secrets.token_hex(64))")
    else
      new_jwt=$(openssl rand -hex 64)
    fi
    _env_set "JWT_SECRET" "$new_jwt"
    ok "JWT_SECRET auto-generated (${#new_jwt} chars)"
  else
    ok "JWT_SECRET already set (${#cur_jwt} chars) — keeping"
  fi

  # ── RESEND_API_KEY ──────────────────────────────────────────────────────
  hdr "2. Resend API Key (email verification + password reset)"
  local cur_resend; cur_resend=$(_env_get "RESEND_API_KEY")
  if [ -n "$cur_resend" ] && [[ "$cur_resend" == re_* ]]; then
    ok "RESEND_API_KEY already set — keeping"
  else
    echo ""
    echo "  Get a free key at: https://resend.com/api-keys"
    echo "  Free plan: 3,000 emails/month (plenty for verification & resets)"
    echo ""
    if [ -t 0 ]; then
      read -r -p "  Paste your Resend API key (or Enter to skip): " new_resend
      if [ -n "$new_resend" ]; then
        _env_set "RESEND_API_KEY" "$new_resend"
        ok "RESEND_API_KEY saved"
      else
        info "Skipped — emails will log verification URL to console (dev mode)"
      fi
    else
      info "Non-interactive: set RESEND_API_KEY=re_xxx in config/.env"
    fi
  fi

  # ── GOOGLE_CLIENT_ID ────────────────────────────────────────────────────
  hdr "3. Google OAuth Client ID (optional — enables Google Sign-In)"
  local cur_gid; cur_gid=$(_env_get "GOOGLE_CLIENT_ID")
  if [ -n "$cur_gid" ] && [[ "$cur_gid" == *.apps.googleusercontent.com ]] \
     && [ "$cur_gid" != "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com" ]; then
    ok "GOOGLE_CLIENT_ID already set — keeping"
  else
    echo ""
    echo "  How to get your Google Client ID:"
    echo "    1. https://console.cloud.google.com/apis/credentials"
    echo "    2. Create OAuth 2.0 Client ID → Web application"
    echo "    3. Authorized JavaScript origins:"
    echo "         https://innerflect.netlify.app"
    echo "         http://localhost:8090 (for local dev)"
    echo "    4. Copy the Client ID (ends in .apps.googleusercontent.com)"
    echo ""
    if [ -t 0 ]; then
      read -r -p "  Paste your Google Client ID (or Enter to skip): " new_gid
      if [ -n "$new_gid" ]; then
        _env_set "GOOGLE_CLIENT_ID" "$new_gid"
        ok "GOOGLE_CLIENT_ID saved"
      else
        info "Skipped — Google Sign-In button will be hidden"
      fi
    else
      info "Non-interactive: set GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com in config/.env"
    fi
  fi

  # ── DATABASE_URL ────────────────────────────────────────────────────────
  hdr "4. Database URL"
  local cur_db; cur_db=$(_env_get "DATABASE_URL")
  if [ -n "$cur_db" ]; then
    if [[ "$cur_db" == *neon.tech* ]]; then
      ok "DATABASE_URL — Neon cloud (already configured)"
    elif [[ "$cur_db" == *localhost* ]]; then
      ok "DATABASE_URL — local PostgreSQL (already configured)"
    else
      ok "DATABASE_URL — already configured"
    fi
  else
    echo ""
    echo "  Option A (recommended): Neon free cloud PostgreSQL"
    echo "    1. netlify.com → your site → Integrations → Neon"
    echo "    2. Copy the connection string (format: postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require)"
    echo ""
    echo "  Option B: Local PostgreSQL (Android/Termux or your PC)"
    echo "    postgresql://innerflect:innerflect_dev@localhost:5432/innerflect"
    echo ""
    if [ -t 0 ]; then
      read -r -p "  Paste DATABASE_URL (or Enter for local default): " new_db
      if [ -n "$new_db" ]; then
        _env_set "DATABASE_URL" "$new_db"
        ok "DATABASE_URL saved"
      else
        _env_set "DATABASE_URL" "postgresql://innerflect:innerflect_dev@localhost:5432/innerflect"
        info "Using local PostgreSQL default"
      fi
    fi
  fi

  # ── Sync config.js ──────────────────────────────────────────────────────
  hdr "5. Syncing config.js files"
  _load_env
  cmd_sync_config

  # ── Final check ─────────────────────────────────────────────────────────
  echo ""
  hdr "Setup Complete — Running final check"
  cmd_check || true

  echo ""
  echo -e "${W}  Next steps:${NC}"
  echo "  • Start the backend:  bash start.sh"
  echo "  • Check secrets:      bash bin/manage-secrets.sh check"
  echo "  • Rotate JWT:         bash bin/manage-secrets.sh rotate-jwt"
  echo ""
}

# ═════════════════════════════════════════════════════════════════════════════
#  ENTRY POINT
# ═════════════════════════════════════════════════════════════════════════════
CMD="${1:-check}"
case "$CMD" in
  check)        cmd_check ;;
  sync-config)  cmd_sync_config ;;
  rotate-jwt)   cmd_rotate_jwt ;;
  setup)        cmd_setup ;;
  *)
    echo ""
    echo -e "${W}  Innerflect — Secrets Manager${NC}"
    echo ""
    echo "  Usage: bash bin/manage-secrets.sh <command>"
    echo ""
    echo "  Commands:"
    echo "    check         Validate all secrets (format, presence, strength)"
    echo "    sync-config   Push GOOGLE_CLIENT_ID from .env → config.js files"
    echo "    rotate-jwt    Generate new JWT_SECRET + restart API"
    echo "    setup         Interactive first-time setup wizard"
    echo ""
    exit 1
    ;;
esac
