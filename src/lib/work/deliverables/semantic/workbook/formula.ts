/**
 * The workbook formula language: tokenizer, parser, canonical printer,
 * reference rewriting and evaluator.
 *
 * Deliberately a closed language. A formula is parsed into an AST before it is
 * stored, every function name is checked against `FUNCTIONS`, and every
 * reference is checked against the workbook. Nothing is `eval`ed and nothing
 * can reach outside the workbook: no INDIRECT, no WEBSERVICE, no HYPERLINK, no
 * DDE, no volatile clock functions (NOW/TODAY would make a stored version
 * compute differently tomorrow). That closure is what makes it safe to let the
 * model write formulas at all, and it is why a plain string that begins with
 * "=" is still text: only a cell the caller explicitly marks as a formula is
 * ever parsed.
 *
 * Grammar (Excel precedence, lowest first):
 *   comparison  =  <>  <  >  <=  >=
 *   concat      &
 *   additive    +  -
 *   multiply    *  /
 *   power       ^
 *   unary       -  +        (binds tighter than ^, as in Excel: -2^2 = 4)
 *   postfix     %
 *   primary     number | "string" | TRUE | FALSE | #ERR | ref | range | name | fn(args) | ( expr )
 */

import {
  MAX_COL,
  MAX_ROW,
  columnLetter,
  columnNumber,
  quoteSheetName,
  type CellAddress,
} from "@/lib/work/deliverables/semantic/workbook/address";

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export const ERROR_CODES = ["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#N/A", "#NUM!", "#CYCLE!"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface FormulaError {
  error: ErrorCode;
}

export type Scalar = number | string | boolean | null;
export type Value = Scalar | FormulaError;
export type Matrix = Value[][];
type Arg = Value | Matrix;

export function isError(value: unknown): value is FormulaError {
  return typeof value === "object" && value !== null && "error" in value;
}

export const err = (code: ErrorCode): FormulaError => ({ error: code });

function isMatrix(value: Arg): value is Matrix {
  return Array.isArray(value);
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export interface RefPart {
  col: number;
  row: number;
  colAbs: boolean;
  rowAbs: boolean;
}

export type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "err"; v: ErrorCode }
  | { k: "ref"; sheet: string | null; at: RefPart }
  | { k: "range"; sheet: string | null; start: RefPart; end: RefPart }
  | { k: "name"; name: string }
  | { k: "un"; op: "-" | "+" | "%"; a: Node }
  | { k: "bin"; op: BinaryOp; a: Node; b: Node }
  | { k: "call"; fn: string; args: Node[] };

type BinaryOp = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=";

export class FormulaSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaSyntaxError";
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "err"; v: ErrorCode }
  | { t: "op"; v: string }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "comma" }
  | { t: "colon" }
  | { t: "sheet"; v: string }
  | { t: "ident"; v: string };

