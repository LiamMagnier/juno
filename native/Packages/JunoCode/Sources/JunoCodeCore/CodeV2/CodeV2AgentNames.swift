import Foundation

/// What a subagent is called: a name made from the work it was given, never a
/// roll call. "Worker 2" says nothing a person can act on; "Reset form
/// checker" says which agent to open when the reset form looks wrong.
///
/// Pure and deterministic, no model call. The web twin is
/// `src/lib/code-v2/agent-names.ts`; both test suites read
/// `contracts/code/agent-names.json`, so a run's agents carry the same names
/// on the website, the Mac and the iPhone.
///
/// The rule, in order:
/// 1. A label the engine chose on purpose ("Hook audit", "Candidate B",
///    "Architect", "Verifier") is kept. Only a role word with an optional
///    number ("Worker 2", "Builder", "Explorer") is replaced.
/// 2. The title, else the task's first line, read as an instruction:
///    "Map the auth middleware" → "Auth middleware mapper".
/// 3. Else read as the thing being made: "Cart total regression suite" →
///    "Regression suite writer".
/// 4. Else the role, in words ("Explorer", "Builder").
/// Two agents that land on the same name are told apart by a number after
/// the first: "Route builder", "Route builder 2".
public enum CodeV2AgentNames {
    /// The longest name a row shows before it drops words.
    public static let maxCharacters = 26

    /// What a name is made from.
    public struct Source: Sendable, Hashable {
        public var id: String
        public var label: String?
        public var title: String?
        public var task: String?
        public var role: CodeV2.AgentRole
        public var phase: CodeV2.TeamPhase?

        public init(id: String, label: String? = nil, title: String? = nil, task: String? = nil, role: CodeV2.AgentRole, phase: CodeV2.TeamPhase? = nil) {
            self.id = id
            self.label = label
            self.title = title
            self.task = task
            self.role = role
            self.phase = phase
        }

        public init(_ subagent: CodeV2.Subagent) {
            self.init(id: subagent.agentId, label: subagent.label, title: subagent.title, task: subagent.task, role: subagent.role, phase: subagent.phase)
        }
    }

