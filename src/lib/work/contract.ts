/**
 * The Juno Work vocabulary as the clients receive it, and the proof that it is
 * the same vocabulary the server uses.
 *
 * `contracts/work/juno-work-v1.json` is the single source of truth. The Swift
 * enums in JunoCore are generated from it by scripts/generate-work-contract.mjs
 * and byte-checked by scripts/check-work-contract.mjs, so the Mac and the phone
 * cannot fall behind it. This module is the other half of that guarantee: it
 * types the document against the unions `./domain` owns and then, at runtime,
 * asserts that every list in the file really is the list domain.ts declares —
 * in both directions, including the derived subsets.
 *
 * That assertion is the whole point of the module. The capability manifest
 * (contracts/capabilities/juno-capabilities-v1.json) generates Swift from the
 * file but leaves `DegradationKind` hand-written in TypeScript, so a kind added
 * to the manifest reaches the Mac and quietly never reaches the server; nothing
 * fails, and the two halves of one contract simply mean different things. A
 * type annotation cannot catch that on its own, because a JSON import widens
 * every string to `string` and the annotation below is therefore a claim rather
 * than a check. `assertWorkContractMatchesDomain` is what turns the claim into
 * a fact, and tests/work-contract.test.ts is what makes it run.
 *
 * Deliberately free of `server-only`, Prisma and SDK imports, exactly like
 * ./domain: the cloud runner, the route handlers and the tests all need it.
 */

import document from "../../../contracts/work/juno-work-v1.json";
import * as domain from "./domain";

/** Where the contract lives, quoted in every failure so the fix is obvious. */
const CONTRACT_PATH = "contracts/work/juno-work-v1.json";

/** Anything a value can carry beyond its name and its summary. */
export type WorkAttributeValue = string | number | boolean;

/**
 * A declared attribute, and how it is checked.
 *
 * `type` drives the Swift property that is generated for it; `vocabulary` is
 * set only for references, where the attribute's value must itself be a value
 * of another vocabulary.
 */
export interface WorkContractAttribute {
  readonly name: string;
  readonly type: "boolean" | "string" | "integer" | "reference";
  readonly vocabulary?: string;
  readonly summary: string;
}

/**
 * A domain constant that is a filter of its vocabulary rather than a vocabulary
 * of its own — `WORK_LIVE_STATUSES` is every status whose `isTerminal` is
 * false. Declaring the rule is what stops the subset and the whole from
 * drifting apart, which is the drift that matters: a status added to one list
 * and not the other is a run that is neither live nor finished.
 */
export interface WorkContractPartition {
  readonly constant: string;
  readonly attribute: string;
  readonly equals: WorkAttributeValue;
}

export interface WorkContractEntry<Value extends string> {
  readonly value: Value;
  readonly summary: string;
  readonly [attribute: string]: WorkAttributeValue;
}

export interface WorkContractVocabulary<Value extends string> {
  /** The `export const` in ./domain this list must equal, name for name. */
  readonly constant: string;
  readonly swiftEnum: string;
  readonly summary: string;
  /** True when the order of `values` carries meaning the code relies on. */
  readonly ordered?: boolean;
  readonly attributes?: readonly WorkContractAttribute[];
  readonly partitions?: readonly WorkContractPartition[];
  readonly values: readonly WorkContractEntry<Value>[];
}

/**
 * The document, with every list typed by the union it is required to contain.
 *
 * Each line is a claim that the assertion below proves. Naming the domain type
 * here rather than restating the literals is the rule ./domain sets out: a
 * union it already owns is never re-declared, only referred to.
 */
