/**
 * Math, laid out in CSS.
 *
 * KaTeX is not a dependency of this package and cannot be fetched — so the
 * honest options were "render `$x^2$` as the literal characters `$x^2$`" or
 * "implement the subset of TeX that actually appears in chat replies". This is
 * the second.
 *
 * WHAT IS SUPPORTED, and it is a deliberate line rather than a to-do list:
 * fractions, superscripts and subscripts (including the both-at-once case that
 * `\sum_{i=1}^{n}` needs), radicals with an optional index, the Greek alphabet,
 * the common relations and operators, big operators with limits, `\text` and
 * the font commands, and `\left…\right` sizing. That covers essentially every
 * expression a model writes inline in prose.
 *
 * WHAT IS NOT: matrices, alignment environments, `\begin{…}`, stacked
 * accents, and anything requiring real metric-driven kerning. Those fall back
 * to their source text in a monospace face — visibly *unrendered*, which is the
 * correct failure. Silently dropping a term the reader cannot see is missing
 * would be much worse than showing them the TeX.
 *
 * The layout uses grid and flexbox with `em`-relative sizing throughout, so the
 * whole expression scales with the surrounding type and inherits `currentColor`
 * — no hardcoded sizes, no colours, and nothing that breaks when the transcript
 * is rendered at a different body size.
 */

import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

/* -------------------------------------------------------------------------- */
/* Symbol table                                                                */
/* -------------------------------------------------------------------------- */

const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',

  times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '∗', star: '⋆',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', equiv: '≡',
  approx: '≈', sim: '∼', simeq: '≃', cong: '≅', propto: '∝',
  ll: '≪', gg: '≫', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  in: '∈', notin: '∉', ni: '∋', cup: '∪', cap: '∩', setminus: '∖',
  emptyset: '∅', varnothing: '∅', infty: '∞', partial: '∂', nabla: '∇',
  forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
  rightarrow: '→', to: '→', leftarrow: '←', leftrightarrow: '↔',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦',
  ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…',
  angle: '∠', perp: '⊥', parallel: '∥', degree: '°', prime: '′',
  aleph: 'ℵ', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', wp: '℘',
  circ: '∘', bullet: '∙', oplus: '⊕', otimes: '⊗', sqrt: '√',
  quad: ' ', qquad: '  ', ',': ' ', ';': ' ', ':': ' ', '!': '',
};

/** Rendered upright and given breathing room — they are words, not variables. */
const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'det', 'dim', 'ker',
  'deg', 'gcd', 'lcm', 'max', 'min', 'sup', 'inf', 'lim', 'limsup', 'liminf',
  'arg', 'mod', 'Pr',
]);

/** Large operators: they grow, and their sub/superscripts sit under and over. */
const BIG_OPERATORS: Record<string, string> = {
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭',
  oint: '∮', bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂',
};

const FONT_COMMANDS = new Set(['text', 'textrm', 'mathrm', 'mathbf', 'textbf', 'mathit', 'mathbb', 'mathcal', 'operatorname']);

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

type Node =
  | { readonly t: 'row'; readonly children: readonly Node[] }
  | { readonly t: 'atom'; readonly text: string; readonly italic: boolean }
  | { readonly t: 'op'; readonly text: string; readonly big: boolean }
  | { readonly t: 'frac'; readonly num: Node; readonly den: Node }
  | { readonly t: 'script'; readonly base: Node; readonly sub: Node | null; readonly sup: Node | null }
  | { readonly t: 'sqrt'; readonly radicand: Node; readonly index: Node | null }
  | { readonly t: 'fenced'; readonly open: string; readonly close: string; readonly body: Node }
  | { readonly t: 'styled'; readonly className: string; readonly body: Node }
  | { readonly t: 'space'; readonly em: number };

/** Signals "this exceeds the supported subset" — the caller shows source instead. */
class Unsupported extends Error {}

