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
 * and quotes in English, French, German, Spanish, Italian, Portuguese,
 * Japanese and Chinese (the micro-query is written in the language the signal
 * was found in, since that is the language the record is indexed in); the
 * entity is a known entity the claim names, else the nearest capitalised name,
 * else the site the quote came from; and every lead is deduplicated against
 * the searches the run already made. A model's leads (`auditAssist`, one
 * cheap call per round, for languages and phrasings the patterns miss) and
 * the workers' own suggested follow-ups ride along, filtered the same way.
 * Pure and client-safe.
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

/** The languages lead signals are written for (ISO 639-1). */
export const LEAD_LANGUAGES = ["en", "fr", "de", "es", "it", "pt", "ja", "zh"] as const;
export type LeadLanguage = (typeof LEAD_LANGUAGES)[number];

/** Alternatives that start at a letter boundary (accents included), case-insensitive. */
function words(...alternatives: string[]): RegExp {
  return new RegExp(`(?<!\\p{L})(?:${alternatives.join("|")})`, "iu");
}
/** Chinese and Japanese: no word boundaries to anchor on. */
function cjk(...alternatives: string[]): RegExp {
  return new RegExp(alternatives.join("|"), "u");
}

interface Signal {
  signal: string;
  tests: Partial<Record<LeadLanguage, RegExp>> & { en: RegExp };
  /** The micro-query's words, in the language the finding was written in. */
  terms: Record<LeadLanguage, string>;
}

/**
 * What a page can reveal that the plan could not have known to ask, in the
 * languages the sources are written in, and the words a micro-query uses for
 * it. English first: an English match wins on mixed text.
 */