const MAX_FORMULA_CHARS = 8_192;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = source;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const match = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
      if (!match) throw new FormulaSyntaxError(`Unexpected "${c}"`);
      tokens.push({ t: "num", v: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = "";
      for (;;) {
        if (j >= s.length) throw new FormulaSyntaxError("A string is missing its closing quote");
        if (s[j] === '"') {
          if (s[j + 1] === '"') {
            out += '"';
            j += 2;
            continue;
          }
          break;
        }
        out += s[j++];
      }
      tokens.push({ t: "str", v: out });
      i = j + 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let out = "";
      for (;;) {
        if (j >= s.length) throw new FormulaSyntaxError("A quoted sheet name is missing its closing quote");
        if (s[j] === "'") {
          if (s[j + 1] === "'") {
            out += "'";
            j += 2;
            continue;
          }
          break;
        }
        out += s[j++];
      }
      if (s[j + 1] !== "!") throw new FormulaSyntaxError("A quoted sheet name must be followed by !");
      tokens.push({ t: "sheet", v: out });
      i = j + 2;
      continue;
    }
    if (c === "#") {
      const code = ERROR_CODES.find((candidate) => s.startsWith(candidate, i));
      if (!code) throw new FormulaSyntaxError("Unknown error literal");
      tokens.push({ t: "err", v: code });
      i += code.length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") {
      tokens.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>%".includes(c)) {
      tokens.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ t: "lp" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ t: "rp" });
      i++;
      continue;
    }
    if (c === "," || c === ";") {
      tokens.push({ t: "comma" });
      i++;
      continue;
    }
    if (c === ":") {
      tokens.push({ t: "colon" });
      i++;
      continue;
    }
    if (/[A-Za-z_$\\]/.test(c)) {
      const match = /^[A-Za-z_$\\][A-Za-z0-9_.$]*/.exec(s.slice(i));
      const word = match![0];
      if (s[i + word.length] === "!") {
        tokens.push({ t: "sheet", v: word });
        i += word.length + 1;
        continue;
      }
      tokens.push({ t: "ident", v: word });
      i += word.length;
      continue;
    }
    throw new FormulaSyntaxError(`Unexpected "${c}"`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const REF_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/;

function refPart(word: string): RefPart | null {
  const match = REF_RE.exec(word);
  if (!match) return null;
  const col = columnNumber(match[2]);
  const row = Number(match[4]);
  if (!(col >= 1 && col <= MAX_COL && row >= 1 && row <= MAX_ROW)) return null;
  return { col, row, colAbs: match[1] === "$", rowAbs: match[3] === "$" };
}

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    if (this.tokens.length === 0) throw new FormulaSyntaxError("The formula is empty");
    const node = this.comparison();
    if (this.i < this.tokens.length) throw new FormulaSyntaxError("Unexpected text after the end of the formula");
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private isOp(...ops: string[]): string | null {
    const token = this.peek();
    return token && token.t === "op" && ops.includes(token.v) ? token.v : null;
  }

  private comparison(): Node {
    let left = this.concat();
    for (let op = this.isOp("=", "<>", "<", ">", "<=", ">="); op; op = this.isOp("=", "<>", "<", ">", "<=", ">=")) {
      this.i++;
      left = { k: "bin", op: op as BinaryOp, a: left, b: this.concat() };
    }
    return left;
  }

  private concat(): Node {
    let left = this.additive();
    while (this.isOp("&")) {
      this.i++;
      left = { k: "bin", op: "&", a: left, b: this.additive() };
    }
    return left;
  }

  private additive(): Node {
    let left = this.multiplicative();
    for (let op = this.isOp("+", "-"); op; op = this.isOp("+", "-")) {
      this.i++;
      left = { k: "bin", op: op as BinaryOp, a: left, b: this.multiplicative() };
    }
    return left;
  }

  private multiplicative(): Node {
    let left = this.power();
    for (let op = this.isOp("*", "/"); op; op = this.isOp("*", "/")) {
      this.i++;
      left = { k: "bin", op: op as BinaryOp, a: left, b: this.power() };
    }
    return left;
  }

  private power(): Node {
    let left = this.unary();
    while (this.isOp("^")) {
      this.i++;
      left = { k: "bin", op: "^", a: left, b: this.unary() };
    }
    return left;
  }

  private unary(): Node {
    const op = this.isOp("-", "+");
    if (op) {
      this.i++;
      return { k: "un", op: op as "-" | "+", a: this.unary() };
    }
    return this.postfix();
  }

  private postfix(): Node {
    let node = this.primary();
    while (this.isOp("%")) {
      this.i++;
      node = { k: "un", op: "%", a: node };
    }
    return node;
  }

  private primary(): Node {
    const token = this.peek();
    if (!token) throw new FormulaSyntaxError("The formula ends too early");
    this.i++;
    switch (token.t) {
      case "num":
        return { k: "num", v: token.v };
      case "str":
        return { k: "str", v: token.v };
      case "err":
        return { k: "err", v: token.v };
      case "lp": {
        const inner = this.comparison();
        if (this.peek()?.t !== "rp") throw new FormulaSyntaxError("A bracket is not closed");
        this.i++;
        return inner;
      }
      case "sheet": {
        const next = this.peek();
        if (!next || next.t !== "ident") throw new FormulaSyntaxError(`Expected a cell after ${token.v}!`);
        this.i++;
        return this.reference(token.v, next.v);
      }
      case "ident": {
        const upper = token.v.toUpperCase();
        if (this.peek()?.t === "lp") {
          this.i++;
          const args: Node[] = [];
          if (this.peek()?.t === "rp") {
            this.i++;
            return { k: "call", fn: upper, args };
          }
          for (;;) {
            if (this.peek()?.t === "comma") throw new FormulaSyntaxError(`${upper}( has an empty argument`);
            args.push(this.comparison());
            const sep = this.peek();
            if (sep?.t === "comma") {
              this.i++;
              continue;
            }
            if (sep?.t === "rp") {
              this.i++;
              break;
            }
            throw new FormulaSyntaxError(`${upper}( is missing a closing bracket`);
          }
          return { k: "call", fn: upper, args };
        }
        if (upper === "TRUE" || upper === "FALSE") return { k: "bool", v: upper === "TRUE" };
        if (refPart(token.v)) return this.reference(null, token.v);
        if (/^[A-Za-z_\\][A-Za-z0-9_.]*$/.test(token.v)) return { k: "name", name: token.v };
        throw new FormulaSyntaxError(`"${token.v}" is not a cell, a function or a name`);
      }
      default:
        throw new FormulaSyntaxError("Unexpected symbol");
    }
  }

  private reference(sheet: string | null, word: string): Node {
    const start = refPart(word);
    if (!start) throw new FormulaSyntaxError(`"${word}" is not a cell address`);
    if (this.peek()?.t === "colon") {
      this.i++;
      const next = this.peek();
      if (!next || next.t !== "ident") throw new FormulaSyntaxError("A range is missing its end cell");
      const end = refPart(next.v);
      if (!end) throw new FormulaSyntaxError(`"${next.v}" is not a cell address`);
      this.i++;
      return { k: "range", sheet, start, end };
    }
    return { k: "ref", sheet, at: start };
  }
}

