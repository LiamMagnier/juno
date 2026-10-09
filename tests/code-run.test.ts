import test from "node:test";
import assert from "node:assert/strict";
import { runTargetFor, serverSnippetLanguage } from "@/lib/exec/snippet-languages";
import { snippetProgram } from "@/lib/exec/snippets";
import { parseLiveUI } from "@/lib/live-ui/spec";
import { liveUISummaryLines } from "@/lib/live-ui/summary";
import { runtimeFor } from "@/lib/artifact-runtime";
import { HR_SAMPLE_SQL } from "@/lib/sandbox/hr-sample";

/*
 * Running code where it stands (owner, 2026-10-09): every language, in the
 * browser when it can (JS, TS, Python, SQL) and in the hosted sandbox
 * otherwise; and the Live UI exercise card the reader answers in.
 */

test("browser languages run in the frame, compiled and other languages in the sandbox", () => {
  for (const [lang, where, language] of [
    ["sql", "browser", "sql"],
    ["PLSQL", "browser", "sql"],
    ["py", "browser", "python"],
    ["ts", "browser", "typescript"],
    ["c", "server", "c"],
    ["c++", "server", "cpp"],
    ["java", "server", "java"],
    ["golang", "server", "go"],
    ["rs", "server", "rust"],
    ["sh", "server", "bash"],
  ] as const) {
    assert.deepEqual({ where: runTargetFor(lang)?.where, language: runTargetFor(lang)?.language }, { where, language }, lang);
  }
  assert.equal(runTargetFor("mermaid"), null);
  assert.equal(runTargetFor("text"), null);
  assert.equal(serverSnippetLanguage("python"), null, "python runs in the browser, not through the snippet route");
});

test("a SQL artifact or block runs on the SQLite console engine", () => {
  assert.equal(runtimeFor("CODE", "sql").engine, "sql");
  assert.equal(runtimeFor("CODE", "plsql").engine, "sql");
});

test("the server program writes the source through a quoted heredoc nothing in the source can end", () => {
  const source = "echo $HOME `id`\nALEVR_SOURCE_\nEOF";
  const program = snippetProgram("bash", source);
  assert.equal(program.language, "bash");
  const delimiter = /<<'(ALEVR_SOURCE_[0-9a-f]{16})'/.exec(program.code)?.[1];
  assert.ok(delimiter);
  assert.ok(!source.includes(delimiter!));
  assert.ok(program.code.includes(`${source}\n${delimiter}\n`));
  assert.match(snippetProgram("c", "int main(){}").code, /gcc -O2 -std=c17 -Wall main\.c -o main -lm && \.\/main/);
  assert.match(snippetProgram("java", "class Main{}").code, /cat > Main\.java/);
  assert.throws(() => snippetProgram("cobol", "x"));
});

test("the HR sample keeps IT's five people, a NULL department and DUAL", () => {
  assert.equal((HR_SAMPLE_SQL.match(/'IT_PROG', \d+, NULL, \d+, 60\)/g) ?? []).length, 5);
  assert.match(HR_SAMPLE_SQL, /\(178, 'Kimberely', 'Grant'.*NULL\)/);
  assert.match(HR_SAMPLE_SQL, /CREATE TABLE dual/);
});

test("an exercise parses with its hints and language, needs a title and a statement, and never carries a solution", () => {
  const { spec } = parseLiveUI(
    JSON.stringify({
      title: "Pratique",
      ui: [
        { type: "exercise", title: "Exercice 1", tag: "SQL", prompt: "Affiche **les employés** du département 60.", language: "SQL", hints: ["a", "b", "c", "d", "e", "f"], solution: "SELECT …" },
        { type: "exercise", title: "No statement" },
        { type: "practice", title: "Alias", prompt: "Explain." },
      ],
    }),
  );
  assert.ok(spec);
  const [first, second] = spec!.ui;
  assert.equal(spec!.ui.length, 2);
  assert.ok(first.type === "exercise" && second.type === "exercise");
  if (first.type !== "exercise") return;
  assert.equal(first.language, "sql");
  assert.equal(first.hints.length, 5);
  assert.ok(!("solution" in first));
  assert.deepEqual(liveUISummaryLines(spec!).slice(0, 2), ["Exercice 1 (SQL)", "Affiche les employés du département 60."]);
});

test("the native apps' console document is the web's inline one, for browser languages only", async () => {
  const { codeBlockConsoleDoc } = await import("@/lib/sandbox/console-doc");
  const sql = codeBlockConsoleDoc("PLSQL", "SELECT 1 FROM dual;", "dark");
  assert.ok(sql);
  assert.equal(sql!.language, "sql");
  assert.match(sql!.html, /sql-wasm\.js/);
  assert.match(sql!.html, /juno:console-size/, "inline: the height is posted");
  assert.match(sql!.html, /color-scheme:dark/);
  assert.match(sql!.html, /Content-Security-Policy/);
  const py = codeBlockConsoleDoc("py", "print('</script>')", "light");
  assert.ok(py && /pyodide\.js/.test(py.html));
  assert.ok(!py!.html.includes("print('</script>')"), "the source cannot close its script tag");
  assert.equal(codeBlockConsoleDoc("ts", "const a: number = 1", "light")?.label, "TypeScript");
  assert.equal(codeBlockConsoleDoc("c", "int main(){}", "light"), null);
  assert.equal(codeBlockConsoleDoc("mermaid", "graph TD", "light"), null);
});

test("the native harnesses' console fixtures are the documents the route builds today", async () => {
  const { consoleFixtures } = await import("../scripts/generate-console-fixtures");
  const { readFileSync } = await import("node:fs");
  const committed = JSON.parse(readFileSync("contracts/code-run/console-fixtures.json", "utf8"));
  assert.deepEqual(committed, consoleFixtures(), "regenerate: npx tsx scripts/generate-console-fixtures.ts");
});
