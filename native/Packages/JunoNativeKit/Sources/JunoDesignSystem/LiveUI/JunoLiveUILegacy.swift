import Foundation

/// LEGACY → Live UI. The Swift twin of `src/lib/live-ui/legacy/convert.ts`.
///
/// Replies written before Live UI became the one interactive answer system
/// carry the old `:::kind` learning blocks (step-lab, learning-card,
/// process-timeline, comparison, quiz, deep-dive) and the older
/// ```` ```juno-visual ```` JSON fences. Nothing teaches a model to write them
/// any more; this turns the ones already saved into Live UI sources, so history
/// renders through ``JunoLiveUIView`` like a new answer and the old views could
/// be deleted. `contracts/live-ui/fixtures/legacy.json` holds both platforms to
/// the same output. Never invents data: a Step Lab visual whose payload is
/// missing draws nothing, and an unreadable block becomes a one-line note.
public enum JunoLiveUILegacy {
    public static let unreadableText = "This part of an earlier answer could not be shown."

    // MARK: Output JSON (ordered keys)

    indirect enum JSON: Equatable {
        case string(String)
        case number(Double)
        case bool(Bool)
        case array([JSON])
        case object([(String, JSON)])

        static func == (lhs: JSON, rhs: JSON) -> Bool { lhs.text == rhs.text }

        static func obj(_ pairs: [(String, JSON?)]) -> JSON {
            .object(pairs.compactMap { key, value in value.map { (key, $0) } })
        }

        var text: String {
            switch self {
            case .string(let s): return Self.quote(s)
            case .number(let n): return JunoYAML.jsNumber(n)
            case .bool(let b): return b ? "true" : "false"
            case .array(let items): return "[" + items.map(\.text).joined(separator: ",") + "]"
            case .object(let pairs): return "{" + pairs.map { Self.quote($0.0) + ":" + $0.1.text }.joined(separator: ",") + "}"
            }
        }

        /// JSON string escaping, with backticks escaped too so the source can
        /// sit inside a Markdown fence without closing it.
        static func quote(_ s: String) -> String {
            var out = "\""
            for unit in s.unicodeScalars {
                switch unit {
                case "\"": out += "\\\""
                case "\\": out += "\\\\"
                case "\n": out += "\\n"
                case "\r": out += "\\r"
                case "\t": out += "\\t"
                case "`": out += "\\u0060"
                default:
                    if unit.value < 0x20 {
                        out += String(format: "\\u%04x", unit.value)
                    } else {
                        out.unicodeScalars.append(unit)
                    }
                }
            }
            return out + "\""
        }

        var objectPairs: [(String, JSON)]? {
            if case .object(let pairs) = self { return pairs }
            return nil
        }
    }

    static let unreadable: JSON = .object([("ui", .array([.object([("type", .string("callout")), ("tone", .string("note")), ("text", .string(unreadableText))])]))])

    static func spec(_ title: String?, data: [(String, JSON)], ui: [JSON]) -> JSON {
        .obj([("title", title.map(JSON.string)), ("data", data.isEmpty ? nil : .object(data)), ("ui", .array(ui))])
    }

    // MARK: Readers over the old YAML payloads

    private static func text(_ v: JunoYAML.Value?) -> String? {
        switch v {
        case .string(let s):
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        case .number(let n): return n.isFinite ? JunoYAML.jsNumber(n) : nil
        case .bool(let b): return b ? "true" : "false"
        default: return nil
        }
    }

    private static func number(_ v: JunoYAML.Value?) -> Double? {
        switch v {
        case .number(let n): return n.isFinite ? n : nil
        case .string(let s):
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty, let d = Double(t), d.isFinite else { return nil }
            return d
        default: return nil
        }
    }

    private static func map(_ v: JunoYAML.Value?) -> JunoYAML.Map {
        if case .mapping(let m) = v { return m }
        return [:]
    }

    // MARK: Step Lab visuals

