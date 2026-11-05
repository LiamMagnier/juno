/**
 * Which inputs on a checkout page take which part of a card, decided from
 * what the page says about each input (its autocomplete token first, then its
 * name, id, placeholder and label). Pure: the computer fill path collects the
 * descriptors from every frame and asks this module where to type.
 *
 * Nothing here ever sees a card value, and nothing the page says is trusted
 * beyond choosing a field: a page that labels its search box "card number"
 * gets a number typed into its search box, which is why the person approved
 * the payment for this merchant and the card is single-use and capped.
 */

export type CardFieldKind = "number" | "exp" | "expMonth" | "expYear" | "cvc" | "name";

/** What the collection script reports for one `<input>` (by its index among the frame's inputs). */
export interface InputDescriptor {
  index: number;
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  placeholder: string;
  label: string;
  visible: boolean;
  disabled: boolean;
}

const AUTOCOMPLETE: Readonly<Record<string, CardFieldKind>> = {
  "cc-number": "number",
  "cc-exp": "exp",
  "cc-exp-month": "expMonth",
  "cc-exp-year": "expYear",
  "cc-csc": "cvc",
  "cc-name": "name",
};

const PATTERNS: ReadonlyArray<[CardFieldKind, RegExp]> = [
  ["number", /\b(card.?number|cardnumber|cc.?num(ber)?|credit.?card|card.?no|numero.?de.?carte)\b/i],
  ["cvc", /\b(cvc|cvv|cvv2|csc|cid|security.?code|card.?code|cryptogramme)\b/i],
  ["expMonth", /\b(exp(iry|iration)?.?month|cc.?month|card.?month|mois)\b/i],
  ["expYear", /\b(exp(iry|iration)?.?year|cc.?year|card.?year|ann[eé]e)\b/i],
  ["exp", /\b(exp(iry|iration)?(.?date)?|mm.?\/?.?yy|valid.?thru|date.?d.?expiration)\b/i],
  ["name", /\b(name.?on.?card|card.?holder|cardholder|cc.?name)\b/i],
];

const FILLABLE_TYPES = new Set(["", "text", "tel", "number", "password"]);

/** The kind of card part one input takes, or null. */
export function cardFieldKind(input: InputDescriptor): CardFieldKind | null {
  if (!input.visible || input.disabled) return null;
  if (!FILLABLE_TYPES.has(input.type.toLowerCase())) return null;
  for (const token of input.autocomplete.toLowerCase().split(/\s+/)) {
    const kind = AUTOCOMPLETE[token];
    if (kind) return kind;
  }
  const words = [input.name, input.id, input.placeholder, input.label]
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-[\]]+/g, " ");
  for (const [kind, pattern] of PATTERNS) if (pattern.test(words)) return kind;
  return null;
}

/** One input per kind, the first the page offers. */
export function planCardFields(inputs: readonly InputDescriptor[]): Map<CardFieldKind, number> {
  const plan = new Map<CardFieldKind, number>();
  for (const input of inputs) {
    const kind = cardFieldKind(input);
    if (kind && !plan.has(kind)) plan.set(kind, input.index);
  }
  return plan;
}

/** Whether the kinds found, across all frames, are enough to pay: a number, a CVC and an expiry. */
export function planIsComplete(kinds: ReadonlySet<CardFieldKind>): boolean {
  return kinds.has("number") && kinds.has("cvc") && (kinds.has("exp") || (kinds.has("expMonth") && kinds.has("expYear")));
}

/** The text typed into one kind of field. */
export function cardFieldValue(
  kind: CardFieldKind,
  details: { number: string; cvc: string; expMonth: number; expYear: number; name: string | null },
): string {
  const mm = String(details.expMonth).padStart(2, "0");
  const yyyy = String(details.expYear);
  switch (kind) {
    case "number":
      return details.number;
    case "cvc":
      return details.cvc;
    case "exp":
      return `${mm}/${yyyy.slice(-2)}`;
    case "expMonth":
      return mm;
    case "expYear":
      return yyyy;
    case "name":
      return details.name ?? "";
  }
}

/**
 * Runs inside each frame: describes every `<input>` without reading any
 * value. A string, not a function, for the same reason as
 * DESCRIBE_TARGET_SCRIPT in src/lib/computer/remote-browser.ts.
 */
export const COLLECT_CARD_INPUTS_SCRIPT = String.raw`(function () {
  var inputs = Array.prototype.slice.call(document.querySelectorAll("input"));
  return inputs.map(function (el, index) {
    var label = "";
    if (el.labels && el.labels.length) label = String(el.labels[0].textContent || "");
    if (!label) label = String(el.getAttribute("aria-label") || "");
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return {
      index: index,
      type: String(el.getAttribute("type") || "").toLowerCase(),
      autocomplete: String(el.getAttribute("autocomplete") || ""),
      name: String(el.getAttribute("name") || ""),
      id: String(el.id || ""),
      placeholder: String(el.getAttribute("placeholder") || ""),
      label: label.replace(/\s+/g, " ").trim().slice(0, 80),
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
      disabled: !!el.disabled || !!el.readOnly
    };
  });
})()`;

/** A descriptor from an untrusted page, checked field by field. */
export function readInputDescriptor(raw: unknown): InputDescriptor | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const str = (key: string) => (typeof value[key] === "string" ? (value[key] as string).slice(0, 200) : "");
  if (typeof value.index !== "number" || !Number.isInteger(value.index) || value.index < 0) return null;
  return {
    index: value.index,
    type: str("type"),
    autocomplete: str("autocomplete"),
    name: str("name"),
    id: str("id"),
    placeholder: str("placeholder"),
    label: str("label"),
    visible: value.visible === true,
    disabled: value.disabled === true,
  };
}
