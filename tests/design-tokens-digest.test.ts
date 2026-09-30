import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * `design:tokens:check` compares the generated Swift and TypeScript, digest
 * line included, against what globals.css projects. The digest used to hash
 * the whole CSS file, so any edit to it (a comment, a component rule) failed
 * the gate with no token changed. These run the real generator against a copy
 * of globals.css in a scratch directory (it reads and writes relative to cwd).
 */

const REPO = process.cwd();
const TSX = resolve(REPO, "node_modules/.bin/tsx");
const SCRIPT = resolve(REPO, "scripts/generate-design-tokens.ts");
const SWIFT = "native/Packages/JunoNativeKit/Sources/JunoDesignSystem/Generated/JunoGeneratedTokens.swift";
const TS = "src/lib/design/tokens.generated.ts";

function generate(cwd: string, ...args: string[]) {
  return spawnSync(TSX, [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

async function outputs(cwd: string) {
  return { swift: await readFile(join(cwd, SWIFT), "utf8"), ts: await readFile(join(cwd, TS), "utf8") };
}

const digestOf = (text: string) => /^\/\/ tokens-digest: ([0-9a-f]{16})$/m.exec(text)?.[1];

async function withScratch(run: (cwd: string, css: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "juno-design-tokens-"));
  try {
    await mkdir(join(cwd, "src/app"), { recursive: true });
    const css = await readFile(join(REPO, "src/app/globals.css"), "utf8");
    await writeFile(join(cwd, "src/app/globals.css"), css);
    const first = generate(cwd);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    await run(cwd, css);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("CSS edits that change no projected token leave the digest and --check alone", async () => {
  await withScratch(async (cwd, css) => {
    const before = await outputs(cwd);
    assert.ok(digestOf(before.swift));
    assert.equal(digestOf(before.swift), digestOf(before.ts));

    const edited = [
      "/* A comment nobody projects. */",
      css.replace(/\n/, "\n\n"),
      ".digest-probe { color: red; padding: 1px; --probe-local: 3px; }",
      // Not a colour, a duration or an easing: declared, never emitted.
      ":root { --probe-width: 12px; }",
      // Conditional, so the generator skips it by design.
      "@media (prefers-reduced-motion: reduce) { :root { --dur-slow: 1ms; } }",
      "",
    ].join("\n");
    await writeFile(join(cwd, "src/app/globals.css"), edited);

    const check = generate(cwd, "--check");
    assert.equal(check.status, 0, check.stderr || check.stdout);

    const rewrite = generate(cwd);
    assert.equal(rewrite.status, 0, rewrite.stderr || rewrite.stdout);
    assert.deepEqual(await outputs(cwd), before);
  });
});

test("a changed or added token value moves the digest and fails --check", async () => {
  await withScratch(async (cwd, css) => {
    const before = digestOf((await outputs(cwd)).swift);

    for (const probe of [":root { --dur-probe: 777ms; }", ".dark { --background: 0 0% 0%; }"]) {
      await writeFile(join(cwd, "src/app/globals.css"), `${css}\n${probe}\n`);
      const check = generate(cwd, "--check");
      assert.equal(check.status, 1, `${probe}: ${check.stdout}`);
      assert.match(check.stderr, /DRIFT/);

      const rewrite = generate(cwd);
      assert.equal(rewrite.status, 0, rewrite.stderr || rewrite.stdout);
      const after = await outputs(cwd);
      assert.notEqual(digestOf(after.swift), before, probe);
      assert.equal(digestOf(after.swift), digestOf(after.ts));

      // Back to the baseline for the next probe.
      await writeFile(join(cwd, "src/app/globals.css"), css);
      assert.equal(generate(cwd).status, 0);
    }
  });
});