    static func stepVisual(_ step: JunoStepLab.Step, n: Int, data: inout [(String, JSON)]) -> [JSON] {
        let d = map(step.data)
        let name = { (k: String) in "s\(n)_\(k)" }
        switch step.visualType {
        case .tokenization:
            var rows: [JSON] = []
            var anyID = false
            for item in JunoYAML.array(d["tokens"]) {
                if rows.count >= 12 { break }
                switch item {
                case .string, .number:
                    if let t = text(item) { rows.append(.object([("token", .string(t))])) }
                case .mapping(let m):
                    if let t = text(m.pick("text", "token")) {
                        let id = text(m["id"])
                        if id != nil { anyID = true }
                        rows.append(.obj([("token", .string(t)), ("id", id.map(JSON.string))]))
                    }
                default: break
                }
            }
            if rows.isEmpty { return [] }
            data.append((name("tokens"), .array(rows)))
            var out: [JSON] = []
            if let input = text(d["input"]) {
                out.append(.object([("type", .string("text")), ("tone", .string("muted")), ("text", .string("Input: “\(input)”"))]))
            }
            var columns: [JSON] = [.object([("label", .string("Token")), ("value", .string("token"))])]
            if anyID { columns.append(.object([("label", .string("ID")), ("value", .string("id"))])) }
            out.append(.object([("type", .string("table")), ("rows", .string(name("tokens"))), ("columns", .array(columns))]))
            return out
        case .embedding:
            var rows: [JSON] = []
            for item in JunoYAML.array(d["examples"]) {
                guard rows.count < 8, case .mapping(let m) = item else { continue }
                let vector = JunoYAML.array(m["vector"]).compactMap(number).prefix(6)
                if let t = text(m.pick("token", "text")), !vector.isEmpty {
                    rows.append(.object([("token", .string(t)), ("vector", .string(vector.map(JunoYAML.jsNumber).joined(separator: ", ")))]))
                }
            }
            if rows.isEmpty { return [] }
            data.append((name("vectors"), .array(rows)))
            return [.object([
                ("type", .string("table")), ("rows", .string(name("vectors"))),
                ("columns", .array([.object([("label", .string("Token")), ("value", .string("token"))]), .object([("label", .string("Vector")), ("value", .string("vector"))])])),
            ])]
        case .attention:
            let tokens = Array(JunoYAML.array(d["tokens"]).compactMap(text).prefix(7))
            let matrix = Array(
                JunoYAML.array(d["matrix"])
                    .map { Array(JunoYAML.array($0).compactMap(number).prefix(tokens.count)) }
                    .filter { !$0.isEmpty }
                    .prefix(tokens.count)
            )
            guard tokens.count >= 2, matrix.count == tokens.count else { return [] }
            let rows: [JSON] = tokens.enumerated().map { r, t in
                .object([("token", .string(t))] + matrix[r].enumerated().map { ("w\($0.offset)", JSON.number($0.element)) })
            }
            data.append((name("attention"), .array(rows)))
            let columns: [JSON] = [.object([("label", .string("")), ("value", .string("token"))])]
                + tokens.enumerated().map { .object([("label", .string($0.element)), ("value", .string("w\($0.offset)")), ("format", .string("number"))]) }
            return [.object([("type", .string("table")), ("rows", .string(name("attention"))), ("rowHeader", .bool(true)), ("columns", .array(columns))])]
        case .transformerProcessing:
            var out: [JSON] = []
            if let layers = number(d["layers"]) {
                out.append(.object([("type", .string("metric")), ("label", .string("Layers")), ("value", .string(JunoYAML.jsNumber(layers)))]))
            }
            let tokens = JunoYAML.array(d["tokens"]).compactMap(text).prefix(5)
            if !tokens.isEmpty {
                out.append(.object([("type", .string("text")), ("tone", .string("muted")), ("text", .string("Tokens: " + tokens.joined(separator: ", ")))]))
            }
            return out
        case .probabilityDistribution:
            var rows: [JSON] = []
            for item in JunoYAML.array(d["candidates"]) {
                guard rows.count < 6, case .mapping(let m) = item else { continue }
                if let t = text(m.pick("token", "text")), let p = number(m.pick("probability", "p")) {
                    rows.append(.object([("token", .string(t)), ("p", .number(p > 1 ? p / 100 : p))]))
                }
            }
            if rows.isEmpty { return [] }
            data.append((name("candidates"), .array(rows)))
            return [.object([
                ("type", .string("chart")), ("kind", .string("bar")), ("rows", .string(name("candidates"))), ("xKey", .string("token")),
                ("series", .array([.object([("label", .string("Probability")), ("y", .string("p"))])])), ("format", .string("percent")),
            ])]
        case .nextTokenSelection:
            guard let token = text(d.pick("selectedToken", "token", "output")) else { return [] }
            let line = text(d["prompt"]).map { "\($0) **\(token)**" } ?? "**\(token)**"
            return [.object([("type", .string("text")), ("text", .string(line))])]
        case .genericProcess:
            var items: [JSON] = []
            if let v = text(d["input"]) { items.append(.object([("label", .string("Input")), ("detail", .string(v))])) }
            if let v = text(d.pick("transform", "process")) { items.append(.object([("label", .string("Transform")), ("detail", .string(v))])) }
            if let v = text(d["output"]) { items.append(.object([("label", .string("Output")), ("detail", .string(v))])) }
            return items.isEmpty ? [] : [.object([("type", .string("timeline")), ("items", .array(items))])]
        }
    }

