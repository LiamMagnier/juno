/**
 * `calculate`'s evaluator (SPEC §3.8.8): arithmetic and unit conversion with no
 * code execution.
 *
 * A recursive-descent parser over a closed grammar — numbers, `+ - * / ^ %`,
 * parentheses, a fixed set of functions and two constants — plus one sentence
 * shape for conversions, `5 km to mi`. Nothing here reaches `eval`, `Function`
 * or any name the input chooses: an identifier either is in one of the tables
 * below or is an error naming it. The limits (500 characters, 64 levels of
 * nesting, 64-character literals, a finite result) bound the work one call can
 * do whatever the model sends.
 *
 * Arithmetic is IEEE 754 on `number`, and every result is rounded to 12
 * significant digits, which hides the binary-fraction noise (`0.1 + 0.2`)
 * without changing any figure a person would read.
 *
 * Errors come back as data (`CalcError`), never as English: the sentence the
 * model reads is written in `specs/calculate.prompt.ts` (INV-29).
 *
 * Pure and client-safe.
 */

export const CALC_MAX_INPUT_CHARS = 500;
export const CALC_MAX_DEPTH = 64;
export const CALC_MAX_LITERAL_CHARS = 64;
const SIGNIFICANT_DIGITS = 12;

export type CalcError =
  | { kind: "too_long" }
  | { kind: "empty" }
  | { kind: "too_deep" }
  | { kind: "literal_too_long"; token: string }
  | { kind: "unexpected"; token: string }
  | { kind: "expected"; token: string }
  | { kind: "unknown_name"; token: string }
  | { kind: "bad_arguments"; token: string }
  | { kind: "division_by_zero"; token: string }
  | { kind: "not_finite" }
  | { kind: "unknown_unit"; token: string }
  | { kind: "incompatible_units"; from: string; to: string };

export type CalcResult =
  | { ok: true; value: number; formatted: string; expression: string; unit?: string }
  | { ok: false; error: CalcError };

class CalcFailure extends Error {
  constructor(readonly error: CalcError) {
    super(error.kind);
  }
}

function fail(error: CalcError): never {
  throw new CalcFailure(error);
}

// ── Tokens ──────────────────────────────────────────────────────────────────

type Token =
  | { type: "number"; text: string; value: number }
  | { type: "name"; text: string }
  | { type: "op"; text: "+" | "-" | "*" | "/" | "^" | "%" | "(" | ")" | "," };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const match = /^(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(input.slice(i));
      if (!match) fail({ kind: "unexpected", token: ch });
      const text = match[0];
      if (text.length > CALC_MAX_LITERAL_CHARS) fail({ kind: "literal_too_long", token: `${text.slice(0, 16)}…` });
      const value = Number(text.replace(/_/g, ""));
      if (!Number.isFinite(value)) fail({ kind: "not_finite" });
      tokens.push({ type: "number", text: text.replace(/_/g, ""), value });
      i += text.length;
      continue;
    }
    if (/[A-Za-zπ]/.test(ch)) {
      const match = /^[A-Za-zπ][A-Za-z0-9_]*/.exec(input.slice(i));
      const text = match ? match[0] : ch;
      if (text.length > CALC_MAX_LITERAL_CHARS) fail({ kind: "literal_too_long", token: `${text.slice(0, 16)}…` });
      tokens.push({ type: "name", text });
      i += text.length;
      continue;
    }
    // `×` and `÷` are what people paste; `**` is what programmers write.
    if (ch === "×") {
      tokens.push({ type: "op", text: "*" });
      i += 1;
      continue;
    }
    if (ch === "÷") {
      tokens.push({ type: "op", text: "/" });
      i += 1;
      continue;
    }
    if (ch === "*" && input[i + 1] === "*") {
      tokens.push({ type: "op", text: "^" });
      i += 2;
      continue;
    }
    if ("+-*/^%(),".includes(ch)) {
      tokens.push({ type: "op", text: ch as "+" });
      i += 1;
      continue;
    }
    fail({ kind: "unexpected", token: ch });
  }
  return tokens;
}

