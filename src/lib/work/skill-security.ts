/**
 * Deterministic security checks for Work skill versions.
 *
 * This is a detector, not a sandbox and not a claim that a clean skill is
 * safe. The runtime envelope and the approval broker remain the boundaries.
 * The value of this layer is that suspicious instructions, broad network
 * declarations and permission changes are visible, persisted and actionable
 * at the moment a version enters the library.
 */

import {
  WORK_PERMISSION_POLICIES,
  type WorkBudget,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";
import type { SkillBundleFileKind } from "@/lib/skills/bundle-manifest";

/**
 * 2 since the scanner also reads a skill's bundle (its scripts and references);
 * 1 read the instructions and the declarations only.
 */
export const SKILL_SECURITY_SCAN_VERSION = 2;
export const SKILL_SECURITY_STATUSES = ["clear", "warning", "blocked"] as const;
export type SkillSecurityStatus = (typeof SKILL_SECURITY_STATUSES)[number];
export type SkillSecuritySeverity = "warning" | "blocked";

export interface SkillSecurityFinding {
  code: string;
  severity: SkillSecuritySeverity;
  field: "instructions" | "contract" | "requestedTools" | "requestedDomains" | "examples" | "bundle";
  message: string;
  /** The bundle file a `bundle` finding is about, relative to the skill's folder. */
  path?: string;
}

export interface SkillPermissionSurface {
  tools: string[];
  connectors: string[];
  apps: string[];
  domains: string[];
  policy: WorkPermissionPolicy | null;
  budget: WorkBudget;
}

export interface SkillSecurityScan {
  scannerVersion: number;
  status: SkillSecurityStatus;
  findings: SkillSecurityFinding[];
  permissionFingerprint: string;
  permissions: SkillPermissionSurface;
  /** What the scanner read of the bundle, when the version has one. */
  bundle?: { digest: string; files: number; scripts: number; scannedFiles: number };
}

/** One bundle file as the scanner reads it. Assets carry no text and are not read. */
export interface SkillSecurityBundleFile {
  path: string;
  kind: SkillBundleFileKind;
  /** The file's text, for scripts and references. */
  text?: string;
}

/**
 * What the scanner reads out of a version.
 *
 * Structural rather than the contract type itself, and the omission worth
 * naming is `resourceAttachmentIds`. The files a skill brings are not part of
 * its permission surface: they are the author's own uploads, checked against
 * their account before the version is written and joined on `userId` again when
 * the run reads them, and they reach the model inside the untrusted-content
 * envelope where they cannot ask for anything. Folding them into the
 * fingerprint would make swapping last month's template for this month's a
 * "permission expansion" the reader has to approve before the skill will run,
 * which is a consent press about a change that grants nothing — and a product
 * that asks for those teaches people to click through the ones that matter.
 */
export interface SkillSecurityInput {
  name: string;
  description: string;
  instructions: string;
  requestedTools: readonly string[];
  contract: {
    requestedConnectors: readonly string[];
    requestedApps: readonly string[];
    requestedDomains: readonly string[];
    requestedPolicy: WorkPermissionPolicy | null;
    requestedBudget: WorkBudget;
    examples?: readonly { expectTools?: readonly string[]; forbidTools?: readonly string[] }[];
  };
  /**
   * The version's bundle, when it has one. Optional so every existing caller
   * that has no bundle keeps its exact verdict.
   */
  bundle?: SkillSecurityBundleInput | null;
}

/**
 * A bundle to scan, or the verdict of an earlier scan of the same bytes.
 *
 * `carried` exists for an edit or a restore: the new version keeps a bundle an
 * earlier version of the same skill already holds (same digest, so the same
 * bytes), and re-reading 5 MB from storage to reach the verdict this scanner
 * version already reached for them would make saving a typo depend on the
 * bucket being up. A verdict from an older scanner version is not carried; the
 * caller rescans instead (see `carriedBundleScan`).
 */
export type SkillSecurityBundleInput =
  | { digest: string; files: readonly SkillSecurityBundleFile[] }
  | { digest: string; carried: { findings: readonly SkillSecurityFinding[]; summary: NonNullable<SkillSecurityScan["bundle"]> } };

/**
 * The bundle half of a stored scan, when it can stand for a new scan of the
 * same digest: written by this scanner version, about this digest. Null means
 * the bundle has to be read and scanned again.
 */
export function carriedBundleScan(
  raw: unknown,
  digest: string
): { findings: SkillSecurityFinding[]; summary: NonNullable<SkillSecurityScan["bundle"]> } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const scan = raw as Partial<SkillSecurityScan>;
  if (scan.scannerVersion !== SKILL_SECURITY_SCAN_VERSION) return null;
  const summary = scan.bundle;
  if (!summary || typeof summary !== "object" || summary.digest !== digest) return null;
  if (![summary.files, summary.scripts, summary.scannedFiles].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const findings = (Array.isArray(scan.findings) ? scan.findings : []).filter(
    (finding): finding is SkillSecurityFinding =>
      !!finding &&
      typeof finding === "object" &&
      finding.field === "bundle" &&
      typeof finding.code === "string" &&
      (finding.severity === "warning" || finding.severity === "blocked") &&
      typeof finding.message === "string"
  );
  return { findings, summary: { digest, files: summary.files, scripts: summary.scripts, scannedFiles: summary.scannedFiles } };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function permissionSurfaceOf(input: Pick<SkillSecurityInput, "requestedTools" | "contract">): SkillPermissionSurface {
  return {
    tools: sortedUnique(input.requestedTools),
    connectors: sortedUnique(input.contract.requestedConnectors),
    apps: sortedUnique(input.contract.requestedApps),
    domains: sortedUnique(input.contract.requestedDomains),
    policy: input.contract.requestedPolicy,
    budget: {
      maxCostMicroUsd: input.contract.requestedBudget.maxCostMicroUsd,
      maxTokens: input.contract.requestedBudget.maxTokens,
      maxRuntimeMs: input.contract.requestedBudget.maxRuntimeMs,
    },
  };
}

export function permissionFingerprint(surface: SkillPermissionSurface): string {
  return JSON.stringify({
    tools: sortedUnique(surface.tools),
    connectors: sortedUnique(surface.connectors),
    apps: sortedUnique(surface.apps),
    domains: sortedUnique(surface.domains),
    policy: surface.policy,
    budget: surface.budget,
  });
}

export function permissionSurfaceFromScan(raw: unknown): SkillPermissionSurface | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const permissions = (raw as { permissions?: unknown }).permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return null;
  const value = permissions as Record<string, unknown>;
  const list = (entry: unknown) =>
    Array.isArray(entry) && entry.every((item) => typeof item === "string")
      ? sortedUnique(entry as string[])
      : null;
  const tools = list(value.tools);
  const connectors = list(value.connectors);
  const apps = list(value.apps);
  const domains = list(value.domains);
  const budget = value.budget;
  if (
    !tools ||
    !connectors ||
    !apps ||
    !domains ||
    !budget ||
    typeof budget !== "object" ||
    Array.isArray(budget)
  ) {
    return null;
  }
  const b = budget as Record<string, unknown>;
  const numbers = [b.maxCostMicroUsd, b.maxTokens, b.maxRuntimeMs];
  if (!numbers.every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0)) return null;
  const policy = value.policy;
  if (policy !== null && !WORK_PERMISSION_POLICIES.includes(policy as WorkPermissionPolicy)) return null;
  return {
    tools,
    connectors,
    apps,
    domains,
    policy: policy as WorkPermissionPolicy | null,
    budget: {
      maxCostMicroUsd: b.maxCostMicroUsd as number,
      maxTokens: b.maxTokens as number,
      maxRuntimeMs: b.maxRuntimeMs as number,
    },
  };
}

