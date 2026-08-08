import "server-only";
import OpenAI from "openai";
import {
  resolveBackgroundCandidates,
  type BackgroundProcessingRecord,
  type BackgroundProviderPolicy,
  type BackgroundDenialReason,
} from "@/lib/background-provider-policy";
import { isProviderConfigured, providerApiKey, providerBaseUrl, type Provider } from "@/lib/providers";

/**
 * Embeddings for the knowledge index.
 *
 * Two things this module exists to say out loud.
 *
 * First: **embedding a user's private documents is background work.** It is the
 * most content-revealing background job Juno has — memory extraction sends one
 * conversation's messages, whereas indexing sends every paragraph of every file
 * someone uploaded — so it resolves its provider through
 * `background-provider-policy` exactly like the rest, and it is subject to the
 * same deployment allowlist. A user whose policy is `same_provider` on an
 * Anthropic conversation gets *no* embedding provider, because Anthropic has no
 * embeddings endpoint (their own guidance is to use a third party for it). That
 * is not a bug to route around: sending the documents to OpenAI instead is
 * precisely the cross-provider send the policy forbids.
 *
 * Second: **no provider is a degradation, not a failure.** Retrieval keeps
 * working without vectors — Postgres full-text is still there, and a lexical
 * hit with a real citation beats an error page. `embedTexts` therefore returns
 * an outcome rather than throwing, and `retrieve.ts` reads `ok: false` as
 * "lexical only" and says so to the caller.
 *
 * The vector space is per-model, so every chunk stores `embeddingModel`
 * alongside its vector. Cosine between two different models' vectors is a
 * number with no meaning, and without the column there would be no way to tell
 * that a re-index had silently mixed two of them.
 */

export interface EmbeddingModelInfo {
  /** Canonical id, "provider:model", matching the chat catalog's convention. */
  id: string;
  provider: Provider;
  /** The id sent to the provider API. */
  providerModel: string;
  /** Vector length, used to reject a stored vector from a different space. */
  dimensions: number;
  /**
   * Never true today: every provider here is a third party. The field exists
   * because `resolveBackgroundCandidates` uses it, and its absence is the
   * reason a `local_only` policy denies embedding outright — which is the
   * correct answer for that policy, not an oversight.
   */
  isLocal?: boolean;
}

/**
 * Providers with a documented OpenAI-compatible `/embeddings` endpoint, in
 * preference order within each provider.
 *
 * Curated rather than discovered: `models.generated.ts` lists chat models, and
 * an embedding model that appears in a `/models` listing still cannot be called
 * on the chat path. Anthropic and DeepSeek are absent because they ship no
 * embeddings endpoint at all — see the note above for why that absence is load-
 * bearing rather than a gap to fill.
 */
export const EMBEDDING_MODELS: readonly EmbeddingModelInfo[] = [
  { id: "openai:text-embedding-3-small", provider: "openai", providerModel: "text-embedding-3-small", dimensions: 1536 },
  { id: "openai:text-embedding-3-large", provider: "openai", providerModel: "text-embedding-3-large", dimensions: 3072 },
  { id: "google:text-embedding-004", provider: "google", providerModel: "text-embedding-004", dimensions: 768 },
  { id: "mistral:mistral-embed", provider: "mistral", providerModel: "mistral-embed", dimensions: 1024 },
  { id: "zhipu:embedding-3", provider: "zhipu", providerModel: "embedding-3", dimensions: 2048 },
  { id: "qwen:text-embedding-v3", provider: "qwen", providerModel: "text-embedding-v3", dimensions: 1024 },
];

/** Embedding models whose provider has an API key in this deployment. */
export function configuredEmbeddingModels(): EmbeddingModelInfo[] {
  return EMBEDDING_MODELS.filter((model) => isProviderConfigured(model.provider));
}

/** Why a batch produced no vectors. Every one of these degrades to lexical. */
export type EmbeddingUnavailableReason =
  /** Nothing to embed. */
  | "empty_input"
  /** No embedding provider is configured in this deployment at all. */
  | "no_configured_provider"
  /** One or more exist, but the account's background policy allows none of them. */
  | "denied_by_policy"
  /** Every permitted provider was tried and failed. */
  | "provider_failed";

export type EmbeddingOutcome =
  | { ok: true; model: EmbeddingModelInfo; vectors: number[][] }
  | { ok: false; reason: EmbeddingUnavailableReason; deniedReason?: BackgroundDenialReason };

/**
 * The provider call, injectable.
 *
 * Production uses the OpenAI-compatible client; tests supply a deterministic
 * fake, because there is no world in which a unit test should reach a paid
 * embeddings endpoint to prove that cosine ranks correctly.
 */
export type EmbeddingTransport = (opts: {
  model: EmbeddingModelInfo;
  texts: readonly string[];
  signal?: AbortSignal;
}) => Promise<number[][]>;

/**
 * Provider input limits are per-request and per-input, and exceeding either is
 * usually a truncation rather than an error — so the caller is charged for a
 * vector describing the first half of a chunk without ever being told. Both
 * caps are deliberately below the smallest documented limit in the catalog.
 */
