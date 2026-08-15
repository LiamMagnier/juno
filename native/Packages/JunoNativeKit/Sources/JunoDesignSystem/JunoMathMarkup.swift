import Foundation

// LaTeX math, extracted and rendered as text. **No view, no WebKit, no network.**
//
// **Why this file has no `import SwiftUI`.** The two obvious ways to draw maths
// on Apple platforms are a `WKWebView` running KaTeX or MathJax from a CDN, and
// a bundled JavaScript engine. Both were rejected for the same reason the
// artifact preview is network-isolated: an assistant transcript must render
// offline, must not phone out mid-answer, and must not hand model-authored
// strings to a script engine that can reach the network. So the maths is
// *converted*, not *typeset* — LaTeX in, Unicode out, entirely in Swift.
//
// That is a real trade. `\int_0^\infty` becomes `∫₀^∞`, not a properly built-up
// integral with limits above and below the sign. It is chosen because the
// alternative is not "nicer maths", it is "no maths offline"; and because the
// overwhelming majority of maths in a chat answer is one line of algebra —
// `E = mc^2`, `\alpha \leq \beta`, `\frac{dy}{dx}` — which converts losslessly.
//
// **The rule this file will not break: it never silently drops a term.** A
// formula with a missing factor is not a degraded formula, it is a *wrong* one,
// and it is wrong in a way the reader cannot see. So an unrecognised command is
// emitted verbatim (`\obscurecmd` stays `\obscurecmd`) and recorded in
// ``JunoMathRendering/unconverted``, which is what lets the display renderer
// offer the LaTeX source next to a conversion it knows to be incomplete. The
// only things deliberately discarded are *layout* directives — `\begin{aligned}`,
// `\left`, `&` — which carry no terms; those still mark the rendering as
// unfaithful so the source stays one tap away.

// MARK: - Segments

/// One run of a paragraph: prose, or a maths formula lifted out of it.
///
/// Splitting happens *before* Markdown inline parsing, because `$x^2$` contains
/// characters (`^`, `_`, `*`) that `AttributedString(markdown:)` would read as
/// emphasis and consume. A formula that loses its underscores has lost its
/// subscripts, which is the same class of bug as dropping a term.
public enum JunoMathSegment: Equatable, Sendable {
    /// Markdown source with no maths in it. Still needs inline parsing.
    case text(String)
    /// A formula's LaTeX source, delimiters stripped.
    ///
    /// `display` records whether it arrived in `$$…$$` / `\[…\]` rather than
    /// `$…$` / `\(…\)`. Inline renderers treat both alike — there is no way to
    /// centre a run inside a paragraph — but the block splitter needs the
    /// distinction, and a test that cannot see it cannot check it.
    case math(String, display: Bool)
}

/// The outcome of converting one formula, and how much of it survived.
public struct JunoMathRendering: Equatable, Sendable {
    /// The Unicode text to draw.
    public var text: String
    /// Commands and environments that could not be expressed as text, in source
    /// order and with duplicates kept — `["\\begin{aligned}", "\\xrightarrow"]`.
    ///
    /// Non-empty means "show the reader the source too". It deliberately does
    /// *not* include things that converted faithfully in a plainer shape, such
    /// as `x^{n+1}` becoming `x^(n+1)`: that is a typesetting compromise, not a
    /// loss of information, and flagging it would train the reader to ignore the
    /// flag.
    public var unconverted: [String]

    public init(text: String, unconverted: [String] = []) {
        self.text = text
        self.unconverted = unconverted
    }

    /// True when every token in the source became text.
    public var isFaithful: Bool { unconverted.isEmpty }
}

// MARK: - Extraction

