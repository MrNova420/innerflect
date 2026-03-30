/**
 * Auto-detects the best WebLLM model for the current device.
 *
 * PRIMARY TARGET: low-end mobile phones.
 *   - Llama 3.2 1B (~700MB, no shader-f16 needed) is the universal hero model.
 *   - On mobile we cap auto-selection at Llama 1B — bigger models won't
 *     be responsive enough for real-time chat on most phones.
 *   - Users can always manually switch to a larger model if they want.
 *
 * Detection uses:
 *  - navigator.userAgent      (mobile vs desktop)
 *  - WebGPU adapter features  (shader-f16 support)
 *  - WebGPU adapter limits    (maxBufferSize → GPU memory tier)
 *  - navigator.deviceMemory   (RAM hint, Chrome/Edge only)
 *  - Previously cached models (prefer what's already downloaded)
 */

/** True when running on a phone or tablet */
export function isMobileDevice() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

export const MODELS = [
  {
    id: 'SmolLM2-135M-Instruct-q0f16-MLC',
    label: 'SmolLM2 135M',
    size: '~270 MB',
    sizeMB: 270,
    desc: 'Ultra-light — loads in seconds. Best for very limited devices or a quick check-in.',
    badge: '⚡ Lightest',
    phoneTag: null,           // requires shader-f16 — not safe to auto-pick on all phones
    minRam: 0,
    gpuTier: 0,
    requiresF16: true,
  },
  {
    id: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
    label: 'SmolLM2 360M',
    size: '~360 MB',
    sizeMB: 360,
    desc: 'Very lightweight. Loads fast — good step-up from 135M for richer responses.',
    badge: '⚡ Instant',
    phoneTag: null,           // requires shader-f16 — not universal on Android
    minRam: 1,
    gpuTier: 0,
    requiresF16: true,
  },
  {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    label: 'Llama 3.2 1B',
    size: '~700 MB',
    sizeMB: 700,
    desc: 'The sweet spot — fast, capable, works on any WebGPU device including most phones.',
    badge: '🚀 Recommended',
    phoneTag: '📱 Best for phones', // no shader-f16 needed — universal
    minRam: 2,
    gpuTier: 1,
    requiresF16: false,
  },
  {
    id: 'SmolLM2-1.7B-Instruct-q4f16_1-MLC',
    label: 'SmolLM2 1.7B',
    size: '~1.1 GB',
    sizeMB: 1100,
    desc: 'Noticeably sharper responses, still compact. Best on a capable phone or desktop.',
    badge: '💡 Sharp',
    phoneTag: '⚠️ High-end phones only',
    minRam: 3,
    gpuTier: 2,
    requiresF16: true,
  },
  {
    id: 'gemma-2-2b-it-q4f16_1-MLC',
    label: 'Gemma 2 2B',
    size: '~1.3 GB',
    sizeMB: 1300,
    desc: "Google's Gemma — strong empathy and nuanced reasoning. Desktop or high-end phone.",
    badge: '💎 Balanced',
    phoneTag: '⚠️ High-end phones only',
    minRam: 4,
    gpuTier: 2,
    requiresF16: true,
  },
  {
    id: 'Phi-3.5-mini-instruct-q4f16_1-MLC',
    label: 'Phi-3.5-mini',
    size: '~2.3 GB',
    sizeMB: 2300,
    desc: 'Best therapy quality. Needs 4GB+ GPU — desktop or high-end device only.',
    badge: '⭐ Best',
    phoneTag: '🖥️ Desktop only',
    minRam: 6,
    gpuTier: 3,
    requiresF16: false,
  },
]

export const DEFAULT_MODEL_ID = 'Phi-3.5-mini-instruct-q4f16_1-MLC'
export const STORAGE_KEY = 'innerflect_model_id'

