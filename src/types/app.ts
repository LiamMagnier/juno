import type { ClientConversation, ClientQuota } from "@/types/chat";
import type { Provider } from "@/lib/providers";

export interface AppUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export interface ClientFolder {
  id: string;
  name: string;
}

export interface ClientSettings {
  theme: "light" | "dark" | "system";
  accent: string;
  defaultModel: string;
  /** Response-style preset id (see @/lib/personalities); "default" injects nothing. */
  personality: string;
  customInstructions: string;
  responseLanguage: string;
  memoryEnabled: boolean;
  voiceId: string | null;
  favoriteModels: string[];
  /** Lifecycle email opt-ins — no-ops until email delivery is configured. */
  emailBudgetAlerts: boolean;
  emailWeeklyDigest: boolean;
}

/** One rolling usage window (5-hour session or weekly) for the settings gauge. */
export interface ClientUsageWindow {
  /** spend ÷ this window's proportional budget (0..∞; 1 = on pace for the monthly cap). */
  pct: number;
  /** Epoch ms when this rolling window next frees up. */
  resetsAtMs: number;
}

/** Usage status for the settings gauge (micro-USD integers). */
export interface ClientSpend {
  spentMicroUsd: number;
  /** null = unlimited (owner). */
  budgetMicroUsd: number | null;
  /** EUR per USD of model spend (display conversion; defaults to 1). */
  eurPerUsd: number;
  /** Rolling windows shown as percentages (no euro figures surfaced). */
  windows: { session: ClientUsageWindow; weekly: ClientUsageWindow };
  /** Billing cycle info for the "renews / cancels" line. */
  billing: {
    /** Epoch ms the budget renews (billing period end); null = unlimited / none. */
    renewsAtMs: number | null;
    /** Subscription is set to end at period end rather than renew. */
    cancelAtPeriodEnd: boolean;
  };
}

export interface AppBootstrap {
  user: AppUser;
  settings: ClientSettings;
  quota: ClientQuota;
  spend: ClientSpend;
  conversations: ClientConversation[];
  folders: ClientFolder[];
  features: {
    billing: boolean;
    /** Server speech-to-text is configured — dictation transcribes with a real
     *  STT model instead of the browser's (poor, English-biased) recognizer. */
    serverStt: boolean;
    /** Server text-to-speech is configured — read-aloud uses a multilingual
     *  model instead of the OS voice. */
    serverTts: boolean;
    /** Which TTS provider is actually in use. The read-aloud voice picker lists
     *  OpenAI's voices, so it is only meaningful when this is "openai": under
     *  ElevenLabs those ids mean nothing and the choice is silently ignored. */
    ttsProvider: "openai" | "elevenlabs" | null;
    storage: boolean;
    webSearch: boolean;
    /** Deep research is configured (TAVILY_API_KEY present) — gates the composer toggle. */
    deepResearch: boolean;
    /** Email delivery is configured (RESEND_API_KEY present). */
    email: boolean;
    providers: Provider[];
    isOwner: boolean;
  };
}
