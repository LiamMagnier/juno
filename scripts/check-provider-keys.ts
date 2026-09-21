/**
 * Which model-provider keys this deployment can actually use.
 *
 *   npm run providers:check
 *
 * The gap this closes: `PROD_ENV` is a write-only GitHub secret, so nobody can
 * read back what is in it, and the deploy's own validation only asserts that
 * each key is PRESENT and non-empty:
 *
 *     if ! printf '%s\n' "$PROD_ENV" | grep -Eq "^${name}=.+$"; then
 *
 * A revoked key passes that. So does a key for the wrong account, and so does
 * the literal string `sk-paste-the-working-key`. The first anyone learns of it
 * is a 401 in `pm2 logs` twenty minutes later, on the far side of a deploy,
 * reported by whoever happened to pick that model.
 *
 * So this asks each provider directly, with the key this process would really
 * send. Real network calls on purpose: a check that mocked the providers would
 * pass on a typo'd key, which is the only thing it was written to catch.
 *
 * Exit status is 1 on a rejected or placeholder key — those are facts about the
 * credential itself. Everything else exits 0: an outage at one lab is not a
 * reason to fail, and neither is anything this script cannot pin on the key.
 *
 * In the deploy that non-zero exit is ADVISORY (`continue-on-error`), and that
 * is deliberate. The first real run failed the whole pipeline over a dead Meta
 * key and a placeholder MiniMax one — neither of which had anything to do with
 * the release being shipped, and one of which had evidently been broken for
 * some time. Holding every deploy hostage to fourteen third-party credentials
 * is a worse failure than the one it prevents. The annotations still land at
 * the top of the run, which is all this ever needed to do.
 *
 * It never prints a key. Only the provider, the env var to go fix, and what
 * that provider said back.
 */

import {
  PROVIDERS,
  PROVIDER_LIST,
  providerApiKey,
  providerBaseUrl,
  type Provider,
} from "../src/lib/providers";

const TIMEOUT_MS = 15_000;

/**
 * Values that are not credentials at all.
 *
 * Every one of these has been pasted into a real `.env` by someone following
 * an example — including, on 2026-09-21, `sk-paste-the-working-key` from a
 * command written in this very repo's chat. They reach the provider as a
 * perfectly well-formed bearer token and come back 401, which sends the reader
 * looking at the provider's console instead of at their own file.
 */
// Matched as SUBSTRINGS rather than prefixes on purpose. A prefix rule like
// /^(sk-)?(the|my|test)/ would reject `sk-thequickbrown…`, a perfectly real
// key, and a false positive here blocks a deploy — strictly worse than the
// miss it prevents. Every token below is one that does not occur in a
// generated credential, and whitespace inside a value never does either.
const PLACEHOLDER_RE = /(paste|placeholder|changeme|change-me|your[-_]?(api[-_]?)?key|xxxx|[<>\s])/i;

type State = "ok" | "rejected" | "placeholder" | "unprobeable" | "unreachable" | "not set";

interface Result {
  provider: Provider;
  state: State;
  detail: string;
}

/** Build the cheapest authenticated GET each provider offers. */
function probeFor(provider: Provider, key: string): { url: string; headers: Record<string, string> } | undefined {
  const def = PROVIDERS[provider];
  if (def.kind === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/models",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    };
  }
  const base = providerBaseUrl(provider);
  if (!base) return undefined;
  return {
    // Base URLs are stored with and without a trailing slash (Google's compat
    // shim ends in one), so normalise rather than template-joining.
    url: `${base.replace(/\/+$/, "")}/models`,
    headers: { Authorization: `Bearer ${key}` },
  };
}

/** Whatever the provider said, with any echo of the key removed. */
async function describe(res: Response, key: string): Promise<string> {
  let body = "";
  try {
    body = (await res.text()).slice(0, 300);
  } catch {
    body = "";
  }
  const safe = body.split(key).join("«key»").replace(/\s+/g, " ").trim();
  return safe ? `${res.status} ${safe.slice(0, 140)}` : `${res.status}`;
}

