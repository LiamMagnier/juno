/**
 * Multi-hop leads (research protocol Stage 3).
 *
 * The protocol's chaining rule: when an extracted page reveals a new unknown —
 * an unannounced rate-limit tier, a hidden deprecation, an architecture
 * change, an incident, a user revolt — formulate a hyper-specific micro-query
 * for it, and send the next round after that lead. Query -> extract deep page
 * -> identify new lead -> issue micro-query.
 *
 * Before this module a round's discoveries reached the next round only through
 * the lead model's free-text gap briefs, and only when the lead judged a
 * sub-question "short of evidence": a round that FOUND a deprecation notice
 * on a covered vector ended the investigation right there, because coverage
 * was high. Nothing read the findings for what they opened.
 *
 * Deterministic: signals are regular expressions over the findings' claims
 * and quotes, the entity is the nearest capitalised name in the claim (else
 * the site the quote came from), and every lead is deduplicated against the
 * searches the run already made. The workers' own suggested follow-ups ride
 * along, filtered the same way. Pure and client-safe.
 */

import { dedupeQueries, restatesGoal } from "@/lib/research/query-dedupe";
import { siteName } from "@/lib/research/source-policy";

export interface LeadFinding {
  objectiveId: string | null;
  url: string;
  claim: string;
  quote: string;
  round: number;
}

export interface ResearchLead {
  objectiveId: string;
  /** The micro-query to run. */
  query: string;
  /** What in the finding opened it: "deprecation", "rate limit", "new tier"… */
  signal: string;
  /** Where it was found, for the brief. */
  from: string;
}

/** What a page can reveal that the plan could not have known to ask, and the words a micro-query uses for it. */
const SIGNALS: Array<{ signal: string; test: RegExp; terms: string }> = [
  { signal: "deprecation", test: /\b(?:deprecat\w*|sunset\w*|end[- ]of[- ](?:life|support)|EOL|retir(?:ed|ing|ement)|discontinu\w*|phased? out)\b/i, terms: "deprecation date migration" },
  { signal: "pricing change", test: /\b(?:price (?:increase|hike|change)s?|pricing change\w*|new pricing|now (?:costs?|charges?)|(?:raised|cut|lowered) (?:its |the )?prices?)\b/i, terms: "pricing change effective date" },
  { signal: "new tier", test: /\b(?:new|introduc\w*|launch\w*|announc\w*|added)\b[^.]{0,60}\b(?:tier|plan|edition|SKU)\b/i, terms: "plan tier limits pricing" },
  { signal: "rate limit", test: /\b(?:rate[- ]limit\w*|requests per (?:minute|second|hour|day)|RPM|TPM|tokens per minute|quota\w*|throttl\w*|usage cap\w*)\b/i, terms: "rate limits quota tiers" },
  { signal: "incident", test: /\b(?:outage\w*|incident\w*|downtime|degraded (?:performance|service)|post-?mortem|data breach|security vulnerabilit\w*|CVE-\d{4}-\d+)\b/i, terms: "incident postmortem" },
  { signal: "legal or regulatory", test: /\b(?:lawsuit\w*|class action|sued|fined|antitrust|regulator\w*|investigation|consent decree|injunction)\b/i, terms: "lawsuit regulator filing" },
  { signal: "user backlash", test: /\b(?:backlash|complain\w*|user revolt|petition|boycott|users (?:report|say|are reporting)|GitHub issue)\b/i, terms: "user complaints GitHub issues" },
  { signal: "preview status", test: /\b(?:beta|public preview|private preview|waitlist|early access|experimental)\b/i, terms: "general availability date" },
  { signal: "architecture change", test: /\b(?:architecture change|re-?architect\w*|migrat(?:ed|ion) to|replac(?:ed|es) (?:the|its)|new (?:model|engine|backend))\b/i, terms: "architecture change announcement" },
  { signal: "terms change", test: /\b(?:terms of (?:service|use)|data retention|train(?:s|ing)? on (?:customer|user) data|opt[- ]out|indemnif\w*|SLA)\b/i, terms: "terms data retention policy" },
];