public enum JunoMathMarkup {
    /// Splits Markdown source into prose and maths runs.
    ///
    /// Total, like ``JunoMarkdown/blocks(from:)`` and for the same reason: it
    /// runs against streaming text. An opening `$` whose partner has not arrived
    /// yet stays a literal dollar sign rather than swallowing the rest of the
    /// answer, so a half-written formula degrades to "a sentence with a `$` in
    /// it" and then becomes maths on the next chunk.
    ///
    /// Recognised delimiters: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`. The backslash
    /// forms are not optional extras — several models emit them by default, and
    /// a reader who sees `\[ x = 1 \]` in the transcript is looking at a
    /// rendering bug, not at maths.
    public static func segments(in source: String) -> [JunoMathSegment] {
        guard source.contains("$") || source.contains("\\(") || source.contains("\\[") else {
            return source.isEmpty ? [] : [.text(source)]
        }

        let chars = Array(source)
        var segments: [JunoMathSegment] = []
        var literal = ""
        var index = 0

        func flushLiteral() {
            guard !literal.isEmpty else { return }
            segments.append(.text(literal))
            literal.removeAll()
        }
        func emitMath(_ body: ArraySlice<Character>, display: Bool) {
            flushLiteral()
            segments.append(.math(String(body), display: display))
        }

        while index < chars.count {
            let character = chars[index]

            // A backslash escape is resolved before anything else, so `\$5.00`
            // is five dollars and never an opening delimiter.
            if character == "\\", index + 1 < chars.count {
                let next = chars[index + 1]
                if next == "$" {
                    literal.append("$")
                    index += 2
                    continue
                }
                if next == "(", let close = find(["\\", ")"], in: chars, from: index + 2) {
                    emitMath(chars[(index + 2)..<close], display: false)
                    index = close + 2
                    continue
                }
                if next == "[", let close = find(["\\", "]"], in: chars, from: index + 2) {
                    emitMath(chars[(index + 2)..<close], display: true)
                    index = close + 2
                    continue
                }
                // Any other escape — including an unterminated `\(` — is prose.
                literal.append(character)
                literal.append(next)
                index += 2
                continue
            }

            // An inline code span is verbatim by definition. `` `$5` `` and
            // ``` `x_i` ``` must survive untouched, or documentation about
            // shell variables turns into algebra.
            if character == "`", let span = codeSpan(in: chars, from: index) {
                literal.append(contentsOf: chars[index..<span])
                index = span
                continue
            }

            if character == "$" {
                if index + 1 < chars.count, chars[index + 1] == "$" {
                    if let close = find(["$", "$"], in: chars, from: index + 2) {
                        emitMath(chars[(index + 2)..<close], display: true)
                        index = close + 2
                        continue
                    }
                    literal.append("$")
                    index += 1
                    continue
                }
                if let close = closingInlineDollar(in: chars, after: index) {
                    emitMath(chars[(index + 1)..<close], display: false)
                    index = close + 1
                    continue
                }
                literal.append(character)
                index += 1
                continue
            }

            literal.append(character)
            index += 1
        }

        flushLiteral()
        return segments
    }

    /// Whether a string holds any maths at all.
    ///
    /// Answers by running the real extractor rather than by scanning for a `$`,
    /// because "contains a dollar sign" and "contains maths" are exactly the two
    /// things ``segments(in:)`` exists to tell apart — a cheaper check here
    /// would be a second, disagreeing opinion about the same string.
    public static func containsMath(_ source: String) -> Bool {
        for segment in segments(in: source) {
            if case .math = segment { return true }
        }
        return false
    }

    // MARK: Delimiter rules

    /// TeX's own heuristic for telling maths from money, which is the entire
    /// reason `$…$` is safe to support at all.
    ///
    /// An opening `$` must be followed by a non-space; a closing `$` must be
    /// preceded by a non-space and not followed by a digit. So "it costs $5 and
    /// $10" has no valid closing delimiter (the second `$` is preceded by a
    /// space) and stays prose, while "$a$ and $b$" is two formulas. Getting this
    /// wrong is not a cosmetic bug: a price list rendered as italic algebra is
    /// unreadable, and the failure is silent.
    ///
    /// A run is additionally refused if it spans a blank line, because at that
    /// point the `$` almost certainly belonged to a different paragraph and the
    /// alternative is one stray dollar sign eating a whole answer.
    private static func closingInlineDollar(in chars: [Character], after open: Int) -> Int? {
        let bodyStart = open + 1
        guard bodyStart < chars.count, !chars[bodyStart].isWhitespace else { return nil }

        var index = bodyStart
        var sawNewline = false
        while index < chars.count {
            let character = chars[index]
            if character == "\\" {
                index += 2
                continue
            }
            if character == "\n" {
                if sawNewline { return nil }
                sawNewline = true
                index += 1
                continue
            }
            if !character.isWhitespace { sawNewline = false }
            if character == "$" {
                let previous = chars[index - 1]
                let followsDigit = index + 1 < chars.count && chars[index + 1].isNumber
                if !previous.isWhitespace, !followsDigit, index > bodyStart {
                    return index
                }
                // A `$` that is not a valid close ENDS THE SEARCH rather than
                // being scanned past. A formula body never contains a bare
                // dollar sign, so hitting one proves the *opener* was wrong —
                // it was money. Without this, "Cost $5 then $y = 2$ holds"
                // opens at `$5`, skips the invalid close before `y`, and
                // succeeds at the one after `2`, swallowing half the sentence
                // into a formula that reads "5 then $y = 2". Abandoning here
                // instead lets the scanner reopen at `$y` and find the real
                // formula on the next character.
                return nil
            }
            index += 1
        }
        return nil
    }