// ── Names ───────────────────────────────────────────────────────────────────

const CONSTANTS: Readonly<Record<string, number>> = {
  pi: Math.PI,
  π: Math.PI,
  e: Math.E,
};

type Fn = { min: number; max: number; apply(args: number[], name: string): number };

const FUNCTIONS: Readonly<Record<string, Fn>> = {
  sqrt: {
    min: 1,
    max: 1,
    apply: ([x], name) => (x < 0 ? fail({ kind: "bad_arguments", token: name }) : Math.sqrt(x)),
  },
  abs: { min: 1, max: 1, apply: ([x]) => Math.abs(x) },
  round: {
    min: 1,
    max: 2,
    apply: ([x, digits], name) => {
      if (digits === undefined) return Math.round(x);
      if (!Number.isInteger(digits) || digits < -15 || digits > 15) fail({ kind: "bad_arguments", token: name });
      const factor = 10 ** digits;
      return Math.round(x * factor) / factor;
    },
  },
  floor: { min: 1, max: 1, apply: ([x]) => Math.floor(x) },
  ceil: { min: 1, max: 1, apply: ([x]) => Math.ceil(x) },
  min: { min: 1, max: 64, apply: (args) => Math.min(...args) },
  max: { min: 1, max: 64, apply: (args) => Math.max(...args) },
  log: {
    min: 1,
    max: 1,
    apply: ([x], name) => (x <= 0 ? fail({ kind: "bad_arguments", token: name }) : Math.log10(x)),
  },
  ln: {
    min: 1,
    max: 1,
    apply: ([x], name) => (x <= 0 ? fail({ kind: "bad_arguments", token: name }) : Math.log(x)),
  },
  exp: { min: 1, max: 1, apply: ([x]) => Math.exp(x) },
  sin: { min: 1, max: 1, apply: ([x]) => Math.sin(x) },
  cos: { min: 1, max: 1, apply: ([x]) => Math.cos(x) },
  tan: { min: 1, max: 1, apply: ([x]) => Math.tan(x) },
};

// ── Parser ──────────────────────────────────────────────────────────────────

