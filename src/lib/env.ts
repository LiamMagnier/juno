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

  // Cloud code runner (GitHub Actions): HMAC secret used to mint the per-task
  // bearer ("cct_…") handed to the runner so it can call back into Juno for the
  // exact task it was dispatched for. Kept SEPARATE from AUTH_SECRET so this
  // runner-facing surface is isolated (compromising one never yields the other).
  // MUST be added to the PROD_ENV secret (see .github/workflows/deploy.yml).
  get cloudCodeSecret() {
    return required("CLOUD_CODE_SECRET");
  },
  // Cloud code runner: a GitHub PAT/app token with `actions:write` on
  // LiamMagnier/juno, used ONLY to workflow_dispatch code-runner.yml. Optional —
  // when absent, cloud task creation fails with 503 (never silently). This token
  // never leaves the server; it is not the user's connector token. Add to PROD_ENV.
  githubDispatchToken: process.env.GITHUB_DISPATCH_TOKEN,
  // Cloud code runner: the repository whose GitHub Actions OIDC token is trusted
  // to redeem runner-context. The runner proves its identity with a GitHub-signed
  // OIDC JWT (audience "juno-cloud-code") — NO credential rides the workflow
  // inputs — and the backend requires the token's `repository` claim AND its
  // `job_workflow_ref` to be THIS repo's code-runner.yml. Optional — defaults to
  // "LiamMagnier/juno"; override only in a fork. If set, add to PROD_ENV.
  cloudCodeRepo: process.env.CLOUD_CODE_REPO ?? "LiamMagnier/juno",

  // Secret-at-rest encryption key rotation (optional). Without these, every
  // secret is sealed under a key derived from AUTH_SECRET (key id "auth"). To
  // rotate — including to decouple from AUTH_SECRET so it can itself be rotated
  // — supply explicit 32-byte keys and name the primary, then run
  // `npm run crypto:rotate` to re-seal existing rows. See src/lib/crypto.ts.
  tokenEncryptionKeys: process.env.TOKEN_ENCRYPTION_KEYS, // "id:material,id2:material" (hex or base64, 32 bytes each)
  tokenEncryptionPrimary: process.env.TOKEN_ENCRYPTION_PRIMARY, // key id that seals new writes (default "auth")

  // App
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",

  // OAuth (optional — Google sign-in is hidden if absent)
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,

  // External tool connectors (OAuth apps you register once). A connector's
  // "Connect" button is shown only when its client id + secret are present.
  connectors: {
    composio: {
      // One managed integration layer for the full Composio toolkit catalog.
      // Per-user OAuth credentials are stored and refreshed by Composio.
      apiKey: process.env.COMPOSIO_API_KEY,
    },
    github: {
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      // Remote MCP server the model will call with the user's token.
      mcpUrl: process.env.GITHUB_MCP_URL ?? "https://api.githubcopilot.com/mcp/",
    },
    figma: {
      clientId: process.env.FIGMA_OAUTH_CLIENT_ID,
      clientSecret: process.env.FIGMA_OAUTH_CLIENT_SECRET,
      // Space-separated OAuth scopes; must match what's enabled in the Figma app.
      scope: process.env.FIGMA_OAUTH_SCOPE,
      mcpUrl: process.env.FIGMA_MCP_URL, // Figma remote MCP endpoint (no default)
    },
    notion: {
      // Hosted Notion MCP uses OAuth 2.1 + PKCE + Dynamic Client Registration, so
      // there is no Notion client id/secret to configure — only the MCP endpoint.
      mcpUrl: process.env.NOTION_MCP_URL ?? "https://mcp.notion.com/mcp",
    },
    appleMusic: {
      // MusicKit developer credentials (Apple Developer → Certificates → Keys).
      // The .p8 private key may be pasted with literal \n escapes in the env var.
      teamId: process.env.APPLE_MUSIC_TEAM_ID,
      keyId: process.env.APPLE_MUSIC_KEY_ID,
      privateKey: process.env.APPLE_MUSIC_PRIVATE_KEY?.replace(/\\n/g, "\n"),
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
    priceMax20: process.env.STRIPE_PRICE_MAX20,
  },

  // Voice (optional — falls back to the browser's Web Speech API, i.e. the OS
  // voice, which reads non-English text with an English accent and transcribes
  // non-English speech poorly. Set STT_PROVIDER/TTS_PROVIDER to fix both.)
  voice: {
    sttProvider: process.env.STT_PROVIDER, // "openai" | "deepgram"
    ttsProvider: process.env.TTS_PROVIDER, // "openai" | "elevenlabs"
    openaiApiKey: process.env.OPENAI_API_KEY,
    // gpt-4o-transcribe is markedly more accurate than whisper-1 on French and
    // other non-English speech; override only to pin an older/cheaper model.
    sttModel: process.env.STT_MODEL || "gpt-4o-transcribe",
    // gpt-4o-mini-tts speaks each language natively rather than transliterating.
    ttsModel: process.env.TTS_MODEL || "gpt-4o-mini-tts",
    ttsVoice: process.env.TTS_VOICE || "alloy",
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

export function isComposioConfigured(): boolean {
  return Boolean(env.connectors.composio.apiKey);
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
