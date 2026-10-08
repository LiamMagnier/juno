/**
 * The Live UI expression language (docs/design/LIVE_UI.md §3).
 *
 * A model writes these ("subtotal * (1 + tip)") and a reader's slider changes
 * their inputs sixty times a second, so the language is small, total and
 * bounded: a hand-written parser into a tiny AST, and a tree-walking evaluator
 * that never throws to its caller, never loops without a budget and has no
 * door to the host (no `eval`, no `Function`, no prototype access, no I/O).
 *
 * `JunoLiveUIExpression.swift` is the same language. Both are held to the
 * fixtures in contracts/live-ui/fixtures/*.json, so a formula means the same
 * number on a phone as in a browser.
 */

import {
  canonicalFormatter,
  canonicalNumberString,
  civilFromDays,
  daysFromCivil,
  isLiveFormat,
  parseISODate,
  roundHalfAway,
  type LiveFormatter,
} from "@/lib/live-ui/format";

export type LiveValue = null | boolean | number | string | LiveValue[] | { [key: string]: LiveValue };

export const EXPR_LIMITS = {
  length: 400,
  nodes: 160,
  depth: 32,
  steps: 50_000,
  range: 500,
  string: 2_000,
} as const;

// ── AST ─────────────────────────────────────────────────────────────────────

export type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "lit"; v: boolean | null }
  | { k: "list"; items: Node[] }
  | { k: "id"; name: string }
  | { k: "un"; op: "-" | "!" | "+"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "tern"; c: Node; a: Node; b: Node }
  | { k: "mem"; o: Node; name: string }
  | { k: "idx"; o: Node; i: Node }
  | { k: "call"; fn: string; args: Node[] };

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

class ExprError extends Error {}

const OPS = ["&&", "||", "==", "!=", "<=", ">=", "+", "-", "*", "/", "%", "^", "<", ">", "!", "?", ":", "(", ")", "[", "]", ",", "."];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if ((c >= "0" && c <= "9") || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError("Bad number");
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new ExprError("Unterminated string");
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`Unexpected "${c}"`);
    out.push({ t: "op", v: op });
    i += op.length;
  }
  return out;
}

const BINARY: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

const PARSE_CACHE = new Map<string, Node | ExprError>();

/** Parse, cached. Throws ExprError (internal; `evaluate` catches it). */
export function parseExpr(src: string): Node {
  const cached = PARSE_CACHE.get(src);
  if (cached instanceof ExprError) throw cached;
  if (cached) return cached;
  try {
    const node = parseUncached(src);
    if (PARSE_CACHE.size > 2000) PARSE_CACHE.clear();
    PARSE_CACHE.set(src, node);
    return node;
  } catch (error) {
    const e = error instanceof ExprError ? error : new ExprError("Invalid expression");
    PARSE_CACHE.set(src, e);
    throw e;
  }
}