const SIGNALS: Signal[] = [
  {
    signal: "deprecation",
    tests: {
      en: /\b(?:deprecat\w*|sunset\w*|end[- ]of[- ](?:life|support)|EOL|retir(?:ed|ing|ement)|discontinu\w*|phased? out)\b/i,
      fr: words("obsol[eè]te", "d[ée]pr[ée]ci[ée]", "fin de (?:vie|support|commercialisation)", "abandonn[ée]", "retir[ée]", "n'est plus (?:pris en charge|support[ée])", "sera supprim[ée]", "arr[êe]t (?:du service|de)"),
      de: words("veraltet", "eingestellt", "einstellung", "abgek[üu]ndigt", "abk[üu]ndigung", "end-of-life", "support-ende", "nicht mehr unterst[üu]tzt", "wird entfernt", "l[äa]uft aus"),
      es: words("obsolet[oa]", "en desuso", "descontinuad[oa]", "fin de (?:vida|soporte)", "dejar[áa] de", "retirad[oa]", "deprecad[oa]"),
      it: words("deprecat[oaie]", "obsolet[oaie]", "dismess[oaie]", "fine (?:del )?(?:supporto|vita)", "non pi[ùu] supportat[oaie]", "ritirat[oaie]", "verr[àa] rimoss[oa]"),
      pt: words("obsolet[oa]", "descontinuad[oa]", "fim d[eo] (?:vida|suporte)", "deixar[áa] de", "n[ãa]o ser[áa] mais suportad[oa]", "depreciad[oa]", "removid[oa]"),
      ja: cjk("非推奨", "廃止", "サポート終了", "提供終了", "終了予定", "段階的に廃止"),
      zh: cjk("弃用", "棄用", "废弃", "停用", "停止支持", "终止支持", "下线", "停止服务", "淘汰"),
    },
    terms: { en: "deprecation date migration", fr: "date de fin migration", de: "Abkündigung Datum Migration", es: "fecha de retirada migración", it: "data dismissione migrazione", pt: "data de descontinuação migração", ja: "廃止 日付 移行", zh: "弃用 日期 迁移" },
  },
  {
    signal: "pricing change",
    tests: {
      en: /\b(?:price (?:increase|hike|change)s?|pricing change\w*|new pricing|now (?:costs?|charges?)|(?:raised|cut|lowered) (?:its |the )?prices?)\b/i,
      fr: words("hausse (?:des|de) (?:prix|tarifs?)", "augmentation (?:des|de) (?:prix|tarifs?)", "nouveaux tarifs", "nouvelle tarification", "changement de (?:prix|tarif)", "baisse (?:des|de) prix"),
      de: words("preiserh[öo]hung", "preis[äa]nderung", "neue preise", "preissenkung", "erh[öo]ht (?:die )?preise", "kostet (?:jetzt|nun)"),
      es: words("subida de(?:l)? precio", "aumento de(?:l)? precio", "nuevos precios", "cambio de precio", "bajada de precio", "nueva tarifa", "ahora cuesta"),
      it: words("aumento (?:di|dei) prezz[oi]", "nuovi prezzi", "cambio di prezzo", "variazione di prezzo", "rincar[oi]", "ora costa"),
      pt: words("aumento d[eo]s? pre[çc]os?", "novos pre[çc]os", "mudan[çc]a de pre[çc]o", "reajuste", "agora custa"),
      ja: cjk("値上げ", "値下げ", "価格改定", "料金改定", "新料金"),
      zh: cjk("涨价", "降价", "调价", "价格调整", "新定价", "价格变动"),
    },
    terms: { en: "pricing change effective date", fr: "changement de prix date d'effet", de: "Preisänderung gültig ab", es: "cambio de precio fecha efectiva", it: "variazione prezzo data di decorrenza", pt: "mudança de preço data de vigência", ja: "価格改定 適用日", zh: "价格调整 生效日期" },
  },
  {
    signal: "new tier",
    tests: {
      en: /\b(?:new|introduc\w*|launch\w*|announc\w*|added)\b[^.]{0,60}\b(?:tier|plan|edition|SKU)\b/i,
      fr: words("(?:nouveau|nouvelle|lance|lancement|introduit|annonce)[^.]{0,60}(?<!\\p{L})(?:offre|forfait|formule|abonnement|niveau|plan|[ée]dition)"),
      de: words("(?:neue[nrs]?|f[üu]hrt|eingef[üu]hrt|startet|angek[üu]ndigt)[^.]{0,60}(?:tarif|plan|abo|stufe|edition|paket)"),
      es: words("(?:nuev[oa]|lanza|lanzamiento|introduce|anuncia)[^.]{0,60}(?<!\\p{L})(?:plan|nivel|edici[óo]n|tarifa|suscripci[óo]n)"),
      it: words("(?:nuov[oa]|lancia|lancio|introduce|annuncia)[^.]{0,60}(?<!\\p{L})(?:piano|livello|edizione|abbonamento|tariffa)"),
      pt: words("(?:nov[oa]|lan[çc]a|lan[çc]amento|introduz|anuncia)[^.]{0,60}(?<!\\p{L})(?:plano|n[íi]vel|edi[çc][ãa]o|assinatura|tarifa)"),
      ja: cjk("新プラン", "新しいプラン", "新料金プラン", "プランを(?:追加|導入|発表)", "新エディション"),
      zh: cjk("新套餐", "推出[^。]{0,20}(?:套餐|版本|计划|方案)", "新增[^。]{0,10}(?:套餐|档位)", "新档位"),
    },
    terms: { en: "plan tier limits pricing", fr: "offre limites tarif", de: "Tarif Limits Preis", es: "plan límites precio", it: "piano limiti prezzo", pt: "plano limites preço", ja: "プラン 制限 料金", zh: "套餐 限制 价格" },
  },
  {
    signal: "rate limit",
    tests: {
      en: /\b(?:rate[- ]limit\w*|requests per (?:minute|second|hour|day)|RPM|TPM|tokens per minute|quota\w*|throttl\w*|usage cap\w*)\b/i,
      fr: words("limites? de d[ée]bit", "limites? d'utilisation", "quotas?", "requ[êe]tes par (?:minute|seconde|heure|jour)", "bridage"),
      de: words("ratenlimit", "rate-limit", "nutzungslimit", "kontingent", "anfragen pro (?:minute|sekunde|stunde|tag)", "drosselung", "gedrosselt"),
      es: words("l[íi]mites? de (?:tasa|uso|velocidad|solicitudes)", "cuotas?", "solicitudes por (?:minuto|segundo|hora|d[íi]a)", "limitaci[óo]n de uso"),
      it: words("limit[ei] di (?:velocit[àa]|utilizzo|richieste)", "quot[ae] di utilizzo", "richieste (?:al|per) (?:minuto|secondo|ora|giorno)"),
      pt: words("limites? de (?:taxa|uso|requisi[çc][õo]es)", "cotas?", "(?:requisi[çc][õo]es|solicita[çc][õo]es) por (?:minuto|segundo|hora|dia)"),
      ja: cjk("レート制限", "利用制限", "使用制限", "クォータ", "リクエスト数の上限", "1分あたり"),
      zh: cjk("速率限制", "限流", "调用限制", "配额", "每分钟请求", "用量上限"),
    },
    terms: { en: "rate limits quota tiers", fr: "limites de débit quotas", de: "Ratenlimits Kontingente", es: "límites de tasa cuotas", it: "limiti di velocità quote", pt: "limites de taxa cotas", ja: "レート制限 クォータ", zh: "速率限制 配额" },
  },
  {
    signal: "incident",
    tests: {
      en: /\b(?:outage\w*|incident\w*|downtime|degraded (?:performance|service)|post-?mortem|data breach|security vulnerabilit\w*|CVE-\d{4}-\d+)\b/i,
      fr: words("panne", "incident", "interruption de service", "indisponibilit[ée]", "fuite de donn[ée]es", "faille de s[ée]curit[ée]", "vuln[ée]rabilit[ée]"),
      de: words("ausfall", "st[öo]rung", "vorfall", "datenleck", "sicherheitsl[üu]cke", "schwachstelle", "datenpanne"),
      es: words("ca[íi]da del servicio", "interrupci[óo]n del servicio", "incidente", "fuga de datos", "brecha de (?:datos|seguridad)", "vulnerabilidad"),
      it: words("interruzione (?:del|di) servizio", "disservizio", "incidente", "violazione dei dati", "falla di sicurezza", "vulnerabilit[àa]"),
      pt: words("interrup[çc][ãa]o do servi[çc]o", "indisponibilidade", "incidente", "vazamento de dados", "falha de seguran[çc]a", "vulnerabilidade"),
      ja: cjk("障害", "システム停止", "不具合", "情報漏えい", "情報漏洩", "脆弱性", "インシデント"),
      zh: cjk("故障", "宕机", "服务中断", "事故", "数据泄露", "漏洞", "安全事件"),
    },
    terms: { en: "incident postmortem", fr: "incident rapport post-mortem", de: "Störung Ursachenanalyse", es: "incidente informe postmortem", it: "incidente rapporto post-mortem", pt: "incidente relatório postmortem", ja: "障害 報告 原因", zh: "故障 事故报告" },
  },
  {
    signal: "legal or regulatory",
    tests: {
      en: /\b(?:lawsuit\w*|class action|sued|fined|antitrust|regulator\w*|investigation|consent decree|injunction)\b/i,
      fr: words("proc[èe]s", "poursuites? judiciaires?", "action (?:collective|de groupe)", "amende", "condamn[ée]", "enqu[êe]te", "autorit[ée] de la concurrence", "r[ée]gulateur"),
      de: words("klage", "verklagt", "sammelklage", "bu[ßs]geld", "geldbu[ßs]e", "ermittlung", "kartellamt", "regulierungsbeh[öo]rde", "aufsichtsbeh[öo]rde"),
      es: words("demanda (?:judicial|colectiva)", "demand[óo]", "demandad[oa]", "acci[óo]n colectiva", "multa", "multad[oa]", "investigaci[óo]n", "regulador", "sanci[óo]n"),
      it: words("fatto causa", "azione collettiva", "class action", "multa", "multat[oa]", "sanzion[ei]", "indagine", "autorit[àa] garante", "antitrust"),
      pt: words("processo judicial", "a[çc][ãa]o (?:judicial|coletiva)", "processad[oa]", "multa", "multad[oa]", "investiga[çc][ãa]o", "regulador", "san[çc][ãa]o"),
      ja: cjk("訴訟", "提訴", "集団訴訟", "罰金", "制裁金", "規制当局", "独占禁止法"),
      zh: cjk("诉讼", "起诉", "集体诉讼", "罚款", "监管机构", "反垄断", "立案调查"),
    },
    terms: { en: "lawsuit regulator filing", fr: "procès régulateur décision", de: "Klage Behörde Entscheidung", es: "demanda regulador resolución", it: "causa autorità decisione", pt: "processo regulador decisão", ja: "訴訟 規制当局", zh: "诉讼 监管 文件" },
  },
  {
    signal: "user backlash",
    tests: {
      en: /\b(?:backlash|complain\w*|user revolt|petition|boycott|users (?:report|say|are reporting)|GitHub issue)\b/i,
      fr: words("m[ée]contentement", "plaintes? des utilisateurs", "col[èe]re des utilisateurs", "p[ée]tition", "boycott", "les utilisateurs se plaignent"),
      de: words("kritik der nutzer", "nutzer beschweren", "beschwerden", "unmut", "petition", "boykott", "shitstorm"),
      es: words("quejas", "los usuarios se quejan", "indignaci[óo]n", "petici[óo]n", "boicot", "cr[íi]ticas de (?:los )?usuarios"),
      it: words("lamentele", "gli utenti si lamentano", "proteste", "petizione", "boicottaggio"),
      pt: words("reclama[çc][õo]es", "usu[áa]rios reclamam", "revolta", "peti[çc][ãa]o", "boicote", "cr[íi]ticas de usu[áa]rios"),
      ja: cjk("不満", "苦情", "炎上", "反発", "ボイコット"),
      zh: cjk("不满", "投诉", "抱怨", "抵制", "用户反弹", "差评"),
    },
    terms: { en: "user complaints GitHub issues", fr: "plaintes utilisateurs problèmes", de: "Nutzerbeschwerden Probleme", es: "quejas usuarios problemas", it: "lamentele utenti problemi", pt: "reclamações usuários problemas", ja: "ユーザー 不満 問題", zh: "用户 投诉 问题" },
  },
  {
    signal: "preview status",
    tests: {
      en: /\b(?:beta|public preview|private preview|waitlist|early access|experimental)\b/i,
      fr: words("b[êe]ta", "version pr[ée]liminaire", "aper[çc]u public", "liste d'attente", "acc[èe]s anticip[ée]", "exp[ée]rimental"),
      de: words("beta", "vorschau", "warteliste", "fr[üu]her zugang", "experimentell"),
      es: words("beta", "vista previa", "lista de espera", "acceso anticipado", "experimental"),
      it: words("beta", "anteprima", "lista d'attesa", "accesso anticipato", "sperimentale"),
      pt: words("beta", "pr[ée]via", "pr[ée]-visualiza[çc][ãa]o", "lista de espera", "acesso antecipado", "experimental"),
      ja: cjk("ベータ", "プレビュー版", "試験運用", "先行アクセス", "ウェイトリスト", "実験的"),
      zh: cjk("测试版", "公测", "内测", "预览版", "候补名单", "抢先体验", "实验性"),
    },
    terms: { en: "general availability date", fr: "disponibilité générale date", de: "allgemeine Verfügbarkeit Datum", es: "disponibilidad general fecha", it: "disponibilità generale data", pt: "disponibilidade geral data", ja: "一般提供 開始日", zh: "正式发布 日期" },
  },
  {
    signal: "architecture change",
    tests: {
      en: /\b(?:architecture change|re-?architect\w*|migrat(?:ed|ion) to|replac(?:ed|es) (?:the|its)|new (?:model|engine|backend))\b/i,
      fr: words("changement d'architecture", "migr[ée] vers", "migration vers", "remplac[ée]e? (?:le|la|son|sa)", "nouveau (?:moteur|mod[èe]le)"),
      de: words("architektur[äa]nderung", "umgestellt auf", "migration auf", "ersetzt (?:den|die|das)", "neue engine", "neues modell"),
      es: words("cambio de arquitectura", "migr[óo] a", "migraci[óo]n a", "reemplaz[aó] (?:el|la|su)", "nuevo (?:motor|modelo)"),
      it: words("cambio di architettura", "migrazione a", "migrat[oa] a", "sostituisce (?:il|la|lo)", "nuovo (?:motore|modello)"),
      pt: words("mudan[çc]a de arquitetura", "migra[çc][ãa]o para", "migrou para", "substitui (?:o|a)", "novo (?:motor|modelo)"),
      ja: cjk("アーキテクチャ変更", "刷新", "新エンジン", "新モデル", "置き換え"),
      zh: cjk("架构调整", "架构变更", "迁移到", "迁移至", "新引擎", "新模型"),
    },
    terms: { en: "architecture change announcement", fr: "changement d'architecture annonce", de: "Architekturänderung Ankündigung", es: "cambio de arquitectura anuncio", it: "cambio di architettura annuncio", pt: "mudança de arquitetura anúncio", ja: "アーキテクチャ変更 発表", zh: "架构变更 公告" },
  },
  {
    signal: "terms change",
    tests: {
      en: /\b(?:terms of (?:service|use)|data retention|train(?:s|ing)? on (?:customer|user) data|opt[- ]out|indemnif\w*|SLA)\b/i,
      fr: words("conditions (?:g[ée]n[ée]rales|d'utilisation)", "conservation des donn[ée]es", "entra[îi]n\\p{L}* sur les donn[ée]es", "d[ée]sinscription", "indemnisation"),
      de: words("nutzungsbedingungen", "agb", "datenaufbewahrung", "aufbewahrungsfrist", "training mit (?:kunden|nutzer)daten", "freistellung"),
      es: words("t[ée]rminos de (?:servicio|uso)", "retenci[óo]n de datos", "entrena\\p{L}* con (?:los )?datos", "exclusi[óo]n voluntaria", "indemnizaci[óo]n"),
      it: words("termini di (?:servizio|utilizzo)", "conservazione dei dati", "addestra\\p{L}* sui dati", "indennizzo"),
      pt: words("termos de (?:servi[çc]o|uso)", "reten[çc][ãa]o de dados", "trein\\p{L}* com (?:os )?dados", "exclus[ãa]o volunt[áa]ria", "indeniza[çc][ãa]o"),
      ja: cjk("利用規約", "データ保持", "学習に(?:利用|使用)", "オプトアウト"),
      zh: cjk("服务条款", "使用条款", "数据保留", "用于训练", "赔偿"),
    },
    terms: { en: "terms data retention policy", fr: "conditions conservation des données", de: "Bedingungen Datenaufbewahrung", es: "términos retención de datos", it: "termini conservazione dei dati", pt: "termos retenção de dados", ja: "利用規約 データ保持", zh: "条款 数据保留 政策" },
  },
];