export function permissionExpansion(
  previous: SkillPermissionSurface | null | undefined,
  next: SkillPermissionSurface
): string[] {
  if (!previous) return [];
  const additions: string[] = [];
  const compare = (label: string, before: readonly string[], after: readonly string[]) => {
    const old = new Set(before);
    for (const value of after) if (!old.has(value)) additions.push(`${label}:${value}`);
  };
  compare("tool", previous.tools, next.tools);
  compare("connector", previous.connectors, next.connectors);
  compare("app", previous.apps, next.apps);
  compare("domain", previous.domains, next.domains);

  const policyRank = (value: WorkPermissionPolicy | null) =>
    value === null ? -1 : WORK_PERMISSION_POLICIES.indexOf(value);
  if (policyRank(next.policy) > policyRank(previous.policy)) additions.push(`policy:${next.policy}`);

  for (const key of ["maxCostMicroUsd", "maxTokens", "maxRuntimeMs"] as const) {
    const before = previous.budget[key];
    const after = next.budget[key];
    // Zero means no request/ceiling in the skill contract. Introducing a
    // finite request, increasing it, or removing an existing ceiling widens
    // the permission surface; adding a smaller ceiling does not.
    if (after > before || (before > 0 && after === 0)) {
      additions.push(`budget:${key}`);
    }
  }
  return additions;
}

