/**
 * Scanning untrusted web output for instruction injection (SPEC §6.4 item 5).
 *
 * A COPY of `scanUntrusted` from runner/agent-core/src/work/injection.ts,
 * which is where the patterns are maintained. The runner is vendored and built
 * standalone and `tsconfig.json` excludes it, so src/ cannot import it; the
 * copy is held to the original by `tests/web-injection-drift.test.ts`, which
 * runs both on one fixture and requires the same verdict from each. Change the
 * runner first, then this file, never this file alone.
 *
 * Read the runner's header for the boundary claim, which applies here in
 * full: a classifier is a detector, not a boundary. In chat the structural
 * defences are the untrusted envelope, the provenance ledger (a page cannot
 * make `web_fetch` open a URL nobody showed the model) and the approval gate.
 * This scan raises the cost of the easy attempts, marks the turn's taint with a
 * severity, and puts a verdict on the tool record for the Activity panel.
 *
 * The scan never mutates. Pure and free of `server-only`.
 */

/** The runner's `WorkInjectionSignal`, mirrored. */
export type WorkInjectionSignal =
  | "assistant_directive"
  | "system_prompt_probe"
  | "tool_invocation_syntax"
  | "credential_exfiltration"
  | "encoded_payload"
  | "envelope_escape";

/** The runner's `WorkInjectionSeverity`, mirrored. */
export type WorkInjectionSeverity = "none" | "suspicious" | "hostile";

/** Mirrored from src/lib/untrusted-content.ts (the runner mirrors it too). */
const SENTINEL = "JUNO_UNTRUSTED";

/**
 * How much of one tool result is scanned.
 *
 * A cap rather than an unbounded scan because a fetched page can be megabytes
 * and a dozen regexes over all of it, per call, is a real cost. When the cap
 * bites the verdict says so: a scanner that quietly stops at 200k and reports
 * "clean" has told the caller something false about the tail.
 */
export const MAX_SCAN_CHARS = 200_000;

/** Matches beyond this are counted but not listed; the list is for a human. */
export const MAX_REPORTED_MATCHES = 20;

/** Matched text is clipped to this before it goes anywhere a person reads. */
export const MAX_EXCERPT_CHARS = 160;

export interface InjectionMatch {
  signal: WorkInjectionSignal;
  severity: Exclude<WorkInjectionSeverity, "none">;
  /** Character offsets into the text as it was passed in. */
  start: number;
  end: number;
  /** The matched span, clipped. Never the surrounding content. */
  excerpt: string;
  /** What this pattern is for, in one sentence. */
  why: string;
}

export interface InjectionVerdict {
  detected: boolean;
  severity: WorkInjectionSeverity;
  matches: InjectionMatch[];
  /** Distinct signals seen, in first-match order. */
  signals: WorkInjectionSignal[];
  /** Total matches, including any past MAX_REPORTED_MATCHES. */
  matchCount: number;
  /** True when the content was longer than MAX_SCAN_CHARS. */
  truncated: boolean;
}

interface Pattern {
  signal: WorkInjectionSignal;
  severity: Exclude<WorkInjectionSeverity, "none">;
  re: RegExp;
  why: string;
}

/*
 * Every pattern is bounded — `[^.\n]{0,60}` and never `.*` — so a hostile
 * input cannot make the scanner itself the denial of service by triggering
 * catastrophic backtracking on a megabyte of text.
 */