    /// A label that is only a role and a number, which the work itself names better.
    public static func isGenericLabel(_ label: String?) -> Bool {
        let trimmed = (label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return true }
        return trimmed.range(
            of: "^(?:worker|builder|agent|sub-?agent|helper|explorer|task|job)\\s*#?\\s*\\d*$",
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }

    /// Instruction verbs and the agent noun each makes, keyed by base form.
    public static let verbNouns: [String: String] = [
        "add": "builder", "build": "builder", "create": "builder", "implement": "builder", "make": "builder", "scaffold": "builder", "wire": "builder", "support": "builder",
        "fix": "fixer", "repair": "fixer", "patch": "fixer", "resolve": "fixer", "debug": "debugger",
        "redesign": "redesigner", "design": "designer", "restyle": "stylist", "style": "stylist", "theme": "stylist", "polish": "polisher",
        "map": "mapper", "trace": "tracer", "find": "finder", "locate": "finder", "search": "searcher", "explore": "explorer", "scan": "scanner", "list": "lister",
        "check": "checker", "verify": "verifier", "validate": "validator", "confirm": "checker", "test": "tester",
        "review": "reviewer", "audit": "auditor", "inspect": "inspector", "analyze": "analyst", "analyse": "analyst", "investigate": "investigator", "research": "researcher", "read": "reader", "study": "researcher",
        "write": "writer", "draft": "writer", "document": "writer", "summarize": "summarizer", "summarise": "summarizer", "explain": "explainer", "plan": "planner", "outline": "planner",
        "refactor": "refactorer", "clean": "cleaner", "tidy": "cleaner", "simplify": "simplifier", "migrate": "migrator", "port": "porter", "convert": "converter", "translate": "translator", "localize": "localizer",
        "update": "updater", "upgrade": "upgrader", "bump": "upgrader", "replace": "updater", "swap": "updater", "change": "updater", "edit": "editor", "rewrite": "rewriter",
        "remove": "remover", "delete": "remover", "drop": "remover", "rename": "renamer", "move": "mover", "extract": "extractor", "split": "splitter", "merge": "merger",
        "optimize": "optimizer", "optimise": "optimizer", "speed": "optimizer", "profile": "profiler", "benchmark": "benchmarker", "measure": "measurer",
        "lint": "linter", "format": "formatter", "deploy": "shipper", "ship": "shipper", "release": "shipper", "configure": "configurer", "setup": "configurer", "set": "configurer", "install": "configurer",
        "integrate": "integrator", "connect": "integrator", "reproduce": "reproducer", "compare": "comparer", "prototype": "prototyper", "generate": "generator",
        "collect": "collector", "gather": "collector", "harden": "hardener", "secure": "hardener", "monitor": "watcher", "sort": "sorter", "tag": "tagger", "label": "tagger",
    ]

    /// Words that end the object of an instruction: what follows says how or where, not what.
    static let breakWords: Set<String> = [
        "for", "to", "in", "into", "on", "onto", "with", "without", "by", "from", "so", "that", "which", "and", "or", "then", "before", "after",
        "using", "via", "across", "against", "under", "over", "at", "of", "while", "when", "because", "if", "but", "as", "than", "per", "through",
        "is", "are", "was", "were", "should", "must", "can", "will", "does", "do", "don't", "keep", "keeping",
    ]

    /// Words that carry no subject of their own.
    static let skipWords: Set<String> = [
        "the", "a", "an", "every", "each", "all", "any", "some", "our", "my", "your", "its", "their", "this", "that", "these", "those", "it", "them",
        "new", "existing", "current", "remaining", "last", "other", "more", "few", "up", "out", "down", "back", "away", "off", "missing", "broken",
        "api", "src", "lib", "app", "components", "get", "post", "put", "patch", "delete", "head", "options",
    ]

    /// Heads that say what kind of thing, not which one: dropped first when a name is too long.
    static let genericHeads: Set<String> = [
        "service", "services", "page", "pages", "form", "flow", "module", "modules", "component", "components", "screen", "view", "file", "files",
        "function", "class", "code", "logic", "layer", "system", "feature", "route", "routes", "endpoint", "handler", "helper", "util", "utils", "script",
    ]

    /// Nouns of things a worker writes rather than builds.
    static let writtenThings: Set<String> = [
        "test", "tests", "suite", "spec", "specs", "coverage", "docs", "doc", "readme", "guide", "changelog", "notes", "comments", "copy", "report", "summary",
    ]

    /// A verb's base form, or nil when no form of it is in the lexicon.
    public static func verbBase(_ word: String) -> String? {
        let w = word.lowercased()
        if verbNouns[w] != nil { return w }
        var tries: [String] = []
        if w.hasSuffix("ing") {
            let stem = String(w.dropLast(3))
            tries.append(contentsOf: [stem, stem + "e", String(w.dropLast(4))])
        }
        if w.hasSuffix("ies") { tries.append(String(w.dropLast(3)) + "y") }
        if w.hasSuffix("es") { tries.append(String(w.dropLast(2))) }
        if w.hasSuffix("s") { tries.append(String(w.dropLast(1))) }
        if w.hasSuffix("ed") { tries.append(contentsOf: [String(w.dropLast(2)), String(w.dropLast(1)), String(w.dropLast(3))]) }
        return tries.first { verbNouns[$0] != nil }
    }

    private static func matches(_ text: String, _ pattern: String, caseInsensitive: Bool = false) -> Bool {
        text.range(of: pattern, options: caseInsensitive ? [.regularExpression, .caseInsensitive] : [.regularExpression]) != nil
    }

    private static func replacing(_ text: String, _ pattern: String, with replacement: String = "") -> String {
        text.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
    }

    /// "useCartTotal" → ["cart", "total"]; "/api/cart/total" → ["cart", "total"]; "x.tsx" → ["x"].
    static func splitToken(_ raw: String) -> [String] {
        // `[`, `]`, `{` and `}` are escaped: inside an ICU set an unescaped brace can start a string.
        let token = replacing(raw, "^[`'\"(\\[\\{<]+|[`'\")\\]\\}>.,:;!?]+$")
        if token.isEmpty { return [] }
        if token.contains("/") {
            let parts = token.split(separator: "/").map { replacing(String($0), "\\.[A-Za-z0-9]{1,5}$") }
            return parts.suffix(2).flatMap { splitToken($0) }
        }
        let bare = replacing(token, "\\.[A-Za-z0-9]{1,5}$")
        // A hyphenated word ("client-side") stays one word; camelCase and snake_case come apart.
        if matches(bare, "[a-z][A-Z]") || bare.contains("_") {
            let spaced = replacing(bare.replacingOccurrences(of: "_", with: " "), "([a-z0-9])([A-Z])", with: "$1 $2")
            var words = spaced.split(whereSeparator: { $0.isWhitespace }).map(String.init)
            // A React hook's "use" is not part of what it is about.
            if words.count > 1, words.first?.lowercased() == "use" { words.removeFirst() }
            return words.map { $0.lowercased() }
        }
        return [bare]
    }

    /// Keep short all-caps words (API, UI, CSS) as written; lower everything else.
    static func caseWord(_ word: String) -> String {
        matches(word, "^[A-Z]{2,6}s?$") ? word : word.lowercased()
    }

    /// The object of a phrase: content words up to the first break, at most the last two.
    static func subject(of words: [String]) -> [String] {
        Array(contentWords(words).suffix(2))
    }

    /// Every content word of a phrase, up to the first break.
    static func contentWords(_ words: [String]) -> [String] {
        var out: [String] = []
        for raw in words {
            let lower = replacing(raw.lowercased(), "[.,:;!?]+$")
            if !out.isEmpty && (breakWords.contains(lower) || (lower.hasSuffix("ing") && lower.count > 5)) { break }
            if out.isEmpty && breakWords.contains(lower) { continue }
            for part in splitToken(raw) {
                let p = part.lowercased()
                if p.isEmpty || skipWords.contains(p) || !matches(p, "[a-z]") { continue }
                out.append(caseWord(part))
            }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasSuffix(".") || trimmed.hasSuffix(":") { break }
        }
        return out
    }

    static func capitalize(_ text: String) -> String {
        text.prefix(1).uppercased() + text.dropFirst()
    }

    static func compose(_ words: [String], _ noun: String) -> String? {
        var subject = words
        guard let last = subject.last else { return nil }
        // The thing and the doer can be the same word ("tests" + "tester"): say it once.
        let head = last.lowercased()
        if head == noun || head + "er" == noun || head + "r" == noun { subject.removeLast() }
        if subject.isEmpty { return nil }
        // Too long for a row: keep the two words nearest the noun, then, if still
        // too long, the one that tells this agent apart ("reconciliation", not "service").
        func fits(_ candidate: [String]) -> Bool {
            "\(candidate.joined(separator: " ")) \(noun)".count <= maxCharacters
        }
        while subject.count > 2 && !fits(subject) { subject.removeFirst() }
        if subject.count == 2 && !fits(subject) {
            subject = genericHeads.contains(subject[1].lowercased()) ? [subject[0]] : [subject[1]]
        }
        return capitalize("\(subject.joined(separator: " ")) \(noun)")
    }

    static func firstLine(_ text: String?) -> String {
        (text ?? "")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? ""
    }

    static func words(_ text: String) -> [String] {
        replacing(text, "^[-*•\\d.)\\s]+").split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    /// "Map the auth middleware" → "Auth middleware mapper"; nil when it does not open with a known verb.
    public static func nameFromInstruction(_ text: String) -> String? {
        var w = words(firstLine(text))
        // "Please", "Then" and "Also" open many tasks without being the instruction.
        while let first = w.first, matches(first, "^(please|then|also|now|next|first|finally)[,:]?$", caseInsensitive: true) { w.removeFirst() }
        guard let first = w.first, let base = verbBase(replacing(first, "[,:]$")), let noun = verbNouns[base] else { return nil }
        var rest = Array(w.dropFirst())
        // "Set up the CI" / "Clean up the logs": the particle belongs to the verb.
        if let next = rest.first, matches(next, "^(up|out|over|through|into)$", caseInsensitive: true) { rest.removeFirst() }
        // "Investigate why the webhook retries": the subject is the first thing named after the question word.
        if let next = rest.first, matches(next, "^(why|how|what|where|whether|when|which|who)$", caseInsensitive: true) {
            return compose(Array(contentWords(Array(rest.dropFirst())).prefix(1)), noun)
        }
        // "Write tests for the reset form": the subject is what the tests are for.
        let object = subject(of: rest)
        if let head = object.last, writtenThings.contains(head.lowercased()), ["write", "add", "create", "draft", "document"].contains(base) {
            var about: [String] = []
            if let target = rest.firstIndex(where: { matches($0, "^(for|of|on)$", caseInsensitive: true) }) {
                about = subject(of: Array(rest[(target + 1)...]))
            }
            let thing = replacing(head.lowercased(), "s$")
            return compose(about + [thing], "writer") ?? compose(object, "writer")
        }
        return compose(object, noun)
    }

    /// "Cart total regression suite" → "Regression suite writer": a deliverable read as a noun phrase.
    public static func nameFromThing(_ text: String, role: CodeV2.AgentRole, phase: CodeV2.TeamPhase?) -> String? {
        let found = subject(of: words(firstLine(text)))
        guard let head = found.last?.lowercased() else { return nil }
        let noun: String
        if writtenThings.contains(head) { noun = "writer" }
        else if role == .explorer { noun = "explorer" }
        else if role == .reviewer || phase == .verify { noun = "reviewer" }
        else if role == .architect || phase == .plan { noun = "planner" }
        else { noun = "builder" }
        return compose(found, noun)
    }

    static func roleWord(_ role: CodeV2.AgentRole, phase: CodeV2.TeamPhase?) -> String {
        switch role {
        case .orchestrator: "Lead"
        case .worker: phase == .verify ? "Verifier" : "Builder"
        case .explorer: "Explorer"
        case .reviewer: "Reviewer"
        case .compaction: "Compaction"
        case .architect: "Architect"
        }
    }

    /// One agent's name, before its run is checked for repeats.
    public static func displayName(_ source: Source) -> String {
        if !isGenericLabel(source.label), let label = source.label { return label.trimmingCharacters(in: .whitespacesAndNewlines) }
        let title = firstLine(source.title)
        let task = firstLine(source.task)
        if !title.isEmpty, let name = nameFromInstruction(title) { return name }
        if !task.isEmpty, let name = nameFromInstruction(task) { return name }
        if !title.isEmpty, let name = nameFromThing(title, role: source.role, phase: source.phase) { return name }
        if !task.isEmpty, let name = nameFromThing(task, role: source.role, phase: source.phase) { return name }
        return roleWord(source.role, phase: source.phase)
    }

    public static func displayName(for subagent: CodeV2.Subagent) -> String {
        displayName(Source(subagent))
    }

    /// Every agent's name in a run, keyed by agent id, in the order given: the
    /// first "Route builder" keeps the name, the next is "Route builder 2".
    public static func displayNames(_ sources: [Source]) -> [String: String] {
        var out: [String: String] = [:]
        var seen: [String: Int] = [:]
        for source in sources where out[source.id] == nil {
            let name = displayName(source)
            let key = name.lowercased()
            let count = (seen[key] ?? 0) + 1
            seen[key] = count
            out[source.id] = count == 1 ? name : "\(name) \(count)"
        }
        return out
    }

    /// The names of every agent in a thread's items: newest snapshot per agent, first-seen order.
    public static func displayNames(in items: [CodeV2.TurnItem]) -> [String: String] {
        var order: [String] = []
        var latest: [String: CodeV2.Subagent] = [:]
        for item in items {
            guard case let .subagent(child) = item else { continue }
            if latest[child.agentId] == nil { order.append(child.agentId) }
            latest[child.agentId] = child
        }
        return displayNames(order.compactMap { id in latest[id].map { Source($0) } })
    }
}