class Parser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): Node {
    const row = this.parseRow(null);
    if (this.index < this.source.length) throw new Unsupported('trailing input');
    return row;
  }

  /** Parse until `stop` (a closing delimiter) or end of input. */
  private parseRow(stop: string | null): Node {
    const children: Node[] = [];
    while (this.index < this.source.length) {
      if (stop !== null && this.peekIs(stop)) break;
      if (this.source[this.index] === '}') break;
      const node = this.parseScripted();
      if (node !== null) children.push(node);
    }
    return children.length === 1 ? (children[0] as Node) : { t: 'row', children };
  }

  /** One unit plus any `^`/`_` attached to it, in either order. */
  private parseScripted(): Node | null {
    const base = this.parseUnit();
    if (base === null) return null;

    let sub: Node | null = null;
    let sup: Node | null = null;
    for (;;) {
      this.skipSpaces();
      const next = this.source[this.index];
      if (next === '^' && sup === null) {
        this.index += 1;
        sup = this.parseUnit() ?? { t: 'row', children: [] };
        continue;
      }
      if (next === '_' && sub === null) {
        this.index += 1;
        sub = this.parseUnit() ?? { t: 'row', children: [] };
        continue;
      }
      break;
    }

    if (sub === null && sup === null) return base;
    return { t: 'script', base, sub, sup };
  }

  private parseUnit(): Node | null {
    this.skipSpaces();
    const character = this.source[this.index];
    if (character === undefined) return null;

    if (character === '{') {
      this.index += 1;
      const body = this.parseRow(null);
      this.expect('}');
      return body;
    }

    if (character === '\\') return this.parseCommand();

    if (character === '^' || character === '_') {
      /* A script with nothing to attach to — malformed. */
      throw new Unsupported('dangling script');
    }

    this.index += 1;

    if (/[0-9]/.test(character)) {
      let digits = character;
      while (this.index < this.source.length && /[0-9.]/.test(this.source[this.index] ?? '')) {
        digits += this.source[this.index];
        this.index += 1;
      }
      return { t: 'atom', text: digits, italic: false };
    }

    /* Single letters are variables and therefore italic — the one typographic
       convention that makes maths readable as maths. */
    if (/[A-Za-z]/.test(character)) return { t: 'atom', text: character, italic: true };

    if ('+-=<>*/'.includes(character)) {
      const glyph = character === '-' ? '−' : character === '*' ? '∗' : character;
      return { t: 'op', text: glyph, big: false };
    }

    if ('()[]|'.includes(character)) return { t: 'atom', text: character, italic: false };

    return { t: 'atom', text: character, italic: false };
  }

  private parseCommand(): Node {
    this.index += 1; /* the backslash */
    const name = this.readCommandName();

    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
      return { t: 'frac', num: this.parseGroup(), den: this.parseGroup() };
    }

    if (name === 'sqrt') {
      let index: Node | null = null;
      this.skipSpaces();
      if (this.source[this.index] === '[') {
        this.index += 1;
        index = this.parseRow(']');
        this.expect(']');
      }
      return { t: 'sqrt', radicand: this.parseGroup(), index };
    }

    if (name === 'left') {
      const open = this.readDelimiter();
      const body = this.parseRow('\\right');
      this.expectCommand('right');
      const close = this.readDelimiter();
      return { t: 'fenced', open, close, body };
    }

    if (FONT_COMMANDS.has(name)) {
      const body = this.parseGroup();
      const className =
        name === 'mathbf' || name === 'textbf'
          ? 'font-semibold not-italic'
          : name === 'mathit'
            ? 'italic'
            : name === 'mathbb'
              ? 'font-serif not-italic'
              : 'not-italic';
      return { t: 'styled', className, body };
    }

    const big = BIG_OPERATORS[name];
    if (big !== undefined) return { t: 'op', text: big, big: true };

    if (FUNCTIONS.has(name)) return { t: 'atom', text: name, italic: false };

    const symbol = SYMBOLS[name];
    if (symbol !== undefined) {
      if (name === 'quad' || name === 'qquad') return { t: 'space', em: name === 'quad' ? 1 : 2 };
      if (name === ',' || name === ';' || name === ':') return { t: 'space', em: 0.22 };
      if (name === '!') return { t: 'space', em: -0.16 };
      return { t: 'atom', text: symbol, italic: false };
    }

    if (name === '\\') return { t: 'space', em: 0 };

    /* An unknown command means the expression uses something outside the
       supported subset. Bail out entirely rather than rendering a partially
       wrong formula — half-rendered maths is indistinguishable from correct
       maths that says something else. */
    throw new Unsupported(`\\${name}`);
  }

  private parseGroup(): Node {
    this.skipSpaces();
    if (this.source[this.index] === '{') {
      this.index += 1;
      const body = this.parseRow(null);
      this.expect('}');
      return body;
    }
    return this.parseUnit() ?? { t: 'row', children: [] };
  }

  private readCommandName(): string {
    const rest = this.source.slice(this.index);
    const letters = /^[A-Za-z]+/.exec(rest);
    if (letters) {
      this.index += letters[0].length;
      return letters[0];
    }
    const single = this.source[this.index] ?? '';
    this.index += 1;
    return single;
  }

  private readDelimiter(): string {
    this.skipSpaces();
    if (this.source[this.index] === '\\') {
      this.index += 1;
      /* `\left\{`, `\left\langle` and friends. */
      const name = this.readCommandName();
      if (name === '{') return '{';
      if (name === '}') return '}';
      return SYMBOLS[name] ?? '';
    }
    const character = this.source[this.index] ?? '';
    this.index += 1;
    /* `\left.` is an explicitly empty delimiter — used to get a lone `\right)`. */
    return character === '.' ? '' : character;
  }

  private peekIs(text: string): boolean {
    return this.source.startsWith(text, this.index);
  }

  private expect(character: string): void {
    if (this.source[this.index] !== character) throw new Unsupported(`expected ${character}`);
    this.index += 1;
  }

  private expectCommand(name: string): void {
    this.skipSpaces();
    if (!this.source.startsWith(`\\${name}`, this.index)) throw new Unsupported(`expected \\${name}`);
    this.index += name.length + 1;
  }

  private skipSpaces(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index] ?? '')) this.index += 1;
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