function parseUncached(src: string): Node {
  if (src.length > EXPR_LIMITS.length) throw new ExprError("Expression is too long");
  const toks = tokenize(src);
  let p = 0;
  let nodes = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => toks[p]?.t === "op" && toks[p].v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`Expected "${v}"`);
    p++;
  };
  const mk = <T extends Node>(n: T, depth: number): T => {
    if (++nodes > EXPR_LIMITS.nodes) throw new ExprError("Expression is too complex");
    if (depth > EXPR_LIMITS.depth) throw new ExprError("Expression is too deep");
    return n;
  };

  const ternary = (d: number): Node => {
    const c = binary(1, d + 1);
    if (isOp("?")) {
      p++;
      const a = ternary(d + 1);
      expect(":");
      const b = ternary(d + 1);
      return mk({ k: "tern", c, a, b }, d);
    }
    return c;
  };

  const binary = (minPrec: number, d: number): Node => {
    let left = unary(d + 1);
    for (;;) {
      const t = peek();
      if (!t || t.t !== "op") break;
      const prec = BINARY[t.v];
      if (prec === undefined || prec < minPrec) break;
      p++;
      const right = binary(prec + 1, d + 1);
      left = mk({ k: "bin", op: t.v, a: left, b: right }, d);
    }
    return left;
  };

  const unary = (d: number): Node => {
    if (isOp("-") || isOp("!") || isOp("+")) {
      const op = (toks[p++] as { v: "-" | "!" | "+" }).v;
      return mk({ k: "un", op, a: unary(d + 1) }, d);
    }
    return power(d);
  };

  const power = (d: number): Node => {
    const base = postfix(d + 1);
    if (isOp("^")) {
      p++;
      // Right-associative, and binds tighter than unary minus on its left:
      // -2^2 is -(2^2), 2^-1 is 2^(-1).
      return mk({ k: "bin", op: "^", a: base, b: unary(d + 1) }, d);
    }
    return base;
  };

  const postfix = (d: number): Node => {
    let node = primary(d + 1);
    for (;;) {
      if (isOp(".")) {
        p++;
        const t = peek();
        if (!t || t.t !== "id") throw new ExprError("Expected a field name");
        p++;
        node = mk({ k: "mem", o: node, name: t.v }, d);
      } else if (isOp("[")) {
        p++;
        const i = ternary(d + 1);
        expect("]");
        node = mk({ k: "idx", o: node, i }, d);
      } else break;
    }
    return node;
  };

  const primary = (d: number): Node => {
    const t = peek();
    if (!t) throw new ExprError("Unexpected end of expression");
    p++;
    if (t.t === "num") return mk({ k: "num", v: t.v }, d);
    if (t.t === "str") return mk({ k: "str", v: t.v }, d);
    if (t.t === "id") {
      if (t.v === "true" || t.v === "false") return mk({ k: "lit", v: t.v === "true" }, d);
      if (t.v === "null") return mk({ k: "lit", v: null }, d);
      if (isOp("(")) {
        p++;
        const args: Node[] = [];
        if (!isOp(")")) {
          for (;;) {
            args.push(ternary(d + 1));
            if (isOp(",")) {
              p++;
              continue;
            }
            break;
          }
        }
        expect(")");
        if (!FUNCTIONS.has(t.v)) throw new ExprError(`Unknown function ${t.v}`);
        return mk({ k: "call", fn: t.v, args }, d);
      }
      return mk({ k: "id", name: t.v }, d);
    }
    if (t.v === "(") {
      const inner = ternary(d + 1);
      expect(")");
      return inner;
    }
    if (t.v === "[") {
      const items: Node[] = [];
      if (!isOp("]")) {
        for (;;) {
          items.push(ternary(d + 1));
          if (isOp(",")) {
            p++;
            if (isOp("]")) break;
            continue;
          }
          break;
        }
      }
      expect("]");
      return mk({ k: "list", items }, d);
    }
    throw new ExprError(`Unexpected "${t.v}"`);
  };

  const root = ternary(0);
  if (p < toks.length) throw new ExprError("Unexpected trailing input");
  return root;
}

// ── Scope ───────────────────────────────────────────────────────────────────

export interface LiveScopeInit {
  inputs: Record<string, LiveValue>;
  lets: Record<string, string>;
  data: Record<string, LiveValue>;
  formatter?: LiveFormatter;
  currency?: string;
}

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };
/** A scope's total budget across every evaluation it serves (charts × points). */
const SCOPE_BUDGET = 2_000_000;

export class LiveScope {
  readonly formatter: LiveFormatter;
  readonly currency: string;
  private readonly memo = new Map<string, LiveValue>();
  private readonly letErrors = new Map<string, string>();
  private readonly visiting = new Set<string>();
  private spent = 0;

  constructor(private readonly init: LiveScopeInit) {
    this.formatter = init.formatter ?? canonicalFormatter;
    this.currency = init.currency ?? "USD";
  }

