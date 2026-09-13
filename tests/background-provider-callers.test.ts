import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/*
 * Every background utility call states where it may be sent.
 *
 * WHY A SOURCE-READING TEST. `resolveBackgroundCandidates` is already covered
 * by tests/background-provider-policy.test.ts, and it is correct — including
 * the rule that makes this bug possible: `same_provider` matched against a null
 * provider yields NO candidates, because guessing would be the cross-provider
 * send the mode exists to forbid. The defect was never in the policy. It was
 * that `runUtilityPrompt` defaults `policy` to `same_provider` and
 * `conversationProvider` to nothing, so a call site that simply says neither
 * fails closed — silently, before a model is reached, with a `console.info` as
 * its only trace.
 *
 * That has now shipped six times, in six different features:
 *
 *   the memory manager      "Regenerate summary" and every natural-language
 *                           memory edit denied on a stock account — and
 *                           reported to the user as a rate limit
 *   /api/memory/edit        the same hole, in the route
 *   chat titles             every chat named by `fallbackChatTitle`, the first
 *                           seven words of the prompt. This is the one a user
 *                           reported, and finding it turned up the rest.
 *   follow-up pills         an empty list, which the client renders exactly
 *                           like "nothing worth suggesting"
 *   AI moderation           the classifier fails open, so a policy refusal and
 *                           a clean message are the same answer: layer 2 of 2
 *                           was not running
 *   UI translation          503, and the whole interface silently English in
 *                           every non-English locale
 *
 * Six times, one omission, and every one of them invisible: a denied walk logs
 * `console.info` and returns null, and every caller above reads null as
 * "nothing to say". What they share is not a behaviour a unit test can reach —
 * it is the SHAPE OF A CALL. So this reads the call sites, and a new one that
 * has not thought about the policy fails here rather than in someone's product
 * a month later.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** The object literal of a `runUtilityPrompt({ ... })` call, by brace matching. */
function callArguments(source: string, from: number): string {
  const open = source.indexOf("{", from);
  assert.notEqual(open, -1, "runUtilityPrompt called with no object literal");
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  assert.fail("unbalanced braces in a runUtilityPrompt call");
}

interface CallSite {
  file: string;
  args: string;
}

function utilityCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of walk(join(ROOT, "src"))) {
    // Comments stripped first. memory.ts's own prose names `runUtilityPrompt
    // (policy-checked)`, which reads as a call and sent the brace matcher into
    // the next unrelated literal.
    const body = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    // `runUtilityPrompt<ModerationHit | null>({` is a call too. Scanning for
    // the bare `runUtilityPrompt(` missed both generic call sites — one of
    // which, the moderation classifier, was denied on every message.
    for (const m of body.matchAll(/(function\s+)?\brunUtilityPrompt\s*(<[^(]*>)?\s*\(/g)) {
      // `function runUtilityPrompt<T>(opts: {…})` is the declaration, not a
      // call. Excluded by what precedes the name rather than by stripping the
      // definition out of the file: a strip that silently stops matching turns
      // this whole test into a pass.
      if (m[1]) continue;
      sites.push({ file: file.slice(ROOT.length), args: callArguments(body, m.index!) });
    }
  }
  return sites;
}

test("every runUtilityPrompt call site states a policy", () => {
  const sites = utilityCallSites();
  // A floor, so a refactor that stops finding the calls fails loudly instead of
  // passing vacuously.
  assert.ok(sites.length >= 7, `only ${sites.length} call sites found — is this test reading the right thing?`);

  for (const site of sites) {
    assert.match(
      site.args,
      /(^|[\s,{])policy[,:]/,
      `${site.file} calls runUtilityPrompt without naming a policy, so it inherits same_provider and is denied`,
    );
  }
});

test("every call site carrying user content anchors same_provider to a provider", () => {
  for (const site of utilityCallSites()) {
    // The platform policy is the one documented opt-out: no account behind the
    // call and no user content in it (Juno's own interface catalog). It states
    // `any_allowed_provider` explicitly, so there is nothing for a conversation
    // provider to anchor.
    if (site.args.includes("platformUtilityPolicy()")) continue;
    assert.match(
      site.args,
      /(^|[\s,{])conversationProvider[,:]/,
      `${site.file} calls runUtilityPrompt with no conversationProvider — same_provider matches nothing against null and the call is denied before a model is reached`,
    );
  }
});

/*
 * The two features this was reported on, named so a regression is legible in
 * the failure output rather than as "some file".
 */
test("chat naming and follow-up pills both resolve a provider", () => {
  const titles = readFileSync(join(ROOT, "src/lib/titles.ts"), "utf8");
  assert.match(
    titles,
    /accountBackgroundProvider/,
    "titles.ts must fall back to the account's own provider when a caller names none — a caller that says nothing must not mean a denial",
  );
  assert.match(titles, /loadBackgroundProviderPolicy/);

  const titleRoute = readFileSync(join(ROOT, "src/app/api/conversations/[id]/title/route.ts"), "utf8");
  assert.match(
    titleRoute,
    /select: \{[^}]*model: true/,
    "the title route must read the conversation's model — it is the provider same_provider matches",
  );

  const followUps = readFileSync(join(ROOT, "src/app/api/chat/follow-ups/route.ts"), "utf8");
  assert.match(
    followUps,
    /select: \{[^}]*model: true/,
    "the follow-ups route must read the conversation's model for the same reason",
  );
});