/** Parse a formula (with or without its leading "="). Throws FormulaSyntaxError. */
export function parseFormula(source: string): Node {
  const body = source.trim().replace(/^=/, "");
  if (body.length > MAX_FORMULA_CHARS) throw new FormulaSyntaxError("The formula is too long");
  return new Parser(tokenize(body)).parse();
}

// ---------------------------------------------------------------------------
// Printer
// ---------------------------------------------------------------------------

function printRef(part: RefPart): string {
  return `${part.colAbs ? "$" : ""}${columnLetter(part.col)}${part.rowAbs ? "$" : ""}${part.row}`;
}

const PRECEDENCE: Record<BinaryOp, number> = {
  "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1,
  "&": 2,
  "+": 3, "-": 3,
  "*": 4, "/": 4,
  "^": 5,
};

function printNumber(value: number): string {
  if (Number.isInteger(value) || Math.abs(value) >= 1e-6) return String(value);
  return value.toExponential();
}

/** The canonical text of a formula, without the leading "=". */
export function printFormula(node: Node, parent = 0): string {
  switch (node.k) {
    case "num":
      return printNumber(node.v);
    case "str":
      return `"${node.v.replace(/"/g, '""')}"`;
    case "bool":
      return node.v ? "TRUE" : "FALSE";
    case "err":
      return node.v;
    case "ref":
      return `${node.sheet !== null ? `${quoteSheetName(node.sheet)}!` : ""}${printRef(node.at)}`;
    case "range":
      return `${node.sheet !== null ? `${quoteSheetName(node.sheet)}!` : ""}${printRef(node.start)}:${printRef(node.end)}`;
    case "name":
      return node.name;
    case "un":
      return node.op === "%" ? `${printFormula(node.a, 7)}%` : `${node.op}${printFormula(node.a, 6)}`;
    case "bin": {
      const p = PRECEDENCE[node.op];
      // Left-associative: the right operand needs brackets at equal precedence.
      const text = `${printFormula(node.a, p)}${node.op}${printFormula(node.b, p + 1)}`;
      return p < parent ? `(${text})` : text;
    }
    case "call":
      return `${node.fn}(${node.args.map((arg) => printFormula(arg)).join(",")})`;
  }
}

// ---------------------------------------------------------------------------
// Walking and rewriting
// ---------------------------------------------------------------------------

export function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  if (node.k === "un") walk(node.a, visit);
  else if (node.k === "bin") {
    walk(node.a, visit);
    walk(node.b, visit);
  } else if (node.k === "call") node.args.forEach((arg) => walk(arg, visit));
}

/** Rebuild the tree bottom-up, letting `map` replace any node. */
export function transform(node: Node, map: (node: Node) => Node): Node {
  let next: Node = node;
  if (node.k === "un") next = { ...node, a: transform(node.a, map) };
  else if (node.k === "bin") next = { ...node, a: transform(node.a, map), b: transform(node.b, map) };
  else if (node.k === "call") next = { ...node, args: node.args.map((arg) => transform(arg, map)) };
  return map(next);
}

/** Function names a formula calls, upper-case. */
export function functionsUsed(node: Node): string[] {
  const out = new Set<string>();
  walk(node, (n) => {
    if (n.k === "call") out.add(n.fn);
  });
  return [...out];
}

/**
 * Shift references as if `count` rows (or columns) were inserted before
 * `at` (count > 0) or `-count` were deleted starting at `at` (count < 0), on
 * `sheet`. References to deleted cells become #REF!; ranges shrink.
 *
 * `formulaSheet` is the sheet the formula lives on, so an unqualified
 * reference is known to point at it.
 */