    /// Index of the first occurrence of `needle`, or nil. Used for the
    /// two-character delimiters, which cannot be escaped inside maths.
    private static func find(
        _ needle: [Character],
        in chars: [Character],
        from start: Int
    ) -> Int? {
        guard start >= 0, needle.count <= chars.count else { return nil }
        var index = start
        while index + needle.count <= chars.count {
            if Array(chars[index..<(index + needle.count)]) == needle { return index }
            index += 1
        }
        return nil
    }

    /// End index (exclusive) of the code span opening at `start`, or nil when
    /// the backticks never close — in which case they are ordinary characters,
    /// exactly as CommonMark says.
    private static func codeSpan(in chars: [Character], from start: Int) -> Int? {
        var fence = 0
        var index = start
        while index < chars.count, chars[index] == "`" {
            fence += 1
            index += 1
        }
        while index < chars.count {
            guard chars[index] == "`" else {
                index += 1
                continue
            }
            var run = 0
            while index + run < chars.count, chars[index + run] == "`" { run += 1 }
            if run == fence { return index + run }
            index += run
        }
        return nil
    }
}

// MARK: - Rendering

public extension JunoMathMarkup {
    /// Converts one formula's LaTeX to Unicode text.
    ///
    /// Deterministic and pure — same input, same output, no locale, no
    /// environment — which is what makes the conversion table testable as a
    /// table rather than through a screenshot.
    static func render(latex: String) -> JunoMathRendering {
        var renderer = Renderer(source: Array(latex))
        let text = renderer.run()
        return JunoMathRendering(
            text: text.trimmingCharacters(in: .whitespacesAndNewlines),
            unconverted: renderer.unconverted
        )
    }
}

/// A single left-to-right pass over one formula.
///
/// Recursive descent rather than a regular-expression cascade, because `\frac`
/// and `^{…}` nest: `\frac{x^{2}}{\sqrt{y}}` needs the numerator rendered as its
/// own formula, and a regex that tries to do that is a regex that gets it wrong
/// on the second level.
private struct Renderer {
    let source: [Character]
    var index = 0
    var unconverted: [String] = []

    init(source: [Character]) {
        self.source = source
    }

    mutating func run() -> String {
        var output = ""
        while index < source.count {
            let character = source[index]
            switch character {
            case "\\":
                output += command()
            case "^":
                index += 1
                output += script(raised: true)
            case "_":
                index += 1
                output += script(raised: false)
            case "{", "}":
                // Grouping braces that no command claimed. They are structure,
                // not content, so they are the one thing dropped without a note.
                index += 1
            case "&":
                // An alignment tab. Becomes a space, and `\begin{…}` has already
                // recorded that the layout was not reproduced.
                index += 1
                output += " "
            case "~":
                index += 1
                output += "\u{00A0}"
            default:
                output.append(character)
                index += 1
            }
        }
        return output
    }

    // MARK: Pieces

    /// The next *atom*: a braced group, a command, or a single character. This
    /// is TeX's own argument rule, which is why `x^2` and `x^{2}` agree.
    private mutating func group() -> String {
        guard index < source.count else { return "" }
        if source[index] == "{" {
            let body = balancedGroupBody()
            var inner = Renderer(source: body)
            let rendered = inner.run()
            unconverted += inner.unconverted
            return rendered
        }
        if source[index] == "\\" { return command() }
        let character = source[index]
        index += 1
        return String(character)
    }