const VERSION = /\bv?(\d+\.\d+(?:\.\d+)?)\b/;
const YEAR = /\b(20\d{2})\b/;
/** Capitalised names, joined across "of"/"for"/"&": "GitHub Copilot Business", "Claude 3.5 Sonnet". */
const NAME = /\b([A-Z][\w.+-]*(?:\s+(?:[A-Z][\w.+-]*|\d[\w.]*|of|for|&)){0,3})/g;
const NOT_NAMES = new Set(["The", "This", "That", "These", "Those", "It", "In", "On", "As", "At", "For", "From", "Starting", "Since", "After", "Before", "Users", "Our", "We", "Each", "All", "New", "According", "However", "When", "If"]);

/** The entity a claim is about: its longest capitalised name, else the source's site. */
export function entityOf(claim: string, url: string): string {
  let best = "";
  for (const match of claim.matchAll(NAME)) {
    const words = match[1]!.split(/\s+/);
    while (words.length && (NOT_NAMES.has(words[0]!) || /^(?:of|for|&)$/.test(words[0]!))) words.shift();
    while (words.length && /^(?:of|for|&)$/.test(words[words.length - 1]!)) words.pop();
    const name = words.join(" ");
    if (name.length > best.length && !/^[A-Z]{2,4}$/.test(name)) best = name;
  }
  if (best) return best;
  const site = siteName(url);
  return site ? site.charAt(0).toUpperCase() + site.slice(1) : "";
}

/** Max leads one round sends on, and per vector. */
export const MAX_LEADS_PER_ROUND = 6;
const MAX_LEADS_PER_OBJECTIVE = 2;

/**
 * The micro-queries a round's findings open, newest round only, deduplicated
 * against every search the run has made and against each other, at most
 * `MAX_LEADS_PER_ROUND`. Worker-suggested follow-ups (`suggested`) come after
 * the signal-derived ones and pass the same filters.
 */
export function extractLeads(input: {
  findings: readonly LeadFinding[];
  round: number;
  issued: readonly string[];
  goal: string;
  suggested?: ReadonlyArray<{ objectiveId: string; query: string }>;
}): ResearchLead[] {
  const out: ResearchLead[] = [];
  const perObjective = new Map<string, number>();
  const taken: string[] = [];
  const offer = (lead: ResearchLead): void => {
    if (out.length >= MAX_LEADS_PER_ROUND) return;
    if ((perObjective.get(lead.objectiveId) ?? 0) >= MAX_LEADS_PER_OBJECTIVE) return;
    const query = lead.query.replace(/\s+/g, " ").trim();
    if (query.split(" ").length < 2 || restatesGoal(query, input.goal)) return;
    if (dedupeQueries([query], [...input.issued, ...taken]).length === 0) return;
    taken.push(query);
    perObjective.set(lead.objectiveId, (perObjective.get(lead.objectiveId) ?? 0) + 1);
    out.push({ ...lead, query });
  };

  for (const finding of input.findings) {
    if (finding.round !== input.round || !finding.objectiveId) continue;
    const text = `${finding.claim} ${finding.quote}`;
    const hit = SIGNALS.find((signal) => signal.test.test(text));
    if (!hit) continue;
    const entity = entityOf(finding.claim, finding.url);
    if (!entity) continue;
    const version = VERSION.exec(finding.claim)?.[1];
    // A new tier is searched by its own name: "Cursor Ultra plan …".
    const tierName = hit.signal === "new tier" ? /\b([A-Z][\w+-]*)\s+(?:plan|tier|edition)\b/.exec(finding.claim)?.[1] : undefined;
    const year = YEAR.exec(text)?.[1];
    offer({
      objectiveId: finding.objectiveId,
      query: [
        entity,
        tierName && !entity.includes(tierName) ? tierName : "",
        version && !entity.includes(version) ? version : "",
        hit.terms,
        year ?? "",
      ]
        .filter(Boolean)
        .join(" "),
      signal: hit.signal,
      from: finding.url,
    });
  }
  for (const suggestion of input.suggested ?? []) {
    offer({ objectiveId: suggestion.objectiveId, query: suggestion.query, signal: "worker follow-up", from: "" });
  }
  return out;
}