export function shiftReferences(
  node: Node,
  options: { sheet: string; formulaSheet: string; axis: "row" | "col"; at: number; count: number }
): Node {
  const { axis, at, count } = options;
  const target = (sheet: string | null) => (sheet ?? options.formulaSheet).toLowerCase() === options.sheet.toLowerCase();
  const shift = (value: number): number | null => {
    if (count > 0) return value >= at ? value + count : value;
    const removed = -count;
    if (value < at) return value;
    if (value >= at + removed) return value - removed;
    return null;
  };
  return transform(node, (n) => {
    if (n.k === "ref" && target(n.sheet)) {
      const moved = shift(n.at[axis]);
      if (moved === null) return { k: "err", v: "#REF!" };
      return { ...n, at: { ...n.at, [axis]: moved } };
    }
    if (n.k === "range" && target(n.sheet)) {
      let lo = n.start[axis];
      let hi = n.end[axis];
      if (count > 0) {
        lo = lo >= at ? lo + count : lo;
        hi = hi >= at ? hi + count : hi;
      } else {
        const removed = -count;
        const last = at + removed - 1;
        if (lo >= at && hi <= last) return { k: "err", v: "#REF!" };
        const newLo = lo < at ? lo : lo > last ? lo - removed : at;
        const newHi = hi < at ? hi : hi > last ? hi - removed : at - 1;
        lo = newLo;
        hi = newHi;
      }
      return { ...n, start: { ...n.start, [axis]: lo }, end: { ...n.end, [axis]: hi } };
    }
    return n;
  });
}

/** Rename a sheet in every qualified reference. */
export function renameSheetReferences(node: Node, from: string, to: string): Node {
  return transform(node, (n) => {
    if ((n.k === "ref" || n.k === "range") && n.sheet !== null && n.sheet.toLowerCase() === from.toLowerCase()) {
      return { ...n, sheet: to };
    }
    return n;
  });
}

/** Turn references to a deleted sheet into #REF!. */
export function dropSheetReferences(node: Node, sheet: string): Node {
  return transform(node, (n) =>
    (n.k === "ref" || n.k === "range") && n.sheet !== null && n.sheet.toLowerCase() === sheet.toLowerCase()
      ? { k: "err", v: "#REF!" }
      : n
  );
}

/**
 * Copy semantics: a formula moved by (dRow, dCol) shifts its relative
 * references by the same amount, as Excel does when a sorted row carries its
 * formula with it. A reference pushed off the sheet becomes #REF!.
 */
