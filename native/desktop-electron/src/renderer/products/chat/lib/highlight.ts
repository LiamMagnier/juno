/**
 * Syntax highlighting, from scratch.
 *
 * Neither Shiki nor Prism nor highlight.js is a dependency of this package, and
 * a code block in a chat transcript is not worth 1–3 MB of grammar payload plus
 * a WASM regex engine. What a transcript actually needs is: comments recede,
 * strings and numbers are distinguishable at a glance, keywords give the eye a
 * skeleton to hang the structure on. That is four colours and a lexer, and this
 * is the lexer.
 *
 * The design constraints that shaped it:
 *
 *   · **One pass, one regex per language.** Each grammar compiles to a single
 *     alternation scanned with `lastIndex`; text between matches is emitted as
 *     plain. That is linear in the source and has no backtracking cliff, which
 *     matters because this runs on the tail of a *streaming* code fence and may
 *     be called many times per second.
 *   · **Every sub-pattern is non-capturing.** Group N of the combined regex is
 *     rule N-1, so a stray `(` inside a pattern would silently misattribute
 *     every token after it. `compile` asserts against it in development.
 *   · **Unknown languages are not an error.** They fall through to a grammar
 *     that still finds strings, numbers and `#`/`//` comments, which is most of
 *     the value for a language nobody wrote a table for.
 *
 * Deliberately NOT attempted: context-sensitive lexing. A regex alternation
 * cannot know that `/` is division rather than a regex literal, or that a `>`
 * closes a JSX tag. Those cases mis-colour a token; they never break the
 * output, because the tokens are re-joined verbatim and the concatenation of
 * every token's text always equals the input.
 */

/**
 * The palette, as roles rather than colours.
 *
 * Four hues in total. A transcript that highlights nine token classes competes
 * with the prose around it; the point of code in a chat reply is to be read,
 * not to look like an IDE screenshot.
 */
export type TokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'type'
  | 'function'
  | 'property'
  | 'operator'
  | 'punctuation'
  | 'variable';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

interface Rule {
  readonly kind: TokenKind;
  /** MUST contain only non-capturing groups. See the header. */
  readonly pattern: string;
}

interface Grammar {
  readonly rules: readonly Rule[];
  /** Lazily built on first use; grammars are module-level and long-lived. */
  compiled?: RegExp;
}

/* -------------------------------------------------------------------------- */
/* Shared fragments                                                            */
/* -------------------------------------------------------------------------- */

const C_LINE_COMMENT = String.raw`//[^\n]*`;
const C_BLOCK_COMMENT = String.raw`/\*[\s\S]*?(?:\*/|$)`;
const HASH_COMMENT = String.raw`#[^\n]*`;
/* The trailing `|$` on every string alternative is what makes an *unterminated*
   string — the normal state of a code fence mid-stream — highlight as a string
   to the end of the line instead of leaving the rest of the block plain. */
const DQ_STRING = String.raw`"(?:[^"\\\n]|\\.)*(?:"|$)`;
const SQ_STRING = String.raw`'(?:[^'\\\n]|\\.)*(?:'|$)`;
const BACKTICK_STRING = String.raw`\`(?:[^\`\\]|\\.)*(?:\`|$)`;
const NUMBER = String.raw`\b(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b`;
const OPERATOR = String.raw`[+\-*/%=<>!&|^~?]+`;
const PUNCTUATION = String.raw`[{}()\[\];,.:]`;

function words(list: string): string {
  return String.raw`\b(?:${list})\b`;
}

/* -------------------------------------------------------------------------- */
/* Grammars                                                                    */
/* -------------------------------------------------------------------------- */

const TS_KEYWORDS =
  'abstract|as|asserts|async|await|break|case|catch|class|const|continue|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|is|keyof|let|namespace|new|of|override|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|try|type|typeof|var|void|while|yield|true|false|null|undefined';

const typescript: Grammar = {
  rules: [
    { kind: 'comment', pattern: `${C_LINE_COMMENT}|${C_BLOCK_COMMENT}` },
    { kind: 'string', pattern: `${DQ_STRING}|${SQ_STRING}|${BACKTICK_STRING}` },
    { kind: 'number', pattern: NUMBER },
    { kind: 'keyword', pattern: words(TS_KEYWORDS) },
    /* Before `function`, so `Foo(` reads as a constructor rather than a call. */
    { kind: 'type', pattern: String.raw`\b[A-Z][A-Za-z0-9_]*\b` },
    { kind: 'function', pattern: String.raw`\b[a-zA-Z_$][\w$]*(?=\s*\()` },
    { kind: 'property', pattern: String.raw`(?<=\.)\s*[a-zA-Z_$][\w$]*` },
    { kind: 'operator', pattern: OPERATOR },
    { kind: 'punctuation', pattern: PUNCTUATION },
  ],
};