    struct QuizQuestion {
        var question: String
        var options: [(label: String, correct: Bool, explanation: String?)]
        var explanation: String?
        var hint: String?
    }

    static func quizComponent(_ questions: [QuizQuestion]) -> JSON? {
        var out: [JSON] = []
        for q in questions {
            guard let answer = q.options.firstIndex(where: \.correct), q.options.count >= 2 else { continue }
            out.append(.obj([
                ("question", .string(q.question)),
                ("options", .array(q.options.map { .obj([("label", .string($0.label)), ("explanation", $0.explanation.map(JSON.string))]) })),
                ("answer", .number(Double(answer))),
                ("explanation", q.explanation.map(JSON.string)),
                ("hint", q.hint.map(JSON.string)),
            ]))
        }
        return out.isEmpty ? nil : .object([("type", .string("quiz")), ("questions", .array(out))])
    }

    static func stepLabSpec(_ lab: JunoStepLab) -> JSON {
        var data: [(String, JSON)] = []
        var steps: [[(String, JSON)]] = lab.steps.enumerated().map { i, step in
            let ui = stepVisual(step, n: i + 1, data: &data)
            return JSON.obj([
                ("title", .string(step.title)),
                ("summary", .string(step.summary)),
                ("detail", step.detail.map(JSON.string)),
                ("notice", step.notice.map(JSON.string)),
                ("ui", ui.isEmpty ? nil : .array(ui)),
            ]).objectPairs ?? []
        }
        if let quiz = lab.quiz.flatMap({ quiz in
            quizComponent(quiz.questions.map { q in
                QuizQuestion(question: q.question, options: q.options.map { ($0.label, $0.correct, $0.explanation) }, explanation: q.explanation, hint: q.hint)
            })
        }), !steps.isEmpty {
            var last = steps[steps.count - 1]
            if let index = last.firstIndex(where: { $0.0 == "ui" }), case .array(let items) = last[index].1 {
                last[index].1 = .array(items + [quiz])
            } else {
                last.append(("ui", .array([quiz])))
            }
            steps[steps.count - 1] = last
        }
        var ui: [JSON] = []
        if let description = lab.description {
            ui.append(.object([("type", .string("text")), ("tone", .string("muted")), ("text", .string(description))]))
        }
        ui.append(.obj([("type", .string("steps")), ("steps", .array(steps.map(JSON.object))), ("takeaway", lab.takeaway.map(JSON.string))]))
        return spec(lab.title, data: data, ui: ui)
    }

    // MARK: Blocks

    static func payloadSpec(_ payload: JunoLearningBlocks.Payload) -> JSON {
        switch payload {
        case .stepLab(let lab):
            return stepLabSpec(lab)
        case .learningCard(let c):
            return spec(nil, data: [], ui: [.object([("type", .string("callout")), ("tone", .string(c.tone.rawValue)), ("title", .string(c.title)), ("text", .string(c.content))])])
        case .processTimeline(let t):
            let items: [JSON] = t.steps.map { .obj([("label", .string($0.label)), ("detail", $0.description.map(JSON.string))]) }
            return spec(t.title, data: [], ui: [.object([("type", .string("timeline")), ("items", .array(items))])])
        case .comparison(let c):
            let rows: [JSON] = c.rows.map { row in
                .object([("c0", .string(row.label))] + c.columns.indices.map { j in ("c\(j + 1)", JSON.string(j < row.values.count ? row.values[j] : "")) })
            }
            let columns: [JSON] = [.object([("label", .string("")), ("value", .string("c0"))])]
                + c.columns.enumerated().map { .object([("label", .string($0.element)), ("value", .string("c\($0.offset + 1)"))]) }
            var ui: [JSON] = [.object([("type", .string("table")), ("rows", .string("rows")), ("rowHeader", .bool(true)), ("columns", .array(columns))])]
            if let verdict = c.verdict { ui.append(.object([("type", .string("callout")), ("tone", .string("insight")), ("text", .string(verdict))])) }
            return spec(c.title, data: [("rows", .array(rows))], ui: ui)
        case .quiz(let quiz):
            let q = quizComponent(quiz.questions.map { q in
                QuizQuestion(question: q.question, options: q.options.map { ($0.label, $0.correct, $0.explanation) }, explanation: q.explanation, hint: q.hint)
            })
            return q.map { spec(quiz.title, data: [], ui: [$0]) } ?? unreadable
        case .deepDive(let d):
            return spec(nil, data: [], ui: [.object([("type", .string("callout")), ("tone", .string("note")), ("title", .string(d.title)), ("text", .string(d.summary)), ("more", .string(d.content))])])
        }
    }

