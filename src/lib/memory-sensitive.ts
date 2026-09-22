/**
 * Sensitive topics — the categories Juno does not remember unless asked to.
 *
 * WHY THIS IS A SEPARATE AXIS FROM `MemoryCategory`.
 *
 * A category answers "what drawer does this fact live in", and every drawer is
 * equally storable. Sensitivity answers a different question — "is this a fact
 * the user would want stored at all, silently, by a background model, because
 * they mentioned it once" — and the honest default for that question is no.
 * A user who asks for help drafting an email about a diagnosis has not asked
 * Juno to carry the diagnosis into every future conversation, and the memory
 * page is a poor place to be surprised by one.
 *
 * The six topics are the GDPR Article 9 special categories that a chat
 * assistant actually encounters, plus finances — not a special category in law,
 * but the one people are most startled to find written down.
 *
 * DELIBERATELY PURE. No `server-only`, no Prisma, no SDK: the rule is applied
 * at the ingestion gate on the server AND used to flag already-stored rows in
 * the browser, and a rule with two implementations is a rule with two answers.
 *
 * DELIBERATELY RECOMPUTED, NOT STORED. There is no `sensitive` column. A stored
 * verdict would be the classifier as it stood on the day the row was written,
 * so widening a pattern later would leave every older row unflagged — exactly
 * the rows a widening was meant to catch. Recomputing means a fact admitted
 * last month is re-read under today's rule, and the worst case is that the page
 * flags something for review rather than quietly keeping it.
 *
 * WHAT THIS IS NOT. It is a keyword heuristic over short third-person
 * sentences, not a classifier with a confidence. It will miss paraphrases and
 * it will occasionally flag a fact that only looks sensitive. Both failure
 * modes are visible and reversible: a miss is a row on the memory page the user
 * can forget, and a false flag is a fact that was not stored and can be added
 * back by hand. That asymmetry is why the patterns lean inclusive.
 */

export const SENSITIVE_TOPICS = [
  "health",
  "ethnicity",
  "religion",
  "politics",
  "sexuality",
  "finances",
] as const;

export type SensitiveTopic = (typeof SENSITIVE_TOPICS)[number];

/**
 * Copy for the settings toggles. `description` says what opting in actually
 * lets Juno keep, in the user's own terms — "Health" alone does not tell
 * anyone whether it means a diagnosis or a gym routine.
 */
export const SENSITIVE_TOPIC_META: Record<
  SensitiveTopic,
  { label: string; description: string }
> = {
  health: {
    label: "Health",
    description: "Conditions, diagnoses, medication, therapy, disability and pregnancy.",
  },
  ethnicity: {
    label: "Race and ethnicity",
    description: "Racial or ethnic background, and national origin.",
  },
  religion: {
    label: "Religion and beliefs",
    description: "Faith, practice, and philosophical convictions.",
  },
  politics: {
    label: "Political views",
    description: "Party affiliation, voting, and political convictions.",
  },
  sexuality: {
    label: "Sexuality and gender",
    description: "Sexual orientation and gender identity.",
  },
  finances: {
    label: "Money",
    description: "Income, debt, savings and financial circumstances.",
  },
};

/**
 * The patterns, one bundle per topic.
 *
 * Two shapes are mixed on purpose. `markers` are words specific enough to
 * decide on their own ("chemotherapy" is not ambiguous). `subjects` are words
 * that only mean the topic when the sentence is ABOUT the user having or being
 * one — "insurance" is not health, "has health insurance" is — so they are
 * paired with `claims`, the verbs an extracted fact uses to attribute something
 * to its subject. The extractor writes third-person statements ("The user has
 * …", "The user is …"), which is what makes the pairing reliable enough to be
 * worth the precision it buys over a flat keyword list.
 */
interface TopicRules {
  markers: RegExp;
  subjects?: RegExp;
}

/** The attribution verbs an extracted fact uses. Kept in one place so every
 *  topic's `subjects` test means the same thing by "the user has this". */