const PY_KEYWORDS =
  'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|True|False|None|self|cls|match|case';

const python: Grammar = {
  rules: [
    { kind: 'comment', pattern: HASH_COMMENT },
    {
      kind: 'string',
      pattern: String.raw`[rbfu]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|${DQ_STRING}|${SQ_STRING})`,
    },
    { kind: 'number', pattern: NUMBER },
    { kind: 'keyword', pattern: words(PY_KEYWORDS) },
    { kind: 'variable', pattern: String.raw`@[A-Za-z_][\w.]*` },
    { kind: 'type', pattern: String.raw`\b[A-Z][A-Za-z0-9_]*\b` },
    { kind: 'function', pattern: String.raw`\b[a-zA-Z_][\w]*(?=\s*\()` },
    { kind: 'operator', pattern: OPERATOR },
    { kind: 'punctuation', pattern: PUNCTUATION },
  ],
};

const json: Grammar = {
  rules: [
    /* The key rule must precede the generic string rule or every key is a
       string, which is exactly the distinction that makes JSON readable. */
    { kind: 'property', pattern: String.raw`"(?:[^"\\]|\\.)*"(?=\s*:)` },
    { kind: 'string', pattern: DQ_STRING },
    { kind: 'number', pattern: String.raw`-?\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b` },
    { kind: 'keyword', pattern: words('true|false|null') },
    { kind: 'punctuation', pattern: PUNCTUATION },
  ],
};

const SHELL_KEYWORDS =
  'if|then|elif|else|fi|for|while|until|do|done|case|esac|function|return|in|select|time|export|local|readonly|declare|source|alias|set|unset|trap|shift|exit';

const shell: Grammar = {
  rules: [
    { kind: 'comment', pattern: HASH_COMMENT },
    { kind: 'string', pattern: `${DQ_STRING}|${SQ_STRING}` },
    { kind: 'variable', pattern: String.raw`\$(?:\{[^}]*\}|[A-Za-z_][\w]*|[@*#?$!0-9])` },
    { kind: 'keyword', pattern: words(SHELL_KEYWORDS) },
    /* The command word: first token on a line or after a pipe/`&&`/`;`. */
    { kind: 'function', pattern: String.raw`(?<=^|[|&;]\s*)\s*[a-zA-Z_][\w.-]*` },
    { kind: 'operator', pattern: String.raw`(?:\|\||&&|[|&<>]|--?[A-Za-z][\w-]*)` },
    { kind: 'number', pattern: NUMBER },
    { kind: 'punctuation', pattern: PUNCTUATION },
  ],
};

const css: Grammar = {
  rules: [
    { kind: 'comment', pattern: C_BLOCK_COMMENT },
    { kind: 'string', pattern: `${DQ_STRING}|${SQ_STRING}` },
    { kind: 'keyword', pattern: String.raw`@[a-zA-Z-]+` },
    { kind: 'variable', pattern: String.raw`--[a-zA-Z0-9-]+` },
    { kind: 'property', pattern: String.raw`[a-zA-Z-]+(?=\s*:)` },
    { kind: 'number', pattern: String.raw`#[0-9a-fA-F]{3,8}\b|\b\d*\.?\d+(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\b` },
    { kind: 'type', pattern: String.raw`(?:::?[a-zA-Z-]+|\.[a-zA-Z][\w-]*|#[a-zA-Z][\w-]*)` },
    { kind: 'punctuation', pattern: PUNCTUATION },
  ],
};

const markup: Grammar = {
  rules: [
    { kind: 'comment', pattern: String.raw`<!--[\s\S]*?(?:-->|$)` },
    { kind: 'keyword', pattern: String.raw`<\/?[a-zA-Z][\w:-]*|\/?>` },
    { kind: 'string', pattern: `${DQ_STRING}|${SQ_STRING}` },
    { kind: 'property', pattern: String.raw`[a-zA-Z-][\w:-]*(?=\s*=)` },
    { kind: 'operator', pattern: '=' },
  ],
};

const RUST_KEYWORDS =
  'as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while';