const PATTERNS: readonly Pattern[] = [
  {
    signal: "assistant_directive",
    severity: "hostile",
    re: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|earlier|above|all)\b[^.\n]{0,30}\b(?:instruction|instructions|prompt|prompts|rule|rules|direction|directions)\b/gi,
    why: "tells the reader to discard the instructions it was given",
  },
  {
    signal: "assistant_directive",
    severity: "hostile",
    re: /\b(?:new|updated|revised|additional)\s+(?:system\s+)?(?:instruction|instructions|directive|directives|task|prompt)\b/gi,
    why: "presents itself as a fresh instruction set",
  },
  {
    signal: "assistant_directive",
    severity: "hostile",
    re: /\b(?:assistant|ai agent|ai assistant|language model|chatbot|claude|juno)\b\s*[,:;.—-]{0,2}\s*(?:please\s+)?(?:you\s+(?:must|should|will|need to|are to)|ignore|disregard|stop|now\s+\w+|do not|don't)\b/gi,
    why: "addresses the assistant directly and issues it an order",
  },
  {
    signal: "assistant_directive",
    severity: "hostile",
    re: /\bfrom now on\b[^.\n]{0,40}\byou\b/gi,
    why: "attempts to install a standing rule",
  },
  {
    signal: "assistant_directive",
    severity: "hostile",
    re: /\b(?:the\s+)?user\s+has\s+(?:already\s+)?(?:approved|authorised|authorized|consented to|permitted)\b/gi,
    why: "claims an approval the user did not give",
  },
  {
    signal: "assistant_directive",
    severity: "hostile",
    re: /\byou(?:'re| are)\s+(?:now\s+)?(?:in|running in)\s+(?:test|testing|maintenance|developer|debug|admin)\s+mode\b/gi,
    why: "claims a mode in which the rules do not apply",
  },
  {
    signal: "system_prompt_probe",
    severity: "hostile",
    re: /\b(?:reveal|repeat|print|output|show|display|disclose|dump|leak|summarise|summarize)\b[^.\n]{0,40}\b(?:system prompt|system message|initial instructions|your instructions|developer message|instructions above)\b/gi,
    why: "asks for the system prompt to be disclosed",
  },
  {
    signal: "system_prompt_probe",
    severity: "hostile",
    re: /\b(?:replace|update|change|append to|extend|rewrite|amend)\b[^.\n]{0,30}\b(?:system prompt|system message|your instructions)\b/gi,
    why: "asks for the system prompt to be modified",
  },
  {
    signal: "tool_invocation_syntax",
    severity: "hostile",
    re: /<\s*\/?\s*(?:antml:)?(?:invoke|function_calls|function_results|tool_use|tool_call|tool_result)\b/gi,
    why: "contains tool-call markup that could be read as a real call",
  },
  {
    signal: "tool_invocation_syntax",
    severity: "hostile",
    re: /<\|(?:im_start|im_end|system|assistant|user|endoftext)\|>/g,
    why: "contains chat-template control tokens",
  },
  {
    signal: "tool_invocation_syntax",
    // Only suspicious, unlike the markup above: a connector that returns its
    // own JSON can legitimately contain a `"function"` key, and a rule that
    // called every structured API response a violation would fill the audit
    // log with noise and train whoever reads it to skip the row.
    severity: "suspicious",
    re: /\{\s*"(?:tool|tool_name|function|recipient|tool_calls)"\s*:/g,
    why: "contains a tool-call shaped object",
  },
  {
    signal: "tool_invocation_syntax",
    severity: "hostile",
    re: /\b(?:call|invoke|run|execute|use)\s+the\s+[a-z0-9_.-]{2,40}\s+(?:tool|function|connector|command)\b/gi,
    why: "instructs the reader to call a named tool",
  },
  {
    signal: "credential_exfiltration",
    severity: "hostile",
    re: /\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|secret|password|passphrase|credential|credentials|private key|session cookie)\b[^.\n]{0,60}\b(?:send|post|email|e-mail|upload|share|forward|transmit|exfiltrate|curl|wget|fetch|https?:)\b/gi,
    why: "asks for a credential to be sent somewhere",
  },
  {
    signal: "credential_exfiltration",
    severity: "hostile",
    // `.env` is spelled outside the `\b…\b` group on purpose: a word boundary
    // before a literal dot never matches after whitespace, so folding it in
    // with the others silently disables that one alternative.
    re: /\b(?:send|post|email|e-mail|upload|share|forward|transmit)\b[^.\n]{0,60}(?:\b(?:api[ _-]?key|access[ _-]?token|secret|password|credential|credentials|private key|keychain|id_rsa)\b|\.env\b)/gi,
    why: "asks for a credential to be sent somewhere",
  },
  {
    signal: "credential_exfiltration",
    severity: "hostile",
    re: /\b(?:cat|read|open|print)\b[^.\n]{0,20}(?:~\/\.ssh\/|\.env\b|id_rsa|\.aws\/credentials|login\.keychain)/gi,
    why: "names a credential file to be read",
  },
  {
    signal: "credential_exfiltration",
    severity: "hostile",
    re: /\bbearer\s+[A-Za-z0-9._~+/-]{20,}/gi,
    why: "carries a bearer token",
  },
  {
    signal: "encoded_payload",
    severity: "suspicious",
    re: /(?:%[0-9a-f]{2}){12,}/gi,
    why: "a long percent-encoded run, which hides text from a reader",
  },
  {
    signal: "encoded_payload",
    severity: "suspicious",
    re: /(?:\\u[0-9a-f]{4}){8,}/gi,
    why: "a long unicode-escape run, which hides text from a reader",
  },
  {
    signal: "encoded_payload",
    severity: "hostile",
    // Bidirectional overrides and zero-width characters reorder or hide text
    // on screen while leaving it intact in the bytes the model reads, so a
    // human reviewing the page sees something different from what was sent.
    // Written as escapes rather than literals so the pattern survives being
    // copied, diffed and reviewed — these characters are invisible in every
    // one of those.
    re: /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]{2,}/g,
    why: "uses bidirectional or zero-width control characters to hide text",
  },
];

