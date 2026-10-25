/**
 * Two validators that use a second, unrelated implementation to read files:
 *
 *   pdf            text and page count through pdf.js (unpdf).
 *   office_reopen  LibreOffice, headless, opens the deliverable the way a
 *                  person's office suite would: a Word/PowerPoint file is
 *                  rendered to PDF (its page count checked, the PDF kept for
 *                  the human reviewer), and a workbook is RECALCULATED from
 *                  scratch and exported, so a formula whose cached value
 *                  disagrees with what it computes is caught.
 *
 * The import filter is named explicitly (Word 2007+ XML, PowerPoint 2007+
 * XML, Excel 2007+ XML). Without it LibreOffice guesses from the content and
 * falls back to a plain-text import, so a text file renamed memo.docx would
 * "reopen" and render. With it, anything that is not a real OOXML package of
 * the declared kind fails to load.
 *
 * The documents come from untrusted products, and LibreOffice has had
 * document-triggered code execution and external-link bugs. So soffice runs
 * in the same sandbox as delivered code (./sandbox.ts): no network, its own
 * filesystem view (system directories and LibreOffice's own configuration
 * read-only, a scratch copy of the one file writable, a private /tmp), its
 * own PID namespace, no capabilities, and a minimal environment (PATH, HOME
 * set to the scratch directory, LANG) so no provider key or token is in
 * reach. Where the sandbox cannot be built the check is `not_run` and the
 * file is not opened, unless the operator passes --unsafe-office on a
 * disposable machine.
 *
 * When LibreOffice is not installed the reopen check is `not_run`, which keeps
 * the run `unverified` — it never passes by default.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CheckResult, ValidatorSpec } from "../types";
import { detectSandbox, runSandboxed, underSystemDir, type SandboxStatus } from "./sandbox";
import { fail, matches, notRun, openPackage, pass, patternLabel, readOutput } from "./util";
import { readWorkbook } from "./xlsx";

type Spec<K extends ValidatorSpec["kind"]> = Extract<ValidatorSpec, { kind: K }>;

export async function pdfText(bytes: Uint8Array): Promise<{ pages: string[] }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: false });
  return { pages: Array.isArray(text) ? text : [text] };
}

export async function validatePdf(spec: Spec<"pdf">, outputsDir: string): Promise<CheckResult[]> {
  const id = (what: string) => `pdf:${spec.file}:${what}`;
  let bytes: Buffer;
  try {
    bytes = readOutput(outputsDir, spec.file);
  } catch (error) {
    return [fail(id("exists"), (error as Error).message)];
  }
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return [fail(id("header"), "not a PDF (no %PDF- header)")];
  let pages: string[];
  try {
    ({ pages } = await pdfText(bytes));
  } catch (error) {
    return [fail(id("parse"), `pdf.js could not open it: ${(error as Error).message}`)];
  }
  const checks: CheckResult[] = [pass(id("parse"), `${pages.length} page(s)`)];
  if (spec.pages) {
    const ok = (spec.pages.min === undefined || pages.length >= spec.pages.min) && (spec.pages.max === undefined || pages.length <= spec.pages.max);
    checks.push(ok ? pass(id("pages"), `${pages.length}`) : fail(id("pages"), `${pages.length} page(s), expected ${spec.pages.min ?? 1}–${spec.pages.max ?? "∞"}`));
  }
  const all = pages.join("\n");
  checks.push(all.replace(/\s/g, "").length > 0 ? pass(id("text-layer"), "has a text layer") : fail(id("text-layer"), "no extractable text (scanned or image-only)"));
  for (const pattern of spec.requiredText ?? []) {
    checks.push(matches(all, pattern) ? pass(id(`text:${patternLabel(pattern)}`), "present") : fail(id(`text:${patternLabel(pattern)}`), "missing"));
  }
  return checks;
}

// ---------------------------------------------------------------------------
// LibreOffice
// ---------------------------------------------------------------------------

export function findSoffice(): string | null {
  const configured = process.env.BENCH_SOFFICE;
  if (configured) return existsSync(configured) ? configured : null;
  for (const candidate of ["/usr/bin/soffice", "/usr/local/bin/soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice", "/opt/homebrew/bin/soffice"]) {
    if (existsSync(candidate)) return candidate;
  }
  const which = spawnSync("sh", ["-c", "command -v soffice || command -v libreoffice"], { encoding: "utf8" });
  const found = which.stdout.trim();
  return which.status === 0 && found ? found : null;
}

export function sofficeVersion(soffice: string | null): string | null {
  if (!soffice) return null;
  const run = spawnSync(soffice, ["--version"], { encoding: "utf8", timeout: 60_000 });
  return run.status === 0 ? run.stdout.trim().split("\n")[0] : null;
}

/** A throwaway profile that recalculates every formula on load (Excel and ODF files alike). */
function recalcProfile(dir: string): string {
  const user = path.join(dir, "profile", "user");
  mkdirSync(user, { recursive: true });
  writeFileSync(
    path.join(user, "registrymodifications.xcu"),
    `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>
`
  );
  return `file://${path.join(dir, "profile")}`;
}