const rust: Grammar = {
  rules: [
    { kind: 'comment', pattern: `${C_LINE_COMMENT}|${C_BLOCK_COMMENT}` },
    { kind: 'string', pattern: `${DQ_STRING}|${SQ_STRING}` },
    { kind: 'number', pattern: NUMBER },
    { kind: 'keyword', pattern: words(RUST_KEYWORDS) },
    { kind: 'variable', pattern: String.raw`#!?\[[^\]]*\]|'[a-z_]\w*` },
    { kind: 'type', pattern: String.raw`\b[A-Z][A-Za-z0-9_]*\b` },
    { kind: 'function', pattern: String.raw`\b[a-z_][\w]*(?=\s*(?:::<[^>]*>)?\()` },
    { kind: 'operator', pattern: OPERATOR },
    { kind: 'punctuation', pattern: PUNCTUATION },
  ],
};

const GO_KEYWORDS =
  'break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var|nil|true|false';

const go: Grammar = {
  rules: [
    { kind: 'comment', pattern: `${C_LINE_COMMENT}|${C_BLOCK_COMMENT}` },
    { kind: 'string', pattern: `${DQ_STRING}|${BACKTICK_STRING}|${SQ_STRING}` },
    { kind: 'number', pattern: NUMBER },
    { kind: 'keyword', pattern: words(GO_KEYWORDS) },
    { kind: 'type', pattern: words('string|int|int8|int16|int32|int64|uint|uint8|uint32|uint64|byte|rune|float32|float64|bool|error|any') },
    { kind: 'function', pattern: String.raw`\b[a-zA-Z_][\w]*(?=\s*\()` },
    { kind: 'operator', pattern: OPERATOR },
    { kind: 'punctuation', pattern: PUNCTUATION },
  ],
};

const SQL_KEYWORDS =
  'select|from|where|insert|into|values|update|set|delete|create|table|alter|drop|index|view|join|inner|left|right|full|outer|on|group|by|order|having|limit|offset|union|all|distinct|as|and|or|not|null|is|in|between|like|case|when|then|else|end|with|returning|primary|key|foreign|references|default|constraint|unique|cascade|asc|desc|count|sum|avg|min|max|coalesce';

const sql: Grammar = {
  rules: [
    { kind: 'comment', pattern: String.raw`--[^\n]*|${C_BLOCK_COMMENT}` },
    { kind: 'string', pattern: SQ_STRING },
    { kind: 'property', pattern: DQ_STRING },
    { kind: 'number', pattern: NUMBER },
    { kind: 'keyword', pattern: String.raw`\b(?:${SQL_KEYWORDS})\b` },
    { kind: 'operator', pattern: OPERATOR },
    { kind: 'punctuation', pattern: PUNCTUATION },
  ],
};

const diff: Grammar = {
  rules: [
    { kind: 'comment', pattern: String.raw`^@@[^\n]*` },
    { kind: 'string', pattern: String.raw`^\+[^\n]*` },
    { kind: 'keyword', pattern: String.raw`^-[^\n]*` },
    { kind: 'property', pattern: String.raw`^(?:diff|index|---|\+\+\+)[^\n]*` },
  ],
};

/** The fallback. Still worth running: comments, strings and numbers cover most of it. */
const generic: Grammar = {
  rules: [
    { kind: 'comment', pattern: `${C_LINE_COMMENT}|${C_BLOCK_COMMENT}|${HASH_COMMENT}` },
    { kind: 'string', pattern: `${DQ_STRING}|${SQ_STRING}|${BACKTICK_STRING}` },
    { kind: 'number', pattern: NUMBER },
    { kind: 'punctuation', pattern: PUNCTUATION },
  ],
};

/**
 * Language aliases, resolved case-insensitively.
 *
 * The keys are what people actually type after the opening fence, which is not
 * the same set as "languages we have grammars for" — `sh`, `zsh`, `console` and
 * `bash` are one grammar, and pretending otherwise means four fences that do
 * not highlight.
 */
const GRAMMARS = new Map<string, Grammar>([
  ['ts', typescript], ['tsx', typescript], ['typescript', typescript],
  ['js', typescript], ['jsx', typescript], ['javascript', typescript],
  ['mjs', typescript], ['cjs', typescript], ['java', typescript],
  ['c', typescript], ['cpp', typescript], ['h', typescript], ['swift', typescript],
  ['kotlin', typescript], ['kt', typescript], ['cs', typescript], ['csharp', typescript],
  ['py', python], ['python', python], ['py3', python],
  ['json', json], ['jsonc', json], ['json5', json],
  ['sh', shell], ['bash', shell], ['zsh', shell], ['shell', shell], ['console', shell], ['fish', shell],
  ['css', css], ['scss', css], ['less', css],
  ['html', markup], ['xml', markup], ['svg', markup], ['vue', markup],
  ['rs', rust], ['rust', rust],
  ['go', go], ['golang', go],
  ['sql', sql], ['postgres', sql], ['postgresql', sql], ['mysql', sql], ['sqlite', sql],
  ['diff', diff], ['patch', diff],
]);