class Parser {
  private at = 0;
  private depth = 0;
  /** The normalised expression, rebuilt from what was actually parsed. */
  readonly out: string[] = [];

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    if (this.tokens.length === 0) fail({ kind: "empty" });
    const value = this.expression();
    const extra = this.peek();
    if (extra) fail({ kind: "unexpected", token: extra.text });
    return value;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.at + offset];
  }

  private isOp(token: Token | undefined, text: string): boolean {
    return token?.type === "op" && token.text === text;
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > CALC_MAX_DEPTH) fail({ kind: "too_deep" });
  }

  private leave(): void {
    this.depth -= 1;
  }

  private expect(text: ")" | ","): void {
    const token = this.peek();
    if (!this.isOp(token, text)) fail({ kind: "expected", token: text });
    this.at += 1;
    this.out.push(text);
  }

  // expression := term (("+" | "-") term)*
  private expression(): number {
    this.enter();
    let value = this.term();
    for (;;) {
      const token = this.peek();
      if (this.isOp(token, "+") || this.isOp(token, "-")) {
        this.at += 1;
        this.out.push(token!.text);
        const right = this.term();
        value = token!.text === "+" ? value + right : value - right;
        continue;
      }
      break;
    }
    this.leave();
    return value;
  }

  // term := unary (("*" | "/" | "%" binary | implicit) unary)*
  private term(): number {
    let value = this.unary();
    for (;;) {
      const token = this.peek();
      if (this.isOp(token, "*") || this.isOp(token, "/")) {
        this.at += 1;
        this.out.push(token!.text);
        const right = this.unary();
        if (token!.text === "/") {
          if (right === 0) fail({ kind: "division_by_zero", token: "/" });
          value /= right;
        } else {
          value *= right;
        }
        continue;
      }
      if (this.isOp(token, "%") && this.startsOperand(this.peek(1))) {
        // Binary: `10 % 3`. A `%` followed by nothing, an operator or `)` is a
        // percentage and was taken by `postfix`.
        this.at += 1;
        this.out.push("%");
        const right = this.unary();
        if (right === 0) fail({ kind: "division_by_zero", token: "%" });
        value %= right;
        continue;
      }
      // Implicit multiplication: `2pi`, `3(4+1)`, `(1+2)(3+4)`.
      if (token && (token.type === "name" || this.isOp(token, "("))) {
        this.out.push("*");
        value *= this.unary();
        continue;
      }
      break;
    }
    return value;
  }

  private startsOperand(token: Token | undefined): boolean {
    return !!token && (token.type === "number" || token.type === "name" || this.isOp(token, "("));
  }

  // unary := ("-" | "+") unary | power      (so -2^2 is -(2^2), as on paper)
  private unary(): number {
    const token = this.peek();
    if (this.isOp(token, "-") || this.isOp(token, "+")) {
      this.at += 1;
      this.out.push(token!.text);
      this.enter();
      const value = this.unary();
      this.leave();
      return token!.text === "-" ? -value : value;
    }
    return this.power();
  }

  // power := postfix ("^" unary)?           (right-associative through unary)
  private power(): number {
    const base = this.postfix();
    if (this.isOp(this.peek(), "^")) {
      this.at += 1;
      this.out.push("^");
      this.enter();
      const exponent = this.unary();
      this.leave();
      const value = base ** exponent;
      if (Number.isNaN(value)) fail({ kind: "bad_arguments", token: "^" });
      return value;
    }
    return base;
  }

  // postfix := primary "%"?                  (a percentage: 15% = 0.15)
  private postfix(): number {
    let value = this.primary();
    while (this.isOp(this.peek(), "%") && !this.startsOperand(this.peek(1))) {
      this.at += 1;
      this.out.push("%");
      value /= 100;
    }
    return value;
  }

  // primary := number | constant | name "(" args ")" | "(" expression ")"
  private primary(): number {
    const token = this.peek();
    if (!token) fail({ kind: "expected", token: "a number" });
    if (token.type === "number") {
      this.at += 1;
      this.out.push(token.text);
      return token.value;
    }
    if (token.type === "name") {
      this.at += 1;
      const name = token.text.toLowerCase();
      const fn = Object.prototype.hasOwnProperty.call(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
      if (fn && this.isOp(this.peek(), "(")) {
        this.at += 1;
        this.out.push(name, "(");
        this.enter();
        const args: number[] = [this.expression()];
        while (this.isOp(this.peek(), ",")) {
          this.at += 1;
          this.out.push(",");
          args.push(this.expression());
        }
        this.expect(")");
        this.leave();
        if (args.length < fn.min || args.length > fn.max) fail({ kind: "bad_arguments", token: name });
        return fn.apply(args, name);
      }
      const constant = Object.prototype.hasOwnProperty.call(CONSTANTS, name) ? CONSTANTS[name] : undefined;
      if (constant !== undefined) {
        this.out.push(name);
        return constant;
      }
      fail({ kind: "unknown_name", token: token.text });
    }
    if (this.isOp(token, "(")) {
      this.at += 1;
      this.out.push("(");
      this.enter();
      const value = this.expression();
      this.expect(")");
      this.leave();
      return value;
    }
    fail({ kind: "unexpected", token: token.text });
  }
}

// ── Units ───────────────────────────────────────────────────────────────────

type Dimension = "length" | "mass" | "volume" | "temperature" | "speed" | "area" | "time" | "data";

interface Unit {
  symbol: string;
  dimension: Dimension;
  /** Multiply by this to reach the dimension's base unit (not used for temperature). */
  factor: number;
}