/** LibreOffice import filters, so a file can only open as what it claims to be. */
export const IMPORT_FILTERS: Record<"docx" | "xlsx" | "pptx", string> = {
  docx: "MS Word 2007 XML",
  xlsx: "Calc MS Excel 2007 XML",
  pptx: "Impress MS PowerPoint 2007 XML",
};

/** What LibreOffice reads outside /usr: its configuration, registry and font setup (whichever exist). */
export const LIBREOFFICE_SYSTEM_PATHS = ["/etc/libreoffice", "/etc/fonts", "/var/lib/libreoffice", "/var/spool/libreoffice", "/var/cache/fontconfig"];

/** The LibreOffice install directory when it lives outside the system dirs (e.g. /opt/libreoffice24.2). */
export function sofficeInstallRoot(soffice: string): string | null {
  let real: string;
  try {
    real = realpathSync(soffice);
  } catch {
    return null;
  }
  const dir = path.dirname(real);
  const root = path.basename(dir) === "program" ? path.dirname(dir) : dir;
  return underSystemDir(root) ? null : root;
}

/**
 * The environment soffice gets: nothing of the operator's beyond PATH, so no
 * provider key or token is in reach of a hostile document.
 */
export function sofficeEnv(work: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: work, LANG: "C.UTF-8" } as unknown as NodeJS.ProcessEnv;
}

function convert(soffice: string, input: string, format: keyof typeof IMPORT_FILTERS, target: string, outDir: string, work: string, sandboxed: boolean): { ok: boolean; log: string } {
  const args = [`-env:UserInstallation=${recalcProfile(work)}`, "--headless", "--norestore", `--infilter=${IMPORT_FILTERS[format]}`, "--convert-to", target, "--outdir", outDir, input];
  const options = { encoding: "utf8" as const, timeout: 180_000, killSignal: "SIGKILL" as const, env: sofficeEnv(work) };
  const install = sofficeInstallRoot(soffice);
  const run = sandboxed
    ? runSandboxed(
        soffice,
        args,
        { readOnly: [...LIBREOFFICE_SYSTEM_PATHS.filter((p) => existsSync(p)), ...(install ? [install] : [])], writable: [work], tmp: true, proc: true, cwd: work },
        options
      )
    : spawnSync(soffice, args, { ...options, cwd: work });
  return { ok: run.status === 0, log: `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? String(run.error) : ""}`.trim() };
}

