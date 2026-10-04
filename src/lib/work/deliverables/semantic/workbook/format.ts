/**
 * Number formats: a safe subset of Excel's format codes, rendered the way
 * Excel renders them, so the canvas and the exported .xlsx show the same text.
 *
 * Stored as the Excel code itself (`#,##0.00`, `0.0%`, `"$"#,##0`,
 * `yyyy-mm-dd`) because that is what the file carries and what a person who
 * opens it will see in Format Cells. The named aliases are what the model is
 * told to write; they expand to codes on the way in.
 */

import type { Value } from "@/lib/work/deliverables/semantic/workbook/formula";
import { formatGeneral, isError } from "@/lib/work/deliverables/semantic/workbook/formula";

export const FORMAT_ALIASES: Record<string, string> = {
  general: "General",
  text: "@",
  number: "#,##0.00",
  integer: "#,##0",
  currency: '"$"#,##0.00',
  usd: '"$"#,##0.00',
  eur: '"€"#,##0.00',
  gbp: '"£"#,##0.00',
  percent: "0.0%",
  date: "yyyy-mm-dd",
  month: "mmm yyyy",
};

/**
 * The codes accepted: digits placeholders, separators, percent, literal text
 * in quotes, currency symbols, a scale suffix and date tokens. No colours,
 * conditions or sections — a format is display, and a code this module cannot
 * render faithfully would make the canvas and Excel disagree.
 */
const NUMERIC_CODE = /^(?:"[^"]{0,8}"|[$€£¥])?[#0,]*0(?:\.0{1,10})?%?(?:"[^"]{0,12}")?$/;
const DATE_CODE = /^(?:yyyy|yy|mmmm|mmm|mm|m|dd|d|[-/ .,])+$/;

export function resolveFormat(input: string): string | null {
  const trimmed = input.trim();
  const alias = FORMAT_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  if (trimmed === "General" || trimmed === "@") return trimmed;
  if (NUMERIC_CODE.test(trimmed) || DATE_CODE.test(trimmed)) return trimmed;
  // "$#,##0.00" written without quotes is common and unambiguous.
  return null;
}

export function isDateFormat(code: string): boolean {
  return DATE_CODE.test(code) && /[dmy]/.test(code);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Excel serial (1900 system, the 1900 leap-year bug folded in) -> UTC date. */
export function serialToDate(serial: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000));
}

export function dateToSerial(date: Date): number {
  return (date.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;
}

function formatDate(serial: number, code: string): string {
  const date = serialToDate(serial);
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  return code.replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d/g, (token) => {
    switch (token) {
      case "yyyy": return String(y);
      case "yy": return String(y).slice(-2);
      case "mmmm": return MONTHS[m];
      case "mmm": return MONTHS[m].slice(0, 3);
      case "mm": return String(m + 1).padStart(2, "0");
      case "m": return String(m + 1);
      case "dd": return String(d).padStart(2, "0");
      default: return String(d);
    }
  });
}

function formatNumber(value: number, code: string): string {
  const prefixMatch = /^(?:"([^"]*)"|([$€£¥]))/.exec(code);
  const prefix = prefixMatch ? (prefixMatch[1] ?? prefixMatch[2]) : "";
  let rest = prefixMatch ? code.slice(prefixMatch[0].length) : code;
  const suffixMatch = /"([^"]*)"$/.exec(rest);
  const suffix = suffixMatch ? suffixMatch[1] : "";
  if (suffixMatch) rest = rest.slice(0, -suffixMatch[0].length);
  const percent = rest.endsWith("%");
  if (percent) rest = rest.slice(0, -1);
  const decimals = rest.includes(".") ? rest.split(".")[1].length : 0;
  const grouped = rest.includes(",");
  const scaled = percent ? value * 100 : value;
  const fixed = Math.abs(scaled).toFixed(decimals);
  const [whole, fraction] = fixed.split(".");
  const wholeText = grouped ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
  const negative = scaled < 0 && Number(fixed) !== 0;
  return `${negative ? "-" : ""}${prefix}${wholeText}${fraction ? `.${fraction}` : ""}${percent ? "%" : ""}${suffix}`;
}

/** The text a cell shows. */
export function formatValue(value: Value, code?: string | null): string {
  if (isError(value)) return value.error;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") return value;
  if (!code || code === "General" || code === "@") return formatGeneral(value);
  if (isDateFormat(code)) return formatDate(value, code);
  return formatNumber(value, code);
}