const UNIT_ROWS: Array<[Dimension, string, number, string[]]> = [
  // length, base metre
  ["length", "m", 1, ["m", "meter", "meters", "metre", "metres"]],
  ["length", "km", 1_000, ["km", "kilometer", "kilometers", "kilometre", "kilometres"]],
  ["length", "cm", 0.01, ["cm", "centimeter", "centimeters", "centimetre", "centimetres"]],
  ["length", "mm", 0.001, ["mm", "millimeter", "millimeters", "millimetre", "millimetres"]],
  ["length", "mi", 1_609.344, ["mi", "mile", "miles"]],
  ["length", "yd", 0.9144, ["yd", "yard", "yards"]],
  ["length", "ft", 0.3048, ["ft", "foot", "feet"]],
  ["length", "in", 0.0254, ["in", "inch", "inches"]],
  ["length", "nmi", 1_852, ["nmi", "nauticalmile", "nauticalmiles"]],
  // mass, base kilogram
  ["mass", "kg", 1, ["kg", "kilogram", "kilograms", "kilo", "kilos"]],
  ["mass", "g", 0.001, ["g", "gram", "grams"]],
  ["mass", "mg", 0.000_001, ["mg", "milligram", "milligrams"]],
  ["mass", "t", 1_000, ["t", "tonne", "tonnes", "ton", "tons"]],
  ["mass", "lb", 0.453_592_37, ["lb", "lbs", "pound", "pounds"]],
  ["mass", "oz", 0.028_349_523_125, ["oz", "ounce", "ounces"]],
  ["mass", "st", 6.350_293_18, ["st", "stone", "stones"]],
  // volume, base litre
  ["volume", "l", 1, ["l", "liter", "liters", "litre", "litres"]],
  ["volume", "ml", 0.001, ["ml", "milliliter", "milliliters", "millilitre", "millilitres"]],
  ["volume", "m3", 1_000, ["m3", "m³", "cubicmeter", "cubicmeters", "cubicmetre", "cubicmetres"]],
  ["volume", "gal", 3.785_411_784, ["gal", "gallon", "gallons"]],
  ["volume", "qt", 0.946_352_946, ["qt", "quart", "quarts"]],
  ["volume", "pt", 0.473_176_473, ["pt", "pint", "pints"]],
  ["volume", "cup", 0.236_588_236_5, ["cup", "cups"]],
  ["volume", "floz", 0.029_573_529_562_5, ["floz", "fl_oz", "fluidounce", "fluidounces"]],
  // speed, base metre per second
  ["speed", "m/s", 1, ["m/s", "mps"]],
  ["speed", "km/h", 1 / 3.6, ["km/h", "kmh", "kph"]],
  ["speed", "mph", 0.447_04, ["mph", "mi/h"]],
  ["speed", "kn", 1_852 / 3_600, ["kn", "knot", "knots"]],
  // area, base square metre
  ["area", "m2", 1, ["m2", "m²", "sqm"]],
  ["area", "km2", 1_000_000, ["km2", "km²"]],
  ["area", "ha", 10_000, ["ha", "hectare", "hectares"]],
  ["area", "acre", 4_046.856_422_4, ["acre", "acres"]],
  ["area", "ft2", 0.092_903_04, ["ft2", "ft²", "sqft"]],
  ["area", "mi2", 2_589_988.110_336, ["mi2", "mi²", "sqmi"]],
  // time, base second
  ["time", "s", 1, ["s", "sec", "secs", "second", "seconds"]],
  ["time", "ms", 0.001, ["ms", "millisecond", "milliseconds"]],
  ["time", "min", 60, ["min", "mins", "minute", "minutes"]],
  ["time", "h", 3_600, ["h", "hr", "hrs", "hour", "hours"]],
  ["time", "day", 86_400, ["d", "day", "days"]],
  ["time", "week", 604_800, ["wk", "week", "weeks"]],
  ["time", "year", 31_557_600, ["yr", "year", "years"]],
  // data, base byte
  ["data", "B", 1, ["b", "byte", "bytes"]],
  ["data", "bit", 1 / 8, ["bit", "bits"]],
  ["data", "KB", 1e3, ["kb", "kilobyte", "kilobytes"]],
  ["data", "MB", 1e6, ["mb", "megabyte", "megabytes"]],
  ["data", "GB", 1e9, ["gb", "gigabyte", "gigabytes"]],
  ["data", "TB", 1e12, ["tb", "terabyte", "terabytes"]],
  ["data", "KiB", 1_024, ["kib", "kibibyte", "kibibytes"]],
  ["data", "MiB", 1_024 ** 2, ["mib", "mebibyte", "mebibytes"]],
  ["data", "GiB", 1_024 ** 3, ["gib", "gibibyte", "gibibytes"]],
  ["data", "TiB", 1_024 ** 4, ["tib", "tebibyte", "tebibytes"]],
  // temperature: converted by formula, factor unused
  ["temperature", "C", 1, ["c", "°c", "celsius", "degc"]],
  ["temperature", "F", 1, ["f", "°f", "fahrenheit", "degf"]],
  ["temperature", "K", 1, ["k", "kelvin", "kelvins"]],
];