const MAX_INPUTS_PER_REQUEST = 64;
const MAX_CHARS_PER_INPUT = 8_000;
const REQUEST_TIMEOUT_MS = 30_000;

const clients = new Map<Provider, OpenAI>();

function client(provider: Provider): OpenAI {
  const apiKey = providerApiKey(provider);
  if (!apiKey) throw new Error(`${provider} API key is not configured.`);
  let existing = clients.get(provider);
  if (!existing) {
    // Embedding retries can duplicate provider spend and produce vectors for a
    // job that has already advanced. The ingestion job owns bounded retries,
    // so the SDK must make exactly one request per job attempt.
    existing = new OpenAI({ apiKey, baseURL: providerBaseUrl(provider), maxRetries: 0 });
    clients.set(provider, existing);
  }
  return existing;
}

const openAiCompatibleTransport: EmbeddingTransport = async ({ model, texts, signal }) => {
  const response = await client(model.provider).embeddings.create(
    { model: model.providerModel, input: texts as string[] },
    { signal, timeout: REQUEST_TIMEOUT_MS }
  );
  // The API contract is that `data` comes back in input order, but it also
  // carries an explicit index; trusting the index costs nothing and a silently
  // permuted batch would attach every vector to the wrong chunk.
  const vectors: number[][] = new Array(texts.length);
  for (const item of response.data) vectors[item.index] = item.embedding as number[];
  if (vectors.some((vector) => !vector)) {
    throw new Error(`${model.id} returned ${response.data.length} vectors for ${texts.length} inputs.`);
  }
  return vectors;
};

export interface EmbedOptions {
  texts: readonly string[];
  /** Where this account's content may be sent. Required — there is no default. */
  policy: BackgroundProviderPolicy;
  /** Provider of the model the user chose, for `same_provider`. */
  conversationProvider?: string | null;
  /** Pin a model, e.g. to match vectors already stored for a document. */
  preferModelId?: string | null;
  signal?: AbortSignal;
  transport?: EmbeddingTransport;
  /** Receives what was decided, for the audit trail. Never given content. */
  onDecision?: (record: BackgroundProcessingRecord) => void;
}

/**
 * Embed a batch, or explain why not.
 *
 * Walks the permitted models in order and takes the first that answers. A
 * failure moves to the next *permitted* model — never outside the permitted
 * set, which is the difference between a fallback and a policy violation.
 */
export async function embedTexts(options: EmbedOptions): Promise<EmbeddingOutcome> {
  const texts = options.texts.map((text) => text.slice(0, MAX_CHARS_PER_INPUT));
  if (texts.length === 0) return { ok: false, reason: "empty_input" };

  const available = configuredEmbeddingModels();
  if (available.length === 0) {
    options.onDecision?.({
      purpose: "knowledge_embedding",
      mode: options.policy.mode,
      effectiveProvider: null,
      effectiveModel: null,
    });
    return { ok: false, reason: "no_configured_provider" };
  }

  const decision = resolveBackgroundCandidates({
    policy: options.policy,
    conversationProvider: options.conversationProvider,
    candidates: available,
  });
  if (decision.candidates.length === 0) {
    options.onDecision?.({
      purpose: "knowledge_embedding",
      mode: decision.mode,
      effectiveProvider: null,
      effectiveModel: null,
      deniedReason: decision.deniedReason,
    });
    return { ok: false, reason: "denied_by_policy", deniedReason: decision.deniedReason };
  }

  // A document already indexed with one model must keep being embedded with it,
  // or the query vector and the stored vectors stop being comparable. The
  // preference only reorders inside the permitted set; it cannot admit a model
  // the policy excluded.
  const candidates = options.preferModelId
    ? [
        ...decision.candidates.filter((model) => model.id === options.preferModelId),
        ...decision.candidates.filter((model) => model.id !== options.preferModelId),
      ]
    : decision.candidates;

  const transport = options.transport ?? openAiCompatibleTransport;

  for (const model of candidates) {
    try {
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += MAX_INPUTS_PER_REQUEST) {
        const batch = texts.slice(i, i + MAX_INPUTS_PER_REQUEST);
        vectors.push(...(await transport({ model, texts: batch, signal: options.signal })));
      }
      options.onDecision?.({
        purpose: "knowledge_embedding",
        mode: decision.mode,
        effectiveProvider: model.provider,
        effectiveModel: model.id,
      });
      return { ok: true, model, vectors };
    } catch (error) {
      // Logged rather than surfaced: the caller's fallback is lexical-only
      // retrieval, which is a working product, and an indexing job that dies
      // because one provider is rate-limited is not.
      console.error(
        `[knowledge/embed] ${model.id} failed:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return { ok: false, reason: "provider_failed" };
}

/** One text, one vector — the query side of retrieval. */
export async function embedQuery(
  options: Omit<EmbedOptions, "texts"> & { text: string }
): Promise<{ ok: true; model: EmbeddingModelInfo; vector: number[] } | { ok: false; reason: EmbeddingUnavailableReason }> {
  const text = options.text.trim();
  if (!text) return { ok: false, reason: "empty_input" };
  const outcome = await embedTexts({ ...options, texts: [text] });
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  return { ok: true, model: outcome.model, vector: outcome.vectors[0] };
}
