import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/*
 * A container query never matches the element that declares the container: it
 * resolves against the nearest ANCESTOR container of that name. A class like
 * `@[50rem]/split:flex-row` written on the same element as `@container/split`
 * is therefore dead, and silently so. The chat mount carried exactly that
 * (11 Nov 2026): it stayed a column at every width, so opening the thought
 * process on a desktop collapsed the conversation and composer to nothing.
 *
 * For every opening tag whose classes declare `@container/<name>`, none of its
 * classes may be a `…/<name>:` container variant.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx$/.test(name) ? [full] : [];
  });
}

/** Comments out, so neither their words nor a `>` in them is read as markup. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The opening tag around `at`: from its `<` to the `>` that closes it. */
function openingTag(source: string, at: number): string {
  const start = source.lastIndexOf("<", at);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && source[i - 1] !== "=") return source.slice(start, i);
  }
  return source.slice(start);
}

test("no element queries the container it declares", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(path.join(process.cwd(), "src"))) {
    const source = withoutComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(/@container\/([\w-]+)/g)) {
      const tag = openingTag(source, match.index!);
      if (!tag.includes(match[0])) continue;
      if (new RegExp(`/${match[1]}:`).test(tag)) {
        offenders.push(`${path.relative(process.cwd(), file)}: @container/${match[1]} queries itself`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