// Migration: rename old viddeoxx_ keys to innerflect_ (one-time, preserves user preference)
;(function migrateStorageKeys() {
  const OLD_MODEL_KEY = 'viddeoxx_model_id'
  const OLD_VISIT_KEY = 'viddeoxx_first_visit_done'
  const OLD_FP_KEY    = 'vx_fp'
  const OLD_USAGE_KEY = 'Innerflect_usage'
  if (localStorage.getItem(OLD_MODEL_KEY) && !localStorage.getItem('innerflect_model_id')) {
    localStorage.setItem('innerflect_model_id', localStorage.getItem(OLD_MODEL_KEY))
    localStorage.removeItem(OLD_MODEL_KEY)
  }
  if (localStorage.getItem(OLD_VISIT_KEY) && !localStorage.getItem('innerflect_first_visit_done')) {
    localStorage.setItem('innerflect_first_visit_done', localStorage.getItem(OLD_VISIT_KEY))
    localStorage.removeItem(OLD_VISIT_KEY)
  }
  if (localStorage.getItem(OLD_FP_KEY) && !localStorage.getItem('innerflect_fp')) {
    localStorage.setItem('innerflect_fp', localStorage.getItem(OLD_FP_KEY))
    localStorage.removeItem(OLD_FP_KEY)
  }
  if (localStorage.getItem(OLD_USAGE_KEY) && !localStorage.getItem('innerflect_usage')) {
    localStorage.setItem('innerflect_usage', localStorage.getItem(OLD_USAGE_KEY))
    localStorage.removeItem(OLD_USAGE_KEY)
  }
})()

// Quick (progressive-load) models:
//   F16 devices  → SmolLM2-135M q0f16  (360MB VRAM, loads in seconds)
//   Compat devices → SmolLM2-360M q4f32 (580MB VRAM, no shader-f16 needed)
export const QUICK_MODEL_F16   = 'SmolLM2-135M-Instruct-q0f16-MLC'
export const QUICK_MODEL_COMPAT = 'SmolLM2-360M-Instruct-q4f32_1-MLC'

/** Returns the right quick model ID for this device */
export function getQuickModelId(supportsF16) {
  return supportsF16 ? QUICK_MODEL_F16 : QUICK_MODEL_COMPAT
}

/** Filter MODELS to only those compatible with this device */
export function getCompatibleModels(supportsF16) {
  return MODELS.filter(m => !m.requiresF16 || supportsF16)
}

/**
 * Detects WebGPU capabilities: GPU memory tier + shader-f16 support.
 * Returns { tier: 0-3, supportsF16: boolean }
 *
 * On mobile, maxBufferSize can be unreliable — we cross-reference
 * with deviceMemory to avoid over-recommending.
 */
async function detectGpuFeatures() {
  if (!navigator.gpu) return { tier: 0, supportsF16: false }
  try {
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) return { tier: 0, supportsF16: false }
    const supportsF16 = adapter.features.has('shader-f16')
    const maxBuf = adapter.limits.maxBufferSize || 0
    const GB = 1024 * 1024 * 1024
    // Tiers based on VRAM requirements:
    //   tier 3 → Phi-3.5-mini (~3.7GB VRAM): need 4GB+ buffer
    //   tier 2 → Gemma/SmolLM2-1.7B (~1.7-1.9GB): need 2GB+ buffer
    //   tier 1 → Llama 1B (~880MB):  need 1GB+ buffer
    //   tier 0 → SmolLM2 (~360-580MB): any WebGPU device
    let tier = 0
    if (maxBuf >= 4 * GB) tier = 3
    else if (maxBuf >= 2 * GB) tier = 2
    else if (maxBuf >= 1 * GB) tier = 1

    // On mobile, some drivers mis-report maxBufferSize.
    // If deviceMemory is available, use it to sanity-check — don't auto-pick
    // models that need more VRAM than the device has total RAM.
    const ram = navigator.deviceMemory || null
    if (ram !== null && isMobileDevice()) {
      if (ram <= 2 && tier > 0) tier = 0   // <2GB RAM phone → SmolLM2 tier only
      else if (ram <= 4 && tier > 1) tier = 1 // ≤4GB RAM → cap at Llama 1B tier
    }

    return { tier, supportsF16 }
  } catch {
    return { tier: 0, supportsF16: false }
  }
}

/**
 * Check which models are already cached in the browser (all variants).
 */
async function getCachedModels(webllm) {
  const cached = new Set()
  if (!webllm?.hasModelInCache) return cached
  // Check main models + compat quick model
  const allIds = [...MODELS.map(m => m.id), QUICK_MODEL_COMPAT]
  await Promise.all(
    allIds.map(async (id) => {
      try { if (await webllm.hasModelInCache(id)) cached.add(id) } catch { /* ignore */ }
    })
  )
  return cached
}