/** LibreOffice's log without its unrelated Java warning. */
function tidyLog(log: string): string {
  return (log.split("\n").filter((l) => !/javaldx/.test(l)).join(" / ").trim() || "no output").slice(0, 300);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface ReopenOptions {
  soffice: string | null;
  enabled: boolean;
  scratchDir: string;
  /** Where rendered PDFs for the human reviewer go. */
  reviewDir: string | null;
  /** Undefined = detect. false = behave as if no sandbox can be built (tests). */
  sandbox?: false;
  /** Open the file without the sandbox (the operator's explicit --unsafe-office). */
  unsafeNoSandbox?: boolean;
}

export async function validateOfficeReopen(spec: Spec<"office_reopen">, outputsDir: string, options: ReopenOptions): Promise<CheckResult[]> {
  const id = (what: string) => `office:${spec.file}:${what}`;
  if (!options.enabled) return [notRun(id("reopen"), "office reopen disabled for this run (--no-office)")];
  if (!options.soffice) return [notRun(id("reopen"), "LibreOffice (soffice) is not installed; the file was not reopened by an office suite")];
  let source: string;
  try {
    readOutput(outputsDir, spec.file);
    source = path.join(outputsDir, spec.file);
  } catch (error) {
    return [fail(id("exists"), (error as Error).message)];
  }
  const sandbox: SandboxStatus = options.sandbox === false ? { available: false, reason: "sandbox disabled for this run" } : detectSandbox();
  if (!sandbox.available && !options.unsafeNoSandbox) {
    return [
      notRun(
        id("reopen"),
        `the file was not opened in LibreOffice: no sandbox here (${sandbox.reason}). Documents from a product are untrusted. ` +
          "Run the benchmark on Linux with unprivileged user namespaces, or pass --unsafe-office to open it unsandboxed on a disposable machine"
      ),
    ];
  }
  const sandboxed = sandbox.available;
  const unsafeNote = sandboxed ? "" : " (UNSAFE: not sandboxed, --unsafe-office)";
  mkdirSync(options.scratchDir, { recursive: true });
  const work = mkdtempSync(path.join(options.scratchDir, "lo-"));
  try {
    const input = path.join(work, `input.${spec.format}`);
    copyFileSync(source, input);
    const out = path.join(work, "out");
    mkdirSync(out);
    if (spec.format === "xlsx") {
      const result = convert(options.soffice, input, "xlsx", "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1", out, work, sandboxed);
      const csvs = readdirSync(out).filter((f) => f.endsWith(".csv"));
      if (!result.ok || csvs.length === 0) return [fail(id("reopen"), `LibreOffice could not open it as an Excel workbook (${IMPORT_FILTERS.xlsx}): ${tidyLog(result.log)}`)];
      const checks: CheckResult[] = [pass(id("reopen"), `LibreOffice opened and recalculated ${csvs.length} sheet(s)${unsafeNote}`)];
      // Recalculated values by sheet and address.
      const recalculated = new Map<string, string>();
      const numbers: number[] = [];
      for (const file of csvs) {
        const sheet = file.replace(/^input-?/, "").replace(/\.csv$/, "") || "?";
        parseCsv(readFileSync(path.join(out, file), "utf8")).forEach((row, r) =>
          row.forEach((value, c) => {
            let letters = "";
            for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
            recalculated.set(`${sheet}!${letters}${r + 1}`, value);
            const num = Number(value);
            if (value.trim() !== "" && Number.isFinite(num)) numbers.push(num);
          })
        );
      }
      // Stale caches: a formula's stored value must equal what it computes.
      const wb = await readWorkbook(await openPackage(readFileSync(source)));
      const stale: string[] = [];
      let compared = 0;
      for (const sheet of wb.sheets) {
        for (const cell of sheet.cells.filter((c) => c.formula && c.type === "number")) {
          const key = csvs.length === 1 ? [...recalculated.keys()].find((k) => k.endsWith(`!${cell.ref}`)) : `${sheet.name}!${cell.ref}`;
          const fresh = key ? Number(recalculated.get(key)) : NaN;
          if (!Number.isFinite(fresh)) continue;
          compared += 1;
          if (Math.abs(fresh - (cell.value as number)) > 1e-6 * Math.max(1, Math.abs(fresh))) stale.push(`${sheet.name}!${cell.ref} cached ${cell.value} but computes ${fresh}`);
        }
      }
      checks.push(stale.length ? fail(id("no-stale-cache"), stale.slice(0, 5).join("; ")) : pass(id("no-stale-cache"), `${compared} formula value(s) match a fresh recalculation`));
      for (const want of spec.recalcValues ?? []) {
        const hit = numbers.some((n) => Math.abs(n - want) <= 0.005);
        checks.push(hit ? pass(id(`recalc=${want}`), "present after recalculation") : fail(id(`recalc=${want}`), "absent after LibreOffice recalculated the workbook"));
      }
      return checks;
    }
    const result = convert(options.soffice, input, spec.format, "pdf", out, work, sandboxed);
    const pdf = path.join(out, "input.pdf");
    if (!result.ok || !existsSync(pdf)) return [fail(id("reopen"), `LibreOffice could not open it as ${spec.format} (${IMPORT_FILTERS[spec.format]}) and render it: ${tidyLog(result.log)}`)];
    const bytes = readFileSync(pdf);
    const { pages } = await pdfText(bytes);
    const checks: CheckResult[] = [pass(id("reopen"), `LibreOffice rendered ${pages.length} page(s)${unsafeNote}`)];
    if (options.reviewDir) {
      mkdirSync(options.reviewDir, { recursive: true });
      copyFileSync(pdf, path.join(options.reviewDir, `${spec.file}.pdf`));
    }
    const rendered = pages.join("\n").replace(/\s/g, "").length;
    checks.push(rendered > 0 ? pass(id("rendered-text"), `${rendered} characters rendered`) : fail(id("rendered-text"), "rendered PDF has no text"));
    if (spec.pages) {
      const ok = (spec.pages.min === undefined || pages.length >= spec.pages.min) && (spec.pages.max === undefined || pages.length <= spec.pages.max);
      checks.push(ok ? pass(id("pages"), `${pages.length} page(s)`) : fail(id("pages"), `${pages.length} page(s), expected ${spec.pages.min ?? 1}–${spec.pages.max ?? "∞"}`));
    }
    return checks;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