  /** Evaluate `src` with optional row/chart locals. Never throws. */
  evaluate(src: string, locals?: Record<string, LiveValue>): { value: LiveValue; error?: string } {
    const run = new Run(this, locals);
    try {
      const value = run.eval(parseExpr(src));
      return { value: clean(value) };
    } catch (error) {
      return { value: null, error: error instanceof Error ? error.message : "Error" };
    } finally {
      this.spent += run.steps;
    }
  }

  /** Every `let` value (errors as null) — the fixture form. */
  allLets(): { values: Record<string, LiveValue>; errors: Record<string, string> } {
    const values: Record<string, LiveValue> = {};
    for (const name of Object.keys(this.init.lets)) {
      try {
        values[name] = clean(this.resolveLet(name, new Run(this)));
      } catch (error) {
        values[name] = null;
        if (!this.letErrors.has(name)) this.letErrors.set(name, error instanceof Error ? error.message : "Error");
      }
    }
    return { values, errors: Object.fromEntries(this.letErrors) };
  }

  /** @internal */
  budgetLeft(): number {
    return SCOPE_BUDGET - this.spent;
  }

  /** @internal */
  lookup(name: string, run: Run): LiveValue {
    if (Object.prototype.hasOwnProperty.call(this.init.inputs, name)) return this.init.inputs[name];
    if (Object.prototype.hasOwnProperty.call(this.init.lets, name)) return this.resolveLet(name, run);
    if (Object.prototype.hasOwnProperty.call(this.init.data, name)) return this.init.data[name];
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
    throw new ExprError(`Unknown name ${name}`);
  }