/**
 * Pick the best model for this device.
 *
 * MOBILE-FIRST: On phones and tablets, auto-selection caps at Llama 3.2 1B.
 *   - Llama 1B works on any WebGPU phone, fits in ~700MB, loads fast enough to chat
 *   - Larger models (Gemma 2B, Phi-3.5) may load but won't respond fast enough on most phones
 *   - Users can always manually switch up from the model picker
 *
 * Priority:
 *  1. User's explicit saved choice (localStorage) — always respected
 *  2. Best already-cached model that fits device
 *  3. Best model device can run, capped at Llama 1B for mobile
 *
 * Returns { modelId, reason, autoSelected, supportsF16, isMobile }
 */
export async function detectBestModel(webllm) {
  const mobile = isMobileDevice()

  // 1. User's explicit saved choice — always honour it
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved && MODELS.find(m => m.id === saved)) {
    const { supportsF16 } = await detectGpuFeatures()
    return { modelId: saved, reason: 'Your saved preference', autoSelected: false, supportsF16, isMobile: mobile }
  }

  const [ram, gpuFeatures, cachedSet] = await Promise.all([
    Promise.resolve(navigator.deviceMemory || 4),
    detectGpuFeatures(),
    webllm ? getCachedModels(webllm) : Promise.resolve(new Set()),
  ])
  const { tier: gpuTier, supportsF16 } = gpuFeatures

  // Filter to only models this device's GPU can run
  const compatible = getCompatibleModels(supportsF16)

  // On mobile: restrict auto-selection to models at or below Llama 1B tier (gpuTier ≤ 1)
  // This prevents auto-downloading 1.3GB+ models on phones where they'd be painfully slow
  const autoPool = mobile
    ? compatible.filter(m => m.gpuTier <= 1)
    : compatible

  // 2. Best cached model from the auto-pool that fits device
  if (cachedSet.size > 0) {
    const bestCached = [...autoPool]
      .reverse()
      .find(m => cachedSet.has(m.id) && ram >= m.minRam && gpuTier >= m.gpuTier)
    if (bestCached) {
      return {
        modelId: bestCached.id,
        reason: `Already on your device · ${bestCached.size}`,
        autoSelected: true,
        fromCache: true,
        supportsF16,
        isMobile: mobile,
      }
    }
    // Also check if any bigger model is cached (user downloaded manually) — prefer that
    if (!mobile) {
      const bigCached = [...compatible]
        .reverse()
        .find(m => cachedSet.has(m.id) && ram >= m.minRam && gpuTier >= m.gpuTier)
      if (bigCached) {
        return {
          modelId: bigCached.id,
          reason: `Already on your device · ${bigCached.size}`,
          autoSelected: true,
          fromCache: true,
          supportsF16,
          isMobile: mobile,
        }
      }
    }
  }

  // 3. Best model this device can run (within auto-pool)
  const best = [...autoPool]
    .reverse()
    .find(m => ram >= m.minRam && gpuTier >= m.gpuTier)
    // Universal fallback: Llama 1B — no shader-f16 required, works everywhere
    || MODELS.find(m => m.id === 'Llama-3.2-1B-Instruct-q4f16_1-MLC')
    || compatible[0]

  const reasons = []
  if (mobile) reasons.push('phone-optimized')
  if (navigator.deviceMemory) reasons.push(`~${ram}GB RAM`)
  reasons.push(gpuTier >= 2 ? 'capable GPU' : gpuTier === 1 ? 'mid GPU' : 'basic GPU')
  if (!supportsF16) reasons.push('compat mode')

  return {
    modelId: best.id,
    reason: `Auto-selected (${reasons.join(', ')})`,
    autoSelected: true,
    fromCache: false,
    supportsF16,
    isMobile: mobile,
  }
}

// Keys for session state
export const FIRST_VISIT_KEY = 'innerflect_first_visit_done'

/**
 * Returns true if we should do progressive loading.
 * Only on first-ever visit when the best model isn't already cached.
 */
export async function shouldProgressiveLoad(webllm, bestModelId, supportsF16) {
  const quickId = getQuickModelId(supportsF16)
  if (bestModelId === quickId) return false
  if (localStorage.getItem(STORAGE_KEY)) return false
  if (localStorage.getItem(FIRST_VISIT_KEY)) return false
  try {
    if (await webllm.hasModelInCache(bestModelId)) return false
  } catch {
    return true // default to progressive on cache check failure
  }
  return true
}

/** Call after user sends their first message — marks "not first visit" */
export function markFirstVisitDone() {
  localStorage.setItem(FIRST_VISIT_KEY, '1')
}
