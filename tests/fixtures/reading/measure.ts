/**
 * Prints what the extractor yields for every fixture in this folder, offline.
 *
 *   npx tsx tests/fixtures/reading/measure.ts [--full]
 *
 * The same path a research run or chat's `web_fetch` takes (`extractUrlDocument`
 * with a fake transport serving the saved bytes), so the numbers are the ones
 * a run would see. `tests/reading-depth.test.ts` asserts the facts; this is
 * the before/after view a person reads.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { extractUrlDocument } from "@/lib/web/extract";

const dir = path.dirname(process.argv[1] ?? __filename);
const full = process.argv.includes("--full");

async function main(): Promise<void> {
  for (const name of readdirSync(dir).filter((file) => /\.(html|pdf)$/.test(file)).sort()) {
    const bytes = readFileSync(path.join(dir, name));
    const type = name.endsWith(".pdf") ? "application/pdf" : "text/html; charset=utf-8";
    const outcome = await extractUrlDocument(`https://fixture.example/${name}`, undefined, {
      maxChars: 60_000,
      transport: async () => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type } }),
    });
    if (!outcome.ok) {
      console.log(`\n=== ${name}: FAILED ${JSON.stringify(outcome.failure)}`);
      continue;
    }
    const { text, shell, publishedAt, author } = outcome.page;
    const tables = (text.match(/^\|.*\|$/gm) ?? []).length;
    console.log(
      `\n=== ${name}: ${text.length} chars, ${tables} table lines, shell=${shell ?? false}, date=${publishedAt?.toISOString().slice(0, 10) ?? "-"}, author=${author ?? "-"}`
    );
    console.log(full ? text : text.slice(0, 700));
  }
}

void main();