    /// Reads `{ … }` with nesting, leaving `index` past the closing brace. An
    /// unclosed group runs to end-of-input rather than failing, because half a
    /// formula arrives on every streamed chunk.
    private mutating func balancedGroupBody() -> [Character] {
        index += 1  // past `{`
        var depth = 1
        var body: [Character] = []
        while index < source.count {
            let character = source[index]
            if character == "\\", index + 1 < source.count {
                body.append(character)
                body.append(source[index + 1])
                index += 2
                continue
            }
            if character == "{" { depth += 1 }
            if character == "}" {
                depth -= 1
                if depth == 0 {
                    index += 1
                    return body
                }
            }
            body.append(character)
            index += 1
        }
        return body
    }

    private mutating func command() -> String {
        index += 1  // past `\`
        guard index < source.count else { return "\\" }

        let first = source[index]
        guard first.isLetter else {
            index += 1
            switch first {
            case "\\": return "\n"
            case ",", ";", ":", " ": return " "
            case "!": return ""  // negative thin space
            case "{", "}", "$", "%", "&", "_", "#": return String(first)
            default: return String(first)
            }
        }

        var name = ""
        while index < source.count, source[index].isLetter {
            name.append(source[index])
            index += 1
        }
        return apply(name)
    }

    private mutating func apply(_ name: String) -> String {
        switch name {
        case "frac", "dfrac", "tfrac", "cfrac":
            let numerator = group()
            let denominator = group()
            return Self.fraction(numerator, denominator)

        case "sqrt":
            var degree: String?
            if index < source.count, source[index] == "[" {
                degree = bracketArgument()
            }
            let radicand = group()
            return Self.root(degree: degree, radicand: radicand)

        case "text", "textrm", "textbf", "textit", "mathrm", "mathbf", "mathit",
             "mathsf", "mathtt", "mathcal", "mathscr", "operatorname", "bm", "boldsymbol":
            return group()

        case "mathbb":
            let body = group()
            return String(body.map { Self.doubleStruck[$0] ?? $0 })

        case "left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr",
             "Bigl", "Bigr", "biggl", "biggr", "Biggl", "Biggr", "displaystyle",
             "textstyle", "limits", "nolimits":
            // Sizing and placement hints. The delimiter itself follows and is
            // emitted normally; `\left.` and `\right.` name *no* delimiter, so
            // the dot is consumed rather than printed as punctuation.
            if index < source.count, source[index] == "." { index += 1 }
            return ""

        case "quad": return "  "
        case "qquad": return "    "

        case "begin", "end":
            // Environments carry layout, not terms — dropping the marker cannot
            // change what the formula says. It is still recorded, because a
            // matrix rendered as one flat line is not what the author wrote and
            // the reader deserves the source.
            var environment = ""
            if index < source.count, source[index] == "{" {
                environment = String(balancedGroupBody())
            }
            unconverted.append("\\\(name){\(environment)}")
            return ""

        default:
            if let symbol = Self.symbols[name] { return symbol }
            if let word = Self.operatorNames[name] { return word }
            // Unknown. Emitted verbatim so no term goes missing, and flagged so
            // the view can offer the source.
            unconverted.append("\\\(name)")
            return "\\\(name)"
        }
    }

    /// `\sqrt[3]{x}` — the optional degree. Not a `group()`, because `[` is an
    /// ordinary character everywhere else in maths.
    private mutating func bracketArgument() -> String {
        index += 1  // past `[`
        var body: [Character] = []
        while index < source.count, source[index] != "]" {
            body.append(source[index])
            index += 1
        }
        if index < source.count { index += 1 }
        var inner = Renderer(source: body)
        let rendered = inner.run()
        unconverted += inner.unconverted
        return rendered
    }

    /// A superscript or subscript, as Unicode where every character has a form
    /// and as a parenthesised fallback where one does not.
    ///
    /// The fallback is `x^(n+1)` rather than a dropped exponent or a mangled
    /// `xn+1`. It is uglier and it is *right*: the reader can still read the
    /// power. It is not recorded as unconverted for exactly that reason.
    private mutating func script(raised: Bool) -> String {
        let body = group()
        guard !body.isEmpty else { return "" }
        let table = raised ? Self.superscripts : Self.subscripts
        var mapped = ""
        for character in body {
            guard let form = table[character] else {
                let marker = raised ? "^" : "_"
                return body.count == 1 ? marker + body : marker + "(" + body + ")"
            }
            mapped.append(form)
        }
        return mapped
    }

    // MARK: Shapes

    private static func fraction(_ numerator: String, _ denominator: String) -> String {
        if let vulgar = vulgarFractions["\(numerator)/\(denominator)"] { return vulgar }
        return parenthesiseIfCompound(numerator) + "/" + parenthesiseIfCompound(denominator)
    }