const UNITS: ReadonlyMap<string, Unit> = new Map(
  UNIT_ROWS.flatMap(([dimension, symbol, factor, names]) =>
    names.map((name) => [name.toLowerCase(), { symbol, dimension, factor }] as const),
  ),
);

function unitFor(raw: string): Unit {
  const unit = UNITS.get(raw.toLowerCase());
  if (!unit) fail({ kind: "unknown_unit", token: raw });
  return unit;
}

function toKelvin(value: number, symbol: string): number {
  if (symbol === "C") return value + 273.15;
  if (symbol === "F") return (value - 32) * (5 / 9) + 273.15;
  return value;
}

function fromKelvin(value: number, symbol: string): number {
  if (symbol === "C") return value - 273.15;
  if (symbol === "F") return (value - 273.15) * (9 / 5) + 32;
  return value;
}

function convert(value: number, from: Unit, to: Unit): number {
  if (from.dimension !== to.dimension) fail({ kind: "incompatible_units", from: from.symbol, to: to.symbol });
  if (from.dimension === "temperature") return fromKelvin(toKelvin(value, from.symbol), to.symbol);
  return (value * from.factor) / to.factor;
}

/** `<expression> <unit> to|in|as <unit>`, split before any arithmetic is parsed. */
const CONVERSION = /^(.*?)\s*(°?[A-Za-z][A-Za-z0-9/²³_]*)\s+(?:to|in|as|into)\s+(°?[A-Za-z][A-Za-z0-9/²³_]*)\s*$/;

// ── Entry ───────────────────────────────────────────────────────────────────

function round12(value: number): number {
  if (value === 0) return 0; // also turns -0 into 0
  return Number(value.toPrecision(SIGNIFICANT_DIGITS));
}

function evaluateArithmetic(source: string): { value: number; expression: string } {
  const parser = new Parser(tokenize(source));
  const value = parser.parse();
  return { value, expression: parser.out.join("") };
}

export function calculate(input: string): CalcResult {
  try {
    const source = typeof input === "string" ? input.trim() : "";
    if (source.length > CALC_MAX_INPUT_CHARS) fail({ kind: "too_long" });
    if (!source) fail({ kind: "empty" });

    const conversion = CONVERSION.exec(source);
    if (conversion && UNITS.has(conversion[3].toLowerCase()) && UNITS.has(conversion[2].toLowerCase())) {
      const from = unitFor(conversion[2]);
      const to = unitFor(conversion[3]);
      const amount = conversion[1].trim() ? evaluateArithmetic(conversion[1]) : { value: 1, expression: "1" };
      const value = round12(convert(amount.value, from, to));
      if (!Number.isFinite(value)) fail({ kind: "not_finite" });
      return {
        ok: true,
        value,
        formatted: String(value),
        expression: `${amount.expression} ${from.symbol} to ${to.symbol}`,
        unit: to.symbol,
      };
    }
    if (conversion && UNITS.has(conversion[2].toLowerCase())) {
      // "5 km to parsecs": the source unit is known, so the target is the one to name.
      unitFor(conversion[3]);
    }

    const { value: raw, expression } = evaluateArithmetic(source);
    const value = round12(raw);
    if (!Number.isFinite(value)) fail({ kind: "not_finite" });
    return { ok: true, value, formatted: String(value), expression };
  } catch (error) {
    if (error instanceof CalcFailure) return { ok: false, error: error.error };
    if (error instanceof RangeError) return { ok: false, error: { kind: "too_deep" } };
    throw error;
  }
}