/** Whether a fence's language tag will produce more than the fallback. */
export function hasGrammar(language: string | null): boolean {
  return language !== null && GRAMMARS.has(language.trim().toLowerCase());
}

/**
 * A display name for the fence's badge.
 *
 * Returns the tag the author wrote rather than a canonical name: someone who
 * typed ```tsx wants to see "tsx", and silently relabelling it "TypeScript"
 * makes the badge look like it is describing something other than their fence.
 */
export function languageLabel(language: string | null): string {
  const tag = language?.trim() ?? '';
  return tag.length > 0 ? tag : 'text';
}

function compile(grammar: Grammar): RegExp {
  if (grammar.compiled) return grammar.compiled;
  const source = grammar.rules.map((rule) => `(${rule.pattern})`).join('|');
  /* `m` for the `^`-anchored rules in `diff` and `shell`; `g` for the scan. No
     `s` — a `.` that crosses lines would let a line comment eat the file. */
  const compiled = new RegExp(source, 'gm');
   
  (grammar as { compiled?: RegExp }).compiled = compiled;
  return compiled;
}

/**
 * Tokenize `code` for `language`.
 *
 * Invariant, relied on by the renderer: `tokens.map(t => t.text).join('')`
 * equals `code` exactly, including trailing newlines. Copy-to-clipboard reads
 * the original string rather than the DOM, but selection-and-drag does not, and
 * a lexer that drops a space silently corrupts what the user pastes.
 */
export function tokenize(code: string, language: string | null): readonly Token[] {
  const key = language?.trim().toLowerCase() ?? '';
  const grammar = GRAMMARS.get(key) ?? generic;
  const scanner = compile(grammar);
  const tokens: Token[] = [];

  scanner.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null = scanner.exec(code);

  while (match !== null) {
    if (match.index > cursor) {
      tokens.push({ kind: 'plain', text: code.slice(cursor, match.index) });
    }

    /* Which alternative fired. Every sub-pattern is non-capturing, so group
       i + 1 is rule i — see the header. */
    let kind: TokenKind = 'plain';
    for (let i = 0; i < grammar.rules.length; i += 1) {
      if (match[i + 1] !== undefined) {
        kind = grammar.rules[i]?.kind ?? 'plain';
        break;
      }
    }

    tokens.push({ kind, text: match[0] });
    cursor = match.index + match[0].length;

    /* A zero-length match cannot happen with these grammars, but a future rule
       could introduce one and it would spin forever. Cheap insurance. */
    if (match[0].length === 0) scanner.lastIndex += 1;
    match = scanner.exec(code);
  }

  if (cursor < code.length) tokens.push({ kind: 'plain', text: code.slice(cursor) });
  return tokens;
}

/**
 * The colour for a token kind, as a CSS declaration value.
 *
 * These are inline styles rather than Tailwind classes on purpose, and it is
 * not a shortcut: `--code-string` and `--code-number` are real design tokens
 * that `tailwind.config.ts` does not expose as colour utilities, and the
 * project forbids arbitrary colour values (`text-[#abc]`) — which is the only
 * other way to reach them from a class. Every value below dereferences a token;
 * none of them names a colour.
 *
 * `null` means "inherit", which is the right answer for plain text and keeps
 * the DOM free of a span per word.
 */
export function tokenColor(kind: TokenKind): string | null {
  switch (kind) {
    case 'comment':
      return 'hsl(var(--muted-foreground))';
    case 'string':
      return 'hsl(var(--code-string))';
    case 'number':
      return 'hsl(var(--code-number))';
    case 'keyword':
      return 'hsl(var(--primary-ink))';
    case 'type':
      return 'hsl(var(--source))';
    case 'variable':
      return 'hsl(var(--source))';
    case 'function':
      return 'hsl(var(--foreground))';
    case 'property':
      return 'hsl(var(--foreground))';
    case 'operator':
    case 'punctuation':
      return 'hsl(var(--muted-foreground))';
    case 'plain':
      return null;
  }
}