  private resolveLet(name: string, run: Run): LiveValue {
    if (this.memo.has(name)) return this.memo.get(name)!;
    const failed = this.letErrors.get(name);
    if (failed) throw new ExprError(failed);
    if (this.visiting.has(name)) {
      // Every member of the cycle is marked as it unwinds.
      for (const member of this.visiting) this.letErrors.set(member, "Circular formula");
      throw new ExprError("Circular formula");
    }
    this.visiting.add(name);
    try {
      // A let never sees row locals: it means one thing everywhere.
      const inner = new Run(this, undefined, run);
      try {
        const value = clean(inner.eval(parseExpr(this.init.lets[name])));
        this.memo.set(name, value);
        return value;
      } finally {
        // The let's work is charged to whoever asked for it.
        run.steps += inner.steps;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error";
      if (!this.letErrors.has(name)) this.letErrors.set(name, message);
      throw new ExprError(this.letErrors.get(name)!);
    } finally {
      this.visiting.delete(name);
    }
  }
}

/** Non-finite numbers become null, long strings are cut. */
function clean(value: LiveValue): LiveValue {
  if (typeof value === "number") return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  if (typeof value === "string" && value.length > EXPR_LIMITS.string) return value.slice(0, EXPR_LIMITS.string);
  return value;
}

// ── Evaluation ──────────────────────────────────────────────────────────────

export function truthy(v: LiveValue): boolean {
  if (v === null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function valueToString(v: LiveValue): string {
  if (v === null) return "";
  if (typeof v === "number") return canonicalNumberString(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(valueToString).join(", ");
  return "";
}

const isNum = (v: LiveValue): v is number => typeof v === "number";
const isObj = (v: LiveValue): v is { [key: string]: LiveValue } => v !== null && typeof v === "object" && !Array.isArray(v);

class Run {
  steps = 0;
  private readonly cap: number;
  constructor(
    private readonly scope: LiveScope,
    private readonly locals?: Record<string, LiveValue>,
    parent?: Run,
  ) {
    this.cap = Math.min(EXPR_LIMITS.steps, scope.budgetLeft());
    if (parent) this.parentRef = parent;
  }
  private parentRef?: Run;

  tick(n = 1) {
    this.steps += n;
    let total = this.steps;
    for (let r = this.parentRef; r; r = r.parentRef) total += r.steps;
    if (total > this.cap) throw new ExprError("Too much work");
  }

  eval(node: Node): LiveValue {
    this.tick();
    switch (node.k) {
      case "num":
      case "str":
      case "lit":
        return node.v;
      case "list": {
        if (node.items.length > EXPR_LIMITS.range) throw new ExprError("List is too long");
        return node.items.map((item) => this.eval(item));
      }
      case "id":
        if (this.locals && Object.prototype.hasOwnProperty.call(this.locals, node.name)) return this.locals[node.name];
        return this.scope.lookup(node.name, this);
      case "un": {
        const a = this.eval(node.a);
        if (node.op === "!") return !truthy(a);
        return this.arith(node.op === "-" ? "neg" : "pos", a, null);
      }
      case "tern":
        return truthy(this.eval(node.c)) ? this.eval(node.a) : this.eval(node.b);
      case "bin":
        return this.binary(node);
      case "mem": {
        const o = this.eval(node.o);
        return this.member(o, node.name);
      }
      case "idx": {
        const o = this.eval(node.o);
        const i = this.eval(node.i);
        if (Array.isArray(o) && isNum(i)) {
          const k = Math.trunc(i);
          return k >= 0 && k < o.length ? o[k] : null;
        }
        if (isObj(o) && typeof i === "string") return this.member(o, i);
        return null;
      }
      case "call":
        return this.call(node.fn, node.args);
    }
  }

  private member(o: LiveValue, name: string): LiveValue {
    if (isObj(o)) return Object.prototype.hasOwnProperty.call(o, name) ? o[name] : null;
    if (Array.isArray(o)) {
      if (name === "length") return o.length;
      this.tick(o.length);
      return o.map((row) => (isObj(row) && Object.prototype.hasOwnProperty.call(row, name) ? row[name] : null));
    }
    return null;
  }

  private binary(node: Extract<Node, { k: "bin" }>): LiveValue {
    const { op } = node;
    if (op === "&&") return truthy(this.eval(node.a)) && truthy(this.eval(node.b));
    if (op === "||") return truthy(this.eval(node.a)) || truthy(this.eval(node.b));
    const a = this.eval(node.a);
    const b = this.eval(node.b);
    switch (op) {
      case "==":
        return equal(a, b);
      case "!=":
        return !equal(a, b);
      case "<":
      case "<=":
      case ">":
      case ">=": {
        if (isNum(a) && isNum(b)) return compare(op, a, b);
        if (typeof a === "string" && typeof b === "string") return compare(op, a < b ? -1 : a > b ? 1 : 0, 0);
        return null;
      }
      case "+":
        if (typeof a === "string" || typeof b === "string") {
          if (Array.isArray(a) || Array.isArray(b)) return null;
          return (valueToString(a) + valueToString(b)).slice(0, EXPR_LIMITS.string);
        }
        return this.arith(op, a, b);
      default:
        return this.arith(op, a, b);
    }
  }

  /** Numeric operators with element-wise broadcasting and null propagation. */
  private arith(op: string, a: LiveValue, b: LiveValue): LiveValue {
    if (Array.isArray(a) || Array.isArray(b)) {
      if (op === "neg" || op === "pos") {
        const list = a as LiveValue[];
        this.tick(list.length);
        return list.map((x) => this.arith(op, x, null));
      }
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) throw new ExprError("Lists differ in length");
        this.tick(a.length);
        return a.map((x, i) => this.arith(op, x, b[i]));
      }
      if (Array.isArray(a)) {
        this.tick(a.length);
        return a.map((x) => this.arith(op, x, b));
      }
      const list = b as LiveValue[];
      this.tick(list.length);
      return list.map((y) => this.arith(op, a, y));
    }
    if (op === "neg") return isNum(a) ? -a : null;
    if (op === "pos") return isNum(a) ? a : null;
    if (!isNum(a) || !isNum(b)) return null;
    let r: number;
    switch (op) {
      case "+": r = a + b; break;
      case "-": r = a - b; break;
      case "*": r = a * b; break;
      case "/": if (b === 0) return null; r = a / b; break;
      case "%": if (b === 0) return null; r = a % b; break;
      case "^": r = Math.pow(a, b); break;
      default: throw new ExprError(`Unknown operator ${op}`);
    }
    return Number.isFinite(r) ? r : null;
  }

  private numbers(args: LiveValue[]): number[] | null {
    const flat: LiveValue[] = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    this.tick(flat.length);
    const out: number[] = [];
    for (const v of flat) {
      if (v === null) continue;
      if (!isNum(v)) return null;
      out.push(v);
    }
    return out;
  }

  private call(fn: string, argNodes: Node[]): LiveValue {
    if (fn === "if") {
      if (argNodes.length < 2) throw new ExprError("if needs a condition and a value");
      return truthy(this.eval(argNodes[0])) ? this.eval(argNodes[1]) : argNodes[2] ? this.eval(argNodes[2]) : null;
    }
    const args = argNodes.map((n) => this.eval(n));
    const num = (i: number): number | null => (isNum(args[i]) ? (args[i] as number) : null);
    const need = (count: number) => {
      if (args.length < count) throw new ExprError(`${fn} needs ${count} argument${count === 1 ? "" : "s"}`);
    };
    const unaryMath = (f: (x: number) => number, ok: (x: number) => boolean = () => true): LiveValue => {
      need(1);
      const x = args[0];
      if (Array.isArray(x)) {
        this.tick(x.length);
        return x.map((v) => (isNum(v) && ok(v) ? f(v) : null));
      }
      return isNum(x) && ok(x) ? f(x) : null;
    };
    switch (fn) {
      case "sum": {
        const xs = this.numbers(args);
        return xs ? xs.reduce((s, x) => s + x, 0) : null;
      }
      case "avg": {
        const xs = this.numbers(args);
        return xs && xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
      }
      case "min":
      case "max": {
        const xs = this.numbers(args);
        if (!xs || xs.length === 0) return null;
        return xs.reduce((m, x) => (fn === "min" ? (x < m ? x : m) : x > m ? x : m));
      }
      case "count":
        need(1);
        return Array.isArray(args[0]) ? args[0].length : args[0] === null ? 0 : 1;
      case "len":
        need(1);
        if (Array.isArray(args[0])) return args[0].length;
        if (typeof args[0] === "string") return [...args[0]].length;
        return null;
      case "round": {
        need(1);
        const d = args.length > 1 ? num(1) : 0;
        if (d === null) return null;
        return unaryMath((x) => roundHalfAway(x, d));
      }
      case "floor":
        return unaryMath(Math.floor);
      case "ceil":
        return unaryMath(Math.ceil);
      case "abs":
        return unaryMath(Math.abs);
      case "sqrt":
        return unaryMath(Math.sqrt, (x) => x >= 0);
      case "exp":
        return unaryMath(Math.exp);
      case "ln":
        return unaryMath(Math.log, (x) => x > 0);
      case "log10":
        return unaryMath(Math.log10, (x) => x > 0);
      case "pow": {
        need(2);
        return this.arith("^", args[0], args[1]);
      }
      case "clamp": {
        need(3);
        const [x, lo, hi] = [num(0), num(1), num(2)];
        if (x === null || lo === null || hi === null) return null;
        return Math.min(Math.max(x, lo), hi);
      }
      case "range": {
        need(2);
        const [from, to] = [num(0), num(1)];
        const step = args.length > 2 ? num(2) : 1;
        if (from === null || to === null || step === null) return null;
        return liveRange(from, to, step, (n) => this.tick(n));
      }
      case "pmt": {
        need(3);
        const [r, nper, pv] = [num(0), num(1), num(2)];
        if (r === null || nper === null || pv === null || nper <= 0) return null;
        if (r === 0) return pv / nper;
        return (pv * r) / (1 - Math.pow(1 + r, -nper));
      }
      case "fv": {
        need(3);
        const [r, nper, payment] = [num(0), num(1), num(2)];
        const pv = args.length > 3 ? num(3) : 0;
        if (r === null || nper === null || payment === null || pv === null) return null;
        if (r === 0) return pv + payment * nper;
        const g = Math.pow(1 + r, nper);
        return pv * g + (payment * (g - 1)) / r;
      }
      case "normpdf": {
        need(3);
        const [x, mean, sd] = [args[0], num(1), num(2)];
        if (mean === null || sd === null || sd <= 0) return null;
        const f = (v: number) => Math.exp(-0.5 * Math.pow((v - mean) / sd, 2)) / (sd * Math.sqrt(2 * Math.PI));
        if (Array.isArray(x)) {
          this.tick(x.length);
          return x.map((v) => (isNum(v) ? f(v) : null));
        }
        return isNum(x) ? f(x) : null;
      }
      case "normcdf": {
        need(3);
        const [x, mean, sd] = [num(0), num(1), num(2)];
        if (x === null || mean === null || sd === null || sd <= 0) return null;
        return 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));
      }
      case "days": {
        need(2);
        const a = typeof args[0] === "string" ? parseISODate(args[0]) : null;
        const b = typeof args[1] === "string" ? parseISODate(args[1]) : null;
        if (!a || !b) return null;
        return daysFromCivil(b.year, b.month, b.day) - daysFromCivil(a.year, a.month, a.day);
      }
      case "addDays": {
        need(2);
        const a = typeof args[0] === "string" ? parseISODate(args[0]) : null;
        const n = num(1);
        if (!a || n === null) return null;
        return civilFromDays(daysFromCivil(a.year, a.month, a.day) + Math.trunc(n));
      }
      case "fmt": {
        need(1);
        const kind = args.length > 1 && isLiveFormat(args[1]) ? args[1] : "number";
        const digits = args.length > 2 ? num(2) ?? undefined : undefined;
        const x = args[0];
        if (kind === "date") return typeof x === "string" ? this.scope.formatter.date(x) : null;
        if (!isNum(x)) return null;
        return this.scope.formatter.number(x, kind, { currency: this.scope.currency, digits });
      }
      default:
        throw new ExprError(`Unknown function ${fn}`);
    }
  }
}

