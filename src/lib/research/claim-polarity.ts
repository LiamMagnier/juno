/**
 * The conservative polarity check: when the text alone may say "the passage
 * states the opposite of this claim".
 *
 * Four rounds of heuristics that scored clauses against each other and picked
 * the "best" one each fixed the cases reported against them and opened new
 * ones, because a best match is a guess and a wrong guess there is a false
 * contradiction: the judge is skipped, the support ceiling is zero and the
 * repair rewrites an honest sentence as "Conflicting evidence: …". So the
 * deterministic layer no longer guesses. It contradicts a claim only when the
 * passage proves it wrong, and leaves everything else to the judge:
 *
 *  1. one proposition of the passage is the claim's own proposition with the
 *     opposite polarity — the same subject in the same surface form (or a
 *     personal pronoun, possessive or head-noun reference that resolves to it
 *     uniquely), the same verb, tense and modal, the same object (a denial of
 *     the act answers the claim's amount: "did not rise" against "rose 14%"),
 *     every one of the claim's time and place qualifiers, and nothing the
 *     negation could be about instead: a denial that adds a qualifier, a part
 *     of the period ("at the end of 2023"), a reason ("because demand fell",
 *     "due to inflation", "as planned"), a count ("once", "again", "three
 *     times"), a quantifier ("all of its shares", "every store") or a reason,
 *     time, condition or purpose clause beside it ("after regulators
 *     objected", "so that it could win customers") denies something narrower
 *     than the claim, and is proof only against a statement narrowed by the
 *     same words; and
 *  2. no other proposition of the passage plausibly states the claim with
 *     the claim's own polarity: one whose subject may be the claim's (another
 *     name, a pronoun it cannot pin down, no subject at all) and whose verb
 *     and qualifiers do not conflict with the claim's.
 *
 * Both halves read the passage as propositions, not as clauses split at
 * commas: a verbless remnant ("…, but not in Italy", "only in Spain, not in
 * Italy", "rather than in Italy") is the previous proposition with the
 * contrasted phrase swapped in; an elided verb ("but the House did", "It
 * didn't in Asia", "In 2024, he did not") takes the previous predicate; a
 * fronted date or place split off by a comma ("In 2023, the bank opened …")
 * belongs to the clause it introduces; a subject left out after "and"/"but"
 * is the previous one; hedged, conditional and attribution clauses state
 * nothing. A "that" clause states something only after an affirmed verb of
 * saying ("said that"); after a noun ("reports that", "rumours that"), a
 * denied or hedged verb ("never said that") or a verb of doubt it states
 * nothing, and denied, disputed or reported wrongly ("denied that",
 * "rejected claims that", "wrongly reported that") it is read with the
 * opposite polarity and never certain: shown for review, never proof.
 * Whatever the reader cannot place with certainty can only make a
 * contradiction LESS likely: an unparsed proposition is never the proof in
 * (1), and always a candidate in (2). "not just", "not only", "not merely" +
 * verb is a focus, not a denial ("did not just raise prices, it also …"
 * says it raised them), and never certain.
 *
 * A denial that cannot be proved is still shown (`findUnresolvedDenial`,
 * contested, never contradicted) whenever its subject may be the claim's: a
 * pronoun, a head-noun alias ("the carrier"), a claim-side alias (the claim's
 * "the agency" for the passage's "Food and Drug Administration"), one subject
 * of "neither … nor", "except", "but not" or "nor did X", or a "not in Y"
 * remnant — so a credulous judge never leaves it unseen.
 *
 * Pure and free of the rest of the audit, so it can be read and tested on
 * its own (tests/research-claim-corpus.test.ts runs it over every repro the
 * verifiers ever reported).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Words
// ─────────────────────────────────────────────────────────────────────────────

interface Token {
  raw: string;
  low: string;
  /** Upper-case first letter, as written. */
  cap: boolean;
  /** Ends in 's or s' (the possessive marker is kept in `low`). */
  possessive: boolean;
  kind: "word" | "num" | "punct";
  /** First word of its sentence (opening punctuation aside). */
  first: boolean;
}

const ABBREVIATIONS = new Set(
  "mr mrs ms dr prof st inc ltd co corp jr sr gov sen rep gen mt no vs etc e.g i.e u.s u.k u.n a.m p.m fig approx dept univ".split(" ")
);

/** The sentences of a text: a full stop, question or exclamation mark and a capital, figure or quote after it. */
function sentencesOf(text: string): Array<{ text: string; question: boolean }> {
  const out: Array<{ text: string; question: boolean }> = [];
  for (const block of text.replace(/\r/g, "").split(/\n+/)) {
    const line = block.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+|>\s*)/, "").trim();
    if (!line) continue;
    let start = 0;
    const re = /([.!?])(["”’')\]]*)\s+(?=["“‘'(\[]?[A-Z0-9$£€])/g;
    for (const m of line.matchAll(re)) {
      const end = m.index + m[1]!.length + m[2]!.length;
      const head = line.slice(start, m.index);
      const lastWord = (head.match(/([A-Za-z.]+)$/)?.[1] ?? "").toLowerCase();
      if (m[1] === "." && (ABBREVIATIONS.has(lastWord) || ABBREVIATIONS.has(lastWord.replace(/\.$/, "")) || /^[a-z]$/.test(lastWord) || /(?:^|\.)[a-z]\.[a-z]$/.test(lastWord))) continue;
      out.push({ text: line.slice(start, end).trim(), question: m[1] === "?" });
      start = m.index + m[0].length;
    }
    const rest = line.slice(start).trim();
    if (rest) out.push({ text: rest, question: rest.endsWith("?") });
  }
  return out;
}

const CONTRACTIONS: Record<string, [string, string]> = {
  "won't": ["will", "not"], "can't": ["can", "not"], cannot: ["can", "not"], "shan't": ["shall", "not"],
  "ain't": ["is", "not"],
};