function render(node: Node, key: number): ReactNode {
  switch (node.t) {
    case 'row':
      return (
        <span key={key} className="inline-flex items-center">
          {node.children.map((child, index) => render(child, index))}
        </span>
      );

    case 'atom':
      return (
        <span key={key} className={node.italic ? 'italic' : undefined}>
          {node.text}
        </span>
      );

    case 'op':
      return (
        <span
          key={key}
          className={cn('inline-block', node.big ? 'mx-0.5 text-[1.45em] leading-none' : 'mx-[0.22em]')}
        >
          {node.text}
        </span>
      );

    case 'space':
      return <span key={key} style={{ display: 'inline-block', width: `${node.em}em` }} />;

    case 'styled':
      return (
        <span key={key} className={node.className}>
          {render(node.body, 0)}
        </span>
      );

    case 'frac':
      /* A real fraction: two stacked rows with a hairline between them, the
         whole thing shifted so the rule sits on the text's mathematical axis
         rather than on the baseline. */
      return (
        <span key={key} className="inline-flex flex-col items-center px-[0.18em] align-middle text-[0.92em] leading-tight">
          <span className="px-[0.2em] pb-[0.1em]">{render(node.num, 0)}</span>
          <span className="h-px w-full bg-current" />
          <span className="px-[0.2em] pt-[0.1em]">{render(node.den, 1)}</span>
        </span>
      );

    case 'sqrt':
      return (
        <span key={key} className="inline-flex items-stretch">
          {node.index ? (
            <span className="self-start text-[0.62em] leading-none">{render(node.index, 0)}</span>
          ) : null}
          <span className="mr-[-0.08em] text-[1.1em] leading-none">√</span>
          <span className="border-t border-current pl-[0.12em] pr-[0.12em] pt-[0.12em]">
            {render(node.radicand, 1)}
          </span>
        </span>
      );

    case 'fenced':
      /* `scaleY` rather than a font-size bump: the delimiter has to match the
         height of what it encloses, and only the vertical axis should stretch. */
      return (
        <span key={key} className="inline-flex items-center">
          {node.open ? <span className="inline-block origin-center scale-y-[1.35]">{node.open}</span> : null}
          <span className="px-[0.08em]">{render(node.body, 0)}</span>
          {node.close ? <span className="inline-block origin-center scale-y-[1.35]">{node.close}</span> : null}
        </span>
      );

    case 'script': {
      const isBig = node.base.t === 'op' && node.base.big;
      if (isBig) {
        /* Limits go under and over a big operator, which is the whole visual
           point of writing `\sum_{i=1}^{n}` rather than `sum(i=1..n)`. */
        return (
          <span key={key} className="inline-flex flex-col items-center px-[0.1em] align-middle leading-none">
            {node.sup ? <span className="text-[0.62em] leading-none">{render(node.sup, 0)}</span> : null}
            {render(node.base, 1)}
            {node.sub ? <span className="text-[0.62em] leading-none">{render(node.sub, 2)}</span> : null}
          </span>
        );
      }
      return (
        <span key={key} className="inline-flex items-center">
          {render(node.base, 0)}
          <span className="inline-flex flex-col items-start justify-center text-[0.68em] leading-[1.05]">
            {node.sup ? <span className="translate-y-[-0.15em]">{render(node.sup, 1)}</span> : <span />}
            {node.sub ? <span className="translate-y-[0.15em]">{render(node.sub, 2)}</span> : null}
          </span>
        </span>
      );
    }
  }
}

export interface MathProps {
  readonly tex: string;
  readonly display?: boolean;
  readonly className?: string;
}

/**
 * Render a TeX expression, or its source if it is outside the subset.
 *
 * The fallback is styled as code rather than as prose, so it is unmistakably
 * "this did not render" rather than looking like the author wrote dollar signs
 * on purpose. `title` carries the reason for anyone hovering it.
 */
export function Math({ tex, display = false, className }: MathProps): ReactNode {
  let content: ReactNode;
  try {
    content = render(new Parser(tex).parse(), 0);
  } catch (error: unknown) {
    const reason = error instanceof Unsupported ? `Unsupported TeX: ${error.message}` : 'Could not render this expression.';
    return (
      <code
        title={reason}
        className={cn(
          'rounded-xs bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-muted-foreground',
          display && 'my-3 block overflow-x-auto px-3 py-2',
          className,
        )}
      >
        {display ? `$$${tex}$$` : `$${tex}$`}
      </code>
    );
  }

  if (display) {
    return (
      <div
        role="math"
        aria-label={tex}
        className={cn('my-4 overflow-x-auto py-1 text-center text-body-lg', className)}
      >
        <span className="inline-flex items-center">{content}</span>
      </div>
    );
  }

  return (
    <span role="math" aria-label={tex} className={cn('inline-flex items-center align-middle', className)}>
      {content}
    </span>
  );
}