const FUNCTIONS = new Set([
  "if", "sum", "avg", "min", "max", "count", "len", "round", "floor", "ceil", "abs", "sqrt", "exp", "ln",
  "log10", "pow", "clamp", "range", "pmt", "fv", "normpdf", "normcdf", "days", "addDays", "fmt",
]);

function equal(a: LiveValue, b: LiveValue): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") return false; // lists and objects compare by nothing
  return a === b;
}

function compare(op: string, a: number, b: number): boolean {
  return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
}

/** Abramowitz & Stegun 7.1.26 — written identically in Swift. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** from, from+step, … up to `to` inclusive (1e-9 slack), at most 500 values. */
export function liveRange(from: number, to: number, step: number, tick?: (n: number) => void): number[] | null {
  if (step === 0 || !Number.isFinite(step)) return null;
  if ((to - from) / step < -1e-9) return [];
  const count = Math.floor((to - from) / step + 1e-9) + 1;
  if (count > EXPR_LIMITS.range) throw new ExprError("Range is too long");
  tick?.(count);
  const out: number[] = [];
  for (let k = 0; k < count; k++) out.push(from + k * step);
  return out;
}

/**
 * `{{expr}}` interpolation for text, prompts and hints. Numbers render with
 * the scope's formatter ("number"), null as the muted dash. Unclosed `{{`
 * is left as literal text.
 */
export function interpolate(text: string, scope: LiveScope, locals?: Record<string, LiveValue>): string {
  if (!text.includes("{{")) return text;
  return text.replace(/\{\{([^{}]{1,400})\}\}/g, (_m, src: string) => {
    const { value } = scope.evaluate(src.trim(), locals);
    if (value === null) return "–";
    if (typeof value === "number") return scope.formatter.number(value, "number");
    return valueToString(value);
  });
}