function tokenize(sentence: string): Token[] {
  const text = sentence.replace(/[’‘]/g, "'").replace(/[“”«»]/g, '"').replace(/[–—]/g, " — ");
  const out: Token[] = [];
  const push = (raw: string, kind: Token["kind"]) => {
    const low = raw.toLowerCase();
    out.push({
      raw,
      low,
      // "easyJet", "eBay": a name with its capital inside.
      cap: /^[A-Z]/.test(raw) || /^[a-z]{1,5}[A-Z]/.test(raw),
      possessive: kind === "word" && /(?:'s|s')$/i.test(raw) && raw.length > 2,
      kind,
      first: false,
    });
  };
  for (const chunk of text.split(/\s+/)) {
    if (!chunk) continue;
    const m = chunk.match(/^([("'[]*)(.*?)([)"'\].,;:!?]*)$/)!;
    const lead = m[1]!;
    let core = m[2]!;
    let trail = m[3]!;
    // An abbreviation or initial keeps its full stop ("U.S.", "Inc.", "Dr.").
    if (trail.startsWith(".") && core && (ABBREVIATIONS.has(core.toLowerCase()) || /^[A-Z]$/.test(core) || /^(?:[A-Za-z]\.)+[A-Za-z]$/.test(core))) {
      core += ".";
      trail = trail.slice(1);
    }
    // A possessive plural ("rivals'") keeps its apostrophe.
    if (trail.startsWith("'") && /s$/i.test(core) && !lead.includes("'")) {
      core += "'";
      trail = trail.slice(1);
    }
    for (const ch of lead) push(ch, "punct");
    if (core) {
      const low = core.toLowerCase();
      if (CONTRACTIONS[low]) {
        const [a, b] = CONTRACTIONS[low]!;
        push(core.charAt(0) === core.charAt(0).toUpperCase() ? a.charAt(0).toUpperCase() + a.slice(1) : a, "word");
        push(b, "word");
      } else if (/n't$/i.test(core) && core.length > 3) {
        push(core.slice(0, -3), "word");
        push("not", "word");
      } else if (/^[$£€]?\d/.test(core)) push(core, "num");
      else if (/^[—-]$/.test(core)) push(core, "punct");
      else if (/[A-Za-z]/.test(core)) push(core, "word");
      else for (const ch of core) push(ch, "punct");
    }
    for (const ch of trail) push(ch, "punct");
  }
  const firstWord = out.findIndex((t) => t.kind !== "punct");
  if (firstWord >= 0) out[firstWord]!.first = true;
  return out;
}

// ── Word classes ──────────────────────────────────────────────────────────────

const DETERMINERS = new Set("the a an this that these those every each no some any all both either neither another such".split(" "));
const POSSESSIVE_PRONOUNS = new Set("its their his her our my your".split(" "));
const SUBJECT_PRONOUNS = new Set("it they he she we i you".split(" "));
const PREPOSITIONS = new Set(
  ("in on at to for from by with into onto over under after before during since until till through throughout across against among " +
    "between within without about per via toward towards around near despite amid amidst except like unlike than upon beyond " +
    "below above behind beside besides along outside inside").split(" ")
);
const BE = new Set("be is are was were been being am".split(" "));
const HAVE = new Set("have has had having".split(" "));
const DO = new Set("do does did".split(" "));
const MODALS = new Set("will would shall should can could may might must".split(" "));
const AUX = new Set([...BE, ...HAVE, ...DO, ...MODALS]);
/** An auxiliary as written: "May" capitalised mid-sentence is the month ("not in May"), not the modal. */
function isAux(t: Token | undefined): boolean {
  return !!t && AUX.has(t.low) && !(t.low === "may" && t.cap && !t.first);
}
/** Modals that leave a statement unasserted. "will", "can", "must" and "would" in reported speech assert. */
const HEDGE_MODALS = new Set("may might could should".split(" "));
const NEGATORS = new Set("not never".split(" "));
/**
 * Focus particles: after "not" they make it a focus, not a denial. "Contoso
 * did not just raise prices, it also cut its range" says Contoso raised
 * prices; so does "Not only did Contoso raise prices …".
 */
const FOCUS_PARTICLES = new Set("just only merely simply solely purely exclusively".split(" "));
/** "not just", "not only": `tokens[i]` is "not" and a focus particle follows. */
function focusNot(tokens: readonly Token[], i: number): boolean {
  return tokens[i]?.low === "not" && FOCUS_PARTICLES.has(tokens[i + 1]?.low ?? "");
}
/** Adverbs that change nothing a polarity comparison reads. */
const NEUTRAL_ADVERBS = new Set(
  ("also too either still already actually even just really ever yet so then now currently presently today once recently previously " +
    "again further however meanwhile instead though indeed later subsequently ultimately finally initially originally officially").split(" ")
);
/** Words in -ly that are not manner adverbs. */
const NOT_ADVERBS = new Set("family supply july italy assembly ally rally reply apply comply rely belly jelly holy ugly only early daily weekly monthly quarterly yearly likely unlikely elderly friendly costly lonely lovely silly".split(" "));
/** A manner or degree adverb in -ly ("sharply", "steadily"), written in lowercase. */
function isMannerAdverb(t: Token): boolean {
  return !t.cap && t.low.length > 4 && t.low.endsWith("ly") && !NOT_ADVERBS.has(t.low) && !verbBase(t.low);
}

/** Words that open a clause and join it to the one before. */
const CONNECTORS = new Set(
  "and but or nor while whereas although though because since unless if yet so when whenever after before once until as whether".split(" ")
);
/** Openers that say the clause is not asserted. */
const UNASSERTED_CONNECTORS = new Set(["if", "unless", "whether"]);
/** Verbs of saying: a clause made of one of them and its subject is attribution, not a statement. */
const REPORTING = new Set(
  ("say says said saying tell tells told add adds added note notes noted show shows showed shown find finds found report reports reported " +
    "confirm confirms confirmed state states stated write writes wrote claim claims claimed announce announces announced argue argues argued " +
    "explain explains explained warn warns warned estimate estimates estimated suggest suggests suggested indicate indicates indicated " +
    "insist insists insisted believe believes believed think thinks thought agree agrees agreed acknowledge acknowledges acknowledged " +
    "admit admits admitted deny denies denied disclose discloses disclosed reveal reveals revealed").split(" ")
);
/** Nouns whose "that" clause is a claim someone made, not a statement of the passage: "reports that", "rumours that". */
const CLAIM_NOUNS = new Set(
  ("suggestion suggestions rumour rumours rumor rumors allegation allegations accusation accusations assertion assertions speculation " +
    "suspicion suspicions fear fears idea notion belief theory impression perception news word").split(" ")
);
/**
 * Frames that leave the verb after them unasserted: "was expected to rise",
 * "is likely to close". The infinitive is the verb the clause is about, so an
 * elided "but did not" after one takes it ("expected to rise, but did not").
 */
const HEDGE_FRAMES = new Set("expected likely set due forecast projected poised going supposed scheduled".split(" "));
/**
 * Verbs whose object is an infinitive: "plans to borrow" is a statement about
 * a plan, asserted as written. The infinitive is part of what is planned.
 */
const CONTROL_VERBS = new Set(
  "plan plans planned aim aims aimed hope hopes hoped intend intends intended want wants wanted seek seeks sought try tries tried propose proposes proposed agree agrees agreed promise promises promised vow vows vowed pledge pledges pledged threaten threatens threatened decide decides decided".split(" ")
);
/** "fail to V", "refuse to V": the negation of V. */
const NEGATING_FRAMES = new Set("fail fails failed refuse refuses refused decline declines declined".split(" "));

// ── Verbs ─────────────────────────────────────────────────────────────────────

/** Irregular past and participle forms, by form. */
const IRREGULAR: Record<string, string> = {};
for (const row of (
  "arise arose arisen|awake awoke awoken|be was were been|bear bore borne born|beat beat beaten|become became become|begin began begun|" +
  "bend bent|bet bet|bid bid|bind bound|bite bit bitten|bleed bled|blow blew blown|break broke broken|breed bred|bring brought|" +
  "build built|burn burnt|burst burst|buy bought|cast cast|catch caught|choose chose chosen|cling clung|come came come|cost cost|" +
  "creep crept|cut cut|deal dealt|dig dug|do did done|draw drew drawn|drink drank drunk|drive drove driven|eat ate eaten|fall fell fallen|" +
  "feed fed|feel felt|fight fought|find found|flee fled|fly flew flown|forbid forbade forbidden|forecast forecast|foresee foresaw foreseen|" +
  "forget forgot forgotten|forgive forgave forgiven|freeze froze frozen|get got gotten|give gave given|go went gone|grind ground|grow grew grown|" +
  "hang hung|have had|hear heard|hide hid hidden|hit hit|hold held|hurt hurt|keep kept|kneel knelt|know knew known|lay laid|lead led|" +
  "lean leant|leap leapt|learn learnt|leave left|lend lent|let let|lie lay lain|light lit|lose lost|make made|mean meant|meet met|" +
  "mislead misled|overcome overcame|overrun overran|oversee oversaw overseen|overtake overtook overtaken|pay paid|prove proved proven|put put|" +
  "quit quit|read read|rebuild rebuilt|redo redid redone|rid rid|ride rode ridden|ring rang rung|rise rose risen|run ran|say said|see saw seen|" +
  "seek sought|sell sold|send sent|set set|shake shook shaken|shed shed|shine shone|shoot shot|show showed shown|shrink shrank shrunk|shut shut|" +
  "sing sang sung|sink sank sunk|sit sat|sleep slept|slide slid|speak spoke spoken|speed sped|spend spent|spin spun|split split|spread spread|" +
  "spring sprang sprung|stand stood|steal stole stolen|stick stuck|sting stung|strike struck|strive strove striven|swear swore sworn|sweep swept|" +
  "swim swam swum|swing swung|take took taken|teach taught|tear tore torn|tell told|think thought|throw threw thrown|thrust thrust|" +
  "undergo underwent undergone|understand understood|undertake undertook undertaken|uphold upheld|upset upset|wake woke woken|wear wore worn|" +
  "weave wove woven|weep wept|win won|wind wound|withdraw withdrew withdrawn|withhold withheld|write wrote written|outgrow outgrew outgrown|" +
  "rerun reran|rewrite rewrote rewritten|sow sowed sown|saw sawed sawn|bring brought"
).split("|")) {
  const [base, ...forms] = row.split(" ");
  for (const f of forms) IRREGULAR[f] = base!;
}
const IRREGULAR_BASES = new Set(Object.values(IRREGULAR));

/** Verbs a report states facts with, in their bare form. Unknown words fall back to their endings. */
const VERB_BASES = new Set(
  ("accept achieve acquire add adopt affect agree allow announce appeal apply appoint approve argue arrive ask assess attend avoid award " +
    "back ban become begin believe benefit block book boost borrow break build buy call cancel cap cause change charge cite claim clear close " +
    "collect comment commit complete confirm consider continue contribute control cover create cross cut deal decide decline deliver deny design " +
    "detect develop die disclose dismiss divest double drop earn ease employ enable end endorse enroll enrol enter establish exceed exit expand " +
    "expect explain export face fail fall file fill finalise finalize finance find fine fire fix flag fly follow force form fund gain generate give " +
    "grant grow halt halve hear help hire hit hold host hurt improve include increase introduce invest issue join keep launch lead leave lend " +
    "lift limit list lose lower maintain make manage meet merge miss move name need note object obtain offer open operate order own pass pay " +
    "perform plan post power prevent price produce promise propose protect protest provide publish purchase push qualify raise reach receive " +
    "recall recommend record recover reduce refuse reject release remain remove renew reopen repay repeat replace report require resign resolve " +
    "respond restore restrict retain return reveal review revise rise rule run sack save secure see seek sell send serve settle shed shift ship " +
    "shorten show shut sign signal slash slow sell spend split stall start stay stop strike submit succeed suffer suggest supply support suspend " +
    "take target teach tell test top trade train transfer treat trigger turn undergo unveil update use veto visit vote warn widen win withdraw " +
    "work write cut set put let cost bid quit spread forecast restate reaffirm overturn uphold block delay defer postpone scrap axe drop " +
    "lay owe hand halt hike trim tighten loosen relax lift bar outlaw legalise legalize authorise authorize license register ratify enact pass " +
    "amend repeal abolish introduce extend expire lapse renew award declare publish finalise implement ease reopen relocate merge partner " +
    "invest divest sue settle appeal overturn convict acquit sentence charge arrest detain release free deport admit employ hire recruit " +
    "train fire lay furlough strike unionise unionize celebrate mark host attend skip boycott endorse back oppose criticise criticize praise " +
    "welcome condemn reject veto sign approve ratify comply breach violate exceed beat miss meet hit reach surpass top trail lag lead win lose " +
    "draw tie qualify advance progress decline drop fall rise climb jump surge soar plunge tumble slump slide slip edge inch rebound recover " +
    "stabilise stabilize contract shrink expand grow double triple halve narrow widen deepen ease cool heat accelerate slow").split(" ")
);

/** A word's bare form if it can be a verb form: the form itself, an irregular form, or a regular inflection of a known verb. */
function verbBase(low: string): string | null {
  if (IRREGULAR[low]) return IRREGULAR[low]!;
  if (VERB_BASES.has(low) || IRREGULAR_BASES.has(low)) return low;
  const candidates: string[] = [];
  if (low.endsWith("ies")) candidates.push(`${low.slice(0, -3)}y`);
  if (low.endsWith("ied")) candidates.push(`${low.slice(0, -3)}y`);
  if (low.endsWith("es")) candidates.push(low.slice(0, -2), low.slice(0, -1));
  if (low.endsWith("s")) candidates.push(low.slice(0, -1));
  if (low.endsWith("ed")) {
    candidates.push(low.slice(0, -2), low.slice(0, -1));
    if (/([bcdfgklmnprstvz])\1ed$/.test(low)) candidates.push(low.slice(0, -3));
  }
  if (low.endsWith("ing")) {
    candidates.push(low.slice(0, -3), `${low.slice(0, -3)}e`);
    if (/([bcdfgklmnprstvz])\1ing$/.test(low)) candidates.push(low.slice(0, -4));
  }
  for (const c of candidates) if (VERB_BASES.has(c) || IRREGULAR_BASES.has(c)) return c;
  return null;
}

/** An unknown verb at its bare stem, so its past and bare forms compare: "flooded" and "flood", "rallied" and "rally". */
function unknownVerbStem(low: string): string {
  let w = low;
  if (w.length > 4 && w.endsWith("ied")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("ed")) {
    w = w.slice(0, -2);
    if (/([bcdfgklmnprtvz])\1$/.test(w)) w = w.slice(0, -1);
  }
  return stemOf(w);
}

type VerbForm = "base" | "s" | "past" | "participle" | "ing" | "unknown";

function verbForm(low: string): VerbForm {
  if (IRREGULAR[low]) {
    const base = IRREGULAR[low]!;
    // "cut", "put", "set", "hit": the same form as the base.
    return low === base ? "base" : "past";
  }
  if (low.endsWith("ing")) return "ing";
  if (low.endsWith("ed")) return "past";
  if (/[^s]s$/.test(low) || low.endsWith("ies") || low.endsWith("sses") || low.endsWith("shes") || low.endsWith("ches") || low.endsWith("xes")) return "s";
  return "base";
}

// ─────────────────────────────────────────────────────────────────────────────
// Stems, dates, qualifiers
// ─────────────────────────────────────────────────────────────────────────────

/** A content word's comparable stem: lowercase, possessive and plural cut, a verb at its bare form, a final e dropped. */
export function stemOf(word: string): string {
  let w = word.toLowerCase().replace(/[’']s$|[’']$/, "").replace(/[.,]+$/, "");
  if (/^[$£€]?\d/.test(w)) return w.replace(/,/g, "");
  const base = verbBase(w);
  if (base) w = base;
  else if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(?:ss|sh|ch|x)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3));
const RELATIVE_TIME = new Set("year month week quarter term decade season".split(" "));

/** A time qualifier, comparable: "y2024", "m3", "y2024-m3", "q4", "h1", "rel:last-year", "now". */
type TimeKey = string;

/** Words that only put a present-tense statement in the present ("does not pay a dividend now"). */
const PRESENT_MARKERS = new Set("now currently presently today nowadays".split(" "));

// ─────────────────────────────────────────────────────────────────────────────
// Propositions
// ─────────────────────────────────────────────────────────────────────────────

interface Subject {
  /** Comparable surface form: lowercase, leading article dropped. */
  key: string;
  /** Content words of the subject, as written (lowercase). */
  words: string[];
  /** The noun it is about: its last word before "of", or a title ("Senator") as a fallback alias. */
  head: string;
  pronoun: string | null;
  /** Has a capitalised word that is not merely the sentence's first word, or is an acronym: a name. */
  proper: boolean;
  /** Capitalised words, lowercase. */
  names: string[];
  plural: boolean | null;
  /** An owner by possessive pronoun ("its rivals"): resolved with the subject. */
  ownerPronoun: string | null;
  /** The rest after the possessive pronoun ("rivals"). */
  owned: string | null;
  /** "a rival", "the older drug", "another senator": marked as some other one. */
  contrast: boolean;
  /** Opens with "a"/"an": a new referent, never one already named. */
  indefinite: boolean;
  /** The key is already in stems (a promoted agent). */
  stemmed?: boolean;
}

interface PP {
  prep: string;
  stems: string[];
}

export interface Proposition {
  /** Sentence and unit index, reading order. */
  sentence: number;
  unit: number;
  subject: Subject | null;
  negated: boolean;
  asserted: boolean;
  /** "will", "can", "must", "would": a statement in that mood is compared with one in the same mood. */
  modal: string | null;
  tense: "past" | "present" | "future" | null;
  verb: string | null;
  passive: boolean;
  object: string[];
  pps: PP[];
  times: TimeKey[];
  /** Manner and degree adverbs ("sharply", "twice"): a denial carrying one denies something narrower. */
  adverbs: string[];
  /** Read with no guess in it: only such a proposition may prove a contradiction. */
  certain: boolean;
  /**
   * What its negation may be about instead of the whole predicate, when the
   * words leave it open: a reason cut off ("did not raise prices because
   * demand fell"), a count ("not once", "twice"), a quantifier ("not all of
   * its shares"), or a reason, time or condition clause beside it ("after
   * regulators objected", "unless costs rise"). A key naming what narrows it
   * ("after:fee-introduc"); null when nothing does. Negated, it is the proof
   * only against a statement narrowed by the same words ("Applications fell
   * after the fee was introduced" against "did not fall after the fee was
   * introduced"); it is still shown for review.
   */
  scope: string | null;
  kind: "full" | "vp" | "elided" | "remnant" | "relative";
  /** Text of the unit, for debugging. */
  text: string;
}

interface Unit {
  tokens: Token[];
  connector: string | null;
  sentence: number;
  question: boolean;
  /** The sentence's first unit. */
  initial: boolean;
}

const SPLIT_PUNCT = new Set([",", ";", ":", "—", "(", ")", '"', "[", "]"]);

/** Whether a token can be a finite verb in its position, and how sure. */
function verbScore(tokens: Token[], i: number, vpOnly: boolean): number {
  const t = tokens[i]!;
  if (t.kind !== "word") return 0;
  if (isAux(t)) return 3;
  const prev = tokens[i - 1];
  const prevLow = prev?.low ?? "";
  if (prev && (DETERMINERS.has(prevLow) || POSSESSIVE_PRONOUNS.has(prevLow) || prev.possessive)) return 0;
  if (prev && PREPOSITIONS.has(prevLow) && prevLow !== "to") return 0;
  if (prevLow === "to") return 0;
  const base = verbBase(t.low);
  const form = verbForm(t.low);
  if (t.cap && !t.first) return 0;
  // A noun right before the auxiliary: "An experimental shot was approved".
  if (i > 0 && tokens[i + 1] && isAux(tokens[i + 1])) return 0;
  if (!base) {
    // Unknown words: a past tense after a noun is a verb ("The museum reopened").
    if (form === "past" && t.low.length > 4 && i > 0) return 1.5;
    return 0;
  }
  if (form === "past") return IRREGULAR[t.low] ? 2.5 : 2;
  if (form === "s") return i > 0 || vpOnly ? 1.5 : 0;
  if (form === "ing") return vpOnly && i === 0 ? 1 : 0;
  // A bare form: after a plural noun, a coordinated subject, a pronoun, or opening a joined-on verb phrase.
  if (vpOnly && i === 0) return 1.5;
  if (prev && (SUBJECT_PRONOUNS.has(prevLow) && prevLow !== "it" && prevLow !== "he" && prevLow !== "she")) return 1.5;
  if (prev && prev.kind === "word" && /s$/.test(prevLow) && !/(?:ss|us|is)$/.test(prevLow) && !prev.possessive) return 1;
  // After a coordinated subject: "Wingtip Toys and Litware support the tax".
  if (tokens.slice(0, i).some((x) => x.low === "and" || x.low === "&") && !tokens.slice(0, i).some((x) => AUX.has(x.low))) return 1.5;
  if (IRREGULAR_BASES.has(t.low) && ["cut", "put", "set", "hit", "cost", "let", "quit", "bid", "shut", "spread", "split", "forecast"].includes(t.low)) {
    // "Northwind cut its budget", "the council set a cap": a determiner or a figure after it makes it the verb.
    const next = tokens[i + 1];
    return next && (DETERMINERS.has(next.low) || POSSESSIVE_PRONOUNS.has(next.low) || next.kind === "num") ? 1.6 : 1.2;
  }
  return 0;
}

function hasVerb(tokens: Token[], vpOnly = false): boolean {
  for (let i = 0; i < tokens.length; i += 1) if (verbScore(tokens, i, vpOnly) >= 1.5) return true;
  return false;
}

/** The units of a sentence: split at punctuation, at clause-opening conjunctions, at "rather than"/"instead of", at "said (that)". */
function unitsOf(tokens: Token[], sentence: number, question: boolean): Unit[] {
  const units: Unit[] = [];
  let current: Token[] = [];
  let connector: string | null = null;
  const flush = (next: string | null) => {
    if (current.some((t) => t.kind !== "punct")) units.push({ tokens: current, connector, sentence, question, initial: units.length === 0 });
    current = [];
    connector = next;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind === "punct") {
      if (SPLIT_PUNCT.has(t.raw) || t.raw === "-") flush(connector && current.length === 0 ? connector : t.raw === ";" ? ";" : ",");
      continue;
    }
    const low = t.low;
    const rest = tokens.slice(i + 1);
    const untilBreak = rest.slice(0, Math.max(0, rest.findIndex((x) => x.kind === "punct" && SPLIT_PUNCT.has(x.raw)))) as Token[];
    const segment = rest.findIndex((x) => x.kind === "punct" && SPLIT_PUNCT.has(x.raw)) >= 0 ? untilBreak : rest;
    if (low === "rather" && tokens[i + 1]?.low === "than") {
      flush("rather than");
      i += 1;
      continue;
    }
    if (low === "instead" && tokens[i + 1]?.low === "of") {
      flush("instead of");
      i += 1;
      continue;
    }
    // "after regulators objected", "because funds ran out", "as planned": an adverbial clause of its own.
    // So is "as some outlets reported" after a verbless "not in 2023": the remnant ends there.
    const negatedRemnant = current.find((x) => x.kind !== "punct")?.low === "not" && !hasVerb(current);
    if (["because", "after", "before", "since", "when", "until", "once", "as"].includes(low) && current.length > 0 && (hasVerb(current) || negatedRemnant) && hasVerb(segment) && !hasVerb(segment.slice(0, 1))) {
      flush(low);
      continue;
    }
    if (low === "but" || low === "yet" || low === "whereas" || low === "although" || low === "though" || low === "unless" || (low === "while" && current.length > 0)) {
      // "not in Italy but in Spain" inside one clause, and "but" anywhere else: a new unit.
      flush(low);
      continue;
    }
    if (low === "nor") {
      const opened = current.find((x) => x.kind === "word");
      if (opened?.low === "neither" && !hasVerb(current)) {
        current.push(t);
        continue;
      }
      flush("nor");
      continue;
    }
    if ((low === "and" || low === "or") && current.length > 0) {
      const leftHasVerb = hasVerb(current);
      const rightClause = hasVerb(segment, true) || ["not", "never"].includes(segment[0]?.low ?? "");
      const rightPrep = segment[0] && PREPOSITIONS.has(segment[0].low) && current.some((x) => x.low === segment[0]!.low);
      if (leftHasVerb && (rightClause || rightPrep)) {
        flush(low);
        continue;
      }
    }
    if ((low === "which" || low === "who") && current.length > 0 && hasVerb(current)) {
      flush(low);
      current.push(t);
      continue;
    }
    if (low === "that" && current.length > 0) {
      const prev = current[current.length - 1]!;
      if (REPORTING.has(prev.low) || CLAIM_NOUNS.has(prev.low) || prev.low === "so") {
        flush("that");
        continue;
      }
    }
    // "The firm said it will not cut jobs": a reporting verb followed by a clause.
    if (current.length > 0 && SUBJECT_PRONOUNS.has(low) && REPORTING.has(current[current.length - 1]!.low) && hasVerb(segment, true)) {
      flush("that");
      current.push(t);
      continue;
    }
    current.push(t);
  }
  flush(null);
  return units;
}

// ── Reading one unit ─────────────────────────────────────────────────────────

interface Parsed {
  fronted: Token[][];
  subjectTokens: Token[] | null;
  verbIndex: number;
  negated: boolean;
  asserted: boolean;
  modal: string | null;
  tense: Proposition["tense"];
  verb: string | null;
  passive: boolean;
  /** The verb is left out after its auxiliary: "but the House did", "It didn't in Asia". */
  elided: boolean;
  /**
   * The verb, with no auxiliary, is a form its past shares with its base
   * ("cut", "set", "put"): present only after a plural subject ("they cut"),
   * past after a singular one ("Northwind cut", which would otherwise be
   * "cuts"). Settled once the subject is read.
   */
  sameForm: boolean;
  rest: Token[];
  certain: boolean;
}

/** Skip connective words a unit opens with. */
function stripOpeners(tokens: Token[]): { tokens: Token[]; opener: string | null; only: boolean } {
  let i = 0;
  let opener: string | null = null;
  let only = false;
  while (i < tokens.length) {
    const low = tokens[i]!.low;
    if (tokens[i]!.kind === "punct") {
      i += 1;
      continue;
    }
    if (CONNECTORS.has(low) || (NEUTRAL_ADVERBS.has(low) && low !== "now" && low !== "today" && low !== "currently")) {
      opener ??= low;
      i += 1;
      continue;
    }
    if (low === "only") {
      only = true;
      i += 1;
      continue;
    }
    break;
  }
  return { tokens: tokens.slice(i), opener, only };
}

const TIME_WORDS = new Set([...MONTHS, ...MONTH_ABBR, "year", "years", "quarter", "week", "month", "today", "yesterday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "spring", "summer", "autumn", "winter", "fall", "term", "decade"]);

function isTimeish(tokens: Token[]): boolean {
  return tokens.some((t) => (t.kind === "num" && /^(?:19|20)\d{2}$/.test(t.raw)) || TIME_WORDS.has(t.low) || /^(?:q[1-4]|h[12]|fy\d{2,4})$/i.test(t.low));
}

/** A leading adverbial before the subject ("In 2023 the bank …", "Last week the council …"). */
function frontedLength(tokens: Token[]): number {
  if (tokens.length === 0) return 0;
  const first = tokens[0]!;
  const startsPP = PREPOSITIONS.has(first.low) || first.low === "according";
  const startsTime = ["last", "next", "this", "earlier", "later"].includes(first.low) && tokens[1] && TIME_WORDS.has(tokens[1].low);
  if (!startsPP && !startsTime) return 0;
  // The adverbial runs to the first word that can open a subject followed by a verb.
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    const opensSubject = DETERMINERS.has(t.low) || SUBJECT_PRONOUNS.has(t.low) || POSSESSIVE_PRONOUNS.has(t.low) || (t.cap && !t.first);
    if (!opensSubject) continue;
    const after = tokens.slice(i);
    // "In its filing the company put …": "its filing" is still the adverbial's; keep going while no verb follows directly.
    for (let j = 1; j < after.length; j += 1) {
      if (verbScore(after, j, false) >= 1.5) {
        // The subject must not itself hold a preposition that ends the adverbial differently.
        return i;
      }
      if (after[j]!.kind === "punct") break;
      if (PREPOSITIONS.has(after[j]!.low) && after[j]!.low !== "of") break;
    }
  }
  return 0;
}

function parseUnit(raw: Token[], vpContext: boolean): Parsed | null {
  let tokens = raw.filter((t) => t.kind !== "punct" || t.raw === "$");
  const fronted: Token[][] = [];
  const f = frontedLength(tokens);
  if (f > 0) {
    fronted.push(tokens.slice(0, f));
    tokens = tokens.slice(f);
  }
  if (tokens.length === 0) return null;
  /*
   * "not just V", "not only V", "Not only did X V": a focus, never a denial —
   * the sentence says X did V, and more. Read with the claim's polarity, and
   * never certain: such a proposition is never the proof of a contradiction,
   * only a statement that may agree with the claim.
   */
  let focus = false;
  if (focusNot(tokens, 0)) {
    tokens = tokens.slice(2);
    focus = true;
    if (tokens.length === 0) return null;
  }
  // Inversion after "nor"/"neither": "nor did it signal a cut".
  let inverted: { aux: Token; subjectEnd: number } | null = null;
  if (AUX.has(tokens[0]!.low) && tokens[1] && (SUBJECT_PRONOUNS.has(tokens[1].low) || DETERMINERS.has(tokens[1].low) || tokens[1].cap)) {
    // A determiner is never a subject on its own: "Did the strike not cost …", "Should the board vote …" — the noun
    // after it is part of the subject, however much it looks like a verb ("strike", "board", "plan").
    const firstVerbAt = DETERMINERS.has(tokens[1].low) ? 3 : 2;
    for (let j = firstVerbAt; j < Math.min(tokens.length, 8); j += 1) {
      if (verbBase(tokens[j]!.low) && verbForm(tokens[j]!.low) === "base") {
        // "Did the strike not cost …": the negator belongs to the verb group, not to the subject.
        let subjectEnd = j;
        while (subjectEnd > firstVerbAt - 1 && NEGATORS.has(tokens[subjectEnd - 1]!.low)) subjectEnd -= 1;
        inverted = { aux: tokens[0]!, subjectEnd };
        break;
      }
    }
  }
  let verbIndex = -1;
  let subjectTokens: Token[] | null = null;
  if (inverted) {
    subjectTokens = tokens.slice(1, inverted.subjectEnd);
    tokens = [inverted.aux, ...tokens.slice(inverted.subjectEnd)];
    verbIndex = 0;
  } else {
    const firstAux = tokens.findIndex((t) => isAux(t));
    // A unit opening with a negator and no clear verb is a remnant ("not on the damages claim").
    const opensNegated = ["not", "never", "neither", "nor"].includes(tokens[0]!.low);
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < tokens.length; i += 1) {
      const vpOnly = vpContext && i === 0;
      const s = verbScore(tokens, i, vpOnly);
      const insidePhrase = tokens.slice(0, i).some((t) => PREPOSITIONS.has(t.low));
      const weakOk = s >= 1 && !opensNegated && !insidePhrase;
      if (s >= 1.5 || (weakOk && best < 0 && (firstAux < 0 || i < firstAux))) {
        // "Northwind cut costs": a same-form past ("cut") directly before a plural object read as a verb.
        if (s >= 1.5 && best >= 0 && best === i - 1 && verbForm(tokens[i]!.low) === "s") break;
        best = i;
        bestScore = s;
        if (s >= 1.5) break;
      }
    }
    if (opensNegated && bestScore < 1.5 && firstAux < 0) best = -1;
    if (firstAux >= 0 && (best < 0 || firstAux <= best)) verbIndex = firstAux;
    else verbIndex = best;
    // Negators and adverbs in front of the verb belong to it: "the council never signed", "no longer offers".
    while (verbIndex > 0) {
      const prev = tokens[verbIndex - 1]!;
      if (NEGATORS.has(prev.low) || (NEUTRAL_ADVERBS.has(prev.low) && !PRESENT_MARKERS.has(prev.low)) || isMannerAdverb(prev)) verbIndex -= 1;
      else if (prev.low === "longer" && tokens[verbIndex - 2]?.low === "no") verbIndex -= 2;
      else break;
    }
    if (verbIndex < 0) return { fronted, subjectTokens: tokens, verbIndex: -1, negated: false, asserted: true, modal: null, tense: null, verb: null, passive: false, elided: false, sameForm: false, rest: [], certain: false };
    subjectTokens = tokens.slice(0, verbIndex);
  }
  // Negators and "no" in the subject ("Neither company", "No analyst").
  let negations = subjectTokens.filter((t) => t.low === "neither" || t.low === "no" || t.low === "none" || t.low === "nobody" || t.low === "not").length;
  if (subjectTokens.some((t) => t.low === "nor")) negations = 1;
  // The verb group.
  let i = verbIndex;
  let modal: string | null = null;
  let asserted = true;
  let tense: Proposition["tense"] = null;
  let passive = false;
  let sawBe = false;
  let sawHave = false;
  let sawDo = false;
  let verb: string | null = null;
  let sameForm = false;
  let certain = true;
  const adverbs: Token[] = [];
  for (; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    const low = t.low;
    if (focusNot(tokens, i)) {
      focus = true;
      i += 1;
      continue;
    }
    if (NEGATORS.has(low)) {
      negations += 1;
      continue;
    }
    if (low === "no" && tokens[i + 1]?.low === "longer") {
      negations += 1;
      i += 1;
      continue;
    }
    if (NEUTRAL_ADVERBS.has(low) || isMannerAdverb(t)) {
      if (!NEUTRAL_ADVERBS.has(low)) adverbs.push(t);
      continue;
    }
    if (MODALS.has(low) && isAux(t)) {
      modal ??= low;
      if (HEDGE_MODALS.has(low)) asserted = false;
      tense ??= low === "will" || low === "shall" ? "future" : "present";
      continue;
    }
    if (BE.has(low)) {
      sawBe = true;
      tense ??= ["was", "were"].includes(low) ? "past" : ["been"].includes(low) ? tense : "present";
      continue;
    }
    if (HAVE.has(low)) {
      // "has" as a main verb ("The company has no debt", "does not have a licence") when no participle follows.
      const next = tokens[i + 1];
      const nextIsVerbal = next && (NEGATORS.has(next.low) || (verbBase(next.low) && (verbForm(next.low) === "past" || IRREGULAR[next.low])) || BE.has(next.low) || NEUTRAL_ADVERBS.has(next.low) || isMannerAdverb(next) || next.low === "done");
      if (next && !nextIsVerbal) {
        verb = "have";
        tense ??= low === "had" ? "past" : "present";
        i += 1;
        break;
      }
      sawHave = true;
      tense ??= low === "had" ? "past" : "past";
      continue;
    }
    if (DO.has(low)) {
      const next = tokens[i + 1];
      // "did so", "did too", "did", "did not": elided; "do so" is the verb phrase left out.
      sawDo = true;
      tense ??= low === "did" ? "past" : "present";
      if (!next) {
        i += 1;
        break;
      }
      continue;
    }
    // A hedge frame: "expected to rise", "plans to borrow", "is likely to".
    if (HEDGE_FRAMES.has(low) && tokens[i + 1]?.low === "to" && !CONTROL_VERBS.has(low)) {
      asserted = false;
      i += 1;
      continue;
    }
    if (NEGATING_FRAMES.has(low) && tokens[i + 1]?.low === "to" && tokens[i + 2] && verbBase(tokens[i + 2]!.low)) {
      negations += 1;
      tense ??= verbForm(low) === "past" ? "past" : "present";
      i += 1;
      continue;
    }
    const base = verbBase(low);
    if (base && !(t.cap && !t.first && i !== verbIndex)) {
      const form = verbForm(low);
      if (low === "do" || low === "done") {
        // "did not do so": the verb phrase is left out.
        i += 1;
        break;
      }
      verb = base;
      if (sawBe && (form === "past" || IRREGULAR[low])) passive = true;
      sameForm = !tense && IRREGULAR[low] === low;
      if (!tense) tense = form === "past" ? "past" : form === "s" || form === "base" ? "present" : null;
      i += 1;
      break;
    }
    if (sawBe) {
      // A copula: "was profitable", "is listed" (handled above), "is available in 40 countries".
      verb = "be";
      break;
    }
    // Unknown word after an auxiliary: a verb we do not know ("has finalised", "was cleaned").
    if ((sawHave || sawDo || modal) && /^[a-z]+$/.test(low)) {
      verb = unknownVerbStem(low);
      if (sawBe && low.endsWith("ed")) passive = true;
      certain = verbForm(low) === "past" || sawDo || !!modal;
      i += 1;
      break;
    }
    if (verbForm(low) === "past" && /^[a-z]+$/.test(low)) {
      verb = unknownVerbStem(low);
      tense ??= "past";
      i += 1;
      break;
    }
    break;
  }
  let elided = false;
  if (!verb) {
    if (sawDo || sawHave || modal || (sawBe && i >= tokens.length)) elided = true;
    else certain = false;
  }
  // "did so", "has done so": the left-out verb phrase.
  let rest = tokens.slice(i);
  if (elided && rest[0]?.low === "so") rest = rest.slice(1);
  if (verb && rest[0]?.low === "so" && (verb === "do")) {
    elided = true;
    verb = null;
    rest = rest.slice(1);
  }
  // A reporting verb whose complement is a clause has been split already; one with nothing after it is attribution.
  // Negations after the verb ("found no link", "opened an office not in Italy").
  rest.forEach((t, k) => {
    if (focusNot(rest, k)) focus = true;
    else if ((t.low === "no" || t.low === "not" || t.low === "never" || t.low === "none" || t.low === "nothing") && !(k > 0 && focusNot(rest, k - 1))) negations += 1;
  });
  if (focus) rest = rest.filter((t, k) => !focusNot(rest, k) && !(k > 0 && focusNot(rest, k - 1)));
  for (const t of adverbs) rest = [t, ...rest];
  return {
    fronted,
    subjectTokens,
    verbIndex,
    negated: negations % 2 === 1,
    asserted,
    modal: modal === "shall" ? "will" : modal,
    tense,
    verb,
    passive,
    elided,
    sameForm,
    rest,
    certain: certain && !focus,
  };
}

// ── Subjects ─────────────────────────────────────────────────────────────────

const CONTRAST_WORDS = new Set("rival rivals competitor competitors other others another older newer different separate".split(" "));
const TITLES = new Set("senator governor mayor president professor prof dr coach judge minister chancellor ceo chairman chairwoman chair secretary representative rep sen gov".split(" "));

function readSubject(tokens: Token[]): Subject | null {
  let words = tokens.filter((t) => t.kind !== "punct" || t.raw === "&");
  // Drop leading negating determiners ("Neither company", "No analyst") and connectors.
  while (words.length > 0 && (["neither", "nor", "no", "not", "either"].includes(words[0]!.low) || CONNECTORS.has(words[0]!.low))) words = words.slice(1);
  if (words.length === 0) return null;
  const pronoun = words.length === 1 && SUBJECT_PRONOUNS.has(words[0]!.low) ? words[0]!.low : null;
  let ownerPronoun: string | null = null;
  let owned: string | null = null;
  if (POSSESSIVE_PRONOUNS.has(words[0]!.low) && words.length > 1) {
    ownerPronoun = words[0]!.low;
    owned = words.slice(1).map((t) => t.low).join(" ");
  }
  const core = words.filter((t, i) => !(i === 0 && (t.low === "the" || t.low === "a" || t.low === "an")));
  // A bare article ("the", "a") names no subject at all: nothing is read, rather than a subject with no head.
  if (core.length === 0) return null;
  const key = core.map((t) => t.low.replace(/\.$/, "")).join(" ");
  const ofAt = core.findIndex((t) => t.low === "of" || t.low === "from" || t.low === "at" || t.low === "in");
  const headTok = (ofAt > 0 ? core[ofAt - 1] : core[core.length - 1]) ?? core[core.length - 1]!;
  const names = core.filter((t) => t.cap && !TITLES.has(t.low)).map((t) => t.low.replace(/(?:'s|')$/, "").replace(/\.$/, ""));
  const proper = core.some((t) => (t.cap && !t.first && !TITLES.has(t.low)) || /^[A-Z]{2,}$/.test(t.raw)) || (core.length > 1 && core.slice(1).some((t) => t.cap));
  const coordinated = core.some((t) => t.low === "and" || t.low === "&");
  const headLow = headTok.low.replace(/(?:'s|')$/, "");
  const andAt = core.findIndex((t) => t.low === "and" || t.low === "&");
  const coordinatedPhrases = coordinated && (DETERMINERS.has(core[andAt + 1]?.low ?? "") || !proper);
  const plural = coordinatedPhrases ? true : coordinated ? null : pronoun ? pronoun === "they" : proper ? null : /[^s]s$|ies$/.test(headLow) && !/(?:ss|us|is|news|series)$/.test(headLow) ? true : false;
  return {
    key,
    words: core.map((t) => t.low),
    head: headLow,
    pronoun,
    proper,
    names,
    plural,
    ownerPronoun,
    owned,
    contrast: core.some((t) => CONTRAST_WORDS.has(t.low)),
    indefinite: words[0]!.low === "a" || words[0]!.low === "an",
  };
}

const WITH_KEY = (s: Subject, key: string): Subject => ({ ...s, key });

// ── Predicates: object, qualifiers, times ───────────────────────────────────

const OBJECT_SKIP = new Set([...DETERMINERS, ...POSSESSIVE_PRONOUNS, "to", "and", "or", "of", "that", "which", "who"]);
const DEGREE_REMNANT = new Set(
  "by as enough always often much more less quite entirely fully completely yet everyone all every only even so very nearly almost necessarily universally unanimously".split(" ")
);

function timeKeys(tokens: Token[]): TimeKey[] {
  const keys: TimeKey[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind === "num" && /^(?:19|20)\d{2}$/.test(t.raw)) keys.push(`y${t.raw}`);
    else if (/^fy'?\d{2,4}$/i.test(t.raw)) keys.push(`fy${t.raw.replace(/\D/g, "").slice(-2)}`);
    else if (/^q[1-4]$/i.test(t.raw)) keys.push(`q${t.raw.slice(1)}`);
    else if (/^h[12]$/i.test(t.raw)) keys.push(`h${t.raw.slice(1)}`);
    else if (MONTHS.includes(t.low) || (MONTH_ABBR.includes(t.low) && t.cap)) {
      if (t.low === "may" && !t.cap) continue;
      keys.push(`m${(MONTHS.includes(t.low) ? MONTHS.indexOf(t.low) : MONTH_ABBR.indexOf(t.low)) + 1}`);
    } else if (["first", "second", "third", "fourth"].includes(t.low) && tokens[i + 1] && /^quarters?$|^half$/.test(tokens[i + 1]!.low)) {
      keys.push(`${tokens[i + 1]!.low.startsWith("half") ? "h" : "q"}${["first", "second", "third", "fourth"].indexOf(t.low) + 1}`);
    } else if (["last", "next", "this", "previous", "prior"].includes(t.low) && tokens[i + 1] && RELATIVE_TIME.has(tokens[i + 1]!.low)) {
      keys.push(`rel:${t.low === "previous" || t.low === "prior" ? "last" : t.low}-${tokens[i + 1]!.low}`);
    } else if (["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "yesterday"].includes(t.low)) keys.push(`d:${t.low}`);
    else if (PRESENT_MARKERS.has(t.low)) keys.push("now");
    else if (["ago", "earlier", "since"].includes(t.low) && i > 0) keys.push(`rel:${t.low}`);
  }
  return keys;
}

/** Words that make a phrase all or each of a set: a denial of "all of its shares" is not a denial of any. */
const QUANTIFIERS = new Set("all every each both entire whole".split(" "));
/** How many times: "did not raise rates once" (it raised them four times), "twice", "three times", "again". */
const COUNT_ADVERBS = new Set("once twice thrice again".split(" "));
const NUMBER_WORDS = new Set("two three four five six seven eight nine ten eleven twelve several many multiple numerous".split(" "));
/** A part of the period a date names: "at the end of 2023" is not 2023, "the first week of March" is not March. */
const PART_OF_PERIOD = new Set("end start beginning middle mid close turn half quarter week weeks month months first second third fourth".split(" "));

/**
 * Splits what follows the verb into its object, prepositional phrases, times
 * and adverbs. `scope` names what it read that a negation may be about
 * instead of the whole predicate (see `Proposition.scope`): a reason it was
 * cut at, a count, a quantifier.
 */
function readRest(rest: Token[]): { object: string[]; pps: PP[]; times: TimeKey[]; adverbs: string[]; scope: string | null } {
  const object: string[] = [];
  const pps: PP[] = [];
  const adverbs: string[] = [];
  const times: TimeKey[] = [];
  let scope: string | null = null;
  let pp: PP | null = null;
  const ppTokens: Token[] = [];
  const closePP = () => {
    if (pp) {
      const tk = timeKeys(ppTokens);
      const span = ppTokens.find((t) => /^(?:quarters?|months?|years?|weeks?|half|halves|decade)$/.test(t.low));
      if (tk.length === 0 && span && ["in", "during", "at", "by", "until", "since", "before", "after"].includes(pp.prep) && !ppTokens.some((t) => t.kind === "num")) {
        const kind = span.low.startsWith("quarter") || span.low.startsWith("hal") ? "q" : span.low.startsWith("month") ? "m" : span.low.startsWith("week") ? "w" : "y";
        times.push(`${pp.prep === "in" || pp.prep === "during" ? "" : `${pp.prep}:`}span-${kind}:${pp.stems.join("-")}`);
        pp = null;
        ppTokens.length = 0;
        return;
      }
      if (tk.length > 0 && ppTokens.filter((t) => t.kind !== "punct" && !OBJECT_SKIP.has(t.low)).every((t) => isTimeish([t]) || PRESENT_MARKERS.has(t.low) || ["end", "start", "beginning", "middle", "mid", "half", "quarter", "first", "second", "third", "fourth", "last", "next", "this", "previous", "prior", "year", "month", "week", "the"].includes(t.low) || t.kind === "num")) {
        for (const k of tk) times.push(pp.prep === "in" || pp.prep === "during" || pp.prep === "on" || pp.prep === "at" || pp.prep === "for" || pp.prep === "of" ? k : `${pp.prep}:${k}`);
        // "at the end of 2023", "in the middle of 2023": a part of the year, which a time of its own keeps apart from
        // the whole year (a quarter, a half or a relative period already carries one).
        const part = ppTokens.find((t) => PART_OF_PERIOD.has(t.low));
        if (part && !tk.some((k) => /^(?:q\d|h\d|rel:)/.test(k))) times.push(`part:${part.low.replace(/s$/, "")}`);
      } else if (pp.stems.length > 0) pps.push(pp);
    }
    pp = null;
    ppTokens.length = 0;
  };
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i]!;
    if (t.kind === "punct") continue;
    const low = t.low;
    // A reason or a manner of plan ("because of the pandemic", "due to delays", "as planned"): about why, not what.
    // A denial cut there may deny only the reason ("did not raise prices because demand fell; costs drove it").
    const next = rest[i + 1]?.low;
    if (low === "because" || ((low === "due" || low === "owing" || low === "thanks") && next === "to") || (low === "as" && (next === "planned" || next === "expected" || next === "scheduled" || next === "promised"))) {
      scope = joinScope(scope, `${low}:${scopeStems(rest.slice(i + 1))}`);
      break;
    }
    // "all of its shares", "every store"; not "at all", "after all", "above all", "in all".
    if (QUANTIFIERS.has(low) && !(low === "all" && ["at", "after", "above", "in", "of"].includes(rest[i - 1]?.low ?? ""))) scope = joinScope(scope, `all:${low}`);
    if (COUNT_ADVERBS.has(low) || (low === "times" && i > 0 && (rest[i - 1]!.kind === "num" || NUMBER_WORDS.has(rest[i - 1]!.low)))) {
      scope = joinScope(scope, `count:${COUNT_ADVERBS.has(low) ? low : rest[i - 1]!.low}`);
      if (COUNT_ADVERBS.has(low)) {
        adverbs.push(low);
        continue;
      }
    }
    if (NEGATORS.has(low) || low === "no" || low === "none" || low === "nothing") continue;
    // "did not raise prices only in Ohio", "… just in Ohio": a focus inside the predicate, which a denial may be about.
    if (FOCUS_PARTICLES.has(low)) scope = joinScope(scope, `focus:${low}`);
    if (low === "only") continue;
    // "to" + verb is a complement ("a licence to operate"), not a phrase about a place.
    const isPrep = PREPOSITIONS.has(low) && !(low === "to" && rest[i + 1] && verbBase(rest[i + 1]!.low) && verbForm(rest[i + 1]!.low) === "base");
    if (isPrep && !(low === "of" && !pp)) {
      closePP();
      pp = { prep: low, stems: [] };
      continue;
    }
    if (low === "of" && pp) {
      // "the tender for the bridge of …": keep "of" inside the phrase.
      continue;
    }
    if (NEUTRAL_ADVERBS.has(low)) {
      if (PRESENT_MARKERS.has(low)) times.push("now");
      continue;
    }
    if ((isMannerAdverb(t) && !pp) || ["sharply", "slightly", "strongly", "steadily"].includes(low)) {
      adverbs.push(stemOf(low));
      continue;
    }
    if (pp) {
      ppTokens.push(t);
      if (!OBJECT_SKIP.has(low)) pp.stems.push(stemOf(low));
      continue;
    }
    // A time phrase without a preposition: "last week", "next year", "two years ago", "now".
    if (isTimeish([t]) || PRESENT_MARKERS.has(low) || ((low === "last" || low === "next" || low === "this") && rest[i + 1] && RELATIVE_TIME.has(rest[i + 1]!.low))) {
      const span = [t];
      if ((low === "last" || low === "next" || low === "this") && rest[i + 1]) {
        span.push(rest[i + 1]!);
        i += 1;
      }
      times.push(...timeKeys(span));
      continue;
    }
    if (!OBJECT_SKIP.has(low)) object.push(stemOf(low));
  }
  closePP();
  return { object, pps, times, adverbs, scope };
}

/** Two scopes as one key: every part of each, sorted. */
function joinScope(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return a ?? b;
  return [...new Set([...a.split("+"), ...b.split("+")])].sort().join("+");
}

/** The content stems of a clause or phrase, for a scope key: "after the fee was introduced" → "fee-introduc". */
function scopeStems(tokens: readonly Token[]): string {
  return tokens
    .filter((t) => t.kind !== "punct" && !OBJECT_SKIP.has(t.low) && !AUX.has(t.low) && !PREPOSITIONS.has(t.low) && !CONNECTORS.has(t.low))
    .map((t) => stemOf(t.low))
    .join("-");
}

// ── Remnants ─────────────────────────────────────────────────────────────────

/** A verbless remnant: "not in Italy", "not e-cigarettes", "only in Spain", "in Europe" (after "and"). */
function remnantOf(tokens: Token[]): { negated: boolean; body: Token[]; degree: boolean } | null {
  const words = tokens.filter((t) => t.kind !== "punct" || t.raw === "$");
  let i = 0;
  let negated = false;
  while (i < words.length && (CONNECTORS.has(words[i]!.low) || ["also", "too", "only", "even", "just", "especially", "particularly", "mainly", "mostly"].includes(words[i]!.low))) i += 1;
  // "but not just in Texas": a focus, which neither denies nor restates the phrase — unreadable.
  if (focusNot(words, i)) return { negated: false, body: words.slice(i + 2), degree: true };
  if (words[i]?.low === "not" || words[i]?.low === "neither" || words[i]?.low === "nor" || words[i]?.low === "never") {
    negated = true;
    i += 1;
  }
  while (i < words.length && ["only", "even", "just", "also", "in", "for"].includes(words[i]!.low) && words[i]!.low !== "in" && words[i]!.low !== "for") i += 1;
  const body = words.slice(i);
  if (body.length === 0) return { negated, body, degree: true };
  const head = body[0]!;
  const degree =
    DEGREE_REMNANT.has(head.low) ||
    head.kind === "num" ||
    isMannerAdverb(head) ||
    head.low === "a" && body[1]?.low === "lot";
  return { negated, body, degree };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a text into propositions
// ─────────────────────────────────────────────────────────────────────────────

interface ReadText {
  props: Proposition[];
  /** Every subject named in the text, by key, for alias uniqueness. */
  subjects: Subject[];
}

const READ_CACHE = new Map<string, ReadText>();
const READ_CACHE_LIMIT = 512;

export function readPropositions(text: string): ReadText {
  const hit = READ_CACHE.get(text);
  if (hit) return hit;
  const read = readText(text);
  if (READ_CACHE.size >= READ_CACHE_LIMIT) READ_CACHE.delete(READ_CACHE.keys().next().value!);
  READ_CACHE.set(text, read);
  return read;
}

function emptyProp(base: Partial<Proposition> & Pick<Proposition, "sentence" | "unit" | "text">): Proposition {
  return {
    subject: null,
    negated: false,
    asserted: true,
    modal: null,
    tense: null,
    verb: null,
    passive: false,
    object: [],
    pps: [],
    times: [],
    adverbs: [],
    certain: false,
    scope: null,
    kind: "full",
    ...base,
  };
}

/**
 * "…, and nor did Contoso", "Neither has it", "and so did Fabrikam": an
 * auxiliary and a subject with the predicate left out — the last predicate,
 * for that subject. `negated` is null when it takes the antecedent's polarity
 * ("so did"). Null when the words after the auxiliary are more than a short
 * noun phrase ("nor did it signal a cut" is an inverted clause of its own).
 */
function invertedElision(body: Token[], connector: string | null, openers: readonly string[]): { subject: Token[]; negated: boolean | null } | null {
  let words = body.filter((t) => t.kind !== "punct");
  let negated: boolean | null | undefined = connector === "nor" || openers.includes("nor") ? true : connector === "so" || openers.includes("so") ? null : undefined;
  if (words[0]?.low === "neither" || words[0]?.low === "nor") {
    negated = true;
    words = words.slice(1);
  } else if (words[0]?.low === "so") {
    negated = null;
    words = words.slice(1);
  }
  if (negated === undefined || !words[0] || !AUX.has(words[0].low)) return null;
  const rest = words.slice(1);
  if (rest.length === 0 || rest.length > 5) return null;
  if (rest.some((t) => NEGATORS.has(t.low) || AUX.has(t.low) || t.kind === "num" || (verbBase(t.low) !== null && !t.cap))) return null;
  return { subject: rest, negated };
}

/** Words that set a subject apart from the rest of its phrase: "every carrier EXCEPT Fabrikam". */
const EXCEPT_WORDS = new Set("except excluding besides".split(" "));

/**
 * The subjects a clause's subject phrase speaks for one by one, each with the
 * polarity the clause gives it: the conjuncts of "Neither Northwind nor
 * Contoso", "Northwind and Contoso" (the clause's polarity), and the subject
 * set apart by "every carrier except Fabrikam" (the opposite one). Empty for
 * a plain subject.
 */
function sideSubjects(subjectWords: readonly Token[], negated: boolean): Array<{ subject: Subject; negated: boolean }> {
  const out: Array<{ subject: Subject; negated: boolean }> = [];
  const words = subjectWords.filter((t) => t.kind !== "punct" || t.raw === "&");
  const exceptAt = words.findIndex((t) => EXCEPT_WORDS.has(t.low) || (t.low === "other" && words[words.indexOf(t) + 1]?.low === "than"));
  if (exceptAt > 0) {
    const after = words.slice(exceptAt + (words[exceptAt]!.low === "other" ? 2 : 1));
    const subject = after.length > 0 && after.length <= 6 ? readSubject(after) : null;
    if (subject && subject.proper) out.push({ subject, negated: !negated });
    return out;
  }
  const joins = words.filter((t) => t.low === "and" || t.low === "or" || t.low === "nor" || t.low === "&");
  if (joins.length === 0) return out;
  // "Procter and Gamble", "Johnson & Johnson": a name joined by "and" is one name unless "neither"/"both"/"either" frames it.
  const framed = ["neither", "both", "either"].includes(words[0]?.low ?? "") || words.some((t) => t.low === "nor");
  if (!framed && words.some((t) => t.low === "&")) return out;
  const parts: Token[][] = [[]];
  for (const t of words) {
    if (["neither", "both", "either"].includes(t.low) && parts.length === 1 && parts[0]!.length === 0) continue;
    if (t.low === "and" || t.low === "or" || t.low === "nor" || t.low === "&") parts.push([]);
    else parts[parts.length - 1]!.push(t);
  }
  if (parts.length < 2 || parts.some((part) => part.length === 0 || part.length > 4)) return out;
  // Without a frame, only conjuncts that all open with a determiner ("the bank and the insurer") or are all one name
  // each ("Northwind and Contoso"): "The Food and Drug Administration" is one name.
  if (!framed && !parts.every((part) => DETERMINERS.has(part[0]!.low)) && !parts.every((part) => part.length === 1 && part[0]!.cap)) return out;
  for (const part of parts) {
    const subject = readSubject(part);
    if (subject) out.push({ subject, negated });
  }
  return out;
}

/**
 * Verbs that deny the clause they report: "Northwind denied that it raised
 * prices", "rejected claims that", "disputed reports that". The passage
 * reports the opposite of that clause — said by someone, never proved.
 */
const DENYING = new Set("deny reject dispute refute dismiss rebut contest disprove debunk repudiate retract".split(" ").map(stemOf));
/** Verbs that doubt the clause they report: it is neither stated nor denied. */
const DOUBTING = new Set("doubt question challenge disbelieve".split(" ").map(stemOf));
/** Verbs that vouch for a claim they take as their object: "confirmed reports that …" states it. */
const CONFIRMING = new Set("confirm acknowledge admit verify corroborate accept".split(" ").map(stemOf));
/** A reporting verb said to be wrong: "wrongly reported that", "It was mistakenly claimed that". */
const FALSITY_ADVERBS = new Set("wrongly mistakenly falsely incorrectly erroneously inaccurately wrongfully misleadingly".split(" ").map(stemOf));
const FALSITY_WORDS = new Set("false mistaken erroneous inaccurate incorrect wrong untrue baseless unfounded discredited debunked bogus fake".split(" "));
/** A source said to be withdrawn or unchecked: what it says is not stated by the passage ("a since-retracted report said …"). */
const RETRACTION_WORDS = new Set("retracted withdrawn unverified unconfirmed disputed contested".split(" "));
/** The parts of a word, a hyphenated one ("since-retracted") split. */
const wordParts = (tokens: readonly Token[]) => tokens.filter((t) => t.kind === "word").flatMap((t) => t.low.split("-"));
/** What a "that" clause is in its sentence: asserted, a claim reported but not stated, or one reported as false. */
type ComplementFrame = "asserted" | "unasserted" | "denied";
/** Openers of a reason, time or condition clause: beside one, a denial may be about that clause alone. */
const SUBORDINATORS = new Set("because since as after before when whenever while whilst until till once if unless".split(" "));
/** A reason or purpose phrase split off by a comma: "…, because of the pandemic", "…, due to inflation". */
const REASON_OPENER = /^(?:because|due to|owing to|thanks to|on account of|as a result of|in order to|so as to)\b/;
/**
 * How a "that" clause reads after the unit it completes (`tokens`, read as
 * `props`). The passage states it only when that unit is an affirmed verb of
 * saying taking it directly ("said that", "reported that"), or a verb that
 * vouches for a claim ("confirmed reports that"). Denied, disputed, rejected
 * or said to be wrong, it reports the opposite ("denied that it raised
 * prices"); after a noun ("reports that", "rumours that"), a denied or hedged
 * verb of saying ("did not say that", "may have said that") or a verb of
 * doubt, it is a claim someone made, and states nothing.
 */
function complementFrame(tokens: readonly Token[], props: readonly Proposition[]): ComplementFrame {
  const words = tokens.filter((t) => t.kind === "word");
  const last = words[words.length - 1];
  const governing = [...props].reverse().find((p) => p.verb !== null && p.kind !== "remnant") ?? null;
  // "Reports that …", "The claim that …": a clause about a claim, not one.
  if (!governing || !last) return "unasserted";
  if (governing.negated || (governing.modal !== null && HEDGE_MODALS.has(governing.modal))) return "unasserted";
  const verb = stemOf(governing.verb!);
  if (DENYING.has(verb) || governing.adverbs.some((a) => FALSITY_ADVERBS.has(a)) || wordParts(words).some((w) => FALSITY_WORDS.has(w))) return "denied";
  if (DOUBTING.has(verb) || wordParts(words).some((w) => RETRACTION_WORDS.has(w))) return "unasserted";
  const takesItDirectly = governing.object.length === 0 && stemOf(last.low) === verb;
  if (!takesItDirectly && !CONFIRMING.has(verb)) return "unasserted";
  return "asserted";
}

function readText(text: string): ReadText {
  const props: Proposition[] = [];
  const subjects: Subject[] = [];
  const sentences = sentencesOf(text);
  let unitIndex = 0;
  /** The last proposition with a verb of its own: what an elided verb or a remnant borrows. */
  let lastPredicate: Proposition | null = null;
  /** Subjects in reading order, resolved: what a pronoun stands for. */
  const subjectHistory: Array<{ subject: Subject; sentence: number }> = [];

  sentences.forEach((s, si) => {
    const tokens = tokenize(s.text);
    const units = unitsOf(tokens, si, s.question);
    let pendingSubject: Subject | null = null;
    /** Subjects a remnant set apart before the verb: "Contoso, but not Fabrikam, cut its dividend". */
    let pendingExcluded: Subject[] = [];
    let pendingFronted: Token[][] = [];
    let sentenceSubject: Subject | null = null;
    let sentenceLast: Proposition | null = null;
    const readUnit = (u: Unit) => {
      const unit = unitIndex++;
      const unitText = u.tokens.map((t) => t.raw).join(" ");
      const { tokens: body, opener, only } = stripOpeners(u.tokens);
      const connector = u.connector && u.connector !== "," && u.connector !== ";" ? u.connector : opener;
      const unasserted = s.question || (connector !== null && UNASSERTED_CONNECTORS.has(connector)) || (opener !== null && UNASSERTED_CONNECTORS.has(opener));
      if (body.length === 0) return;
      // "…, and nor did Contoso": the last predicate, for Contoso, denied. Never certain.
      const inverted = invertedElision(body, u.connector, u.tokens.slice(0, u.tokens.length - body.length).map((t) => t.low));
      if (inverted) {
        const antecedent = sentenceLast && sentenceLast.verb ? sentenceLast : lastPredicate;
        let subject = readSubject(inverted.subject);
        if (subject?.pronoun) {
          const resolved = resolvePronoun(subject.pronoun, subjectHistory, si);
          if (resolved) subject = { ...resolved, pronoun: subject.pronoun };
        }
        if (antecedent?.verb && subject) {
          props.push({
            ...antecedent,
            sentence: si,
            unit,
            subject,
            negated: inverted.negated ?? antecedent.negated,
            asserted: antecedent.asserted && !unasserted,
            kind: "elided",
            certain: false,
            text: unitText,
          });
          return;
        }
      }
      const relative = body[0]!.low === "which" || body[0]!.low === "who";
      const vpContext = !relative && (u.connector === "and" || u.connector === "but" || u.connector === "or" || u.connector === "yet" || opener === "and" || opener === "but" || (u.connector === "," && !u.initial));
      const parsed = parseUnit(relative ? body.slice(1) : body, vpContext || relative);
      if (!parsed) return;

      // ── No verb at all: a fronted adverbial, a subject waiting for its verb, or a remnant.
      if (parsed.verbIndex < 0 && !parsed.elided) {
        const words = body.filter((t) => t.kind !== "punct");
        const first = words[0];
        const startsPP = first && (PREPOSITIONS.has(first.low) || first.low === "according" || (["last", "next", "this"].includes(first.low) && words[1] && TIME_WORDS.has(words[1].low)));
        const contrastConnector = connector === "but" || connector === "rather than" || connector === "instead of" || connector === "nor" || connector === "and" || connector === "or" || connector === "though" || connector === "although" || connector === "yet";
        const negatedRemnant = words.some((t) => t.low === "not" || t.low === "neither" || t.low === "nor") && (first?.low === "not" || first?.low === "neither" || first?.low === "nor" || ["only", "even", "just"].includes(first?.low ?? ""));
        if (u.initial && startsPP && !negatedRemnant) {
          pendingFronted.push(words);
          return;
        }
        if (u.initial && words.some((t) => t.low === "not" || t.low === "no" || t.low === "never") && !first?.cap) return;
        if (!contrastConnector && !negatedRemnant && !only) {
          // A noun phrase: the subject of a verb phrase further on ("The company, which …, raised"), or an apposition.
          if (!startsPP && words.length > 0) {
            if (!sentenceLast) pendingSubject = readSubject(words);
          } else if (startsPP && !u.initial && sentenceLast && !["unlike", "except", "besides", "despite", "according", "like", "than"].includes(first!.low)) {
            // A trailing adjunct split off by a comma ("…, in Portugal,"): it belongs to the last clause.
            const extra = readRest(words);
            sentenceLast.pps.push(...extra.pps);
            sentenceLast.times.push(...extra.times);
          }
          return;
        }
        // Between a subject and its verb, a remnant sets a subject apart: "Contoso, but not Fabrikam, cut …".
        const rem = remnantOf(body);
        if (!sentenceLast && pendingSubject && rem && rem.negated && !rem.degree && rem.body.length > 0 && rem.body.length <= 6 && !PREPOSITIONS.has(rem.body[0]!.low)) {
          const excluded = readSubject(rem.body);
          if (excluded) pendingExcluded.push(excluded);
          return;
        }
        // A remnant of the previous proposition.
        const antecedent = sentenceLast ?? lastPredicate;
        if (!antecedent || !rem || rem.degree || antecedent.verb === null) {
          // Unreadable: a candidate statement of either polarity, never proof.
          if (antecedent && rem && !rem.degree) props.push(emptyProp({ sentence: si, unit, text: unitText, kind: "remnant", negated: rem.negated, subject: antecedent.subject }));
          return;
        }
        const replaced = replaceIn(antecedent, rem.body);
        const negated = rem.negated
          ? true
          : connector === "but" && antecedent.negated
            ? false
            : connector === "rather than" || connector === "instead of"
              ? true
              : antecedent.negated;
        props.push({
          ...antecedent,
          ...replaced,
          sentence: si,
          unit,
          negated,
          asserted: antecedent.asserted && !unasserted,
          kind: "remnant",
          certain: antecedent.certain && replaced.certain,
          // A contrast says what its negation is about: the phrase it swaps in, whatever narrowed the clause before.
          scope: replaced.scope,
          text: unitText,
        });
        return;
      }

      // ── A clause.
      let subject: Subject | null = null;
      let certain = parsed.certain;
      const subjectWords = parsed.subjectTokens?.filter((t) => t.kind !== "punct") ?? [];
      if (relative) {
        if (subjectWords.length === 0) {
          // "which never paid a dividend", "who took office in 2021": the noun phrase before it.
          subject = pendingSubject ?? lastObjectSubject(sentenceLast) ?? null;
          certain = certain && !!pendingSubject;
        } else {
          // "which analysts put at $1.2 billion": an object relative clause.
          subject = readSubject(subjectWords);
          certain = false;
        }
      } else if (subjectWords.length === 0) {
        // A verb phrase joined on: the subject of the clause before, or one waiting for its verb.
        subject = pendingSubject ?? sentenceSubject ?? null;
        if (!subject) {
          subject = subjectHistory.length > 0 ? subjectHistory[subjectHistory.length - 1]!.subject : null;
          certain = false;
        }
        pendingSubject = null;
      } else {
        subject = readSubject(subjectWords);
        pendingSubject = null;
      }
      // Pronouns, possessive pronouns, head-noun references.
      if (subject?.pronoun) {
        const antecedent = resolvePronoun(subject.pronoun, subjectHistory, si);
        if (antecedent) subject = { ...antecedent, pronoun: subject.pronoun };
        else certain = false;
      } else if (subject?.ownerPronoun) {
        const owner = resolvePronoun(subject.ownerPronoun === "their" ? "they" : subject.ownerPronoun === "his" ? "he" : subject.ownerPronoun === "her" ? "she" : "it", subjectHistory, si);
        if (owner) subject = WITH_KEY(subject, `${owner.key}'s ${subject.owned}`);
        else certain = false;
      }
      if (subject && !subject.pronoun) subjects.push(subject);

      const restInfo = readRest(parsed.rest);
      const frontedTimes: TimeKey[] = [];
      const frontedPPs: PP[] = [];
      for (const fr of [...pendingFronted, ...parsed.fronted]) {
        const first = fr[0]?.low;
        if (!first || ["according", "unlike", "despite", "without", "except", "like", "besides"].includes(first)) continue;
        const info = readRest(fr);
        frontedTimes.push(...info.times);
        // "In a statement on Monday", "In its filing": framing, not a place the claim could name.
        if (!(fr.some((t) => ["statement", "filing", "report", "interview", "letter", "release", "speech"].includes(t.low)))) frontedPPs.push(...info.pps);
      }
      pendingFronted = [];

      let prop: Proposition;
      if (parsed.elided) {
        const antecedent = sentenceLast && sentenceLast.verb ? sentenceLast : lastPredicate;
        if (!antecedent || !antecedent.verb) {
          prop = emptyProp({ sentence: si, unit, text: unitText, kind: "elided", subject, negated: parsed.negated });
        } else {
          // The left-out predicate, with this clause's own times and places swapped in.
          const swapped = swapQualifiers(antecedent, [...frontedPPs, ...restInfo.pps], [...frontedTimes, ...restInfo.times]);
          prop = {
            ...antecedent,
            ...swapped,
            sentence: si,
            unit,
            subject,
            negated: parsed.negated,
            asserted: parsed.asserted && !unasserted,
            modal: parsed.modal ?? antecedent.modal,
            tense: parsed.tense ?? antecedent.tense,
            adverbs: restInfo.adverbs,
            kind: "elided",
            certain: certain && antecedent.certain && restInfo.object.length === 0,
            scope: joinScope(antecedent.scope, restInfo.scope),
            text: unitText,
          };
        }
      } else {
        // "Northwind cut its budget": past after a singular subject or a name, unknown after a plural one.
        const singular = !!subject && (subject.plural === false || subject.pronoun === "it" || subject.pronoun === "he" || subject.pronoun === "she" || (subject.proper && subject.plural === null && !subject.words.includes("and")));
        const tense = parsed.sameForm ? (singular ? "past" : null) : parsed.tense;
        prop = {
          sentence: si,
          unit,
          subject,
          negated: parsed.negated,
          asserted: parsed.asserted && !unasserted,
          modal: parsed.modal,
          tense,
          verb: parsed.verb,
          passive: parsed.passive,
          object: restInfo.object,
          pps: [...frontedPPs, ...restInfo.pps],
          times: [...frontedTimes, ...restInfo.times],
          adverbs: restInfo.adverbs,
          certain,
          scope: joinScope(restInfo.scope, subjectWords.some((t) => QUANTIFIERS.has(t.low)) ? "all:subject" : null),
          kind: relative ? "relative" : subjectWords.length === 0 ? "vp" : "full",
          text: unitText,
        };
        // A joined-on participle borrows the auxiliary of the clause before ("The dividend was cut, but not suspended").
        if (prop.kind === "vp" && sentenceLast && sentenceLast.passive && !prop.passive && parsed.verb && /ed$|en$/.test(parsed.rest.length >= 0 ? (u.tokens.find((t) => verbBase(t.low) === parsed.verb)?.low ?? "") : "")) {
          prop.passive = true;
          prop.tense = sentenceLast.tense;
        }
      }
      if (!parsed.elided) {
        // "and its profits rose too": the same circumstances as the clause it adds to.
        const adds = u.tokens.some((t) => t.low === "too") || u.tokens.some((t, k) => t.low === "as" && u.tokens[k + 1]?.low === "well");
        if (adds && sentenceLast && sentenceLast.verb === prop.verb && prop.times.length === 0 && prop.pps.length === 0) {
          prop.times = [...sentenceLast.times];
          prop.pps = [...sentenceLast.pps];
        }
        // "cut them again", "raised them 5%": the object of the clause before.
        if (prop.object.length === 1 && (prop.object[0] === "them" || prop.object[0] === "it")) {
          const before = sentenceLast ?? lastPredicate;
          if (before && before.object.length > 0 && !(before.object.length === 1 && (before.object[0] === "them" || before.object[0] === "it"))) prop.object = [...before.object];
          // "The merger closed in 2024, though regulators never approved it": the subject before, when it had no object.
          else if (before && before.object.length === 0 && before.subject && !before.subject.pronoun && prop.object[0] === "it") prop.object = normKey(before.subject).split(" ");
          else prop.certain = false;
        }
      }
      // Attribution: a verb of saying with nothing after it.
      if (prop.verb && REPORTING.has(prop.verb) && prop.object.length === 0 && prop.kind !== "elided") prop.asserted = false;
      props.push(prop);
      /*
       * The subjects the clause speaks for one by one — "Neither Northwind nor
       * Contoso raised prices", "every carrier except Fabrikam", "Contoso, but
       * not Fabrikam, cut its dividend" — each a proposition of its own with
       * the polarity the clause gives it. Never certain: they say what may
       * deny a claim, for a reader to review, and never prove it.
       */
      if (prop.verb && !relative) {
        const side = sideSubjects(subjectWords, prop.negated);
        if (subjectWords.length === 0) for (const excluded of pendingExcluded) side.push({ subject: excluded, negated: !prop.negated });
        for (const { subject: one, negated } of side) {
          props.push({ ...prop, subject: one, negated, certain: false, kind: "remnant" });
        }
      }
      pendingExcluded = [];
      if (prop.verb || prop.kind === "elided") {
        sentenceLast = prop;
        if (prop.verb && prop.asserted !== false) lastPredicate = prop;
        else if (prop.verb && !lastPredicate) lastPredicate = prop;
        if (prop.verb && !prop.asserted && prop.verb && !REPORTING.has(prop.verb)) lastPredicate = prop;
      }
      if (subject && prop.kind !== "relative") {
        sentenceSubject = subject;
        subjectHistory.push({ subject, sentence: si });
      }
    };
    /** The unit before, as read: what a "that" clause is the complement of, and what a reason or time clause qualifies. */
    let previous: { tokens: Token[]; props: Proposition[]; subordinate: boolean } | null = null;
    /** A frame a "that" clause was read in, carried to a verb phrase joined on to it ("denied that it raised prices and cut wages"). */
    let frame: ComplementFrame = "asserted";
    /** A reason, time or condition clause opened the sentence: the clause after it is qualified by it. */
    let scopeNext: string | null = null;
    /** "According to a since-retracted report, …", "According to a false report, …": the sentence is that report's. */
    let sentenceFrame: ComplementFrame = "asserted";
    let sentenceFraming = "";
    const applyFrame = (ps: readonly Proposition[], how: ComplementFrame, framing: string) => {
      for (const p of ps) {
        if (how === "unasserted") p.asserted = false;
        else if (how === "denied") {
          // Denied, disputed or reported wrongly: the passage reports the opposite, and never proves it.
          p.negated = !p.negated;
          p.certain = false;
          p.text = `${framing} ${p.text}`.trim();
        }
      }
    };
    units.forEach((u) => {
      const start = props.length;
      readUnit(u);
      const mine = props.slice(start);
      const { tokens: body, opener } = stripOpeners(u.tokens);
      const connector = u.connector && u.connector !== "," && u.connector !== ";" ? u.connector : opener;
      if (u.initial && body[0]?.low === "according") {
        const parts = wordParts(u.tokens);
        sentenceFrame = parts.some((w) => FALSITY_WORDS.has(w)) ? "denied" : parts.some((w) => RETRACTION_WORDS.has(w)) ? "unasserted" : "asserted";
        sentenceFraming = u.tokens.map((t) => t.raw).join(" ");
      } else if (sentenceFrame !== "asserted") applyFrame(mine, sentenceFrame, sentenceFraming);
      // ── What a reported clause is: "Northwind denied that it raised prices" states nothing about prices.
      if (u.connector === "that" && previous) {
        frame = complementFrame(previous.tokens, previous.props);
      } else if (!(mine.length > 0 && mine.every((p) => p.kind === "vp") && (u.connector === "and" || u.connector === "or"))) {
        frame = "asserted";
      }
      if (u.connector === "that" && !previous) frame = "unasserted";
      if (frame !== "asserted") applyFrame(mine, frame, previous ? previous.tokens.map((t) => t.raw).join(" ") : "");
      // ── A reason, time or condition clause beside a denial: the denial may be about it alone. "as some outlets
      // reported" comments on what was said, and a contrast ("in 2024, not in 2023 as first reported") already says
      // what its negation is about.
      const comment = connector === "as" && body.some((t) => REPORTING.has(t.low));
      // "… so that it could win customers": a purpose, which a denial may be about alone.
      const purpose = u.connector === "that" && previous?.tokens.filter((t) => t.kind === "word").pop()?.low === "so";
      const reason = REASON_OPENER.test(u.tokens.filter((t) => t.kind === "word").map((t) => t.low).join(" "));
      // "…, while Japan fined Apple", "…, while Contoso did not": a contrast with the clause before (its verb again, or
      // left out), not a time it is narrowed to ("while the freeze was in force").
      const contrast =
        (connector === "while" || connector === "whilst") &&
        !!previous &&
        mine.some((p) => p.kind === "elided" || (p.verb !== null && previous!.props.some((q) => q.verb !== null && (q.verb === p.verb || synonyms(q.verb, p.verb)))));
      const subordinate = (((connector !== null && SUBORDINATORS.has(connector)) || purpose) && hasVerb(body) && !comment && !contrast) || reason;
      const narrow = (ps: readonly Proposition[], key: string) => {
        for (const p of ps) if (p.kind !== "remnant") p.scope = joinScope(p.scope, key);
      };
      if (subordinate) {
        const key = `${purpose ? "so" : connector}:${scopeStems(body)}`;
        if (previous && !previous.subordinate) narrow(previous.props, key);
        if (u.initial) scopeNext = key;
      } else if (scopeNext !== null && mine.length > 0) {
        narrow(mine, scopeNext);
        scopeNext = null;
      }
      if (u.tokens.some((t) => t.kind !== "punct")) previous = { tokens: u.tokens, props: mine, subordinate };
    });
  });
  return { props, subjects };
}

function lastObjectSubject(prop: Proposition | null): Subject | null {
  if (!prop || prop.object.length === 0) return null;
  return { key: prop.object.join(" "), words: prop.object, head: prop.object[prop.object.length - 1]!, pronoun: null, proper: false, names: [], plural: null, ownerPronoun: null, owned: null, contrast: false, indefinite: false, stemmed: true };
}

function resolvePronoun(pronoun: string, history: Array<{ subject: Subject; sentence: number }>, sentence: number): Subject | null {
  const fits = (subject: Subject) =>
    !subject.contrast &&
    !subject.indefinite &&
    !(pronoun === "it" && subject.plural === true) &&
    !(pronoun === "they" && subject.plural === false && !isCollective(subject)) &&
    !((pronoun === "he" || pronoun === "she") && subject.plural === true);
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const { subject, sentence: at } = history[i]!;
    if (sentence - at > 2) return null;
    if (fits(subject)) return subject;
    // "Northwind's sales rose …, but its profits did not": the owner of a subject that does not fit.
    const owner = possessorOf(subject);
    if (owner && fits(owner)) return owner;
  }
  return null;
}

/** "Northwind" for "Northwind's sales". */
function possessorOf(subject: Subject): Subject | null {
  const at = subject.words.findIndex((w) => /'s$|s'$/.test(w));
  if (at < 0 || at === subject.words.length - 1) return null;
  const words = subject.words.slice(0, at + 1).map((w, i) => (i === at ? w.replace(/'s$|'$/, "") : w)).filter((w) => w !== "the");
  if (words.length === 0) return null;
  return { key: words.join(" "), words, head: words[words.length - 1]!, pronoun: null, proper: subject.proper, names: subject.names.filter((n) => words.includes(n)), plural: subject.proper ? null : false, ownerPronoun: null, owned: null, contrast: false, indefinite: false };
}

/** Nouns "they" may stand for in the singular. */
function isCollective(s: Subject): boolean {
  return ["council", "committee", "board", "team", "government", "company", "union", "staff", "police", "public", "group", "family", "panel", "jury", "court"].includes(s.head);
}

/**
 * A passive with its agent ("The merger was approved by regulators") as the
 * active clause it states ("Regulators approved the merger"), for comparing
 * it with one in the active voice. Null when there is no agent to promote.
 */
function activeOf(prop: Proposition): Proposition | null {
  if (!prop.passive) return prop;
  const by = prop.pps.findIndex((pp) => pp.prep === "by");
  if (by < 0 || !prop.subject) return null;
  const agent = prop.pps[by]!;
  return {
    ...prop,
    passive: false,
    pps: prop.pps.filter((_, i) => i !== by),
    object: normKey(prop.subject).split(" "),
    subject: { key: agent.stems.join(" "), words: agent.stems, head: agent.stems[agent.stems.length - 1] ?? "", pronoun: null, proper: false, names: [], plural: null, ownerPronoun: null, owned: null, contrast: false, indefinite: false, stemmed: true },
  };
}

/** Both propositions in the same voice: as read when they agree, both active when they do not. */
function sameVoice(a: Proposition, b: Proposition): [Proposition, Proposition] | null {
  if (a.passive === b.passive) return [a, b];
  const aa = activeOf(a);
  const bb = activeOf(b);
  return aa && bb ? [aa, bb] : null;
}

/** The previous proposition with the remnant's phrase in place of the one it contrasts with. */
function replaceIn(antecedent: Proposition, body: Token[]): Pick<Proposition, "object" | "pps" | "times" | "scope"> & { certain: boolean } {
  const info = readRest(body);
  const first = body.find((t) => t.kind !== "punct");
  if (first && PREPOSITIONS.has(first.low)) {
    // A phrase: in place of the one with the same preposition, else added.
    const swapped = swapQualifiers(antecedent, info.pps, info.times);
    return { ...swapped, object: antecedent.object, certain: true, scope: info.scope };
  }
  if (info.times.length > 0 && info.object.length === 0) {
    return { ...swapQualifiers(antecedent, [], info.times), object: antecedent.object, certain: true, scope: info.scope };
  }
  // A noun phrase: in place of the object; the phrases after the object went with the contrasted one.
  return { object: info.object, pps: info.pps, times: info.times.length > 0 ? info.times : antecedent.times, certain: antecedent.object.length > 0, scope: info.scope };
}

function swapQualifiers(antecedent: Proposition, pps: PP[], times: TimeKey[]): Pick<Proposition, "pps" | "times"> {
  let outPPs = antecedent.pps;
  for (const pp of pps) {
    const at = outPPs.findIndex((x) => x.prep === pp.prep);
    outPPs = at >= 0 ? outPPs.map((x, i) => (i === at ? pp : x)) : [...outPPs, pp];
  }
  let outTimes = antecedent.times;
  if (times.length > 0) {
    const kinds = new Set(times.map(timeKind));
    outTimes = [...antecedent.times.filter((t) => !kinds.has(timeKind(t))), ...times];
  }
  return { pps: outPPs, times: outTimes };
}

function timeKind(t: TimeKey): string {
  const span = t.match(/span-([a-z]):/);
  if (span) return span[1] === "w" ? "d" : span[1]!;
  const bare = t.replace(/^[a-z]+:(?=[a-z]\d|y\d|m\d)/, "");
  return bare.startsWith("y") ? "y" : bare.startsWith("m") ? "m" : bare.startsWith("q") || bare.startsWith("h") ? "q" : bare.startsWith("d:") ? "d" : bare;
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparing propositions
// ─────────────────────────────────────────────────────────────────────────────

/** Generic nouns another name for an organisation, a body or a person can take. */
const GENERIC_HEADS = new Set(
  ("company firm group business corporation conglomerate maker manufacturer carmaker automaker drugmaker chipmaker producer supplier retailer grocer chain " +
    "lender bank insurer airline carrier operator agency regulator watchdog authority ministry department government administration council committee " +
    "board body court commission institution organisation organization fund startup contractor builder developer venue museum gallery utility " +
    "senator governor mayor minister president official officials executive spokesperson leader politician democrat republican researcher scientist " +
    "team club party union city state country nation region province county town village school university hospital clinic plant factory").split(" ")
);

/** Measured nouns in groups of near-synonyms: two subjects in different groups are about different things. */
const MEASURE_GROUPS: string[][] = [
  ["revenue", "revenues", "sales", "turnover", "takings", "receipts"],
  ["profit", "profits", "earnings", "income"],
  ["cost", "costs", "expense", "expenses", "spending", "expenditure"],
  ["margin", "margins"],
  ["dividend", "dividends", "payout"],
  ["price", "prices", "fees", "tariffs"],
  ["wage", "wages", "salaries", "pay"],
  ["inflation"],
  ["unemployment", "jobless"],
  ["emissions"],
  ["share", "shares", "stock", "stocks"],
  ["output", "production"],
  ["exports"],
  ["imports"],
  ["applications"],
  ["debt", "borrowings"],
  ["deposits"],
  ["loans"],
];
const MEASURE_GROUP = new Map<string, number>();
MEASURE_GROUPS.forEach((group, i) => group.forEach((w) => MEASURE_GROUP.set(stemOf(w), i)));

/** The near-synonym group of a measured noun ("revenue", "sales", "turnover" are one), or undefined for a noun in none. */
export function measureGroupOf(word: string): number | undefined {
  return MEASURE_GROUP.get(stemOf(word));
}

function subjectsEqual(a: Subject | null, b: Subject | null): boolean {
  if (!a || !b) return false;
  return normKey(a) === normKey(b);
}

function normKey(s: Subject): string {
  const stemmed = s.stemmed;
  const key = s.key.replace(/^(?:the|a|an) /, "");
  return stemmed ? key : key.split(" ").map((w) => (/'s$|'$/.test(w) ? `${stemOf(w)}'s` : stemOf(w))).join(" ");
}

/**
 * Whether `alias` may be read as `full` with certainty: "the council" for "The
 * Harlow city council", "the committee" for "The International Olympic
 * Committee", "Northwind" for "Northwind Traders", "the senator" for "Senator
 * James Holt" — its words are the full name's head, title or name words, and
 * no other subject named in the passage shares them.
 */
function headReference(alias: Subject, full: Subject, named: readonly Subject[]): boolean {
  if (alias.pronoun || alias.contrast || alias.ownerPronoun) return false;
  const aliasWords = alias.words.filter((w) => w !== "the" && w !== "a" && w !== "an");
  // "the NTSB" after "The National Transportation Safety Board".
  if (aliasWords.length === 1 && /^[a-z]{2,6}$/.test(aliasWords[0]!) && alias.names.includes(aliasWords[0]!)) {
    const initials = full.words.filter((w) => !["the", "of", "and", "for", "&"].includes(w)).map((w) => w[0]).join("");
    if (initials === aliasWords[0] && full.names.length >= 2) {
      return !named.some((s) => normKey(s) !== normKey(full) && normKey(s) !== normKey(alias) && s.words.filter((w) => !["the", "of", "and", "for", "&"].includes(w)).map((w) => w[0]).join("") === initials);
    }
  }
  if (aliasWords.length === 0 || aliasWords.length >= full.words.length) return false;
  const fullWords = full.words.map((w) => w.replace(/\.$/, ""));
  const covered = aliasWords.every((w) => fullWords.includes(w));
  if (!covered) return false;
  const isHead = aliasWords.length === 1 && (aliasWords[0] === full.head || TITLES.has(aliasWords[0]!) || full.names.includes(aliasWords[0]!));
  const isNamePart = aliasWords.every((w) => full.names.includes(w));
  if (!isHead && !isNamePart) return false;
  // Unique: no other subject of the passage (other than the full name itself) holds those words.
  return !named.some((s) => normKey(s) !== normKey(full) && normKey(s) !== normKey(alias) && aliasWords.every((w) => s.words.includes(w)));
}

/** Name words that are the generic head of an institution's name ("the Bank", "the Commission"). */
function distinctiveNames(s: Subject): string[] {
  return s.names.filter((w) => !GENERIC_HEADS.has(w) && !TITLES.has(w));
}

/** Whether two subjects are provably different entities (a candidate statement about one says nothing about the other). */
function provablyDifferent(claim: Subject, other: Subject): boolean {
  if (other.pronoun) return false;
  if (subjectsEqual(claim, other)) return false;
  if (other.contrast && !claim.contrast) return true;
  // "a rival vaccine", "an experimental shot": a new referent, not one the claim names.
  if (other.indefinite && !claim.indefinite) return true;
  // Something of its own: "its rivals", "its board" (unless the claim is about exactly that).
  if (other.ownerPronoun) return true;
  const ch = stemOf(claim.head);
  const oh = stemOf(other.head);
  const cg = MEASURE_GROUP.get(ch);
  const og = MEASURE_GROUP.get(oh);
  if (cg !== undefined && og !== undefined) {
    if (cg !== og) return true;
    // The same measure of two owners named differently: "Contoso's shares" and "Fabrikam's shares".
    const co = possessorOf(claim);
    const oo = possessorOf(other);
    if (!co || !oo) return false;
    const cn = distinctiveNames(co);
    const on = distinctiveNames(oo);
    return cn.length > 0 && on.length > 0 && cn.some((w) => !on.includes(w)) && on.some((w) => !cn.includes(w));
  }
  // Two names: different when neither holds all of the other's distinctive name words, and neither is the other's acronym.
  const cn = distinctiveNames(claim);
  const on = distinctiveNames(other);
  if (cn.length > 0 && on.length > 0) {
    const acronym = (a: string[], b: string[]) => a.some((w) => w.length >= 2 && w === b.map((n) => n[0]).join(""));
    if (acronym(cn, on) || acronym(on, cn)) return false;
    const cHasOwn = cn.some((w) => !on.includes(w));
    const oHasOwn = on.some((w) => !cn.includes(w));
    if (cHasOwn && oHasOwn) return true;
  }
  // The same head, each with a modifier the other lacks: "the county council", "the city council".
  if (ch === oh && claim.words.length > 1 && other.words.length > 1) {
    const cm = claim.words.filter((w) => !other.words.includes(w) && !["the", "a", "an"].includes(w));
    const om = other.words.filter((w) => !claim.words.includes(w) && !["the", "a", "an"].includes(w));
    if (cm.length > 0 && om.length > 0) return true;
  }
  return false;
}

function sameStems(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 && b.length === 0) return true;
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

function subset(a: readonly string[], b: readonly string[]): boolean {
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

function timesAgree(claim: TimeKey, other: TimeKey): boolean {
  return claim === other || claim.replace(/^[a-z]+:/, "") === other.replace(/^[a-z]+:/, "") && !/:/.test(claim) === !/:/.test(other);
}

/** Times that only restate the present tense, dropped before comparing two present-tense statements. */
function meaningfulTimes(p: Proposition): TimeKey[] {
  return p.times.filter((t) => !(t === "now" && p.tense === "present"));
}

/**
 * Whether passage proposition `c` is claim proposition `p` with the opposite
 * polarity and nothing else changed: the proof half of the rule.
 */
function exactOpposite(claimProp: Proposition, rawPassageProp: Proposition, named: readonly Subject[], claimSubjects: readonly Subject[]): boolean {
  const passageProp = inClaimVerb(claimProp, rawPassageProp);
  if (!passageProp.certain || !passageProp.asserted || passageProp.negated === claimProp.negated) return false;
  // A denial that may be about a reason, a count, a quantifier or a clause beside it denies something narrower, on
  // either side: "did not raise prices because demand fell", "did not sell all of its shares", "did not raise rates
  // once". Only a statement narrowed by the same words answers it.
  if (rawPassageProp.negated && rawPassageProp.scope !== null && rawPassageProp.scope !== claimProp.scope) return false;
  if (claimProp.negated && claimProp.scope !== null && claimProp.scope !== rawPassageProp.scope) return false;
  const voiced = sameVoice(claimProp, passageProp);
  if (!voiced) return false;
  const [p, c] = voiced;
  if (!c.verb || c.verb !== p.verb || c.passive !== p.passive) return false;
  if ((c.modal ?? null) !== (p.modal ?? null)) return false;
  if (p.tense && c.tense && p.tense !== c.tense) return false;
  if (!subjectMatches(p.subject, c.subject, named, claimSubjects)) return false;
  // A denial of the act denies it by any amount: "did not rise in 2024" answers "rose 14% in 2024", "did not cut jobs"
  // answers "cut 500 jobs". Only figures may be the claim's extra object, never a word of what was acted on.
  const amountOnly =
    rawPassageProp.negated && !claimProp.negated && subset(c.object, p.object) && p.object.filter((w) => !c.object.includes(w)).every((w) => /^[$£€]?\d/.test(w));
  if (!sameStems(p.object, c.object) && !amountOnly) return false;
  // Every one of the claim's places and times, in the passage's statement.
  for (const pp of p.pps) if (!c.pps.some((x) => x.prep === pp.prep && sameStems(x.stems, pp.stems))) return false;
  const pt = meaningfulTimes(p);
  const ct = meaningfulTimes(c);
  for (const t of pt) if (!ct.some((x) => timesAgree(t, x))) return false;
  // A denial denies exactly the claim; a statement may say more ("rose sharply in 2024" is a rise, and
  // "rejected the proposal after a long session" a rejection).
  if (rawPassageProp.negated) {
    if (c.pps.length > p.pps.length || ct.length > pt.length) return false;
    if (c.adverbs.some((a) => !p.adverbs.includes(a))) return false;
  } else {
    if (ct.length > pt.length) return false;
    // The same for a denying claim: "did not raise rates twice" is not contradicted by "raised rates".
    if (claimProp.negated && p.adverbs.some((a) => !c.adverbs.includes(a))) return false;
  }
  return true;
}

/** The claim's subject in the passage's words, or a reference that can only be to it. */
function subjectMatches(claim: Subject | null, passage: Subject | null, named: readonly Subject[], claimSubjects: readonly Subject[]): boolean {
  if (!claim || !passage) return false;
  if (subjectsEqual(claim, passage)) return true;
  // "the council" after "The Harlow city council" was named in the passage.
  const full = named.find((s) => subjectsEqual(s, claim));
  if (full && headReference(passage, full, named)) return true;
  void claimSubjects;
  return false;
}

/**
 * Whether passage proposition `d`, of the claim's own polarity, may state the
 * claim: the doubt half of the rule. Anything it cannot rule out counts.
 */
function plausiblyStates(claimProp: Proposition, rawPassageProp: Proposition, named: readonly Subject[]): boolean {
  const passageProp = inClaimVerb(claimProp, rawPassageProp);
  if (passageProp.negated !== claimProp.negated) return false;
  // Two voices with no agent to line them up ("The merger was approved" / "Regulators approved the merger"):
  // it may state the claim when its verb may be the claim's and the passive's subject is the active's object.
  const voiced = sameVoice(claimProp, passageProp);
  if (!voiced) {
    if (!passageProp.asserted) return false;
    if (passageProp.verb === null) return true;
    if (passageProp.verb !== claimProp.verb && !synonyms(passageProp.verb, claimProp.verb)) return false;
    const passive = claimProp.passive ? claimProp : passageProp;
    const active = claimProp.passive ? passageProp : claimProp;
    const patient = passive.subject ? normKey(passive.subject).split(" ") : [];
    return active.object.length === 0 || patient.length === 0 || patient.some((w) => active.object.includes(w));
  }
  const [p, d] = voiced;
  if (!d.asserted && d.verb !== null) return false;
  if (d.subject && p.subject && provablyDifferent(p.subject, d.subject) && !subjectMatches(p.subject, d.subject, named, [])) return false;
  if (d.verb === null) return true;
  // Another verb counts when it may mean the same ("cleared" for "approved"); an unrelated one states something else.
  if (d.verb !== p.verb && !synonyms(d.verb, p.verb)) return false;
  // A statement about another time of the verb ("taught at Stanford" against "still teaches there").
  if (p.tense && d.tense && p.tense !== d.tense) return false;
  // A conflicting object, place or time rules it out; a missing one does not, nor one left as a pronoun ("it raised
  // them because costs rose": what "them" is was not read).
  if (p.object.length > 0 && d.object.length > 0 && !pronounObject(d) && !subset(p.object, d.object) && !subset(d.object, p.object)) return false;
  // "his assistant's contract" is not "his contract": an owner named in one object and not the other.
  const owners = (x: Proposition) => x.object.filter((w) => w.endsWith("'s"));
  if (!sameStems(owners(p), owners(d))) return false;
  for (const pp of p.pps) {
    const same = d.pps.filter((x) => x.prep === pp.prep);
    if (same.length > 0 && !same.some((x) => subset(pp.stems, x.stems) || subset(x.stems, pp.stems))) return false;
  }
  const pt = meaningfulTimes(p);
  const dt = meaningfulTimes(d);
  for (const t of pt) {
    const sameKind = dt.filter((x) => timeKind(x) === timeKind(t));
    if (sameKind.length > 0 && !sameKind.some((x) => timesAgree(t, x))) return false;
  }
  return true;
}

/** An object that is only "it" or "them": what it stands for was not read. */
function pronounObject(p: Proposition): boolean {
  return p.object.length === 1 && (p.object[0] === "it" || p.object[0] === "them");
}

/** Verbs a report uses for the same act, by bare form. */
const SYNONYM_GROUPS = [
  "approve clear authorise authorize back endorse sanction ratify accept",
  "reject block deny refuse veto oppose",
  "raise increase hike lift boost",
  "cut reduce lower slash trim",
  "rise increase climb grow gain jump rebound",
  "fall decline drop decrease slip slide sink plunge",
  "buy acquire purchase",
  "sell divest",
  "open launch",
  "close shut",
  "hire recruit employ",
  "fire dismiss sack",
  "win secure",
  "pay repay",
  "meet hit reach achieve",
  "miss fail",
  "sign ratify",
  "start begin launch",
  "end stop halt cease",
  "return reopen",
  "release publish issue",
  "recall withdraw",
  "say state tell report announce",
].map((g) => new Set(g.split(" ").map(stemOf)));

/**
 * Verbs that state the negation of another ("rejected" is "did not accept"),
 * by bare form. A statement with one reads as the other, negated.
 */
const ANTONYM_PAIRS: Array<[string, string]> = [];
for (const [pos, neg] of [
  ["accept approve adopt endorse back ratify pass sanction clear", "reject veto refuse block"],
  ["win", "lose"],
  ["meet hit reach beat", "miss"],
  ["rise increase grow climb gain", "fall decline drop decrease shrink slip"],
  ["confirm admit", "deny"],
  ["allow permit", "ban prohibit forbid"],
  ["support", "oppose"],
  ["include", "exclude"],
  ["succeed pass", "fail"],
] as const) for (const a of pos.split(" ")) for (const b of neg.split(" ")) ANTONYM_PAIRS.push([stemOf(a), stemOf(b)]);

function antonyms(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const sa = stemOf(a);
  const sb = stemOf(b);
  return ANTONYM_PAIRS.some(([x, y]) => (x === sa && y === sb) || (x === sb && y === sa));
}

/** `other` in the claim's verb when it says the same with an antonym ("rejected" as "not accepted"). */
function inClaimVerb(claim: Proposition, other: Proposition): Proposition {
  if (other.verb && claim.verb && other.verb !== claim.verb && antonyms(other.verb, claim.verb)) {
    return { ...other, verb: claim.verb, negated: !other.negated };
  }
  return other;
}

function synonyms(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const sa = stemOf(a);
  const sb = stemOf(b);
  return SYNONYM_GROUPS.some((g) => g.has(sa) && g.has(sb));
}

/** Content stems for overlap: object and phrases, hyphenated words split, "-ty"/"-ity"/"-ness" nouns at their adjective. */
function overlapStems(p: Proposition): Set<string> {
  const out = new Set<string>();
  for (const w of [...p.object, ...p.pps.flatMap((pp) => pp.stems)]) {
    for (const part of w.split("-")) {
      if (part.length < 3) continue;
      const bare = part.replace(/(?:ity|ty|ness)$/, "");
      out.add(stemOf(bare.length >= 3 ? bare : part));
    }
  }
  return out;
}

/** Whether `d` says the same as claim proposition `p`, in the claim's polarity: its subject, verb, object and every qualifier. */
function sameStatement(p: Proposition, raw: Proposition, named: readonly Subject[]): boolean {
  const d = inClaimVerb(p, raw);
  if (!d.asserted || d.negated !== p.negated || !d.verb) return false;
  if (d.verb !== p.verb && !synonyms(d.verb, p.verb)) return false;
  if (!subjectMatches(p.subject, d.subject, named, [])) return false;
  if (!sameStems(p.object, d.object)) return false;
  for (const pp of p.pps) if (!d.pps.some((x) => x.prep === pp.prep && sameStems(x.stems, pp.stems))) return false;
  const dt = meaningfulTimes(d);
  return meaningfulTimes(p).every((t) => dt.some((x) => timesAgree(t, x)));
}

/** A subject with no name of its own: "the carrier", "the toymaker", "the agency". */
function isDescription(s: Subject): boolean {
  return !s.pronoun && !s.proper && s.names.length === 0 && !s.ownerPronoun && !s.contrast && !s.indefinite && s.words.length > 0 && s.words.length <= 3;
}

/**
 * Whether passage subject `other` may be the claim's subject, for a denial
 * shown for review — never for proof, which takes `subjectMatches`:
 *
 *  - the same subject, or a certain reference to it (`subjectMatches`);
 *  - a pronoun that does not resolve to a provably different subject, or
 *    the same pronoun as the claim's ("… and it paid a dividend");
 *  - a description with no name of its own ("the carrier", "the toymaker")
 *    in a passage that names the claim's subject and no provably different
 *    one: a head-noun alias;
 *  - a name for the claim's own description ("The Food and Drug
 *    Administration" for the claim's "the agency"), the one name the passage
 *    gives: a claim-side alias.
 */
function mayBeClaimSubject(claimSubject: Subject, other: Subject, named: readonly Subject[]): boolean {
  if (subjectMatches(claimSubject, other, named, [])) return true;
  if (other.contrast || other.indefinite) return false;
  if (other.pronoun) {
    if (claimSubject.pronoun === other.pronoun) return true;
    if (other.key === other.pronoun) return true;
    const antecedent: Subject = { ...other, pronoun: null };
    const owner = possessorOf(claimSubject);
    return subjectsEqual(claimSubject, antecedent) || !provablyDifferent(claimSubject, antecedent) || (!!owner && subjectsEqual(owner, antecedent));
  }
  const others = (than: Subject) => named.filter((s) => s.proper && !subjectsEqual(s, than) && provablyDifferent(than, s));
  // A name that opens the claim ("Proseware recalled its fans") is as much a name as one in mid-sentence: its capitals
  // are no evidence, but the passage naming it as a subject is.
  if (isDescription(other) && (claimSubject.proper || claimSubject.names.length > 0)) {
    return named.some((s) => subjectsEqual(s, claimSubject)) && others(claimSubject).length === 0;
  }
  if (isDescription(claimSubject) && other.proper) return others(other).length === 0;
  return false;
}

/**
 * A statement of the passage that may deny the claim but cannot be proved to
 * (the "needs review" half of the rule): one with the opposite polarity whose
 * subject may be the claim's (`mayBeClaimSubject`: the subject itself, a
 * pronoun, a head-noun alias, a claim-side alias, one subject of "neither …
 * nor", "except" or "but not", "nor did X"), about the same occasion (no
 * conflicting time or place), sharing the claim's verb, a verb the claim
 * names in its predicate ("went on strike" / "did not strike"), or two of its
 * content words — "The trial was not designed to assess long-term safety"
 * against "The trial showed the drug is safe in the long term". Null when the
 * passage also states the claim as the claim does, or when nothing like that
 * is there. Never a contradiction: the judge decides, and the reader is shown
 * the sentence.
 */
export function findUnresolvedDenial(claim: string, passage: string): string | null {
  const claimRead = readPropositions(claim);
  const passageRead = readPropositions(passage);
  const named = passageRead.subjects;
  for (const p of claimRead.props) {
    if (!p.certain || !p.asserted || !p.verb || !p.subject) continue;
    if (passageRead.props.some((d) => sameStatement(p, d, named))) continue;
    const claimStems = overlapStems(p);
    for (const raw of passageRead.props) {
      const n = inClaimVerb(p, raw);
      if (!n.asserted || n.negated === p.negated || !n.subject || !n.verb) continue;
      const exact = subjectMatches(p.subject, n.subject, named, []);
      if (!exact && !mayBeClaimSubject(p.subject, n.subject, named)) continue;
      // A subject that only may be the claim's needs the claim's object too: "it never cut its workforce" says
      // nothing about the marketing budget the claim says it cut.
      if (!exact && p.object.length > 0 && n.object.length > 0 && !p.object.some((w) => n.object.includes(w))) continue;
      const pt = meaningfulTimes(p);
      const nt = meaningfulTimes(n);
      if (pt.some((t) => nt.some((x) => timeKind(x) === timeKind(t)) && !nt.some((x) => timesAgree(t, x)))) continue;
      if (p.pps.some((pp) => n.pps.some((x) => x.prep === pp.prep) && !n.pps.some((x) => x.prep === pp.prep && (subset(pp.stems, x.stems) || subset(x.stems, pp.stems))))) continue;
      const passageStems = overlapStems(n);
      const shared = [...passageStems].filter((w) => claimStems.has(w)).length;
      const verbInPredicate = claimStems.has(stemOf(n.verb)) || passageStems.has(stemOf(p.verb));
      if (n.verb === p.verb || synonyms(n.verb, p.verb) || verbInPredicate || shared >= 2) return raw.text;
    }
  }
  return null;
}

export interface PolarityProof {
  /** The claim proposition the passage denies. */
  claim: string;
  /** The passage proposition that denies it. */
  passage: string;
}

/**
 * The conservative polarity contradiction: the passage proposition that
 * denies one of the claim's propositions beyond doubt, or null. See the file
 * comment for the rule.
 */
export function provePolarityContradiction(claim: string, passage: string): PolarityProof | null {
  const claimRead = readPropositions(claim);
  const passageRead = readPropositions(passage);
  const named = passageRead.subjects;
  for (const p of claimRead.props) {
    if (!p.certain || !p.asserted || !p.verb || !p.subject) continue;
    const proofs = passageRead.props.filter((c) => exactOpposite(p, c, named, claimRead.subjects));
    if (proofs.length === 0) continue;
    const doubt = passageRead.props.some((d) => !proofs.includes(d) && plausiblyStates(p, d, named));
    if (!doubt) return { claim: p.text, passage: proofs[0]!.text };
  }
  return null;
}