    /// One found block (closed or cut off) as a Live UI spec.
    static func blockSpec(_ block: JunoLearningBlocks.Parsed) -> JSON {
        let b = block.streaming ? JunoLearningBlocks.salvage(block) : block
        guard let payload = b.payload else { return unreadable }
        if case .stepLab(let lab) = payload, lab.steps.count == 1, lab.steps[0].id == "fallback" { return unreadable }
        return payloadSpec(payload)
    }

    /// The Live UI source (one line of JSON) for an old learning block.
    public static func source(for block: JunoLearningBlocks.Parsed) -> String {
        blockSpec(block).text
    }

    // MARK: juno-visual fences

    private static func vtext(_ v: Any?) -> String? {
        switch v {
        case let s as String:
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
            return n.doubleValue.isFinite ? JunoYAML.jsNumber(n.doubleValue) : nil
        default:
            return nil
        }
    }

    /// JavaScript's `=== true`: a JSON boolean, not a 1.
    private static func isTrue(_ v: Any?) -> Bool {
        guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return false }
        return n.boolValue
    }

    /// `a ?? b ?? c` over JSON values: the first present, non-null one.
    private static func pick(_ m: [String: Any], _ keys: String...) -> Any? {
        for k in keys { if let v = m[k], !(v is NSNull) { return v } }
        return nil
    }

    struct VisualItem {
        var title: String?
        var label: String?
        var primary: String
        func title(_ fallback: String) -> String { title ?? label ?? fallback }
    }

    private static func visualItem(_ v: Any) -> VisualItem? {
        if let s = v as? String { return VisualItem(primary: s.trimmingCharacters(in: .whitespacesAndNewlines)) }
        guard let m = v as? [String: Any] else { return nil }
        return VisualItem(
            title: vtext(pick(m, "title", "name")),
            label: vtext(pick(m, "label", "step", "id", "date")),
            primary: vtext(pick(m, "body", "description", "content")) ?? vtext(m["text"]) ?? vtext(pick(m, "detail", "details")) ?? vtext(m["value"]) ?? ""
        )
    }

    private static func visualItems(_ raw: [String: Any]) -> [VisualItem] {
        for k in ["items", "steps", "cards", "nodes"] {
            let items = (raw[k] as? [Any] ?? []).compactMap(visualItem)
            if !items.isEmpty { return items }
        }
        return []
    }

    static func visualSpec(_ source: String) -> JSON? {
        guard let data = source.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data),
            let raw = object as? [String: Any]
        else { return nil }
        let type = (vtext(pick(raw, "type", "kind")) ?? "cards").lowercased()
        let title = vtext(raw["title"])
        let subtitle = vtext(pick(raw, "subtitle", "description"))
        let body = vtext(pick(raw, "body", "text"))
        let items = visualItems(raw)
        let intro: [JSON] = subtitle.map { [.object([("type", .string("text")), ("tone", .string("muted")), ("text", .string($0))])] } ?? []

        switch type {
        case "cards":
            if items.isEmpty { return unreadable }
            let parts: [JSON] = items.prefix(24).enumerated().map { i, item in
                .object([("id", .string("p\(i + 1)")), ("label", .string(item.title("Card \(i + 1)"))), ("detail", .string(item.primary.isEmpty ? item.title("Card \(i + 1)") : item.primary))])
            }
            return spec(title, data: [], ui: intro + [.object([("type", .string("explorer")), ("parts", .array(parts))])])
        case "steps":
            if items.isEmpty { return unreadable }
            let steps: [JSON] = items.prefix(12).enumerated().map { i, item in
                .obj([("title", .string(item.title("Step \(i + 1)"))), ("summary", item.primary.isEmpty ? nil : .string(item.primary))])
            }
            let lead = subtitle ?? body
            let leadUI: [JSON] = lead.map { [.object([("type", .string("text")), ("tone", .string("muted")), ("text", .string($0))])] } ?? []
            return spec(title, data: [], ui: leadUI + [.object([("type", .string("steps")), ("steps", .array(steps))])])
        case "flow", "flowchart", "diagram", "timeline":
            if items.isEmpty { return unreadable }
            let moment = type == "timeline" ? "Moment" : "Step"
            let timeline: [JSON] = items.prefix(20).enumerated().map { i, item in
                .obj([
                    ("label", .string(item.title("\(moment) \(i + 1)"))),
                    ("detail", item.primary.isEmpty ? nil : .string(item.primary)),
                    ("time", type == "timeline" && item.title != nil ? item.label.map(JSON.string) : nil),
                ])
            }
            return spec(title, data: [], ui: intro + [.object([("type", .string("timeline")), ("items", .array(timeline))])])
        case "comparison", "table":
            let columnsRaw = (raw["columns"] as? [Any] ?? []).compactMap(vtext)
            let columns = Array((columnsRaw.isEmpty ? ["Option A", "Option B"] : columnsRaw).prefix(7))
            let rowsRaw = (raw["rows"] as? [Any] ?? []).filter { $0 is String || $0 is [String: Any] }
            var rows: [JSON] = []
            if !rowsRaw.isEmpty {
                for (i, r) in rowsRaw.prefix(100).enumerated() {
                    guard let item = visualItem(r) else { continue }
                    let map = r as? [String: Any]
                    let values = map.flatMap { pick($0, "values", "cells") }
                    var row: [(String, JSON)] = [("c0", .string(item.title("Row \(i + 1)")))]
                    for (j, col) in columns.enumerated() {
                        var v: String?
                        if let list = values as? [Any] {
                            v = j < list.count ? vtext(list[j]) : nil
                        } else if let keyed = values as? [String: Any] {
                            v = vtext(pick(keyed, col, col.lowercased(), String(j)))
                        } else {
                            v = j == 0 ? item.primary : nil
                        }
                        row.append(("c\(j + 1)", .string(v ?? "")))
                    }
                    rows.append(.object(row))
                }
            } else {
                for (i, item) in items.enumerated() {
                    rows.append(.object([("c0", .string(item.title("Row \(i + 1)")))] + columns.indices.map { j in ("c\(j + 1)", JSON.string(j == 0 ? item.primary : "")) }))
                }
            }
            if rows.isEmpty { return unreadable }
            let cols: [JSON] = [.object([("label", .string("")), ("value", .string("c0"))])]
                + columns.enumerated().map { .object([("label", .string($0.element)), ("value", .string("c\($0.offset + 1)"))]) }
            return spec(title, data: [("rows", .array(rows))], ui: intro + [.object([("type", .string("table")), ("rows", .string("rows")), ("rowHeader", .bool(true)), ("columns", .array(cols))])])
        case "quiz":
            let options: [(label: String, correct: Bool, explanation: String?)] = (raw["options"] as? [Any] ?? []).compactMap { o in
                guard let item = visualItem(o) else { return nil }
                let label = item.title ?? item.label ?? item.primary
                guard !label.isEmpty else { return nil }
                let m = o as? [String: Any]
                return (label, isTrue(m?["correct"]), m.flatMap { vtext(pick($0, "explanation", "why")) })
            }
            let question = vtext(raw["question"]) ?? title ?? "Which option fits best?"
            guard let quiz = quizComponent([QuizQuestion(question: question, options: Array(options.prefix(6)))]) else { return unreadable }
            return spec(question == title ? nil : title, data: [], ui: [quiz])
        case "callout":
            let lines = ([body] + items.map { item -> String? in
                if !item.primary.isEmpty { return item.primary }
                return item.title ?? item.label
            }).compactMap { $0 }
            if lines.isEmpty { return unreadable }
            return spec(nil, data: [], ui: [.obj([("type", .string("callout")), ("tone", .string("insight")), ("title", title.map(JSON.string)), ("text", .string(lines.joined(separator: "\n")))])])
        default:
            return nil
        }
    }

    /// The Live UI source for a ```` ```juno-visual ```` fence. While streaming,
    /// an unparsable body is "" (the view shows a skeleton).
    public static func visualSource(_ source: String, streaming: Bool = false) -> String {
        if let s = visualSpec(source) { return s.text }
        return streaming ? "" : unreadable.text
    }
}

/// The old ```` ```juno-visual ```` fence names (and aliases). LEGACY: models
/// are no longer taught them; ``JunoMarkdownText`` routes these fences to
/// ``JunoLiveUILegacy/visualSource(_:streaming:)`` so saved replies still draw.
public enum JunoVisualMarkup {
    public static let fenceNames: Set<String> = ["juno-visual", "juno-ui", "juno-block", "visual", "visual-block"]

    public static func isVisualFence(info: String?) -> Bool {
        guard let info else { return false }
        let name = info.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
        return fenceNames.contains(name.lowercased())
    }
}