const CLAIM =
  /\b(is|isn['’]?t|are|was|am|identifies as|has|have|had|has been|was diagnosed|diagnosed|suffers|suffering|lives with|takes|taking|prescribed|treated|undergoing|recovering|practi[cs]es|practi[cs]ing|believes|follows|supports|votes?|voted|earns?|owes?|makes)\b/i;

const TOPIC_RULES: Record<SensitiveTopic, TopicRules> = {
  health: {
    markers:
      /\b(diagnos(?:is|ed|es)|chemotherapy|chemo|cancer|tumou?r|diabet(?:es|ic)|epilep(?:sy|tic)|asthma(?:tic)?|migraine|arthritis|fibromyalgia|endometriosis|hiv|aids|hepatitis|crohn['’]?s|colitis|lupus|ms|multiple sclerosis|parkinson['’]?s|alzheimer['’]?s|dementia|stroke|heart attack|cardiac|hypertension|cholesterol|thyroid|anaemia|anemia|depress(?:ion|ed)|anxiety|bipolar|schizophreni|ptsd|ocd|adhd|autis(?:m|tic)|asperger|dyslexi|eating disorder|anorexi|bulimi|addiction|alcoholi|sober|in recovery|rehab|therapy|therapist|psychiatr|counsell?ing|antidepressant|medication|medicated|prescription|prescribed|insulin|chronic (?:pain|illness|fatigue)|disab(?:led|ility)|wheelchair|surgery|operation|hospitali[sz]ed|pregnan(?:t|cy)|miscarriage|ivf|fertility|menopaus|allergic|allergy|immunocompromised|long covid)\b/i,
    subjects: /\b(health|illness|ill|sick|condition|symptoms?|treatment|clinic|hospital|doctor|gp|appointment)\b/i,
  },
  ethnicity: {
    markers:
      /\b(race|racial|ethnicity|ethnic(?:ally)?|mixed[- ]race|biracial|people of colou?r|bipoc|indigenous|aboriginal|m[āa]ori|first nations|caste|immigrant|refugee|asylum seeker)\b/i,
    subjects:
      /\b(black|white|asian|south asian|east asian|hispanic|latino|latina|latinx|arab|romani|jewish|african|afro[- ]?\w+|caribbean|nationality|heritage|ancestry|descent)\b/i,
  },
  religion: {
    markers:
      /\b(religio(?:n|us)|faith|muslim|islam(?:ic)?|christian(?:ity)?|catholic|protestant|orthodox|evangelical|mormon|jehovah|jewish|juda(?:ism|ic)|hindu(?:ism)?|buddhis[tm]|sikh|jain|ba['’]?ha['’]?i|taoist|shinto|pagan|atheis[tm]|agnostic|spiritual(?:ity)?|church|mosque|synagogue|temple|gurdwara|ramadan|lent|shabbat|sabbath|kosher|halal|baptis[mt]|confirmation|bar mitzvah|prays?|prayer|scripture|bible|quran|qur['’]?an|torah)\b/i,
  },
  politics: {
    markers:
      /\b(politic(?:s|al|ally)|vot(?:e|ed|es|ing)|electorate|party member|conservative|labour party|liberal democrat|republican|democrat(?:ic party)?|socialist|communist|marxist|anarchist|libertarian|green party|left[- ]wing|right[- ]wing|far[- ](?:left|right)|progressive|maga|brexit|referendum|trade union|unionised|unionized|activis[tm]|protest(?:er|ing)|campaign(?:s|ed|ing) for)\b/i,
  },
  sexuality: {
    markers:
      /\b(sexual orientation|sexuality|gender identity|lgbtq?i?a?\+?|gay|lesbian|bisexual|pansexual|asexual|queer|transgender|trans (?:man|woman|person)|nonbinary|non[- ]binary|genderfluid|genderqueer|intersex|came out|coming out|pronouns are|they\/them|he\/him|she\/her|same[- ]sex|deadname)\b/i,
  },
  finances: {
    markers:
      /\b(salary|salaries|wage|income|earnings|net worth|savings|pension|inheritance|bankrupt(?:cy)?|insolven|debts?|in debt|overdraft|loan|mortgage|repossess|credit score|credit rating|foreclos|evict(?:ed|ion)|benefits claim|universal credit|food bank|broke|struggling financially|can['’]?t afford|financial (?:trouble|difficulty|hardship|situation))\b/i,
  },
};

/**
 * The sensitive topic `content` falls under, or null.
 *
 * Returns the FIRST match in `SENSITIVE_TOPICS` order rather than every match.
 * One fact needs one reason — the gate only asks "may this be stored", and a
 * fact blocked for two reasons is blocked exactly as hard as one blocked for
 * one. Health leads the order because it is both the commonest to come up in a
 * chat and the one people most expect not to be kept.
 */
export function sensitiveTopicOf(content: string): SensitiveTopic | null {
  if (!content) return null;
  const hasClaim = CLAIM.test(content);
  for (const topic of SENSITIVE_TOPICS) {
    const rules = TOPIC_RULES[topic];
    if (rules.markers.test(content)) return topic;
    // A subject word is only sensitive when the sentence attributes it to
    // someone. "The user is researching diabetes care for a client" carries a
    // marker and is caught above; "The user's team works in health tech" has a
    // subject word and no claim about the user, and is not.
    if (rules.subjects && hasClaim && rules.subjects.test(content)) return topic;
  }
  return null;
}

export function isSensitiveTopic(value: unknown): value is SensitiveTopic {
  return typeof value === "string" && (SENSITIVE_TOPICS as readonly string[]).includes(value);
}

/** Label for a topic id read back from settings, which may be stale or unknown. */
export function sensitiveTopicLabel(value: string | null | undefined): string {
  return isSensitiveTopic(value) ? SENSITIVE_TOPIC_META[value].label : "Sensitive";
}

/**
 * Keep only the topic ids this build recognises.
 *
 * The column is `String[]`, so a value written by a newer build (or by hand)
 * can name a topic this one has never heard of. Dropping it is the safe read:
 * an unrecognised topic grants nothing, where passing it through would make
 * `allows()` answer for a rule that does not exist here.
 */
export function normalizeSensitiveTopics(values: readonly string[] | null | undefined): SensitiveTopic[] {
  if (!values) return [];
  return SENSITIVE_TOPICS.filter((topic) => values.includes(topic));
}

/**
 * May a fact be remembered, given what the account has opted into?
 *
 * Non-sensitive content is always allowed — this gate only ever subtracts.
 */
export function sensitiveWriteDecision(
  content: string,
  allowedTopics: readonly string[] | null | undefined
): { ok: true } | { ok: false; topic: SensitiveTopic; message: string } {
  const topic = sensitiveTopicOf(content);
  if (!topic) return { ok: true };
  if (normalizeSensitiveTopics(allowedTopics).includes(topic)) return { ok: true };
  return { ok: false, topic, message: sensitiveRefusalMessage(topic) };
}

/**
 * The sentence shown wherever a sensitive write is refused. Built here, beside
 * the rule, for the same reason `suppressionRefusalMessage` is — three call
 * sites refusing in three different words is how a product's promise stops
 * sounding like one promise.
 */
const REFUSAL = {
  lead: "Juno doesn’t remember",
  tail: "unless you turn that topic on in Settings → Memory. Nothing was saved.",
};

export function sensitiveRefusalMessage(topic: SensitiveTopic): string {
  return `${REFUSAL.lead} ${SENSITIVE_TOPIC_META[topic].label.toLowerCase()} ${REFUSAL.tail}`;
}
