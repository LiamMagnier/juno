import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Walks a module's runtime import graph and names every file in it that
 * imports "server-only" (SPEC §13, harness rule 1).
 *
 * `node_modules/server-only` throws the moment a plain Node process imports
 * it, which is every test here, so a pure core that picks up a server-only
 * import three files down fails as "cannot find module" in someone else's
 * test run. The research tests assert their subjects stay clear with this, the
 * same walk `contract-scaffold.test.ts` does for the §12.7 symbols.
 */

// `npm test` runs from the repository root, as contract-scaffold.test.ts assumes.
const root = process.cwd();

function resolveLocal(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(root, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && path.extname(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${path.relative(root, from)}`);
}

/** Static imports and re-exports that survive compilation: `import type` / `export type` are erased. */
function runtimeSpecifiers(source: string): string[] {
  const found: string[] = [];
  const statement = /^\s*(import|export)\s+(?!type\s)(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["'];?/gm;
  for (const match of source.matchAll(statement)) {
    if (match[1] === "export" && !/\sfrom\s/.test(match[0])) continue;
    found.push(match[2]);
  }
  return found;
}

/** The files under `relativeEntry`'s runtime graph that import "server-only". Empty is clean. */
export function serverOnlyIn(relativeEntry: string): string[] {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier === "server-only") {
        offenders.push(path.relative(root, file));
        continue;
      }
      const next = resolveLocal(file, specifier);
      if (next) visit(next);
    }
  };
  visit(path.join(root, relativeEntry));
  return offenders;
}

/** A source file as text, for the checks that read a server-only module rather than import it. */
export function readSource(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}
