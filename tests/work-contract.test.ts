import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORK_CONTRACT,
  WORK_CONTRACT_VERSION,
  assertWorkContractMatchesDomain,
  summaryFor,
  type WorkContractVocabulary,
} from "@/lib/work/contract";
import * as domain from "@/lib/work/domain";

/*
 * Juno Work's vocabulary is enforced in three places that cannot see each
 * other: a TEXT column in Postgres, a literal union in TypeScript, and a Swift
 * enum on two clients. The capability manifest showed how that ends — Swift is
 * generated and stays right, the TypeScript union is typed by hand and quietly
 * stops matching, and nothing anywhere fails. These tests are the failure the
 * capability manifest does not have.
 */

const SWIFT_PATH = "native/Packages/JunoNativeKit/Sources/JunoCore/Generated/JunoWorkContract.swift";

const vocabularies = Object.entries(WORK_CONTRACT.vocabularies) as readonly [
  string,
  WorkContractVocabulary<string>,
][];

/** The same widening src/lib/work/contract.ts does, so a constant can be looked up by name. */
const domainExports: Record<string, unknown> = { ...domain };

/** WORK_TOOL_TIERS is the one constant whose elements announce themselves as `id`. */
function listValues(constant: unknown): string[] {
  assert.ok(Array.isArray(constant), "expected a list of values");
  return constant.map((element: unknown) =>
    typeof element === "string" ? element : (element as { id: string }).id
  );
}

test("the contract and domain.ts are the same vocabulary", () => {
  assertWorkContractMatchesDomain();
});

test("every vocabulary lists exactly its domain constant, in the same order", () => {
  // Written out here rather than delegated to assertWorkContractMatchesDomain,
  // because a bug in that function would otherwise pass its own test.
  for (const [id, vocabulary] of vocabularies) {
    assert.deepEqual(
      vocabulary.values.map((entry) => entry.value),
      listValues(domainExports[vocabulary.constant]),
      `${id} does not match ${vocabulary.constant}`
    );
  }
});

test("every list domain.ts exports is accounted for, and every list the contract names exists", () => {
  const accountedFor = new Set<string>();
  for (const [, vocabulary] of vocabularies) {
    accountedFor.add(vocabulary.constant);
    for (const partition of vocabulary.partitions ?? []) accountedFor.add(partition.constant);
  }

  const exported = Object.entries(domainExports)
    .filter(([, value]) => Array.isArray(value))
    .map(([name]) => name);

  assert.deepEqual([...exported].sort(), [...accountedFor].sort());
});

test("the derived subsets follow from the attributes rather than being restated", () => {
  assert.deepEqual(domain.WORK_LIVE_STATUSES.filter(domain.isTerminalStatus), []);
  assert.deepEqual(
    domain.WORK_TERMINAL_STATUSES.filter((status) => !domain.isTerminalStatus(status)),
    []
  );
  assert.deepEqual(
    WORK_CONTRACT.vocabularies.capabilities.values
      .filter((entry) => entry.requiresLocalHost === true)
      .map((entry) => entry.value),
    [...domain.LOCAL_ONLY_CAPABILITIES]
  );
  assert.deepEqual(
    WORK_CONTRACT.vocabularies.triggerKinds.values
      .filter((entry) => entry.requiresLocalHost === true)
      .map((entry) => entry.value),
    [...domain.LOCAL_ONLY_TRIGGER_KINDS]
  );
});

test("the attributes clients act on say what the server says", () => {
  for (const entry of WORK_CONTRACT.vocabularies.statuses.values) {
    assert.equal(
      entry.needsAttention,
      domain.statusNeedsAttention(entry.value),
      `${entry.value} disagrees about needing the user`
    );
  }
  for (const entry of WORK_CONTRACT.vocabularies.terminalReasons.values) {
    assert.equal(entry.status, domain.statusForTerminalReason(entry.value));
  }
  for (const entry of WORK_CONTRACT.vocabularies.artifactKinds.values) {
    assert.equal(entry.mime, domain.ARTIFACT_MIME[entry.value]);
    assert.equal(entry.fileExtension, domain.ARTIFACT_EXTENSION[entry.value]);
    assert.equal(entry.maxBytes, domain.ARTIFACT_MAX_BYTES[entry.value]);
  }
  // `superseded` is the one terminal reason whose name is not its status: a run
  // a newer run replaced is cancelled, because nothing went wrong.
  assert.equal(domain.statusForTerminalReason("superseded"), "cancelled");
});

