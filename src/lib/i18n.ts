const DEFAULT_LOCALE = "en";

// ISO 639-1 languages used by standard browser locale tags. Region/script
// subtags (pt-BR, zh-Hant, etc.) are preserved after the language is checked.
const WEB_LANGUAGES = new Set(
  "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu".split(" "),
);

const LEGACY_LANGUAGE_ALIASES: Record<string, string> = {
  in: "id",
  iw: "he",
  ji: "yi",
};

const RTL_LANGUAGES = new Set(["ar", "dv", "fa", "he", "ku", "ps", "sd", "ug", "ur", "yi"]);

function canonicalLocale(candidate: string): string | null {
  const cleaned = candidate.trim().replace(/_/g, "-");
  if (!cleaned || cleaned === "*") return null;
  try {
    const locale = new Intl.Locale(cleaned);
    const language = LEGACY_LANGUAGE_ALIASES[locale.language.toLowerCase()] ?? locale.language.toLowerCase();
    if (!WEB_LANGUAGES.has(language)) return null;
    const parts = [language];
    if (locale.script) parts.push(locale.script);
    if (locale.region) parts.push(locale.region);
    return parts.join("-");
  } catch {
    return null;
  }
}

/** Resolve the browser's ordered Accept-Language header to a safe web locale. */
export function localeFromAcceptLanguage(header: string | null | undefined): string {
  if (!header) return DEFAULT_LOCALE;
  const requested = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.find((param) => param.trim().startsWith("q="));
      const q = qParam ? Number(qParam.trim().slice(2)) : 1;
      return { tag, q: Number.isFinite(q) ? q : 0, index };
    })
    .sort((a, b) => b.q - a.q || a.index - b.index);

  for (const { tag, q } of requested) {
    if (q <= 0) continue;
    const locale = canonicalLocale(tag);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

/** Validate a locale supplied to an API route. */
export function normalizeWebLocale(value: string | null | undefined): string | null {
  return value ? canonicalLocale(value) : null;
}

export function languageOf(locale: string): string {
  return locale.split("-")[0]?.toLowerCase() || DEFAULT_LOCALE;
}

export function directionOf(locale: string): "ltr" | "rtl" {
  return RTL_LANGUAGES.has(languageOf(locale)) ? "rtl" : "ltr";
}

export function localeDisplayName(locale: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}