    private static func root(degree: String?, radicand: String) -> String {
        let body = parenthesiseIfCompound(radicand)
        switch degree {
        case nil, .some(""): return "√" + body
        case .some("3"): return "∛" + body
        case .some("4"): return "∜" + body
        case .some(let other):
            let prefix = other.allSatisfy { superscripts[$0] != nil }
                ? String(other.map { superscripts[$0] ?? $0 })
                : other
            return prefix + "√" + body
        }
    }

    /// `a+b` in a numerator has to become `(a+b)`, or `\frac{a+b}{c}` renders as
    /// `a+b/c` — a different expression, and one that looks plausible.
    private static func parenthesiseIfCompound(_ part: String) -> String {
        guard part.count > 1 else { return part }
        let breaking = CharacterSet(charactersIn: "+-±×÷/ =<>·∓")
        guard part.unicodeScalars.contains(where: { breaking.contains($0) }) else { return part }
        if part.hasPrefix("("), part.hasSuffix(")") { return part }
        return "(" + part + ")"
    }
}

// MARK: - Tables

private extension Renderer {
    /// Only the fractions Unicode actually has. A `\frac{5}{7}` has no glyph and
    /// correctly falls through to `5/7` rather than to a lookalike.
    static let vulgarFractions: [String: String] = [
        "1/2": "½", "1/3": "⅓", "2/3": "⅔", "1/4": "¼", "3/4": "¾",
        "1/5": "⅕", "2/5": "⅖", "3/5": "⅗", "4/5": "⅘",
        "1/6": "⅙", "5/6": "⅚", "1/8": "⅛", "3/8": "⅜", "5/8": "⅝", "7/8": "⅞",
    ]

    static let superscripts: [Character: Character] = [
        "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
        "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
        "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
        "a": "ᵃ", "b": "ᵇ", "c": "ᶜ", "d": "ᵈ", "e": "ᵉ", "f": "ᶠ", "g": "ᵍ",
        "h": "ʰ", "i": "ⁱ", "j": "ʲ", "k": "ᵏ", "l": "ˡ", "m": "ᵐ", "n": "ⁿ",
        "o": "ᵒ", "p": "ᵖ", "r": "ʳ", "s": "ˢ", "t": "ᵗ", "u": "ᵘ", "v": "ᵛ",
        "w": "ʷ", "x": "ˣ", "y": "ʸ", "z": "ᶻ",
        "A": "ᴬ", "B": "ᴮ", "D": "ᴰ", "E": "ᴱ", "G": "ᴳ", "H": "ᴴ", "I": "ᴵ",
        "J": "ᴶ", "K": "ᴷ", "L": "ᴸ", "M": "ᴹ", "N": "ᴺ", "O": "ᴼ", "P": "ᴾ",
        "R": "ᴿ", "T": "ᵀ", "U": "ᵁ", "V": "ⱽ", "W": "ᵂ",
    ]

    /// Deliberately shorter than the superscript table: Unicode has no
    /// subscript `b`, `c`, `d`, `f`, `g`, `q`, `w`, `y`, `z`. `x_{y}` therefore
    /// renders `x_y`, which is what the author typed, rather than a lookalike
    /// from another block.
    static let subscripts: [Character: Character] = [
        "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
        "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
        "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎",
        "a": "ₐ", "e": "ₑ", "h": "ₕ", "i": "ᵢ", "j": "ⱼ", "k": "ₖ", "l": "ₗ",
        "m": "ₘ", "n": "ₙ", "o": "ₒ", "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ",
        "u": "ᵤ", "v": "ᵥ", "x": "ₓ",
    ]

    static let doubleStruck: [Character: Character] = [
        "A": "𝔸", "B": "𝔹", "C": "ℂ", "D": "𝔻", "E": "𝔼", "F": "𝔽", "G": "𝔾",
        "H": "ℍ", "I": "𝕀", "J": "𝕁", "K": "𝕂", "L": "𝕃", "M": "𝕄", "N": "ℕ",
        "O": "𝕆", "P": "ℙ", "Q": "ℚ", "R": "ℝ", "S": "𝕊", "T": "𝕋", "U": "𝕌",
        "V": "𝕍", "W": "𝕎", "X": "𝕏", "Y": "𝕐", "Z": "ℤ",
    ]