/** Function words that give a Latin-script text's language away. */
const STOPWORDS: Record<Exclude<LeadLanguage, "ja" | "zh">, RegExp> = {
  en: /(?<!\p{L})(?:the|and|of|to|is|with|for|will|has|from|this)(?!\p{L})/giu,
  fr: /(?<!\p{L})(?:le|la|les|des|est|et|une|du|pour|avec|sera|dans)(?!\p{L})/giu,
  de: /(?<!\p{L})(?:der|die|das|und|ist|mit|nicht|wird|für|ein|eine|auf)(?!\p{L})/giu,
  es: /(?<!\p{L})(?:el|los|las|del|es|y|una|para|con|por|será|que)(?!\p{L})/giu,
  it: /(?<!\p{L})(?:il|gli|della|di|è|e|una|per|con|sarà|che|non)(?!\p{L})/giu,
  pt: /(?<!\p{L})(?:os|as|do|da|é|e|uma|para|com|será|não|que)(?!\p{L})/giu,
};

/** The text's language among the lead languages, or null when it does not say. */
export function guessLanguage(text: string): LeadLanguage | null {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja";
  if (/\p{Script=Han}/u.test(text)) return "zh";
  let best: LeadLanguage | null = null;
  let bestHits = 1;
  for (const [language, pattern] of Object.entries(STOPWORDS) as Array<[LeadLanguage, RegExp]>) {
    const hits = text.slice(0, 2_000).match(pattern)?.length ?? 0;
    if (hits > bestHits) {
      best = language;
      bestHits = hits;
    }
  }
  return best;
}