async function check(provider: Provider): Promise<Result> {
  const key = providerApiKey(provider);
  if (!key) return { provider, state: "not set", detail: `set ${PROVIDERS[provider].apiKeyEnv}` };

  if (PLACEHOLDER_RE.test(key)) {
    return { provider, state: "placeholder", detail: "the value is an example, not a credential" };
  }

  const probe = probeFor(provider, key);
  if (!probe) return { provider, state: "unprobeable", detail: "no base URL configured" };

  let res: Response;
  try {
    res = await fetch(probe.url, { headers: probe.headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return { provider, state: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }

  if (res.ok) return { provider, state: "ok", detail: `${res.status}` };
  // 401 ONLY, and the exclusion of 403 is load-bearing rather than fussy.
  //
  // The first run of this script reported `openai REJECTED 403` — and the 403
  // came from a network egress proxy ("Host not in allowlist: api.openai.com"),
  // not from OpenAI. Nothing in the response distinguishes that from a real
  // entitlement 403, so a gate that failed on 403 would block a deploy over a
  // perfectly good key the moment a proxy, WAF or geo-block sat in the path.
  //
  // Dropping 403 costs nothing either, because a provider's own 403 means "this
  // key is valid but not entitled to this route" — which is not the claim this
  // script makes. 401 is the one status that means the credential is wrong.
  if (res.status === 401) {
    return { provider, state: "rejected", detail: await describe(res, key) };
  }
  // Not every lab uses 401. xAI answers a bad key with
  //   400 {"code":"invalid-argument","error":"Incorrect API key provided..."}
  // which this script first reported as merely "unreachable" — the one bad key
  // in production it looked straight at and waved through. A 400 is only read
  // as a verdict when the body says so in as many words; a 400 about anything
  // else is still a request problem, not a credential one.
  if (res.status === 400) {
    const body = await describe(res, key);
    if (/incorrect api key|invalid api[- _]?key|api[- _]?key.*(invalid|incorrect|expired)/i.test(body)) {
      return { provider, state: "rejected", detail: body };
    }
    return { provider, state: "unreachable", detail: body };
  }
  if (res.status === 403) {
    return { provider, state: "unreachable", detail: `403 (proxy, WAF or entitlement — not a key verdict)` };
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    return { provider, state: "unprobeable", detail: `${res.status} — no /models route to ask` };
  }
  return { provider, state: "unreachable", detail: await describe(res, key) };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

const MARK: Record<State, string> = {
  ok: "OK",
  rejected: "REJECTED",
  placeholder: "PLACEHOLDER",
  unprobeable: "can't probe",
  unreachable: "unreachable",
  "not set": "not set",
};

async function main() {
  const results = await Promise.all(PROVIDER_LIST.map(check));

  console.log("\n" + pad("PROVIDER", 14) + pad("KEY", 22) + pad("STATE", 14) + "DETAIL");
  console.log("─".repeat(100));
  for (const r of results) {
    console.log(
      pad(r.provider, 14) + pad(PROVIDERS[r.provider].apiKeyEnv, 22) + pad(MARK[r.state], 14) + r.detail,
    );
  }

  const bad = results.filter((r) => r.state === "rejected" || r.state === "placeholder");
  const live = results.filter((r) => r.state === "ok");
  console.log(
    `\n${live.length} accepted · ${results.filter((r) => r.state === "not set").length} not configured · ${bad.length} bad\n`,
  );

  if (bad.length) {
    for (const r of bad) {
      const def = PROVIDERS[r.provider];
      // ::error:: so GitHub surfaces it on the run summary, not only in the log.
      console.log(
        `::error::${def.apiKeyEnv} is not a working key for ${def.label} — ${r.detail}. New key: ${def.docsUrl}`,
      );
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("provider key check failed to run:", err);
  process.exit(1);
});