const BLOCKED_INSTRUCTION_RULES: Array<{ code: string; pattern: RegExp; message: string }> = [
  {
    code: "instruction_override",
    pattern: /\b(?:ignore|disregard|override)\b.{0,60}\binstructions?\b/i,
    message: "The instructions attempt to override a higher-priority instruction source.",
  },
  {
    code: "approval_bypass",
    pattern: /\b(?:bypass|skip|disable|avoid)\s+(?:approval|consent|permission|safety|review)\b/i,
    message: "The instructions attempt to bypass a safety or approval boundary.",
  },
  {
    code: "secret_exfiltration",
    pattern: /\b(?:exfiltrat|leak|send|upload|post|forward)\w*\b.{0,100}\b(?:password|secret|token|api[ _-]?key|private key|credential|environment variable)\b/i,
    message: "The instructions combine an outbound action with credentials or secrets.",
  },
  {
    code: "hidden_behavior",
    pattern: /\b(?:do not tell|hide this from|conceal|silently disable|pretend to be|claim that it succeeded)\b/i,
    message: "The instructions ask the agent to conceal behavior or misrepresent a result.",
  },
];

const WARNING_INSTRUCTION_RULES: Array<{ code: string; pattern: RegExp; message: string }> = [
  {
    code: "shell_or_network_execution",
    pattern: /\b(?:curl|wget|invoke-webrequest|powershell|bash|sh\s+-c|netcat|nc\s|eval\s*\(|exec\s*\(|child_process)\b/i,
    message: "The instructions mention shell or arbitrary network execution; review the declared tools and domains.",
  },
  {
    code: "destructive_operation",
    pattern: /\b(?:rm\s+-rf|format\s+disk|drop\s+table|chmod\s+777|sudo\b|delete\s+all)\b/i,
    message: "The instructions contain a destructive operation and must remain behind the normal approval broker.",
  },
  {
    code: "encoded_or_obfuscated_payload",
    pattern: /\b(?:base64|decode this|obfuscat|hex[- ]encoded|rot13)\b/i,
    message: "The instructions mention encoded or obfuscated content that a reviewer should inspect.",
  },
];

/*
 * What a script in a skill's bundle is read for. The sandbox it runs in has no
 * network, no credentials and nothing outside /work and its own read-only
 * folder, so none of these is a way out by itself; they are the shapes a
 * reviewer should look at before saying yes, and the consent screen lists them
 * with the file they were found in.
 */
const BUNDLE_SCRIPT_RULES: Array<{ code: string; pattern: RegExp; message: string }> = [
  {
    code: "bundle_network_call",
    pattern: /\b(?:import\s+socket|socket\.socket|requests\.(?:get|post|put|delete|session)|urllib(?:\.request|2)?|http\.client|httpx|aiohttp|fetch\s*\(|axios|XMLHttpRequest|net\.connect|https?\.request|curl\s|wget\s|nc\s+-|websocket)/i,
    message: "A script reaches for the network. The sandbox has no network, so this part will fail there; check what it tries to contact.",
  },
  {
    code: "bundle_subprocess",
    pattern: /\b(?:subprocess|os\.system|os\.popen|os\.exec\w*|pty\.spawn|child_process|execSync|spawnSync|Deno\.run|eval\s*\(|exec\s*\()/,
    message: "A script starts other programs or evaluates code it builds at run time.",
  },
  {
    code: "bundle_path_outside_work",
    pattern: /["'`](?:\/etc\/|\/root\b|\/home\/|\/Users\/|\/var\/|\/proc\/|\/sys\/|\/dev\/(?!null)|~\/)/,
    message: "A script names a path outside the files it was given. In the sandbox those paths are empty or absent.",
  },
  {
    code: "bundle_credential_path",
    pattern: /(?:\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.docker\/config|\/etc\/shadow|keychain|\bos\.environ\b|process\.env\b)/i,
    message: "A script reads credential files or environment variables.",
  },
  {
    code: "bundle_encoded_payload",
    // The long-run half (400+ base64 characters) is `hasLongBase64Run`, not a
    // `{400,}` alternative here: that alternative is retried at every offset,
    // so a crafted 5 MB bundle of 399-character runs cost seconds of CPU per scan.
    pattern: /(?:b64decode|base64\s+-d|atob\s*\(|Buffer\.from\([^)]{0,80}["']base64["']|codecs\.decode\([^)]{0,80}rot)/,
    message: "A script decodes an encoded payload or carries a long encoded string.",
  },
];

/**
 * Reads a bundle's scripts and references.
 *
 * Findings are warnings with one exception each way it is unambiguous: a
 * script that reads credentials AND reaches for the network, or one that
 * decodes a payload and executes it, is blocked. A reference file is text the
 * model may read, so it gets the instruction rules, at warning severity: it is
 * enveloped when read, and a style guide that happens to say "do not tell" is
 * not an attack.
 */
const LONG_ENCODED_RUN = 400;

/** One pass: whether `text` holds 400 or more base64 characters in a row. */
export function hasLongBase64Run(text: string, min = LONG_ENCODED_RUN): boolean {
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const base64 =
      (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;
    if (base64) {
      if (++run >= min) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

function scanBundleFiles(files: readonly SkillSecurityBundleFile[]): { findings: SkillSecurityFinding[]; scanned: number } {
  const findings: SkillSecurityFinding[] = [];
  let scanned = 0;
  for (const file of files) {
    if (typeof file.text !== "string") continue;
    // A bounded read. A 2 MB script is already unusual; regexes over it all are not needed.
    const text = file.text.slice(0, 400_000);
    scanned++;
    if (file.kind === "script") {
      const hits = new Set<string>();
      for (const rule of BUNDLE_SCRIPT_RULES) {
        if (rule.pattern.test(text) || (rule.code === "bundle_encoded_payload" && hasLongBase64Run(text))) {
          hits.add(rule.code);
          findings.push({ code: rule.code, severity: "warning", field: "bundle", message: rule.message, path: file.path });
        }
      }
      if (hits.has("bundle_credential_path") && hits.has("bundle_network_call")) {
        findings.push({
          code: "bundle_credential_exfiltration",
          severity: "blocked",
          field: "bundle",
          message: "A script reads credentials and also reaches for the network.",
          path: file.path,
        });
      }
      if (/(?:exec|eval)\s*\(\s*(?:base64\.b64decode|atob|Buffer\.from|codecs\.decode|bytes\.fromhex|zlib\.decompress)/.test(text)) {
        findings.push({
          code: "bundle_obfuscated_execution",
          severity: "blocked",
          field: "bundle",
          message: "A script decodes hidden code and executes it.",
          path: file.path,
        });
      }
    } else if (file.kind === "reference" || file.kind === "instructions") {
      for (const rule of BLOCKED_INSTRUCTION_RULES) {
        if (rule.pattern.test(text)) {
          findings.push({ code: `bundle_${rule.code}`, severity: "warning", field: "bundle", message: rule.message, path: file.path });
        }
      }
    }
  }
  return { findings, scanned };
}

const DOMAIN_PATTERN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function scanSkillVersion(input: SkillSecurityInput): SkillSecurityScan {
  const findings: SkillSecurityFinding[] = [];
  const addMatches = (
    rules: readonly { code: string; pattern: RegExp; message: string }[],
    field: SkillSecurityFinding["field"],
    severity: SkillSecuritySeverity
  ) => {
    for (const rule of rules) {
      if (rule.pattern.test(input.instructions)) {
        findings.push({ code: rule.code, severity, field, message: rule.message });
      }
    }
  };

  addMatches(BLOCKED_INSTRUCTION_RULES, "instructions", "blocked");
  addMatches(WARNING_INSTRUCTION_RULES, "instructions", "warning");

  for (const domain of input.contract.requestedDomains) {
    if (domain === "*" || domain.includes("://") || !DOMAIN_PATTERN.test(domain)) {
      findings.push({
        code: "broad_or_invalid_domain",
        severity: "blocked",
        field: "requestedDomains",
        message: "A skill domain must be a concrete hostname; wildcard or URL-shaped declarations are blocked.",
      });
    }
  }
  if (input.contract.requestedDomains.length > 8) {
    findings.push({
      code: "many_declared_domains",
      severity: "warning",
      field: "requestedDomains",
      message: "The version declares an unusually broad domain surface.",
    });
  }
  if (input.contract.requestedPolicy === "permissive") {
    findings.push({
      code: "permissive_policy_request",
      severity: "warning",
      field: "contract",
      message: "The version requests the broadest Work policy and needs explicit review.",
    });
  }
  if (input.requestedTools.some((tool) => /(?:shell|terminal|browser|http|network|delete|write)/i.test(tool))) {
    findings.push({
      code: "sensitive_tool_request",
      severity: "warning",
      field: "requestedTools",
      message: "The version requests a tool with filesystem, network or destructive capability.",
    });
  }

  const declaredTools = new Set(input.requestedTools);
  for (const example of input.contract.examples ?? []) {
    for (const tool of [...(example.expectTools ?? []), ...(example.forbidTools ?? [])]) {
      if (!declaredTools.has(tool)) {
        findings.push({
          code: "example_tool_not_declared",
          severity: "warning",
          field: "examples",
          message: "An example names a tool the version does not declare.",
        });
        break;
      }
    }
  }

  let bundleSummary: SkillSecurityScan["bundle"];
  if (input.bundle && "carried" in input.bundle) {
    findings.push(...input.bundle.carried.findings.map((finding) => ({ ...finding })));
    bundleSummary = { ...input.bundle.carried.summary, digest: input.bundle.digest };
  } else if (input.bundle) {
    const scanned = scanBundleFiles(input.bundle.files);
    findings.push(...scanned.findings);
    bundleSummary = {
      digest: input.bundle.digest,
      files: input.bundle.files.length,
      scripts: input.bundle.files.filter((file) => file.kind === "script").length,
      scannedFiles: scanned.scanned,
    };
  }

  const permissions = permissionSurfaceOf(input);
  const status: SkillSecurityStatus = findings.some((finding) => finding.severity === "blocked")
    ? "blocked"
    : findings.length > 0
    ? "warning"
    : "clear";
  // Blocked findings first, so the cap below can never cut the one that decides.
  const ordered = [
    ...findings.filter((finding) => finding.severity === "blocked"),
    ...findings.filter((finding) => finding.severity !== "blocked"),
  ];
  return {
    scannerVersion: SKILL_SECURITY_SCAN_VERSION,
    status,
    findings: ordered.slice(0, 32),
    permissionFingerprint: permissionFingerprint(permissions),
    permissions,
    ...(bundleSummary ? { bundle: bundleSummary } : {}),
  };
}

/**
 * Whether a version's bundle waits for the reader's consent before anything in
 * it may run.
 *
 * Scripts from somebody else are reviewed before they execute: an imported
 * (`untrusted`) skill whose bundle carries a script waits, exactly like a
 * version that asks for more permissions than the last one. A skill the reader
 * wrote, or has read and vouched for, does not ask them to approve their own
 * code. A bundle already consented to on an earlier version of the same skill
 * (same digest, so byte-identical) does not ask again: an edit to the
 * instructions or a restore carries the files over unchanged.
 *
 * A pending review travels with the bytes. Scripts still waiting for consent on
 * an earlier version (`pendingDigests`) keep waiting on the next one, whatever
 * the trust says by then: marking an imported skill "written by me" and then
 * editing a typo must not be a way past reviewing its scripts.
 */
export function bundleRequiresConsent(input: {
  trust: string;
  bundle: { digest: string; files: readonly { kind: SkillBundleFileKind }[] } | null | undefined;
  consentedDigests: ReadonlySet<string>;
  pendingDigests?: ReadonlySet<string>;
}): boolean {
  if (!input.bundle) return false;
  if (!input.bundle.files.some((file) => file.kind === "script")) return false;
  if (input.consentedDigests.has(input.bundle.digest)) return false;
  if (input.pendingDigests?.has(input.bundle.digest)) return true;
  return !(input.trust === "user_authored" || input.trust === "verified");
}
