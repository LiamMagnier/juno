/**
 * Juno Data Loss Prevention (DLP) & PII Redaction Engine
 *
 * Scans prompts, attachments, and tool arguments for sensitive credentials,
 * secrets (OpenAI, AWS, GitHub, Stripe tokens), credit cards, SSNs, and personal data
 * before dispatching payloads to external third-party LLM providers.
 */

export interface DlpScanResult {
  hasViolations: boolean;
  sanitizedText: string;
  detectedTypes: string[];
  redactedCount: number;
}

export interface DlpRule {
  type: string;
  pattern: RegExp;
  mask: string | ((match: string) => string);
}

const DLP_RULES: DlpRule[] = [
  // Anthropic API Keys (checked first)
  {
    type: "ANTHROPIC_API_KEY",
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    mask: "[REDACTED_ANTHROPIC_KEY]",
  },
  // OpenAI API Keys
  {
    type: "OPENAI_API_KEY",
    pattern: /sk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
    mask: "[REDACTED_OPENAI_KEY]",
  },
  // GitHub Personal Access Tokens & Fine-grained tokens
  {
    type: "GITHUB_TOKEN",
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{82}/g,
    mask: "[REDACTED_GITHUB_TOKEN]",
  },
  // AWS Access Key ID
  {
    type: "AWS_ACCESS_KEY_ID",
    pattern: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g,
    mask: "[REDACTED_AWS_KEY_ID]",
  },
  // Stripe Live & Secret Keys
  {
    type: "STRIPE_SECRET_KEY",
    pattern: /sk_live_[0-9a-zA-Z]{24,}/g,
    mask: "[REDACTED_STRIPE_KEY]",
  },
  // Generic Private Keys
  {
    type: "PRIVATE_KEY",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    mask: "[REDACTED_PRIVATE_KEY_BLOCK]",
  },
  // Credit Card Numbers (Major formats with standard separators)
  {
    type: "CREDIT_CARD",
    pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    mask: (match: string) => `[REDACTED_CARD_ending_in_${match.slice(-4)}]`,
  },
  // US Social Security Numbers
  {
    type: "SSN",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    mask: "[REDACTED_SSN]",
  },
  // JWT Bearer Tokens
  {
    type: "JWT_TOKEN",
    pattern: /eyJ[A-Za-z0-9-_=]+\.eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]+/g,
    mask: "[REDACTED_JWT]",
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
