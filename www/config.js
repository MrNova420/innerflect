// Innerflect runtime config
// ⚠  DO NOT edit www/config.js or public/config.js directly.
//    Single source of truth: config/.env (local) or Netlify environment variables.
//    Auto-synced by: bash bin/manage-secrets.sh sync-config
//    Called automatically by: start.sh and npm prebuild

// API base URL — leave empty when frontend + backend share the same origin.
// Set to your Tailscale/ngrok URL when hosting backend on Android.
// Update via: bash termux-setup/update-api-base.sh https://your-device.ts.net
window.INNERFLECT_API_BASE = '';

// Google OAuth Client ID — set GOOGLE_CLIENT_ID in config/.env (or Netlify env vars).
// Empty string = Google Sign-In button is hidden (app still works fully without it).
// Setup guide:
//   1. https://console.cloud.google.com/apis/credentials
//   2. Create OAuth 2.0 Client ID (Web application)
//   3. Add https://innerflect.netlify.app to Authorized JavaScript origins
//   4. Copy the Client ID (ends in .apps.googleusercontent.com)
//   5. Set GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com in config/.env
//   6. Run: bash bin/manage-secrets.sh sync-config
window.GOOGLE_CLIENT_ID = '';
