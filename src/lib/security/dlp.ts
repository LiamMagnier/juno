/**
 * Juno Data Loss Prevention (DLP) & Secret Scanning Policy Engine
 *
 * Scans prompts, attachments, and tool arguments for sensitive credentials,
 * API tokens (OpenAI, Anthropic, AWS, GitHub, Stripe), private keys, credit cards, SSNs, and JWTs.
 * Provides policy enforcement across 'allow', 'warn', and 'block' modes with audit logging.
 */

export type DlpPolicyMode = "allow" | "warn" | "block";
export type DlpDestination = "model_provider" | "external_tool" | "connector" | "storage";

export interface DlpScanResult {
  hasViolations: boolean;
  sanitizedText: string;
  detectedTypes: string[];
  redactedCount: number;
}

export interface DlpRule {
  type: string;
  name: string;
  pattern: RegExp;
  mask: string | ((match: string) => string);
  severity: "low" | "medium" | "high" | "critical";
}

export interface DlpPolicyConfig {
  mode: DlpPolicyMode;
  enabledRules?: string[];
  allowUserOverride?: boolean;
  maxScanSizeBytes?: number;
}

export interface DlpAuditEvent {
  id: string;
  timestamp: number;
  destination: DlpDestination;
  mode: DlpPolicyMode;
  actionTaken: "allowed" | "sanitized" | "blocked";
  detectedTypes: string[];
  violationCount: number;
}

export interface DlpEvaluationResult {
  allowed: boolean;
  actionTaken: "allowed" | "sanitized" | "blocked";
  hasViolations: boolean;
  sanitizedContent: string;
  detectedTypes: string[];
  auditEvent: DlpAuditEvent;
  reason?: string;
}

export const DLP_RULES: DlpRule[] = [
  // Anthropic API Keys
  {
    type: "ANTHROPIC_API_KEY",
    name: "Anthropic API Key",
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    mask: "[REDACTED_ANTHROPIC_KEY]",
    severity: "critical",
  },
  // OpenAI API Keys
  {
    type: "OPENAI_API_KEY",
    name: "OpenAI API Key",
    pattern: /sk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
    mask: "[REDACTED_OPENAI_KEY]",
    severity: "critical",
  },
  // GitHub Personal Access Tokens & Fine-grained tokens
  {
    type: "GITHUB_TOKEN",
    name: "GitHub Access Token",
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{82}/g,
    mask: "[REDACTED_GITHUB_TOKEN]",
    severity: "critical",
  },
  // AWS Access Key ID
  {
    type: "AWS_ACCESS_KEY_ID",
    name: "AWS Access Key",
    pattern: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g,
    mask: "[REDACTED_AWS_KEY_ID]",
    severity: "critical",
  },
  // Stripe Live & Secret Keys
  {
    type: "STRIPE_SECRET_KEY",
    name: "Stripe Secret Key",
    pattern: /sk_live_[0-9a-zA-Z]{24,}/g,
    mask: "[REDACTED_STRIPE_KEY]",
    severity: "critical",
  },
  // Generic Private Keys
  {
    type: "PRIVATE_KEY",
    name: "Private Cryptographic Key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    mask: "[REDACTED_PRIVATE_KEY_BLOCK]",
    severity: "critical",
  },
  // Credit Card Numbers
  {
    type: "CREDIT_CARD",
    name: "Credit Card Number",
    pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    mask: (match: string) => `[REDACTED_CARD_ending_in_${match.slice(-4)}]`,
    severity: "high",
  },
  // US Social Security Numbers
  {
    type: "SSN",
    name: "US Social Security Number",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    mask: "[REDACTED_SSN]",
    severity: "high",
  },
  // JWT Bearer Tokens
  {
    type: "JWT_TOKEN",
    name: "JWT Bearer Token",
    pattern: /eyJ[A-Za-z0-9-_=]+\.eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]+/g,
    mask: "[REDACTED_JWT]",
    severity: "medium",
  },
];

/**
 * Scans input text and redacts sensitive credentials and PII according to active policy.
 */
export function scanAndRedact(
  input: string,
  options: { enabledTypes?: string[]; strict?: boolean } = {}
): DlpScanResult {
  if (!input || typeof input !== "string") {
    return {
      hasViolations: false,
      sanitizedText: input ?? "",
      detectedTypes: [],
      redactedCount: 0,
    };
  }

  let sanitized = input;
  const detectedTypes = new Set<string>();
  let redactedCount = 0;

  for (const rule of DLP_RULES) {
    if (options.enabledTypes && !options.enabledTypes.includes(rule.type)) {
      continue;
    }

    const pattern = new RegExp(rule.pattern.source, "g");
    const matches = sanitized.match(pattern);
    if (matches && matches.length > 0) {
      detectedTypes.add(rule.type);
      redactedCount += matches.length;

      if (typeof rule.mask === "function") {
        sanitized = sanitized.replace(new RegExp(rule.pattern.source, "g"), rule.mask);
      } else {
        sanitized = sanitized.replace(new RegExp(rule.pattern.source, "g"), rule.mask);
      }
    }
  }

  return {
    hasViolations: detectedTypes.size > 0,
    sanitizedText: sanitized,
    detectedTypes: Array.from(detectedTypes),
    redactedCount,
  };
}

/**
 * Evaluates DLP policy on payload for a given destination.
 */
export function evaluateDlpPolicy(
  content: string,
  destination: DlpDestination = "model_provider",
  config: DlpPolicyConfig = { mode: "warn" }
): DlpEvaluationResult {
  const maxSize = config.maxScanSizeBytes || 5 * 1024 * 1024;
  const textToScan = content.length > maxSize ? content.slice(0, maxSize) : content;

  const scan = scanAndRedact(textToScan, { enabledTypes: config.enabledRules });

  let actionTaken: "allowed" | "sanitized" | "blocked" = "allowed";
  let allowed = true;
  let reason: string | undefined;

  if (scan.hasViolations) {
    if (config.mode === "block") {
      actionTaken = "blocked";
      allowed = false;
      reason = `Payload blocked by DLP policy due to detected sensitive data: ${scan.detectedTypes.join(", ")}`;
    } else if (config.mode === "warn") {
      actionTaken = "sanitized";
      allowed = true;
      reason = `Payload sanitized before dispatching to ${destination}.`;
    } else {
      actionTaken = "allowed";
      allowed = true;
    }
  }

  const auditEvent: DlpAuditEvent = {
    id: `dlp-audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    destination,
    mode: config.mode,
    actionTaken,
    detectedTypes: scan.detectedTypes,
    violationCount: scan.redactedCount,
  };

  return {
    allowed,
    actionTaken,
    hasViolations: scan.hasViolations,
    sanitizedContent: actionTaken === "sanitized" ? scan.sanitizedText : content,
    detectedTypes: scan.detectedTypes,
    auditEvent,
    reason,
  };
}

/**
 * Deep scans JSON or structured objects, redacting strings recursively.
 */
export function redactStructuredPayload<T>(payload: T): T {
  if (typeof payload === "string") {
    return scanAndRedact(payload).sanitizedText as unknown as T;
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => redactStructuredPayload(item)) as unknown as T;
  }

  if (payload !== null && typeof payload === "object") {
    const redactedObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      redactedObj[key] = redactStructuredPayload(value);
    }
    return redactedObj as T;
  }

  return payload;
}
