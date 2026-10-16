/**
 * PER-PACKAGE ENFORCEMENT for the wave 2 design rules (spec §14, "Lint
 * enforcement").
 *
 * Every wave 2 rule WARNS everywhere. A package that has cleaned its files
 * lists their globs in its own `eslint-rules/enforce/<pkg>.json`, and those
 * globs turn the same rules into ERRORS — for the web rules in
 * eslint.config.mjs and for the native design gates in
 * scripts/check-native-design-lib.mjs, which read the `native` list. One file
 * per package, so packages never edit each other's lists, and nothing to
 * register: every `*.json` in the directory is loaded at startup.
 *
 *   {
 *     "package": "p1",
 *     "web": ["src/lib/strings/**"],        // ESLint globs, repo-relative
 *     "native": ["native/.../Generated/**"]  // Swift paths, repo-relative
 *   }
 *
 * No dependencies: a tiny glob matcher (`**`, `*`, `?`, `{a,b}`) is enough for
 * repo-relative paths and keeps the native gates `node:*`-only.
 */

import fs from "node:fs";
import path from "node:path";

/** The enforce files under `<root>/eslint-rules/enforce`, merged. */
export function loadEnforce(root = process.cwd()) {
  const dir = path.join(root, "eslint-rules", "enforce");
  const out = { web: [], native: [], packages: [] };
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error.code === "ENOENT") return out;
    throw error;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`eslint-rules/enforce/${name} is not valid JSON: ${error.message}`);
    }
    for (const key of ["web", "native"]) {
      const list = data[key] ?? [];
      if (!Array.isArray(list) || list.some((glob) => typeof glob !== "string" || glob.startsWith("/"))) {
        throw new Error(`eslint-rules/enforce/${name}: "${key}" must be a list of repo-relative globs`);
      }
      out[key].push(...list);
    }
    out.packages.push({ file: name, package: data.package ?? name.replace(/\.json$/, ""), web: data.web ?? [], native: data.native ?? [] });
  }
  return out;
}

/** A repo-relative glob as a RegExp: `**` any depth, `*` and `?` within a segment, `{a,b}` alternatives. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        continue;
      }
      re += `(?:${glob.slice(i + 1, end).split(",").map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
      i = end;
    } else {
      re += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** Whether a repo-relative path (forward slashes) matches any of the globs. */
export function matchesAny(relativePath, globs) {
  const normal = relativePath.split(path.sep).join("/").replace(/^\.\//, "");
  return globs.some((glob) => globToRegExp(glob).test(normal));
}
