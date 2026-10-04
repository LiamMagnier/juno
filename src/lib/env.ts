/**
 * Centralized, typed access to environment variables.
 *
 * Required vars are read lazily (only when used) so that an incomplete .env
 * never crashes the whole build. Optional providers (voice, storage, Stripe)
 * expose `isXConfigured()` helpers so the app can degrade gracefully.
 */

import { providerApiKey } from "@/lib/providers";
import { ttsProviderOrder } from "@/lib/tts-order";
import type { TtsProvider } from "@/lib/voices";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
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

  // App downloads: a READ-ONLY GitHub token (fine-grained, Contents: read on
  // LiamMagnier/juno) used ONLY by the release feed behind /api/downloads,
  // /download and the Mac updater, to list releases and sign asset downloads.
  // Optional — without it the feed reads GitHub anonymously, as it always did,
  // which for a private repository means it sees no releases at all. Never
  // GITHUB_DISPATCH_TOKEN: that one's actions:write exists for workflow_dispatch
  // alone. A getter so a test can set it after import. Add to PROD_ENV.
  get releasesGithubToken(): string | undefined {
    return process.env.JUNO_RELEASES_GITHUB_TOKEN?.trim() || undefined;
  },

  // Secret-at-rest encryption key rotation (required in production). Without these, every
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
    priceLite: process.env.STRIPE_PRICE_LITE,
    pricePro: process.env.STRIPE_PRICE_PRO,
    pricePlus: process.env.STRIPE_PRICE_PLUS,
    priceMax: process.env.STRIPE_PRICE_MAX,
    priceMax20: process.env.STRIPE_PRICE_MAX20,
    priceUltra: process.env.STRIPE_PRICE_ULTRA,
    // Annual equivalents. Same entitlement, different Stripe billing interval:
    // ten months' price for twelve (ANNUAL_MONTHS_BILLED in price-display.ts).
    priceLiteYearly: process.env.STRIPE_PRICE_LITE_YEARLY,
    priceProYearly: process.env.STRIPE_PRICE_PRO_YEARLY,
    pricePlusYearly: process.env.STRIPE_PRICE_PLUS_YEARLY,
    priceMaxYearly: process.env.STRIPE_PRICE_MAX_YEARLY,
    priceMax20Yearly: process.env.STRIPE_PRICE_MAX20_YEARLY,
    priceUltraYearly: process.env.STRIPE_PRICE_ULTRA_YEARLY,
    // One-time usage top-up packs (Stripe one-off prices, see src/lib/credits.ts).
    priceTopUp5: process.env.STRIPE_PRICE_TOPUP_5,
    priceTopUp20: process.env.STRIPE_PRICE_TOPUP_20,
    // Stripe Tax computes and collects the buyer's VAT (FR 20%, OSS for other
    // EU consumers, reverse charge for EU businesses with a VAT number). On by
    // default; "false" only for a test account without Stripe Tax set up.
    automaticTax: process.env.STRIPE_AUTOMATIC_TAX !== "false",
  },

  // App Store Server API / StoreKit 2 (optional — native billing is refused
  // rather than trusting a client-supplied receipt when this is incomplete).
  // `rootCertificates` holds comma-separated base64 DER Apple root CAs.
  appStore: {
    bundleId: process.env.APP_STORE_BUNDLE_ID,
    appAppleId: process.env.APP_STORE_APPLE_ID,
    environment: process.env.APP_STORE_ENVIRONMENT ?? "Production",
    rootCertificates: process.env.APP_STORE_ROOT_CERTIFICATES,
    enableOnlineChecks: process.env.APP_STORE_ENABLE_ONLINE_CHECKS !== "false",
  },

  // Voice (optional — falls back to the browser's Web Speech API, i.e. the OS
  // voice, which reads non-English text with an English accent and transcribes
  // non-English speech poorly. Read-aloud turns on by itself when the Google
  // key is set (Gemini 3.8 Flash TTS); STT_PROVIDER enables dictation.)
  voice: {
    sttProvider: process.env.STT_PROVIDER, // "openai" | "deepgram"
    // Unset: Gemini when GOOGLE_API_KEY/GEMINI_API_KEY is set, then OpenAI, then
    // ElevenLabs as fallbacks. Set to force one to the front (see tts-order.ts).
    ttsProvider: process.env.TTS_PROVIDER, // "google" | "openai" | "elevenlabs"
    // Gemini TTS reads each language natively (130+, auto-detected) and returns
    // a complete WAV. gemini-3.8-flash-lite-tts is the cheaper sibling.
    googleTtsModel: process.env.GOOGLE_TTS_MODEL || "gemini-3.8-flash-tts",
    // Deliberately unvetted, like TTS_VOICE: lets an operator adopt a voice
    // Google ships before voices.ts lists it.
    googleTtsVoice: process.env.GOOGLE_TTS_VOICE || "Kore",
    openaiApiKey: process.env.OPENAI_API_KEY,
    // gpt-4o-transcribe is markedly more accurate than whisper-1 on French and
    // other non-English speech; override only to pin an older/cheaper model.
    sttModel: process.env.STT_MODEL || "gpt-4o-transcribe",
    // OpenAI's model and voice. gpt-4o-mini-tts speaks each language natively
    // rather than transliterating.
    ttsModel: process.env.TTS_MODEL || "gpt-4o-mini-tts",
    ttsVoice: process.env.TTS_VOICE || "alloy",
    deepgramApiKey: process.env.DEEPGRAM_API_KEY,
    elevenlabsApiKey: process.env.ELEVENLABS_API_KEY,
    elevenlabsVoiceId: process.env.ELEVENLABS_VOICE_ID,
  },

  // Agent computers (optional — disabled unless AGENT_COMPUTER_PROVIDER / COMPUTER_PROVIDER is set)
  agentComputer: {
    get provider(): string {
      return (
        process.env.COMPUTER_PROVIDER ??
        process.env.AGENT_COMPUTER_PROVIDER ??
        ""
      ).trim();
    },
    /**
     * The tag `deploy/agent-computers/setup-vm.sh` builds. The default here
     * used to be a different tag, which left the feature silently off on a
     * server set up exactly as documented (`available()` reported the image
     * missing).
     */
    get image(): string {
      // The tag setup-vm.sh builds. A different default here left the feature
      // silently off on a server set up exactly as documented.
      return (
        process.env.COMPUTER_DOCKER_IMAGE ??
        process.env.AGENT_COMPUTER_IMAGE ??
        ""
      ).trim() || "juno-computer:1";
    },
    get storageRoot(): string {
      return (process.env.AGENT_COMPUTER_STORAGE_ROOT ?? "").trim() || "/var/lib/juno-computers";
    },
    /** The network setup-vm.sh creates (172.30.0.0/24, no container-to-container traffic). */
    get network(): string {
      return (
        process.env.AGENT_COMPUTER_NETWORK ??
        process.env.COMPUTER_DOCKER_NETWORK ??
        ""
      ).trim() || "juno-computers";
    },
    get memoryMb(): number {
      return positiveNumber(process.env.COMPUTER_MEMORY_MB ?? process.env.AGENT_COMPUTER_MEMORY_MB, 2048);
    },
    get cpus(): number {
      return positiveNumber(process.env.COMPUTER_CPUS ?? process.env.AGENT_COMPUTER_CPUS, 2);
    },
    get shmMb(): number {
      return positiveNumber(process.env.AGENT_COMPUTER_SHM_MB, 1024);
    },
    get diskQuotaMb(): number {
      return positiveNumber(
        process.env.COMPUTER_DISK_LIMIT_MB ?? process.env.AGENT_COMPUTER_DISK_QUOTA_MB,
        10240
      );
    },
    /** Also read under the name the operations runbook documents (`COMPUTER_MAX_RUNNING_TOTAL`). */
    get maxAwakeHost(): number {
      return Math.floor(
        positiveNumber(process.env.AGENT_COMPUTER_MAX_AWAKE_HOST ?? process.env.COMPUTER_MAX_RUNNING_TOTAL, 6)
      );
    },
    /** Also read under the name the operations runbook documents (`COMPUTER_MAX_RUNNING_PER_USER`). */
    get maxAwakeUser(): number {
      return Math.floor(
        positiveNumber(process.env.AGENT_COMPUTER_MAX_AWAKE_USER ?? process.env.COMPUTER_MAX_RUNNING_PER_USER, 2)
      );
    },
    get minFreeMemMb(): number {
      return nonNegativeNumber(
        process.env.COMPUTER_MIN_FREE_MEMORY_MB ?? process.env.AGENT_COMPUTER_MIN_FREE_MEM_MB,
        1024
      );
    },
    get minFreeDiskMb(): number {
      if (process.env.COMPUTER_MIN_FREE_DISK_GB) {
        const gb = Number(process.env.COMPUTER_MIN_FREE_DISK_GB);
        if (Number.isFinite(gb) && gb >= 0) return gb * 1024;
      }
      return nonNegativeNumber(process.env.AGENT_COMPUTER_MIN_FREE_DISK_MB, 10240);
    },
    /** Idle minutes before an awake computer rests (`docker pause`). */
    get restMinutes(): number {
      if (process.env.COMPUTER_IDLE_PAUSE_SECONDS) {
        const s = Number(process.env.COMPUTER_IDLE_PAUSE_SECONDS);
        if (Number.isFinite(s) && s > 0) return s / 60;
      }
      return positiveNumber(process.env.AGENT_COMPUTER_REST_MINUTES, 3);
    },
    /** Idle hours before a computer sleeps (`docker stop`). */
    get sleepHours(): number {
      if (process.env.COMPUTER_IDLE_STOP_MINUTES) {
        const m = Number(process.env.COMPUTER_IDLE_STOP_MINUTES);
        if (Number.isFinite(m) && m > 0) return m / 60;
      }
      return positiveNumber(process.env.AGENT_COMPUTER_SLEEP_HOURS, 0.5);
    },
    /** Days asleep before a computer, its sign-ins and its files are destroyed. */
    get retentionDays(): number {
      return positiveNumber(process.env.COMPUTER_RETENTION_DAYS, 30);
    },
    get costUsdPerMin(): number {
      if (process.env.COMPUTER_COST_MICRO_USD_PER_SECOND) {
        const micro = Number(process.env.COMPUTER_COST_MICRO_USD_PER_SECOND);
        if (Number.isFinite(micro) && micro >= 0) return (micro * 60) / 1_000_000;
      }
      return nonNegativeNumber(process.env.AGENT_COMPUTER_COST_USD_PER_MIN, 0);
    },
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

/** App Store entitlement endpoints must fail closed until Apple verification is configured. */
export function isAppStoreConfigured(): boolean {
  const appStore = env.appStore;
  return Boolean(
    appStore.bundleId
      && appStore.appAppleId
      && appStore.rootCertificates
      && appStore.environment === "Production"
  );
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

/** The server TTS engines to try, in order — empty when server TTS is off. */
export function serverTtsOrder(): TtsProvider[] {
  const v = env.voice;
  return ttsProviderOrder(v.ttsProvider, {
    google: Boolean(providerApiKey("google")),
    openai: Boolean(v.openaiApiKey),
    elevenlabs: Boolean(v.elevenlabsApiKey),
  });
}

export function isServerTtsConfigured(): boolean {
  return serverTtsOrder().length > 0;
}

/** The provider read-aloud uses when nothing fails — what the voice picker lists. */
export function activeTtsProvider(): TtsProvider | null {
  return serverTtsOrder()[0] ?? null;
}