export function offsetRelative(node: Node, dRow: number, dCol: number): Node {
  const move = (part: RefPart): RefPart | null => {
    const row = part.rowAbs ? part.row : part.row + dRow;
    const col = part.colAbs ? part.col : part.col + dCol;
    if (row < 1 || row > MAX_ROW || col < 1 || col > MAX_COL) return null;
    return { ...part, row, col };
  };
  return transform(node, (n) => {
    if (n.k === "ref") {
      const at = move(n.at);
      return at ? { ...n, at } : { k: "err", v: "#REF!" };
    }
    if (n.k === "range") {
      const start = move(n.start);
      const end = move(n.end);
      return start && end ? { ...n, start, end } : { k: "err", v: "#REF!" };
    }
    return n;
  });
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** How the evaluator reads the workbook. The engine implements it. */
export interface EvalContext {
  /** The value of one cell; `sheet` null means the formula's own sheet. */
  cell(sheet: string | null, address: CellAddress): Value;
  /** A rectangular block of values. */
  range(sheet: string | null, start: CellAddress, end: CellAddress): Matrix | FormulaError;
  /** A defined name's value: a scalar for one cell, a matrix for a range. */
  name(name: string): Arg | FormulaError;
}

function toNumber(value: Value): number | FormulaError {
  if (isError(value)) return value;
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  const percent = trimmed.endsWith("%");
  const n = Number((percent ? trimmed.slice(0, -1) : trimmed).replace(/,/g, ""));
  if (!Number.isFinite(n)) return err("#VALUE!");
  return percent ? n / 100 : n;
}

function toText(value: Value): string | FormulaError {
  if (isError(value)) return value;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return formatGeneral(value);
  return value;
}

function toBool(value: Value): boolean | FormulaError {
  if (isError(value)) return value;
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const upper = value.trim().toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  return err("#VALUE!");
}

/** Excel's General display of a number, used for & and TEXT-less coercion. */
export function formatGeneral(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const fixed = Number(value.toPrecision(15));
  return String(fixed);
}

function scalarOf(arg: Arg): Value {
  if (!isMatrix(arg)) return arg;
  // A range used where one value is expected: its top-left value (implicit intersection is out of scope).
  return arg.length === 1 && arg[0].length === 1 ? arg[0][0] : err("#VALUE!");
}

function flatten(args: Arg[]): Value[] {
  const out: Value[] = [];
  for (const arg of args) {
    if (isMatrix(arg)) for (const row of arg) out.push(...row);
    else out.push(arg);
  }
  return out;
}

/**
 * Numbers for the aggregate functions, with Excel's rule: inside a range,
 * text and booleans are skipped; typed directly as an argument they are
 * coerced. The first error wins.
 */
function numbers(args: Arg[]): number[] | FormulaError {
  const out: number[] = [];
  for (const arg of args) {
    if (isMatrix(arg)) {
      for (const row of arg) {
        for (const value of row) {
          if (isError(value)) return value;
          if (typeof value === "number") out.push(value);
        }
      }
    } else {
      if (arg === null) continue;
      const n = toNumber(arg);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

function compare(a: Value, b: Value): number {
  const rank = (value: Value) => (typeof value === "number" || value === null ? 0 : typeof value === "string" ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return ((a as number | null) ?? 0) - ((b as number | null) ?? 0);
  if (ra === 1) {
    const x = (a as string).toLowerCase();
    const y = (b as string).toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return Number(a) - Number(b);
}

/**
 * A criteria test as SUMIF/COUNTIF/AVERAGEIF read it: ">5", "<>x", "=done",
 * "apple", 3. Wildcards (* and ?) are supported for text equality.
 */
function criteriaTest(criteria: Value): (value: Value) => boolean {
  if (typeof criteria === "number" || typeof criteria === "boolean") {
    return (value) => value === criteria;
  }
  const text = criteria === null || isError(criteria) ? "" : String(criteria);
  const match = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(text)!;
  const op = match[1] ?? "=";
  const operand = match[2];
  const asNumber = operand.trim() !== "" && Number.isFinite(Number(operand)) ? Number(operand) : null;
  return (value) => {
    if (isError(value)) return false;
    if (asNumber !== null && typeof value === "number") {
      switch (op) {
        case "=": return value === asNumber;
        case "<>": return value !== asNumber;
        case "<": return value < asNumber;
        case ">": return value > asNumber;
        case "<=": return value <= asNumber;
        case ">=": return value >= asNumber;
      }
    }
    const left = value === null ? "" : String(value).toLowerCase();
    if (op === "=" || op === "<>") {
      const pattern = new RegExp(
        `^${operand.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
        "s"
      );
      const equal = pattern.test(left);
      return op === "=" ? equal : !equal;
    }
    if (typeof value !== "string") return false;
    const right = operand.toLowerCase();
    switch (op) {
      case "<": return left < right;
      case ">": return left > right;
      case "<=": return left <= right;
      default: return left >= right;
    }
  };
}

function roundTo(value: number, digits: number, mode: "half" | "up" | "down"): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  // Correct for binary representation: 1.005 * 100 = 100.49999999999999.
  const nudged = Number(scaled.toPrecision(15));
  const magnitude = Math.abs(nudged);
  const rounded = mode === "half" ? Math.round(magnitude) : mode === "up" ? Math.ceil(magnitude) : Math.floor(magnitude);
  return (Math.sign(nudged) * rounded) / factor;
}

type Fn = (args: Arg[]) => Value | Matrix;

const firstError = (...values: unknown[]): FormulaError | null =>
  (values.find((value) => isError(value)) as FormulaError | undefined) ?? null;

function num(arg: Arg | undefined, fallback?: number): number | FormulaError {
  if (arg === undefined) return fallback ?? err("#VALUE!");
  return toNumber(scalarOf(arg));
}

function aggregate(reduce: (values: number[]) => Value): Fn {
  return (args) => {
    const values = numbers(args);
    return isError(values) ? values : reduce(values);
  };
}

function criteriaFn(kind: "sum" | "count" | "average"): Fn {
  return (args) => {
    const range = args[0];
    if (!isMatrix(range)) return err("#VALUE!");
    const test = criteriaTest(scalarOf(args[1] ?? null));
    const target = kind === "count" ? range : args[2] === undefined ? range : args[2];
    if (!isMatrix(target)) return err("#VALUE!");
    let total = 0;
    let count = 0;
    for (let r = 0; r < range.length; r++) {
      for (let c = 0; c < range[r].length; c++) {
        if (!test(range[r][c])) continue;
        if (kind === "count") {
          count++;
          continue;
        }
        const value = target[r]?.[c];
        if (isError(value)) return value;
        if (typeof value === "number") {
          total += value;
          count++;
        }
      }
    }
    if (kind === "count") return count;
    if (kind === "sum") return total;
    return count === 0 ? err("#DIV/0!") : total / count;
  };
}

function textFn(apply: (text: string, args: Arg[]) => Value): Fn {
  return (args) => {
    const text = toText(scalarOf(args[0] ?? null));
    return isError(text) ? text : apply(text, args);
  };
}

/**
 * The functions this build computes. A formula naming anything else is
 * refused when it is written, and kept as an opaque cell (its last value) when
 * it is imported.
 */
export const FUNCTIONS: Record<string, { min: number; max: number; fn: Fn }> = {
  SUM: { min: 1, max: 255, fn: aggregate((v) => v.reduce((a, b) => a + b, 0)) },
  AVERAGE: { min: 1, max: 255, fn: aggregate((v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : err("#DIV/0!"))) },
  MIN: { min: 1, max: 255, fn: aggregate((v) => (v.length ? Math.min(...v) : 0)) },
  MAX: { min: 1, max: 255, fn: aggregate((v) => (v.length ? Math.max(...v) : 0)) },
  MEDIAN: {
    min: 1,
    max: 255,
    fn: aggregate((v) => {
      if (!v.length) return err("#NUM!");
      const s = [...v].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }),
  },
  PRODUCT: { min: 1, max: 255, fn: aggregate((v) => v.reduce((a, b) => a * b, 1)) },
  COUNT: {
    min: 1,
    max: 255,
    fn: (args) => flatten(args).filter((value) => typeof value === "number").length,
  },
  COUNTA: {
    min: 1,
    max: 255,
    fn: (args) => flatten(args).filter((value) => value !== null && value !== "").length,
  },
  COUNTBLANK: {
    min: 1,
    max: 1,
    fn: (args) => flatten(args).filter((value) => value === null || value === "").length,
  },
  SUMIF: { min: 2, max: 3, fn: criteriaFn("sum") },
  COUNTIF: { min: 2, max: 2, fn: criteriaFn("count") },
  AVERAGEIF: { min: 2, max: 3, fn: criteriaFn("average") },
  SUMPRODUCT: {
    min: 1,
    max: 30,
    fn: (args) => {
      const matrices = args.map((arg) => (isMatrix(arg) ? arg : [[arg]]));
      const rows = matrices[0].length;
      const cols = matrices[0][0]?.length ?? 0;
      if (matrices.some((m) => m.length !== rows || (m[0]?.length ?? 0) !== cols)) return err("#VALUE!");
      let total = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let product = 1;
          for (const m of matrices) {
            const value = m[r][c];
            if (isError(value)) return value;
            product *= typeof value === "number" ? value : 0;
          }
          total += product;
        }
      }
      return total;
    },
  },
  IF: {
    min: 1,
    max: 3,
    fn: (args) => {
      const test = toBool(scalarOf(args[0]));
      if (isError(test)) return test;
      if (test) return args.length > 1 ? scalarOf(args[1]) : true;
      return args.length > 2 ? scalarOf(args[2]) : false;
    },
  },
  IFERROR: {
    min: 2,
    max: 2,
    fn: (args) => {
      const value = scalarOf(args[0]);
      return isError(value) ? scalarOf(args[1]) : value;
    },
  },
  AND: {
    min: 1,
    max: 255,
    fn: (args) => {
      for (const value of flatten(args)) {
        if (value === null || typeof value === "string") continue;
        const b = toBool(value);
        if (isError(b)) return b;
        if (!b) return false;
      }
      return true;
    },
  },
  OR: {
    min: 1,
    max: 255,
    fn: (args) => {
      let any = false;
      for (const value of flatten(args)) {
        if (value === null || typeof value === "string") continue;
        const b = toBool(value);
        if (isError(b)) return b;
        any = any || b;
      }
      return any;
    },
  },
  NOT: {
    min: 1,
    max: 1,
    fn: (args) => {
      const b = toBool(scalarOf(args[0]));
      return isError(b) ? b : !b;
    },
  },
  ROUND: {
    min: 1,
    max: 2,
    fn: (args) => {
      const x = num(args[0]);
      const d = num(args[1], 0);
      return firstError(x, d) ?? roundTo(x as number, Math.trunc(d as number), "half");
    },
  },
  ROUNDUP: {
    min: 1,
    max: 2,
    fn: (args) => {
      const x = num(args[0]);
      const d = num(args[1], 0);
      return firstError(x, d) ?? roundTo(x as number, Math.trunc(d as number), "up");
    },
  },
  ROUNDDOWN: {
    min: 1,
    max: 2,
    fn: (args) => {
      const x = num(args[0]);
      const d = num(args[1], 0);
      return firstError(x, d) ?? roundTo(x as number, Math.trunc(d as number), "down");
    },
  },
  INT: { min: 1, max: 1, fn: (args) => { const x = num(args[0]); return isError(x) ? x : Math.floor(x); } },
  ABS: { min: 1, max: 1, fn: (args) => { const x = num(args[0]); return isError(x) ? x : Math.abs(x); } },
  SQRT: {
    min: 1,
    max: 1,
    fn: (args) => {
      const x = num(args[0]);
      if (isError(x)) return x;
      return x < 0 ? err("#NUM!") : Math.sqrt(x);
    },
  },
  POWER: {
    min: 2,
    max: 2,
    fn: (args) => {
      const x = num(args[0]);
      const y = num(args[1]);
      const e = firstError(x, y);
      if (e) return e;
      const result = (x as number) ** (y as number);
      return Number.isFinite(result) ? result : err("#NUM!");
    },
  },
  MOD: {
    min: 2,
    max: 2,
    fn: (args) => {
      const x = num(args[0]);
      const y = num(args[1]);
      const e = firstError(x, y);
      if (e) return e;
      if (y === 0) return err("#DIV/0!");
      return (x as number) - (y as number) * Math.floor((x as number) / (y as number));
    },
  },
  PMT: {
    min: 3,
    max: 5,
    fn: (args) => {
      const rate = num(args[0]);
      const periods = num(args[1]);
      const pv = num(args[2]);
      const fv = num(args[3], 0);
      const type = num(args[4], 0);
      const e = firstError(rate, periods, pv, fv, type);
      if (e) return e;
      const [r, n, p, f, t] = [rate, periods, pv, fv, type] as number[];
      if (n === 0) return err("#NUM!");
      if (r === 0) return -(p + f) / n;
      const factor = (1 + r) ** n;
      return -(r * (p * factor + f)) / ((1 + r * (t ? 1 : 0)) * (factor - 1));
    },
  },
  NPV: {
    min: 2,
    max: 255,
    fn: (args) => {
      const rate = num(args[0]);
      if (isError(rate)) return rate;
      const flows = numbers(args.slice(1));
      if (isError(flows)) return flows;
      return flows.reduce((total, flow, i) => total + flow / (1 + rate) ** (i + 1), 0);
    },
  },
  CONCAT: {
    min: 1,
    max: 255,
    fn: (args) => {
      let out = "";
      for (const value of flatten(args)) {
        const text = toText(value);
        if (isError(text)) return text;
        out += text;
      }
      return out;
    },
  },
  CONCATENATE: {
    min: 1,
    max: 255,
    fn: (args) => {
      let out = "";
      for (const arg of args) {
        const text = toText(scalarOf(arg));
        if (isError(text)) return text;
        out += text;
      }
      return out;
    },
  },
  LEN: { min: 1, max: 1, fn: textFn((text) => text.length) },
  UPPER: { min: 1, max: 1, fn: textFn((text) => text.toUpperCase()) },
  LOWER: { min: 1, max: 1, fn: textFn((text) => text.toLowerCase()) },
  TRIM: { min: 1, max: 1, fn: textFn((text) => text.trim().replace(/ {2,}/g, " ")) },
  LEFT: {
    min: 1,
    max: 2,
    fn: textFn((text, args) => {
      const n = num(args[1], 1);
      return isError(n) ? n : n < 0 ? err("#VALUE!") : text.slice(0, Math.trunc(n));
    }),
  },
  RIGHT: {
    min: 1,
    max: 2,
    fn: textFn((text, args) => {
      const n = num(args[1], 1);
      if (isError(n)) return n;
      if (n < 0) return err("#VALUE!");
      return Math.trunc(n) === 0 ? "" : text.slice(-Math.trunc(n));
    }),
  },
  MID: {
    min: 3,
    max: 3,
    fn: textFn((text, args) => {
      const start = num(args[1]);
      const length = num(args[2]);
      const e = firstError(start, length);
      if (e) return e;
      if ((start as number) < 1 || (length as number) < 0) return err("#VALUE!");
      return text.substr(Math.trunc(start as number) - 1, Math.trunc(length as number));
    }),
  },
  INDEX: {
    min: 2,
    max: 3,
    fn: (args) => {
      const range = args[0];
      if (!isMatrix(range)) return err("#VALUE!");
      const r = num(args[1]);
      const c = num(args[2], 1);
      const e = firstError(r, c);
      if (e) return e;
      // A one-row range indexed by a single number reads along the row.
      const single = args.length === 2 && range.length === 1;
      const row = single ? 1 : Math.trunc(r as number);
      const col = single ? Math.trunc(r as number) : Math.trunc(c as number);
      const value = range[row - 1]?.[col - 1];
      return value === undefined ? err("#REF!") : value;
    },
  },
  MATCH: {
    min: 2,
    max: 3,
    fn: (args) => {
      const needle = scalarOf(args[0]);
      const haystack = args[1];
      if (!isMatrix(haystack)) return err("#N/A");
      const list = haystack.length === 1 ? haystack[0] : haystack.map((row) => row[0]);
      const mode = num(args[2], 1);
      if (isError(mode)) return mode;
      if (mode === 0) {
        const test = criteriaTest(needle);
        const index = list.findIndex((value) => test(value));
        return index === -1 ? err("#N/A") : index + 1;
      }
      let best = -1;
      for (let i = 0; i < list.length; i++) {
        const cmp = compare(list[i], needle);
        if (mode > 0 ? cmp <= 0 : cmp >= 0) best = i;
        else break;
      }
      return best === -1 ? err("#N/A") : best + 1;
    },
  },
  VLOOKUP: {
    min: 3,
    max: 4,
    fn: (args) => {
      const needle = scalarOf(args[0]);
      const table = args[1];
      if (!isMatrix(table)) return err("#N/A");
      const col = num(args[2]);
      if (isError(col)) return col;
      if (col < 1 || col > (table[0]?.length ?? 0)) return err("#REF!");
      const approximate = args[3] === undefined ? true : toBool(scalarOf(args[3]));
      if (isError(approximate)) return approximate;
      let found = -1;
      if (!approximate) {
        const test = criteriaTest(needle);
        found = table.findIndex((row) => test(row[0]));
      } else {
        for (let i = 0; i < table.length; i++) {
          if (compare(table[i][0], needle) <= 0) found = i;
          else break;
        }
      }
      return found === -1 ? err("#N/A") : table[found][Math.trunc(col) - 1];
    },
  },
};

export function isSupportedFunction(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(FUNCTIONS, name.toUpperCase());
}

function binary(op: BinaryOp, a: Value, b: Value): Value {
  if (isError(a)) return a;
  if (isError(b)) return b;
  if (op === "&") {
    const x = toText(a);
    const y = toText(b);
    return firstError(x, y) ?? `${x as string}${y as string}`;
  }
  if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
    const cmp = compare(a === null && typeof b === "string" ? "" : a, b === null && typeof a === "string" ? "" : b);
    switch (op) {
      case "=": return cmp === 0;
      case "<>": return cmp !== 0;
      case "<": return cmp < 0;
      case ">": return cmp > 0;
      case "<=": return cmp <= 0;
      default: return cmp >= 0;
    }
  }
  const x = toNumber(a);
  const y = toNumber(b);
  const e = firstError(x, y);
  if (e) return e;
  const l = x as number;
  const r = y as number;
  let result: number;
  switch (op) {
    case "+": result = l + r; break;
    case "-": result = l - r; break;
    case "*": result = l * r; break;
    case "/":
      if (r === 0) return err("#DIV/0!");
      result = l / r;
      break;
    default:
      result = l ** r;
  }
  return Number.isFinite(result) ? result : err("#NUM!");
}

function evalArg(node: Node, ctx: EvalContext): Arg {
  if (node.k === "range") return ctx.range(node.sheet, node.start, node.end);
  if (node.k === "name") return ctx.name(node.name);
  return evaluate(node, ctx);
}

/** Evaluate an AST to one value. Never throws: every failure is a formula error value. */
export function evaluate(node: Node, ctx: EvalContext): Value {
  switch (node.k) {
    case "num":
      return node.v;
    case "str":
      return node.v;
    case "bool":
      return node.v;
    case "err":
      return err(node.v);
    case "ref":
      return ctx.cell(node.sheet, node.at);
    case "range":
    case "name":
      return scalarOf(evalArg(node, ctx));
    case "un": {
      const value = evaluate(node.a, ctx);
      if (isError(value)) return value;
      const n = toNumber(value);
      if (isError(n)) return n;
      return node.op === "-" ? -n : node.op === "%" ? n / 100 : n;
    }
    case "bin":
      return binary(node.op, evaluate(node.a, ctx), evaluate(node.b, ctx));
    case "call": {
      const spec = FUNCTIONS[node.fn];
      if (!spec) return err("#NAME?");
      if (node.args.length < spec.min || node.args.length > spec.max) return err("#VALUE!");
      // IF and IFERROR evaluate lazily so the branch not taken cannot raise.
      if (node.fn === "IF") {
        const test = toBool(evaluate(node.args[0], ctx));
        if (isError(test)) return test;
        if (test) return node.args.length > 1 ? evaluate(node.args[1], ctx) : true;
        return node.args.length > 2 ? evaluate(node.args[2], ctx) : false;
      }
      if (node.fn === "IFERROR") {
        const value = evaluate(node.args[0], ctx);
        return isError(value) ? evaluate(node.args[1], ctx) : value;
      }
      const result = spec.fn(node.args.map((arg) => evalArg(arg, ctx)));
      return Array.isArray(result) ? scalarOf(result) : result;
    }
  }
}