/** Base64 runs long enough to carry a sentence, examined by decoding them. */
const BASE64_RUN = /[A-Za-z0-9+/]{64,}={0,2}/g;

const ENVELOPE_ESCAPE = new RegExp(SENTINEL, "gi");

function clip(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length <= MAX_EXCERPT_CHARS
    ? flattened
    : `${flattened.slice(0, MAX_EXCERPT_CHARS)}…`;
}

/**
 * Whether a decoded blob is text a person could have written.
 *
 * Random binary decodes to mostly control bytes; a hidden instruction decodes
 * to prose. Without this test every JPEG in a data URI would be reported.
 */
function looksLikeText(decoded: string): boolean {
  if (decoded.length < 16) return false;
  let printable = 0;
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127)) printable += 1;
  }
  return printable / decoded.length > 0.85;
}

export interface ScanOptions {
  /** Override the scan cap; the verdict still reports truncation. */
  maxChars?: number;
}

/**
 * Scan untrusted content and report what was found. Never mutates.
 *
 * Offsets are into the string as passed in, so a caller that wants to show a
 * user the matched span can slice the original rather than trusting an
 * excerpt this function chose.
 */
export function scanUntrusted(content: string, options: ScanOptions = {}): InjectionVerdict {
  const limit = options.maxChars ?? MAX_SCAN_CHARS;
  const truncated = content.length > limit;
  const text = truncated ? content.slice(0, limit) : content;

  const matches: InjectionMatch[] = [];

  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    let found: RegExpExecArray | null;
    while ((found = pattern.re.exec(text)) !== null) {
      matches.push({
        signal: pattern.signal,
        severity: pattern.severity,
        start: found.index,
        end: found.index + found[0].length,
        excerpt: clip(found[0]),
        why: pattern.why,
      });
      // A zero-length match would spin forever; no pattern here can produce
      // one, but the loop must not depend on that staying true.
      if (found.index === pattern.re.lastIndex) pattern.re.lastIndex += 1;
    }
  }

  ENVELOPE_ESCAPE.lastIndex = 0;
  let escape: RegExpExecArray | null;
  while ((escape = ENVELOPE_ESCAPE.exec(text)) !== null) {
    matches.push({
      signal: "envelope_escape",
      severity: "hostile",
      start: escape.index,
      end: escape.index + escape[0].length,
      excerpt: clip(escape[0]),
      why: "reproduces the untrusted-content marker, an attempt to close its own envelope and be read as an instruction",
    });
  }

  BASE64_RUN.lastIndex = 0;
  let blob: RegExpExecArray | null;
  while ((blob = BASE64_RUN.exec(text)) !== null) {
    const decoded = decodeBase64(blob[0]);
    if (!decoded || !looksLikeText(decoded)) continue;
    const inner = scanDecoded(decoded);
    matches.push({
      signal: "encoded_payload",
      // A base64 blob is only suspicious until it is decoded; once the text
      // inside it trips a rule, the encoding is the tell rather than the
      // finding, and reporting it as merely suspicious understates it.
      severity: inner ? "hostile" : "suspicious",
      start: blob.index,
      end: blob.index + blob[0].length,
      excerpt: clip(blob[0]),
      why: inner
        ? `base64 that decodes to text which ${inner}`
        : "a long base64 run that decodes to readable text",
    });
  }

  matches.sort((a, b) => a.start - b.start || a.end - b.end);

  const signals: WorkInjectionSignal[] = [];
  let severity: WorkInjectionSeverity = "none";
  for (const match of matches) {
    if (!signals.includes(match.signal)) signals.push(match.signal);
    if (match.severity === "hostile") severity = "hostile";
    else if (severity === "none") severity = "suspicious";
  }

  return {
    detected: matches.length > 0,
    severity,
    matches: matches.slice(0, MAX_REPORTED_MATCHES),
    signals,
    matchCount: matches.length,
    truncated,
  };
}

function decodeBase64(blob: string): string | null {
  try {
    const decoded = Buffer.from(blob, "base64").toString("utf8");
    // A replacement character means the bytes were not UTF-8 text at all,
    // so this was an image or an archive rather than a hidden instruction.
    return decoded.includes("\uFFFD") ? null : decoded;
  } catch {
    return null;
  }
}

/** The `why` of the first hostile pattern the decoded text trips, if any. */
function scanDecoded(decoded: string): string | null {
  for (const pattern of PATTERNS) {
    if (pattern.severity !== "hostile" || pattern.signal === "encoded_payload") continue;
    pattern.re.lastIndex = 0;
    if (pattern.re.test(decoded)) return pattern.why;
  }
  return null;
}