/**
 * The first signal a text carries, and the language it was found in: the
 * text's own language is tried first (a Spanish "incidente" is a Spanish
 * signal, not the English "incident"), then the report's, then English.
 */
export function detectSignal(text: string, prefer: readonly LeadLanguage[] = []): { signal: Signal; language: LeadLanguage } | null {
  const own = guessLanguage(text);
  const order: LeadLanguage[] = [...new Set<LeadLanguage>([...(own ? [own] : []), ...prefer, "en", ...LEAD_LANGUAGES])];
  for (const signal of SIGNALS) {
    for (const language of order) {
      const test = signal.tests[language];
      if (test && test.test(text)) return { signal, language };
    }
  }
  return null;
}

/** "fr-CA" → "fr", when it is a lead language. */
export function leadLanguageOf(tag: string | null | undefined): LeadLanguage | null {
  const base = (tag ?? "").toLowerCase().split(/[-_]/)[0] ?? "";
  return (LEAD_LANGUAGES as readonly string[]).includes(base) ? (base as LeadLanguage) : null;
}

const VERSION = /\bv?(\d+\.\d+(?:\.\d+)?)\b/;
const YEAR = /\b(20\d{2})\b/;
/** Capitalised names, joined across "of"/"for"/"&": "GitHub Copilot Business", "Claude 3.5 Sonnet". */
const NAME = /\b([A-Z][\w.+-]*(?:\s+(?:[A-Z][\w.+-]*|\d[\w.]*|of|for|&)){0,3})/g;
const NOT_NAMES = new Set([
  "The", "This", "That", "These", "Those", "It", "In", "On", "As", "At", "For", "From", "Starting", "Since", "After", "Before", "Users", "Our", "We", "Each", "All", "New", "According", "However", "When", "If",
  // Sentence openers and articles in the other lead languages.
  "Le", "La", "Les", "Un", "Une", "Des", "Depuis", "Selon", "Il", "Elle", "Ce", "Cette",
  "Der", "Die", "Das", "Ein", "Eine", "Seit", "Laut", "Ab", "Nutzer", "Kunden",
  "El", "Los", "Las", "Una", "Desde", "Según", "Los usuarios",
  "Lo", "Gli", "Uno", "Dal", "Dalla", "Secondo",
  "Os", "As", "Um", "Uma", "Segundo", "Desde",
]);