export interface WorkContractDocument {
  readonly version: number;
  readonly vocabularies: {
    readonly statuses: WorkContractVocabulary<domain.WorkStatus>;
    readonly terminalReasons: WorkContractVocabulary<domain.WorkTerminalReason>;
    readonly targets: WorkContractVocabulary<domain.WorkTarget>;
    readonly capabilities: WorkContractVocabulary<domain.WorkCapability>;
    readonly degradationKinds: WorkContractVocabulary<domain.WorkDegradationKind>;
    readonly permissionPolicies: WorkContractVocabulary<domain.WorkPermissionPolicy>;
    readonly riskLevels: WorkContractVocabulary<domain.WorkRiskLevel>;
    readonly approvalDecisions: WorkContractVocabulary<domain.WorkApprovalDecision>;
    // The one list domain.ts types as plain strings rather than a union, because
    // an action name is matched against tool calls at runtime; the assertion
    // still pins the membership exactly.
    readonly alwaysConfirmActions: WorkContractVocabulary<string>;
    readonly unattendedPolicies: WorkContractVocabulary<domain.WorkUnattendedPolicy>;
    readonly hostOfflinePolicies: WorkContractVocabulary<domain.WorkHostOfflinePolicy>;
    readonly toolTiers: WorkContractVocabulary<domain.WorkToolTierId>;
    readonly eventKinds: WorkContractVocabulary<domain.WorkEventKind>;
    readonly artifactKinds: WorkContractVocabulary<domain.WorkArtifactKind>;
    readonly grantKinds: WorkContractVocabulary<domain.WorkGrantKind>;
    readonly accessModes: WorkContractVocabulary<domain.WorkAccessMode>;
    readonly commandKinds: WorkContractVocabulary<domain.WorkCommandKind>;
    readonly commandStatuses: WorkContractVocabulary<domain.WorkCommandStatus>;
    readonly hostStates: WorkContractVocabulary<domain.WorkHostState>;
    readonly triggerKinds: WorkContractVocabulary<domain.WorkTriggerKind>;
    readonly missedRunPolicies: WorkContractVocabulary<domain.WorkMissedRunPolicy>;
    readonly auditKinds: WorkContractVocabulary<domain.WorkAuditKind>;
    readonly auditSeverities: WorkContractVocabulary<domain.WorkAuditSeverity>;
    readonly actors: WorkContractVocabulary<domain.WorkActor>;
    readonly sensitivities: WorkContractVocabulary<domain.WorkSensitivity>;
  };
}

export const WORK_CONTRACT = document as unknown as WorkContractDocument;

/** Bumped whenever a value is added or its meaning changes. */
export const WORK_CONTRACT_VERSION: number = WORK_CONTRACT.version;

export type WorkVocabularyId = keyof WorkContractDocument["vocabularies"];

/** The values one vocabulary may take, derived from the document rather than restated. */
export type WorkVocabularyValue<Id extends WorkVocabularyId> =
  WorkContractDocument["vocabularies"][Id]["values"][number]["value"];

const VOCABULARIES: readonly [string, WorkContractVocabulary<string>][] = Object.entries(
  WORK_CONTRACT.vocabularies
);

/**
 * The sentence the contract attaches to one value.
 *
 * The summaries live here rather than in ./domain because they are the half of
 * the vocabulary a client needs and the server does not: a Mac explaining why a
 * task cannot run has to say what `local_browser` means, and it must say the
 * same thing the web app says.
 */
export function summaryFor<Id extends WorkVocabularyId>(
  vocabulary: Id,
  value: WorkVocabularyValue<Id>
): string | null {
  const entries = WORK_CONTRACT.vocabularies[vocabulary]
    .values as readonly WorkContractEntry<string>[];
  return entries.find((entry) => entry.value === value)?.summary ?? null;
}

/**
 * How each attribute is verified against the code that owns its meaning.
 *
 * An attribute with no entry here would be a fact about Work that only the JSON
 * asserts — it would reach Swift unchecked, and Swift would then disagree with
 * the server about which risk levels always ask. The assertion below refuses a
 * contract that declares one, unless a partition already pins it.
 */
const ATTRIBUTE_ORACLES: Readonly<Record<string, (value: string) => WorkAttributeValue>> = {
  "statuses.needsAttention": (value) => domain.statusNeedsAttention(value),
  "terminalReasons.status": (value) =>
    domain.statusForTerminalReason(value as domain.WorkTerminalReason),
  "capabilities.userPhrase": (value) => domain.describeCapability(value),
  // A deliberately unlisted action, so what comes back is the answer for the
  // risk level alone rather than for the action-name allowlist.
  "riskLevels.alwaysRequiresApproval": (value) =>
    domain.requiresExplicitApproval("work.contract.probe", value as domain.WorkRiskLevel),
  "eventKinds.visibility": (value) => domain.defaultVisibilityFor(value),
  "artifactKinds.mime": (value) => domain.ARTIFACT_MIME[value as domain.WorkArtifactKind],
  "artifactKinds.fileExtension": (value) =>
    domain.ARTIFACT_EXTENSION[value as domain.WorkArtifactKind],
  "artifactKinds.maxBytes": (value) => domain.ARTIFACT_MAX_BYTES[value as domain.WorkArtifactKind],
  "accessModes.allowsWrite": (value) => domain.allowsWrite(value as domain.WorkAccessMode),
  "accessModes.allowsTrash": (value) => domain.allowsTrash(value as domain.WorkAccessMode),
  "toolTiers.tier": (value) => domain.toolTier(value),
  "toolTiers.label": (value) =>
    domain.WORK_TOOL_TIERS.find((tier) => tier.id === value)?.label ?? "",
  "sensitivities.allowsScreenshotRelay": (value) =>
    domain.allowsScreenshotRelay(value as domain.WorkSensitivity),
};