test("the ordered vocabularies are ordered the way the domain narrows and raises", () => {
  const policies = WORK_CONTRACT.vocabularies.permissionPolicies.values.map((entry) => entry.value);
  for (const narrower of policies) {
    for (const wider of policies) {
      const expected = policies.indexOf(narrower) <= policies.indexOf(wider) ? narrower : wider;
      assert.equal(domain.narrowestPolicy(narrower, wider), expected);
    }
  }

  const sensitivities = WORK_CONTRACT.vocabularies.sensitivities.values.map((entry) => entry.value);
  for (const lower of sensitivities) {
    for (const higher of sensitivities) {
      const expected =
        sensitivities.indexOf(lower) >= sensitivities.indexOf(higher) ? lower : higher;
      assert.equal(domain.maxSensitivity(lower, higher), expected);
    }
  }

  const tiers = WORK_CONTRACT.vocabularies.toolTiers.values;
  for (const [index, entry] of tiers.entries()) {
    assert.equal(entry.tier, index + 1, "tier numbers must follow the listed order");
    assert.equal(domain.toolTier(entry.value), entry.tier);
  }
  assert.equal(domain.permitsTier("visual", ["connector", "visual"]), false);
});

test("every value explains itself, because the clients show these sentences", () => {
  for (const [id, vocabulary] of vocabularies) {
    for (const entry of vocabulary.values) {
      assert.ok(entry.summary.trim().length > 0, `${id}.${entry.value} has no summary`);
    }
  }
  assert.equal(
    summaryFor("capabilities", "local_browser"),
    "Drive a browser profile that is already signed in on the Mac."
  );
  assert.equal(
    summaryFor("statuses", "draft"),
    WORK_CONTRACT.vocabularies.statuses.values[0].summary
  );
});

test("the checked-in Swift is exactly what the contract generates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "juno-work-contract-"));
  const firstOutput = join(directory, "First.swift");
  const secondOutput = join(directory, "Second.swift");
  try {
    for (const output of [firstOutput, secondOutput]) {
      const result = spawnSync(
        process.execPath,
        ["scripts/generate-work-contract.mjs", `--output=${output}`],
        { cwd: process.cwd(), encoding: "utf8" }
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }

    const [first, second, checkedIn, contractSource] = await Promise.all([
      readFile(firstOutput, "utf8"),
      readFile(secondOutput, "utf8"),
      readFile(SWIFT_PATH, "utf8"),
      readFile("contracts/work/juno-work-v1.json", "utf8"),
    ]);

    assert.equal(first, second, "generation must be deterministic or CI will diff against itself");
    assert.equal(checkedIn, first, `${SWIFT_PATH} is stale; run npm run work:contract:generate`);

    const digest = createHash("sha256").update(contractSource).digest("hex");
    assert.match(checkedIn, new RegExp(`digest = "${digest}"`));
    assert.match(checkedIn, new RegExp(`version = ${WORK_CONTRACT_VERSION}\\b`));

    // Every vocabulary reaches Swift, and the values that are Swift keywords
    // reach it escaped rather than not at all.
    for (const [, vocabulary] of vocabularies) {
      assert.match(checkedIn, new RegExp(`public enum ${vocabulary.swiftEnum}: String,`));
    }
    assert.match(checkedIn, /case `public` = "public"/);
    assert.match(checkedIn, /case workFilePermanentDelete = "work\.file\.permanent_delete"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the drift gate agrees the checked-in Swift is current", () => {
  const result = spawnSync(process.execPath, ["scripts/check-work-contract.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
