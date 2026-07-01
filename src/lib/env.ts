/**
 * Centralized, typed access to environment variables.
 *
 * Required vars are read lazily (only when used) so that an incomplete .env
 * never crashes the whole build. Optional providers (voice, storage, Stripe)
 * expose `isXConfigured()` helpers so the app can degrade gracefully.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export const env = {
  // Core (required)
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get anthropicApiKey() {
    return required("ANTHROPIC_API_KEY");
  },
  get authSecret() {
    return required("AUTH_SECRET");
  },

  // App
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",

  // OAuth (optional — Google sign-in is hidden if absent)
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,

  // External tool connectors (OAuth apps you register once). A connector's
  // "Connect" button is shown only when its client id + secret are present.
  connectors: {
    github: {
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      // Remote MCP server the model will call with the user's token.
      mcpUrl: process.env.GITHUB_MCP_URL ?? "https://api.githubcopilot.com/mcp/",
    },
    figma: {
      clientId: process.env.FIGMA_OAUTH_CLIENT_ID,
      clientSecret: process.env.FIGMA_OAUTH_CLIENT_SECRET,
      mcpUrl: process.env.FIGMA_MCP_URL, // Figma remote MCP endpoint (no default)
    },
  },

  // Storage (S3-compatible — required only for uploads)
  s3: {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    bucket: process.env.S3_BUCKET,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    publicUrl: process.env.S3_PUBLIC_URL, // optional CDN/base URL for public objects
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  },

  // Stripe (optional — billing disabled if absent)
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    pricePro: process.env.STRIPE_PRICE_PRO,
    priceMax: process.env.STRIPE_PRICE_MAX,
  },

  // Voice (optional — falls back to browser Web Speech API)
  voice: {
    sttProvider: process.env.STT_PROVIDER, // "openai" | "deepgram"
    ttsProvider: process.env.TTS_PROVIDER, // "openai" | "elevenlabs"
    openaiApiKey: process.env.OPENAI_API_KEY,
    deepgramApiKey: process.env.DEEPGRAM_API_KEY,
    elevenlabsApiKey: process.env.ELEVENLABS_API_KEY,
    elevenlabsVoiceId: process.env.ELEVENLABS_VOICE_ID,
  },

  isProd: process.env.NODE_ENV === "production",
};

export function isStorageConfigured(): boolean {
  const s = env.s3;
  return Boolean(s.bucket && s.accessKeyId && s.secretAccessKey);
}

/** Uploads are usable if S3 is set (cloud) OR we're on a writable filesystem
 *  (local dev disk fallback). On Vercel without S3 the disk is ephemeral, so
 *  uploads require a cloud bucket there. */
export function isStorageAvailable(): boolean {
  return isStorageConfigured() || process.env.VERCEL !== "1";
}

export function isStripeConfigured(): boolean {
  return Boolean(env.stripe.secretKey && env.stripe.pricePro && env.stripe.priceMax);
}

export function isGoogleConfigured(): boolean {
  return Boolean(env.googleClientId && env.googleClientSecret);
}

export function isServerSttConfigured(): boolean {
  const v = env.voice;
  if (v.sttProvider === "openai") return Boolean(v.openaiApiKey);
  if (v.sttProvider === "deepgram") return Boolean(v.deepgramApiKey);
  return false;
}

export function isServerTtsConfigured(): boolean {
  const v = env.voice;
  if (v.ttsProvider === "openai") return Boolean(v.openaiApiKey);
  if (v.ttsProvider === "elevenlabs") return Boolean(v.elevenlabsApiKey);
  return false;
}