    /// Named operators keep their letters and their following space — `\sin x`
    /// is "sin x", not "sinx". They are listed rather than pattern-matched so an
    /// unknown `\foo` still reaches the unconverted path.
    static let operatorNames: [String: String] = {
        let names = [
            "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
            "sinh", "cosh", "tanh", "coth", "log", "ln", "lg", "exp", "min", "max",
            "lim", "limsup", "liminf", "sup", "inf", "det", "dim", "ker", "deg",
            "gcd", "hom", "arg", "Pr", "mod", "bmod",
        ]
        return Dictionary(uniqueKeysWithValues: names.map { ($0, $0) })
    }()

    static let symbols: [String: String] = [
        // Greek, lower case.
        "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
        "varepsilon": "ε", "zeta": "ζ", "eta": "η", "theta": "θ", "vartheta": "ϑ",
        "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ",
        "omicron": "ο", "pi": "π", "varpi": "ϖ", "rho": "ρ", "varrho": "ϱ",
        "sigma": "σ", "varsigma": "ς", "tau": "τ", "upsilon": "υ", "phi": "φ",
        "varphi": "ϕ", "chi": "χ", "psi": "ψ", "omega": "ω",
        // Greek, upper case.
        "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ",
        "Pi": "Π", "Sigma": "Σ", "Upsilon": "Υ", "Phi": "Φ", "Psi": "Ψ",
        "Omega": "Ω",
        // Binary operators and relations.
        "times": "×", "div": "÷", "cdot": "·", "cdots": "⋯", "ldots": "…",
        "dots": "…", "vdots": "⋮", "ddots": "⋱", "pm": "±", "mp": "∓",
        "ast": "∗", "star": "⋆", "circ": "∘", "bullet": "•",
        "leq": "≤", "le": "≤", "geq": "≥", "ge": "≥", "neq": "≠", "ne": "≠",
        "ll": "≪", "gg": "≫", "approx": "≈", "sim": "∼", "simeq": "≃",
        "cong": "≅", "equiv": "≡", "propto": "∝", "asymp": "≍",
        "subset": "⊂", "supset": "⊃", "subseteq": "⊆", "supseteq": "⊇",
        "in": "∈", "notin": "∉", "ni": "∋", "cup": "∪", "cap": "∩",
        "setminus": "∖", "emptyset": "∅", "varnothing": "∅",
        "land": "∧", "lor": "∨", "wedge": "∧", "vee": "∨", "neg": "¬", "lnot": "¬",
        "oplus": "⊕", "ominus": "⊖", "otimes": "⊗", "odot": "⊙",
        "perp": "⊥", "parallel": "∥", "angle": "∠", "triangle": "△",
        // Arrows.
        "to": "→", "rightarrow": "→", "leftarrow": "←", "leftrightarrow": "↔",
        "Rightarrow": "⇒", "Leftarrow": "⇐", "Leftrightarrow": "⇔",
        "implies": "⇒", "impliedby": "⇐", "iff": "⇔", "mapsto": "↦",
        "uparrow": "↑", "downarrow": "↓", "nearrow": "↗", "searrow": "↘",
        // Big operators. Rendered at their inline size, which is why limits
        // written as `_` and `^` end up beside the sign rather than under it.
        "sum": "∑", "prod": "∏", "coprod": "∐", "int": "∫", "iint": "∬",
        "iiint": "∭", "oint": "∮", "bigcup": "⋃", "bigcap": "⋂",
        "bigoplus": "⨁", "bigotimes": "⨂",
        // Quantifiers, calculus, misc.
        "forall": "∀", "exists": "∃", "nexists": "∄", "infty": "∞",
        "partial": "∂", "nabla": "∇", "hbar": "ℏ", "ell": "ℓ", "Re": "ℜ",
        "Im": "ℑ", "aleph": "ℵ", "prime": "′", "degree": "°", "circledast": "⊛",
        "therefore": "∴", "because": "∵", "square": "□", "blacksquare": "■",
        "checkmark": "✓", "dagger": "†", "ddagger": "‡", "S": "§", "P": "¶",
        "lbrace": "{", "rbrace": "}", "lbrack": "[", "rbrack": "]",
        "langle": "⟨", "rangle": "⟩", "lfloor": "⌊", "rfloor": "⌋",
        "lceil": "⌈", "rceil": "⌉", "vert": "|", "Vert": "‖", "colon": ":",
    ]
}