/**
 * Reads a domain constant as a list of vocabulary values.
 *
 * `WORK_TOOL_TIERS` is the one constant whose elements carry more than an
 * identifier, so an element is either the value itself or an object announcing
 * it as `id`. Returning null rather than throwing lets the caller report which
 * constant was the wrong shape instead of dying on the first one.
 */
function listValues(constant: unknown): string[] | null {
  if (!Array.isArray(constant)) return null;
  const values: string[] = [];
  for (const element of constant) {
    if (typeof element === "string") {
      values.push(element);
      continue;
    }
    const id = (element as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return null;
    values.push(id);
  }
  return values;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Proves the contract and ./domain are the same vocabulary, and says precisely
 * where they are not.
 *
 * Every mismatch is collected rather than thrown on sight: someone who has just
 * added a status wants to be told about the subset lists and the Swift enum in
 * one run, not to rediscover the same mistake four times.
 */
export function assertWorkContractMatchesDomain(): void {
  const failures: string[] = [];
  const domainExports: Record<string, unknown> = { ...domain };
  const accountedFor = new Set<string>();

  for (const [id, vocabulary] of VOCABULARIES) {
    const contractValues = vocabulary.values.map((entry) => entry.value);
    accountedFor.add(vocabulary.constant);

    const declared = listValues(domainExports[vocabulary.constant]);
    if (declared === null) {
      failures.push(
        `${CONTRACT_PATH} says "${id}" mirrors domain.ts's ${vocabulary.constant}, which is not a list of values there.`
      );
    } else if (!sameList(declared, contractValues)) {
      failures.push(
        `"${id}" lists [${contractValues.join(", ")}] but domain.ts's ${vocabulary.constant} lists [${declared.join(", ")}].`
      );
    }

    const partitioned = new Set<string>();
    for (const partition of vocabulary.partitions ?? []) {
      accountedFor.add(partition.constant);
      partitioned.add(partition.attribute);

      const expected = vocabulary.values
        .filter((entry) => entry[partition.attribute] === partition.equals)
        .map((entry) => entry.value);
      const actual = listValues(domainExports[partition.constant]);
      if (actual === null) {
        failures.push(
          `${CONTRACT_PATH} says ${partition.constant} is every "${id}" whose ${partition.attribute} is ${String(partition.equals)}, but domain.ts has no such list.`
        );
      } else if (!sameList(actual, expected)) {
        failures.push(
          `domain.ts's ${partition.constant} lists [${actual.join(", ")}], but the "${id}" values whose ${partition.attribute} is ${String(partition.equals)} are [${expected.join(", ")}].`
        );
      }
    }

    for (const attribute of vocabulary.attributes ?? []) {
      const oracle = ATTRIBUTE_ORACLES[`${id}.${attribute.name}`];
      if (!oracle) {
        if (!partitioned.has(attribute.name)) {
          failures.push(
            `"${id}.${attribute.name}" is checked by nothing in domain.ts; give it a partition or an oracle, or the clients will trust a value the server never agreed to.`
          );
        }
        continue;
      }
      for (const entry of vocabulary.values) {
        const expected = oracle(entry.value);
        if (entry[attribute.name] !== expected) {
          failures.push(
            `"${id}.${entry.value}.${attribute.name}" is ${JSON.stringify(entry[attribute.name])} but domain.ts says ${JSON.stringify(expected)}.`
          );
        }
      }
    }
  }

  // The other direction. A vocabulary added to domain.ts and forgotten here is
  // exactly the drift this file exists to prevent: the server would gain a
  // value the contract has never heard of, and every client would keep decoding
  // happily until one arrived.
  for (const [name, value] of Object.entries(domainExports)) {
    if (!Array.isArray(value) || accountedFor.has(name)) continue;
    failures.push(
      `domain.ts exports ${name}, which no vocabulary or partition in ${CONTRACT_PATH} accounts for.`
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `The Juno Work contract and src/lib/work/domain.ts disagree:\n  - ${failures.join("\n  - ")}\n`
        + `Change ${CONTRACT_PATH}, then regenerate Swift with: `
        + "node scripts/generate-work-contract.mjs "
        + "--output=native/Packages/JunoNativeKit/Sources/JunoCore/Generated/JunoWorkContract.swift"
    );
  }
}
