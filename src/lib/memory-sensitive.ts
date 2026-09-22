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
 * back by hand. That asymmetry is why the patterns lean inclusive — but only
 * over words that cannot be read another way; see the note on TOPIC_RULES for
 * what leaning inclusive over ordinary English cost the first version.
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
 * The patterns, one per topic.
 *
 * WHOLE WORDS, EVERY INFLECTION SPELLED OUT. The first version of this file
 * had two defects that a single probe exposed, and both are worth naming
 * because both are easy to reintroduce:
 *
 *  1. It never matched a plural or a stem. Each pattern ended in `\b`, so
 *     `migraine\b` cannot match "migraines", and stems written to catch a
 *     family of words — `schizophreni`, `psychiatr`, `menopaus` — could match
 *     no real word at all, because the letter after the stem is a word
 *     character and `\b` needs a boundary there. Nine of nine plainly
 *     sensitive facts in the probe went through. Every alternative below is
 *     therefore a complete word with its inflections written out
 *     (`migraines?`, `schizophreni(?:a|c)`), never a stem left open.
 *
 *  2. It flagged ordinary technical English. Eleven of twelve innocent facts
 *     were refused — "race conditions" as ethnicity, "a progressive web app"
 *     as politics, "the app came out last week" as sexuality, "broke the build"
 *     as money, "lent a laptop" as religion, "gradient descent" and "a black
 *     theme" as ethnicity. For a product whose users are largely developers
 *     that is not a rounding error: it silently stops Juno learning what they
 *     build. The words that did it — race, progressive, conservative, came
 *     out, broke, lent, descent, faith, spiritual, operation, aids, PoC,
 *     welfare, bare colour words — are gone or appear only inside a phrase
 *     that cannot be read the other way ("came out as", "black heritage").
 *     It also used to accept a vague "subject word" (clinic, doctor, heritage)
 *     whenever the sentence contained a verb like "is" or "has", which every
 *     extracted fact does; that mechanism is gone with them.
 *
 * What remains still leans inclusive where a word has no innocent reading
 * worth protecting — "medication" is flagged in "a medication-reminder app" as
 * well as in "takes medication", because a keyword cannot tell them apart and
 * a miss is the failure the user cannot see. tests/memory-sensitive.test.ts
 * pins both lists, so a change here that trades one kind of error for the
 * other has to say so.
 */