/**
 * The entity a claim is about: a known entity (a compared option, the run's
 * subject) the claim names, else its longest capitalised name, else the
 * source's site. Known entities come first because German capitalises every
 * noun, and "Preiserhöhung" is not who raised the price.
 */
export function entityOf(claim: string, url: string, known: readonly string[] = []): string {
  const lower = claim.toLowerCase();
  const named = known.filter((entity) => entity && lower.includes(entity.toLowerCase())).sort((a, b) => b.length - a.length)[0];
  if (named) return named;
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
  /** Entities the run is about (compared options, the subject), preferred when a finding names one. */
  entities?: readonly string[];
  /** The report's language, tried right after English when a finding matches several. */
  language?: string | null;
  /** Leads a model read out of findings the patterns missed (`auditAssist`); same filters, after the pattern ones. */
  modelLeads?: ReadonlyArray<{ objectiveId: string; query: string; signal: string; from: string }>;
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

  const prefer = leadLanguageOf(input.language);
  for (const finding of input.findings) {
    if (finding.round !== input.round || !finding.objectiveId) continue;
    const text = `${finding.claim} ${finding.quote}`;
    const hit = detectSignal(text, prefer ? [prefer] : []);
    if (!hit) continue;
    const entity = entityOf(finding.claim, finding.url, input.entities ?? []);
    if (!entity) continue;
    const version = VERSION.exec(finding.claim)?.[1];
    // A new tier is searched by its own name: "Cursor Ultra plan …".
    const tierName =
      hit.signal.signal === "new tier"
        ? /\b([A-Z][\w+-]*)\s+(?:plan|tier|edition)\b/.exec(finding.claim)?.[1] ??
          /(?<!\p{L})(?:plan|offre|forfait|tarif|piano|plano)\s+(\p{Lu}[\p{L}\d+-]*)/u.exec(finding.claim)?.[1]
        : undefined;
    const year = YEAR.exec(text)?.[1];
    offer({
      objectiveId: finding.objectiveId,
      query: [
        entity,
        tierName && !entity.includes(tierName) ? tierName : "",
        version && !entity.includes(version) ? version : "",
        // The source's own language: its records are indexed in it.
        hit.signal.terms[hit.language],
        year ?? "",
      ]
        .filter(Boolean)
        .join(" "),
      signal: hit.signal.signal,
      from: finding.url,
    });
  }
  for (const lead of input.modelLeads ?? []) {
    offer({ objectiveId: lead.objectiveId, query: lead.query, signal: lead.signal || "model lead", from: lead.from });
  }
  for (const suggestion of input.suggested ?? []) {
    offer({ objectiveId: suggestion.objectiveId, query: suggestion.query, signal: "worker follow-up", from: "" });
  }
  return out;
}
