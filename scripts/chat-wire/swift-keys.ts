/**
 * Read the wire keys a Swift type or function actually uses, so the chat wire
 * contract's "native" claims are checked against the code that sends and
 * decodes the JSON rather than taken on trust.
 *
 * Deliberately small: it is not a Swift parser. It masks comments and string
 * literals, matches braces, and reads one of three shapes:
 *   - `struct`: a type's `CodingKeys` (raw values win) or else its stored
 *     `let`/`var` properties at the top level of its body. `Outer.Inner` finds
 *     a nested type.
 *   - `function`: every `["key"]` subscript in a function's body (the
 *     dictionary readers, like the `work` frame's).
 *   - `set`: the string literals of a `let name … = [ … ]` collection.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface SwiftSource {
  file: string;
  struct?: string;
  function?: string;
  set?: string;
}

/** Comments (and, unless `keepStrings`, string contents) become spaces; offsets stay aligned. */
function mask(source: string, keepStrings = false): string {
  const out = source.split("");
  let index = 0;
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
    } else if (source.startsWith('"""', index)) {
      const end = source.indexOf('"""', index + 3);
      const stop = end === -1 ? source.length : end + 3;
      if (!keepStrings) blank(index + 3, stop - 3);
      index = stop;
    } else if (source[index] === '"') {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== '"' && source[cursor] !== "\n") {
        cursor += source[cursor] === "\\" ? 2 : 1;
      }
      if (!keepStrings) blank(index + 1, cursor);
      index = cursor + 1;
    } else {
      index += 1;
    }
  }
  return out.join("");
}

/** The offsets just inside the braces of the block that opens at or after `from`. */
function blockAfter(masked: string, from: number): { start: number; end: number } | null {
  const open = masked.indexOf("{", from);
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    else if (masked[index] === "}") {
      depth -= 1;
      if (depth === 0) return { start: open + 1, end: index };
    }
  }
  return null;
}

/** The body's text with every nested block blanked, so only its own declarations remain. */
function topLevel(masked: string, start: number, end: number): string {
  let depth = 0;
  let out = "";
  for (let index = start; index < end; index += 1) {
    const char = masked[index];
    if (char === "{") {
      out += depth === 0 ? char : " ";
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      out += depth === 0 ? char : " ";
    } else {
      out += depth === 0 || char === "\n" ? char : " ";
    }
  }
  return out;
}

function findType(masked: string, path: string): { start: number; end: number } | null {
  let scope = { start: 0, end: masked.length };
  for (const name of path.split(".")) {
    const text = topLevel(masked, scope.start, scope.end);
    const match = new RegExp(`\\b(?:struct|class|enum|actor)\\s+${name}\\b`).exec(
      scope.start === 0 && scope.end === masked.length ? masked : text,
    );
    if (!match) return null;
    const block = blockAfter(masked, scope.start + match.index);
    if (!block) return null;
    scope = block;
  }
  return scope;
}

export function swiftKeys(root: string, source: SwiftSource): Set<string> {
  const original = readFileSync(resolve(root, source.file), "utf8");
  const masked = mask(original);
  const keys = new Set<string>();
  const fail = (what: string): never => {
    throw new Error(`[chat-wire] ${source.file}: cannot find ${what}`);
  };

  if (source.struct) {
    const body = findType(masked, source.struct) ?? fail(`type ${source.struct}`);
    const text = topLevel(masked, body.start, body.end);
    const codingKeys = /\benum\s+CodingKeys\b/.exec(text);
    if (codingKeys) {
      const block = blockAfter(masked, body.start + codingKeys.index) ?? fail(`${source.struct}.CodingKeys`);
      const cases = mask(original, true).slice(block.start, block.end).replace(/\bcase\b/g, ",");
      for (const part of cases.split(/[,\n]/)) {
        const named = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*"([^"]*)")?\s*$/.exec(part);
        if (named?.[1]) keys.add(named[2] ?? named[1]);
      }
    } else {
      for (const match of text.matchAll(/^[ \t]*(?:(?:public|private|fileprivate|internal|package)\s+)?(?:let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:[^\n{]*$/gm)) {
        keys.add(match[1]);
      }
    }
    return keys;
  }

  if (source.function) {
    const found = new RegExp(`\\bfunc\\s+${source.function}\\b`).exec(masked) ?? fail(`func ${source.function}`);
    const block = blockAfter(masked, found.index) ?? fail(`the body of ${source.function}`);
    for (const match of original.slice(block.start, block.end).matchAll(/\[\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\]/g)) {
      keys.add(match[1]);
    }
    return keys;
  }

  if (source.set) {
    const found = new RegExp(`\\blet\\s+${source.set}\\b[^=]*=\\s*\\[`).exec(masked) ?? fail(`let ${source.set}`);
    const open = found.index + found[0].length - 1;
    const close = masked.indexOf("]", open);
    for (const match of original.slice(open, close).matchAll(/"([^"]+)"/g)) keys.add(match[1]);
    return keys;
  }

  return fail("a struct, function or set name");
}