const TOPIC_RULES: Record<SensitiveTopic, RegExp> = {
  health:
    /\b(?:diagnos(?:is|es|ed|e|ing)|chemo(?:therapy)?|cancers?|tumou?rs?|oncolog(?:y|ist)|diabet(?:es|ic|ics)|epilep(?:sy|tic)|asthma(?:tic)?|migraines?|arthritis|fibromyalgia|endometriosis|lupus|colitis|crohn['’]?s|hiv|hepatitis|multiple sclerosis|parkinson['’]?s|alzheimer['’]?s|dementia|heart (?:attack|condition|disease|failure)s?|cardiac|hypertension|high blood pressure|cholesterol|thyroid|an(?:a)?emi(?:a|c)|depress(?:ion|ed|ive)|anxiety|panic attacks?|bipolar|schizophreni(?:a|c)|ptsd|ocd|adhd|autis(?:m|tic)|asperger['’]?s|dyslexi(?:a|c)|dyspraxi(?:a|c)|eating disorders?|anorexi(?:a|c)|bulimi(?:a|c)|addict(?:ion|ions|ed)|alcoholi(?:c|sm)|sobriety|in recovery|rehab|therap(?:y|ies|ist|ists)|psychiatr(?:y|ist|ists|ic)|psychologists?|counsell?(?:ing|or|ors)|antidepressants?|medications?|medicated|prescriptions?|insulin|chronic (?:pain|illness|fatigue|condition|disease)|disab(?:led|ility|ilities)|wheelchairs?|surger(?:y|ies)|hospitali[sz](?:ed|ation)|pregnan(?:t|cy|cies)|miscarriages?|ivf|fertility|infertil(?:e|ity)|menopaus(?:e|al)|allerg(?:y|ies|ic)|immunocompromised|long covid)\b/i,
  ethnicity:
    /\b(?:racial(?:ly)?|racism|racist|ethnicity|ethnic(?:ally)?|mixed[- ]race|biracial|multiracial|people of colou?r|person of colou?r|bipoc|indigenous|aboriginal|m[āa]ori|first nations|native american|caste|immigrants?|immigrated|emigrated|refugees?|asylum seekers?|(?:black|white|asian|hispanic|latin[oax]|arab|jewish|romani|african|caribbean) (?:person|man|woman|people|heritage|background|descent|family|ancestry)|identif(?:y|ies) as (?:black|white|asian|hispanic|latin[oax]|arab|romani))\b/i,
  religion:
    /\b(?:religio(?:n|ns|us)|muslims?|islam(?:ic)?|christians?|christianity|catholics?|catholicism|protestants?|evangelicals?|mormons?|latter[- ]day saints|jehovah['’]?s witness(?:es)?|jews|jewish|judaism|hindus?|hinduism|buddhis(?:t|ts|m)|sikhs?|sikhism|jains?|jainism|bah[aá]['’]?[ií]s?|taois(?:t|m)|shinto|pagans?|paganism|wicca(?:ns?)?|atheis(?:t|ts|m)|agnostic(?:s|ism)?|spirituality|church(?:es)?|mosques?|synagogues?|gurdwaras?|ramadan|shabbat|sabbath|kosher|halal|baptis(?:m|ed|t|ts)|bar mitzvah|bat mitzvah|first communion|prays?|prayed|praying|prayers?|scriptures?|bible|quran|qur['’]?an|torah)\b/i,
  politics:
    /\b(?:politic(?:s|al|ally)|vot(?:e|ed|es|ing|er|ers)|electorate|party member(?:ship)?|conservative party|tor(?:y|ies)|labour party|liberal democrats?|lib dems?|republicans?|democrats?|democratic party|gop|socialis(?:t|ts|m)|communis(?:t|ts|m)|marxis(?:t|ts|m)|anarchis(?:t|ts|m)|libertarians?|green party|left[- ]wing|right[- ]wing|far[- ](?:left|right)|cent(?:re|er)[- ](?:left|right)|maga|brexit(?:eers?)?|remainers?|referendum|trade unions?|unioni[sz]ed|activis(?:t|ts|m)|protest(?:er|ers|ing|ed)|campaign(?:s|ed|ing)? for)\b/i,
  sexuality:
    /\b(?:sexual orientation|sexuality|gender identity|lgbt(?:q|qi|qia)?\+?|gay|lesbians?|bisexual|pansexual|asexual|queer|transgender|trans (?:man|woman|person|people)|non[- ]?binary|genderfluid|genderqueer|agender|intersex|pronouns are|they\/them|he\/him|she\/her|she\/they|he\/they|same[- ]sex|deadnam(?:e|ed|ing)|(?:came|coming) out as|out as (?:gay|lesbian|bi|trans|queer))\b/i,
  finances:
    /\b(?:salar(?:y|ies)|wages?|income|earnings|net worth|savings|pensions?|inheritance|bankrupt(?:cy)?|insolven(?:t|cy)|debts?|in debt|overdrafts?|loans?|mortgages?|repossess(?:ed|ion)|credit (?:score|rating)|foreclos(?:ed|ure)|evict(?:ed|ion)|benefits claim|universal credit|food banks?|struggling financially|financial(?:ly)? (?:trouble|difficult(?:y|ies)|hardship|struggl(?:e|es|ing)|situation)|can['’]?t afford|cannot afford|paycheck to paycheck)\b/i,
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
  for (const topic of SENSITIVE_TOPICS) {
    if (TOPIC_RULES[topic].test(content)) return topic;
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
