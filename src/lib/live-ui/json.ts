/**
 * The tolerant JSON reader behind Live UI (docs/design/LIVE_UI.md §5).
 *
 * A Live UI block is read while the model is still writing it, so this reader
 * returns everything that has fully ARRIVED and says which containers have not
 * closed yet. Three rules decide what "arrived" means, and the Swift twin
 * (`JunoLiveUIJSON.swift`) follows them byte for byte, held to the fixtures in
 * contracts/live-ui/fixtures/json.json:
 *
 *   1. A string, number or literal still being written at the end of input is
 *      dropped, never surfaced half-typed ("12" may yet become "125").
 *   2. An object key whose value has not arrived is dropped.
 *   3. Every object and array that has not seen its closing bracket is listed
 *      in `open`, so the renderer can draw closed things and hold back the rest.
 *
 * Trailing commas and raw newlines inside strings are accepted (models write
 * both). Anything else that is not
 * JSON is an error; a streaming caller keeps its last good parse.
 *
 * Pure, no dependencies, never throws.
 */

export type LiveJSON = null | boolean | number | string | LiveJSON[] | { [key: string]: LiveJSON };

export interface LiveJSONResult {
  /** What has arrived. `undefined` when nothing usable has (or on error). */
  value: LiveJSON | undefined;
  /** Containers that have not closed. Identity-based: test with `open.has(obj)`. */
  open: ReadonlySet<object>;
  /** The top-level value closed and only whitespace follows. */
  complete: boolean;
  error?: string;
}

export const LIVE_UI_MAX_SOURCE = 24_000;
const MAX_DEPTH = 64;

class SyntaxFailure extends Error {}

/** Sentinel for "this value had not finished arriving". */
const INCOMPLETE = Symbol("incomplete");
type Read = LiveJSON | typeof INCOMPLETE;

export function readLiveJSON(source: string): LiveJSONResult {
  const open = new Set<object>();
  if (source.length > LIVE_UI_MAX_SOURCE) {
    return { value: undefined, open, complete: false, error: "Block is too large." };
  }
  let i = 0;
  const n = source.length;

  const ws = () => {
    while (i < n) {
      const c = source.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };

  const fail = (message: string): never => {
    throw new SyntaxFailure(`${message} at ${i}`);
  };

  const readString = (): string | typeof INCOMPLETE => {
    // at opening quote
    i++;
    let out = "";
    while (i < n) {
      const c = source[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        if (i + 1 >= n) return (i = n), INCOMPLETE;
        const e = source[i + 1];
        i += 2;
        switch (e) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "/": out += "/"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "u": {
            if (i + 4 > n) return (i = n), INCOMPLETE;
            const hex = source.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Bad unicode escape");
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            fail("Bad escape");
        }
        continue;
      }
      out += c;
      i++;
    }
    return INCOMPLETE;
  };

  const readNumber = (): number | typeof INCOMPLETE => {
    const start = i;
    if (source[i] === "-") i++;
    while (i < n && /[0-9.eE+-]/.test(source[i])) i++;
    // A number that runs into the end of input may still be growing.
    if (i >= n) return INCOMPLETE;
    const text = source.slice(start, i);
    if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text)) fail("Bad number");
    const value = Number(text);
    if (!Number.isFinite(value)) fail("Number out of range");
    return value;
  };

  const readLiteral = (): boolean | null | typeof INCOMPLETE => {
    for (const [word, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (source.startsWith(word, i)) {
        i += word.length;
        return value;
      }
      const rest = source.slice(i);
      if (rest.length < word.length && word.startsWith(rest)) {
        i = n;
        return INCOMPLETE;
      }
    }
    return fail("Unexpected character");
  };

  const readValue = (depth: number): Read => {
    if (depth > MAX_DEPTH) fail("Too deeply nested");
    ws();
    if (i >= n) return INCOMPLETE;
    const c = source[i];
    if (c === "{") return readObject(depth);
    if (c === "[") return readArray(depth);
    if (c === '"') return readString();
    if (c === "-" || (c >= "0" && c <= "9")) return readNumber();
    return readLiteral();
  };

  const readObject = (depth: number): LiveJSON => {
    i++;
    const out: { [key: string]: LiveJSON } = {};
    for (;;) {
      ws();
      if (i >= n) {
        open.add(out);
        return out;
      }
      if (source[i] === "}") {
        i++;
        return out;
      }
      if (source[i] !== '"') fail("Expected key");
      const key = readString();
      if (key === INCOMPLETE) {
        open.add(out);
        return out;
      }
      ws();
      if (i >= n) {
        open.add(out);
        return out;
      }
      if (source[i] !== ":") fail("Expected colon");
      i++;
      const value = readValue(depth + 1);
      if (value === INCOMPLETE) {
        open.add(out);
        return out;
      }
      // `__proto__` would rewrite the prototype on a plain object literal.
      if (key !== "__proto__") out[key] = value;
      ws();
      if (i >= n) {
        open.add(out);
        return out;
      }
      if (source[i] === ",") {
        i++;
        continue;
      }
      if (source[i] === "}") {
        i++;
        return out;
      }
      fail("Expected comma or }");
    }
  };

  const readArray = (depth: number): LiveJSON => {
    i++;
    const out: LiveJSON[] = [];
    for (;;) {
      ws();
      if (i >= n) {
        open.add(out);
        return out;
      }
      if (source[i] === "]") {
        i++;
        return out;
      }
      const value = readValue(depth + 1);
      if (value === INCOMPLETE) {
        open.add(out);
        return out;
      }
      out.push(value);
      ws();
      if (i >= n) {
        open.add(out);
        return out;
      }
      if (source[i] === ",") {
        i++;
        continue;
      }
      if (source[i] === "]") {
        i++;
        return out;
      }
      fail("Expected comma or ]");
    }
  };

  try {
    const value = readValue(0);
    if (value === INCOMPLETE) return { value: undefined, open, complete: false };
    ws();
    if (i < n) fail("Unexpected trailing content");
    const complete = !(value !== null && typeof value === "object" && open.has(value));
    return { value, open, complete };
  } catch (error) {
    return {
      value: undefined,
      open: new Set(),
      complete: false,
      error: error instanceof Error ? error.message : "Malformed block.",
    };
  }
}

/** JSON paths ("$", "$.ui", "$.ui[1]") of every open container — the fixture form. */
export function openPaths(result: LiveJSONResult): string[] {
  const paths: string[] = [];
  const walk = (value: LiveJSON, path: string) => {
    if (value === null || typeof value !== "object") return;
    if (result.open.has(value)) paths.push(path);
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`));
    else for (const key of Object.keys(value)) walk(value[key], `${path}.${key}`);
  };
  if (result.value !== undefined) walk(result.value, "$");
  return paths;
}
