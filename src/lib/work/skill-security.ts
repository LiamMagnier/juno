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

export const SKILL_SECURITY_SCAN_VERSION = 1;
export const SKILL_SECURITY_STATUSES = ["clear", "warning", "blocked"] as const;
export type SkillSecurityStatus = (typeof SKILL_SECURITY_STATUSES)[number];
export type SkillSecuritySeverity = "warning" | "blocked";

export interface SkillSecurityFinding {
  code: string;
  severity: SkillSecuritySeverity;
  field: "instructions" | "contract" | "requestedTools" | "requestedDomains" | "examples";
  message: string;
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
}

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

  const permissions = permissionSurfaceOf(input);
  const status: SkillSecurityStatus = findings.some((finding) => finding.severity === "blocked")
    ? "blocked"
    : findings.length > 0
    ? "warning"
    : "clear";
  return {
    scannerVersion: SKILL_SECURITY_SCAN_VERSION,
    status,
    findings: findings.slice(0, 32),
    permissionFingerprint: permissionFingerprint(permissions),
    permissions,
  };
}
