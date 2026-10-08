import Foundation

/// Live UI spec: JSON (possibly still streaming) → a typed, bounded component
/// tree. The Swift twin of `src/lib/live-ui/spec.ts`; both are held to
/// `contracts/live-ui/fixtures/spec.json`, so a phone and a browser draw the
/// same components from the same half-written block.
public enum JunoLiveUIMarkup {
    public static let fences: Set<String> = ["live-ui", "live", "juno-live"]

    public static func isLiveFence(info: String?) -> Bool {
        guard let info else { return false }
        let first = info.trimmingCharacters(in: .whitespaces).split(separator: " ").first.map(String.init) ?? ""
        return fences.contains(first.lowercased())
    }
}

public enum LiveSpecLimits {
    public static let components = 80
    public static let nesting = 4
    public static let lets = 40
    public static let chartSeries = 4
    public static let tableColumns = 8
    public static let parts = 24
    public static let facts = 8
    public static let links = 40
    public static let stops = 25
    public static let checklist = 40
    public static let options = 12
    public static let steps = 12
    public static let questions = 10
    public static let quizOptions = 6
    public static let timeline = 20
    public static let text = 2000
    public static let label = 120
}

public struct LiveSelectOption: Equatable, Sendable {
    public var label: String
    public var value: LiveValue
}

public struct LiveLayout: Sendable {
    public enum Kind: String, Sendable { case row, grid, section }
    public var key: String
    public var kind: Kind
    public var columns: Int
    public var title: String?
    public var children: [LiveComponent]
    public var pending: Bool
}

public struct LiveInput: Sendable {
    public enum Kind: String, Sendable { case slider, number, stepper, select, toggle, date, input }
    public var key: String
    public var kind: Kind
    public var id: String
    public var label: String
    public var min: Double?
    public var max: Double?
    public var step: Double?
    public var value: LiveValue
    public var format: LiveFormat?
    public var unit: String?
    public var options: [LiveSelectOption] = []
    public var segmented = false
    public var placeholder: String?
}

public struct LiveMetric: Sendable {
    public var key: String
    public var label: String
    public var value: String
    public var format: LiveFormat?
    public var unit: String?
    public var hint: String?
    public var emphasis: Bool
}

public struct LiveTextBlock: Sendable {
    public enum Tone: String, Sendable { case body, muted, heading }
    public var key: String
    public var text: String
    public var tone: Tone
}

public struct LiveProgress: Sendable {
    public var key: String
    public var label: String
    public var value: String
    public var max: String
    public var format: LiveFormat?
}

public struct LiveChartSpec: Sendable {
    public enum Kind: String, Sendable { case line, area, bar }
    public struct Range: Sendable {
        public var from: String, to: String, step: String, variable: String
        public var label: String?
    }
    public struct Series: Sendable {
        public var label: String
        public var y: String
    }
    public var key: String
    public var kind: Kind
    public var title: String?
    public var x: Range?
    public var rows: String?
    public var xKey: String?
    public var series: [Series]
    public var format: LiveFormat?
    public var xFormat: LiveFormat?
    public var mark: String?
}

public struct LiveTableSpec: Sendable {
    public struct Column: Sendable {
        public var label: String, value: String
        public var format: LiveFormat?
        public var unit: String?
    }
    public var key: String
    public var rows: String
    public var columns: [Column]
    /// The first column names each row (a comparison's aspect column).
    public var rowHeader = false
    /// A column index to set apart (the recommended option).
    public var highlight: Int?
}

/// A guided walkthrough: each step has words and, optionally, its own visual.
public struct LiveStepsSpec: Sendable {
    public struct Step: Sendable {
        public var title: String
        public var summary: String?
        public var detail: String?
        public var notice: String?
        public var ui: [LiveComponent]
    }
    public var key: String
    public var title: String?
    public var steps: [Step]
    public var takeaway: String?
}

/// A self-check answered in place.
public struct LiveQuizSpec: Sendable {
    public struct Question: Sendable {
        public var question: String
        public var options: [(label: String, explanation: String?)]
        public var answer: Int
        public var explanation: String?
        public var hint: String?
    }
    public var key: String
    public var title: String?
    public var questions: [Question]
}

public struct LiveCalloutSpec: Sendable {
    public enum Tone: String, Sendable { case insight, tip, warning, note }
    public var key: String
    public var tone: Tone
    public var title: String?
    public var text: String
    public var more: String?
}

public struct LiveTimelineSpec: Sendable {
    public struct Item: Sendable {
        public var label: String
        public var detail: String?
        public var time: String?
    }
    public var key: String
    public var title: String?
    public var items: [Item]
}

public struct LiveExplorerPart: Sendable, Identifiable {
    public var id: String
    public var label: String
    public var summary: String?
    public var detail: String
    public var facts: [(label: String, value: String)]
    public var at: (x: Double, y: Double)?
}

public struct LiveExplorerSpec: Sendable {
    public var key: String
    public var title: String?
    public var parts: [LiveExplorerPart]
    public var links: [(String, String)]
}

public struct LiveStopsSpec: Sendable {
    public struct Stop: Sendable {
        public var name: String
        public var time: String?
        public var note: String?
        public var query: String
    }
    public var key: String
    public var title: String?
    public var stops: [Stop]
}

public struct LiveChecklistSpec: Sendable {
    public var key: String
    public var id: String
    public var title: String?
    public var items: [(label: String, note: String?)]
}

public struct LiveButtonSpec: Sendable {
    public var key: String
    public var label: String
    public var prompt: String?
    public var copy: String?
}

public indirect enum LiveComponent: Sendable, Identifiable {
    case layout(LiveLayout)
    case input(LiveInput)
    case metric(LiveMetric)
    case text(LiveTextBlock)
    case progress(LiveProgress)
    case chart(LiveChartSpec)
    case table(LiveTableSpec)
    case explorer(LiveExplorerSpec)
    case stops(LiveStopsSpec)
    case checklist(LiveChecklistSpec)
    case button(LiveButtonSpec)
    case steps(LiveStepsSpec)
    case quiz(LiveQuizSpec)
    case callout(LiveCalloutSpec)
    case timeline(LiveTimelineSpec)
    case pending(key: String)

    public var key: String {
        switch self {
        case .layout(let c): c.key
        case .input(let c): c.key
        case .metric(let c): c.key
        case .text(let c): c.key
        case .progress(let c): c.key
        case .chart(let c): c.key
        case .table(let c): c.key
        case .explorer(let c): c.key
        case .stops(let c): c.key
        case .checklist(let c): c.key
        case .button(let c): c.key
        case .steps(let c): c.key
        case .quiz(let c): c.key
        case .callout(let c): c.key
        case .timeline(let c): c.key
        case .pending(let key): key
        }
    }

    public var id: String { key }

    /// The web's type name for this component — what the fixtures compare.
    public var typeName: String {
        switch self {
        case .layout(let c): c.kind.rawValue
        case .input(let c): c.kind.rawValue
        case .metric: "metric"
        case .text: "text"
        case .progress: "progress"
        case .chart: "chart"
        case .table: "table"
        case .explorer: "explorer"
        case .stops: "stops"
        case .checklist: "checklist"
        case .button: "button"
        case .steps: "steps"
        case .quiz: "quiz"
        case .callout: "callout"
        case .timeline: "timeline"
        case .pending: "pending"
        }
    }
}

public struct LiveSpec: Sendable {
    public var title: String?
    public var currency: String
    public var data: [String: LiveValue]
    public var dataKeys: [String]
    public var lets: [(String, String)]
    public var ui: [LiveComponent]
    public var streaming: Bool

    /// Every input, depth-first.
    public var inputs: [LiveInput] {
        var out: [LiveInput] = []
        func walk(_ list: [LiveComponent]) {
            for c in list {
                if case .layout(let l) = c { walk(l.children) }
                if case .steps(let st) = c { for step in st.steps { walk(step.ui) } }
                if case .input(let i) = c { out.append(i) }
            }
        }
        walk(ui)
        return out
    }

    public var defaults: [String: LiveValue] {
        Dictionary(inputs.map { ($0.id, $0.value) }, uniquingKeysWith: { a, _ in a })
    }
}

public enum LiveSpecParser {
    static let reserved: Set<String> = ["true", "false", "null", "pi", "e"]
    static let aliases: [String: String] = [
        "stat": "metric", "kpi": "metric", "switch": "toggle", "segmented": "select", "dropdown": "select",
        "picker": "select", "textfield": "input", "text-input": "input", "field": "number", "heading": "text",
        "note": "text", "route": "stops", "map": "stops", "itinerary": "stops", "parts": "explorer",
        "diagram": "explorer", "todo": "checklist", "action": "button", "stack": "section", "group": "section",
        "card": "section", "columns": "row", "bar": "progress",
        "walkthrough": "steps", "guide": "steps", "lesson": "steps", "key-idea": "callout", "keyidea": "callout",
        "insight": "callout", "process": "timeline", "check": "quiz",
    ]
    static let tones: Set<String> = ["insight", "tip", "warning", "note"]
    static let layouts: Set<String> = ["row", "grid", "section"]

    static func isIdent(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard let first = u.first, (first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first == 95 else { return false }
        return u.allSatisfy { ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 95 || ($0 >= 48 && $0 <= 57) }
    }

    /// `String(v)` the JavaScript way for a finite number.
    static func jsNumberString(_ n: Double) -> String { liveCanonicalNumberString(n) }

    static func str(_ v: LiveJSON?, _ max: Int = LiveSpecLimits.label) -> String? {
        switch v {
        case .string(let s):
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : String(decoding: t.utf16.prefix(max), as: UTF16.self)
        case .number(let n): return jsNumberString(n)
        default: return nil
        }
    }

    static func num(_ v: LiveJSON?) -> Double? {
        switch v {
        case .number(let n): return n
        case .string(let s):
            let t = s.trimmingCharacters(in: .whitespaces)
            guard !t.isEmpty, let d = Double(t), d.isFinite else { return nil }
            return d
        default: return nil
        }
    }

    static func expr(_ v: LiveJSON?) -> String? {
        switch v {
        case .string(let s):
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : String(decoding: t.utf16.prefix(400), as: UTF16.self)
        case .number(let n): return jsNumberString(n)
        case .bool(let b): return b ? "true" : "false"
        default: return nil
        }
    }

    static func fmt(_ v: LiveJSON?) -> LiveFormat? {
        if case .string(let s) = v { return LiveFormat(rawValue: s) }
        return nil
    }

    public static func parse(_ source: String) -> (spec: LiveSpec?, error: String?) {
        normalize(LiveJSONReader.read(source))
    }

    public static func normalize(_ read: LiveJSONResult) -> (spec: LiveSpec?, error: String?) {
        if let error = read.error { return (nil, error) }
        guard let root = read.value else {
            return (LiveSpec(title: nil, currency: "USD", data: [:], dataKeys: [], lets: [], ui: [], streaming: true), nil)
        }
        guard case .object(let obj, let rootOpen) = root else { return (nil, "A Live UI block is a JSON object.") }

        let currencyRaw = str(obj["currency"], 3)
        let currency = currencyRaw.flatMap { c in c.count == 3 && c.allSatisfy { $0.isASCII && $0.isLetter } ? c.uppercased() : nil } ?? "USD"

        var data: [String: LiveValue] = [:]
        var dataKeys: [String] = []
        if case .object(let d, _) = obj["data"] {
            for (k, v) in d.pairs where isIdent(k) && !reserved.contains(k) {
                if v.isOpen { continue }
                data[k] = LiveValue(json: v, depth: 0)
                dataKeys.append(k)
            }
        }

        var lets: [(String, String)] = []
        let letSource: LiveJSONObject? = obj["let"]?.objectValue ?? obj["lets"]?.objectValue
        if let letSource {
            for (k, v) in letSource.pairs {
                if lets.count >= LiveSpecLimits.lets { break }
                guard isIdent(k), !reserved.contains(k), let e = expr(v) else { continue }
                lets.append((k, e))
            }
        }

        var counter = Counter()
        let uiJSON = obj["ui"]?.arrayValue ?? obj["components"]?.arrayValue ?? []
        var ui = components(uiJSON, prefix: "", depth: 0, counter: &counter)
        if let uiValue = obj["ui"], case .array(_, true) = uiValue {
            if case .pending = ui.last {} else { ui.append(.pending(key: "\(ui.count)")) }
        }

        return (LiveSpec(title: str(obj["title"]), currency: currency, data: data, dataKeys: dataKeys, lets: lets, ui: ui, streaming: rootOpen), nil)
    }

    struct Counter {
        var count = 0
        var ids: Set<String> = []
    }

    static func components(_ list: [LiveJSON], prefix: String, depth: Int, counter: inout Counter) -> [LiveComponent] {
        var out: [LiveComponent] = []
        for (index, raw) in list.enumerated() {
            if counter.count >= LiveSpecLimits.components { break }
            let key = prefix.isEmpty ? "\(index)" : "\(prefix).\(index)"
            guard case .object(let o, let isOpen) = raw else { continue }
            let typeRaw: String? = {
                if case .string(let t) = o["type"] { return t.trimmingCharacters(in: .whitespaces).lowercased() }
                return nil
            }()
            let type = typeRaw.map { aliases[$0] ?? $0 }
            if isOpen, type == nil || !layouts.contains(type!) {
                out.append(.pending(key: key))
                continue
            }
            guard let type else { continue }
            if let c = component(o, type: type, typeRaw: typeRaw ?? type, key: key, depth: depth, isOpen: isOpen, counter: &counter) {
                counter.count += 1
                out.append(c)
            }
        }
        return out
    }

    static func component(
        _ raw: LiveJSONObject, type: String, typeRaw: String, key: String, depth: Int, isOpen: Bool, counter: inout Counter
    ) -> LiveComponent? {
        if layouts.contains(type) {
            if depth >= LiveSpecLimits.nesting { return nil }
            let kids = raw["children"]?.arrayValue ?? raw["items"]?.arrayValue ?? []
            let children = components(kids, prefix: key, depth: depth + 1, counter: &counter)
            let pending = isOpen || (raw["children"]?.isOpen ?? false)
            if !pending && children.isEmpty { return nil }
            let kind = LiveLayout.Kind(rawValue: type) ?? .section
            let columns = Swift.max(2, Swift.min(4, Int((num(raw["columns"]) ?? 2).rounded(.towardZero))))
            return .layout(LiveLayout(key: key, kind: kind, columns: columns, title: kind == .section ? str(raw["title"]) : nil, children: children, pending: pending))
        }

        if let kind = LiveInput.Kind(rawValue: type) {
            guard case .string(let idRaw) = raw["id"] else { return nil }
            let id = idRaw.trimmingCharacters(in: .whitespaces)
            guard isIdent(id), !reserved.contains(id), !counter.ids.contains(id) else { return nil }
            let label = str(raw["label"]) ?? id
            guard let input = input(raw, kind: kind, typeRaw: typeRaw, key: key, id: id, label: label) else { return nil }
            counter.ids.insert(id)
            return .input(input)
        }

        switch type {
        case "metric":
            guard let value = expr(raw["value"]) else { return nil }
            let emphasis = raw["emphasis"] == .bool(true) || raw["primary"] == .bool(true)
            return .metric(LiveMetric(key: key, label: str(raw["label"]) ?? "", value: value, format: fmt(raw["format"]), unit: str(raw["unit"], 16), hint: str(raw["hint"] ?? raw["caption"], LiveSpecLimits.text), emphasis: emphasis))
        case "text":
            guard let text = str(raw["text"] ?? raw["content"] ?? raw["value"], LiveSpecLimits.text) else { return nil }
            let tone: LiveTextBlock.Tone =
                typeRaw == "heading" || raw["tone"] == .string("heading") ? .heading
                : (raw["tone"] == .string("muted") || typeRaw == "note") ? .muted : .body
            return .text(LiveTextBlock(key: key, text: text, tone: tone))
        case "progress":
            guard let value = expr(raw["value"]) else { return nil }
            return .progress(LiveProgress(key: key, label: str(raw["label"]) ?? "", value: value, max: expr(raw["max"]) ?? "1", format: fmt(raw["format"])))
        case "chart":
            let kindRaw: String = {
                if case .string(let k) = raw["kind"] { return k }
                if case .string(let k) = raw["chart"] { return k }
                return "line"
            }()
            let kind: LiveChartSpec.Kind = kindRaw == "bar" || kindRaw == "column" ? .bar : kindRaw == "area" ? .area : .line
            var seriesRaw: [LiveJSON] = raw["series"]?.arrayValue ?? []
            if raw["series"]?.arrayValue == nil, let y = raw["y"] {
                seriesRaw = [.object(LiveJSONObject(pairs: [("label", .string(str(raw["label"]) ?? "")), ("y", y)]), open: false)]
            }
            var series: [LiveChartSpec.Series] = []
            for s in seriesRaw {
                if series.count >= LiveSpecLimits.chartSeries { break }
                guard case .object(let so, _) = s, let y = expr(so["y"] ?? so["value"]) else { continue }
                series.append(.init(label: str(so["label"] ?? so["name"]) ?? "", y: y))
            }
            if series.isEmpty { return nil }
            var range: LiveChartSpec.Range?
            if case .object(let xo, _) = raw["x"], let from = expr(xo["from"]), let to = expr(xo["to"]) {
                var variable = "x"
                if case .string(let v) = xo["var"], isIdent(v) { variable = v }
                range = .init(from: from, to: to, step: expr(xo["step"]) ?? "1", variable: variable, label: str(xo["label"]))
            }
            let rows = expr(raw["rows"])
            if range == nil && rows == nil { return nil }
            return .chart(LiveChartSpec(
                key: key, kind: kind, title: str(raw["title"]), x: range,
                rows: range == nil ? rows : nil,
                xKey: range == nil ? (expr(raw["xKey"] ?? raw["xkey"] ?? raw["label_key"]) ?? "index") : nil,
                series: series, format: fmt(raw["format"]), xFormat: fmt(raw["xFormat"]), mark: expr(raw["mark"])
            ))
        case "table":
            let rows = expr(raw["rows"])
            var columns: [LiveTableSpec.Column] = []
            for c in raw["columns"]?.arrayValue ?? [] {
                if columns.count >= LiveSpecLimits.tableColumns { break }
                guard case .object(let co, _) = c, let value = expr(co["value"] ?? co["key"]) else { continue }
                // An empty label is a deliberate blank (a comparison's aspect column).
                let label = str(co["label"]) ?? (co["label"] == .string("") ? "" : value)
                columns.append(.init(label: label, value: value, format: fmt(co["format"]), unit: str(co["unit"], 16)))
            }
            guard let rows, !columns.isEmpty else { return nil }
            var table = LiveTableSpec(key: key, rows: rows, columns: columns)
            table.rowHeader = raw["rowHeader"] == .bool(true)
            if let hi = num(raw["highlight"]), hi == hi.rounded(), hi >= 0, Int(hi) < columns.count { table.highlight = Int(hi) }
            return .table(table)
        case "steps":
            if depth >= LiveSpecLimits.nesting { return nil }
            let list = raw["steps"]?.arrayValue ?? raw["items"]?.arrayValue ?? []
            var steps: [LiveStepsSpec.Step] = []
            for (index, s) in list.enumerated() {
                if steps.count >= LiveSpecLimits.steps { break }
                guard case .object(let so, _) = s, let title = str(so["title"] ?? so["label"]) else { continue }
                let kids = so["ui"]?.arrayValue ?? so["children"]?.arrayValue ?? []
                let ui = components(kids, prefix: "\(key).\(index)", depth: depth + 1, counter: &counter)
                steps.append(.init(
                    title: title,
                    summary: str(so["summary"] ?? so["text"] ?? so["body"], LiveSpecLimits.text),
                    detail: str(so["detail"], LiveSpecLimits.text),
                    notice: str(so["notice"], 400),
                    ui: ui
                ))
            }
            if steps.isEmpty { return nil }
            return .steps(LiveStepsSpec(key: key, title: str(raw["title"]), steps: steps, takeaway: str(raw["takeaway"], 400)))
        case "quiz":
            let fromList = raw["questions"]?.arrayValue
            let list: [LiveJSON] = fromList ?? (raw["question"] != nil ? [.object(raw, open: false)] : [])
            var questions: [LiveQuizSpec.Question] = []
            for q in list {
                if questions.count >= LiveSpecLimits.questions { break }
                guard case .object(let qo, _) = q else { continue }
                let question = str(qo["question"] ?? qo["q"], 500)
                var options: [(label: String, explanation: String?)] = []
                var flagged = -1
                for o in qo["options"]?.arrayValue ?? [] {
                    if options.count >= LiveSpecLimits.quizOptions { break }
                    switch o {
                    case .string, .number:
                        if let label = str(o, 300) { options.append((label, nil)) }
                    case .object(let oo, _):
                        guard let label = str(oo["label"] ?? oo["text"], 300) else { continue }
                        if oo["correct"] == .bool(true) && flagged < 0 { flagged = options.count }
                        options.append((label, str(oo["explanation"] ?? oo["why"], 600)))
                    default:
                        break
                    }
                }
                var answer = -1
                switch qo["answer"] {
                case .number(let n) where n == n.rounded() && n >= 0 && Int(n) < options.count:
                    answer = Int(n)
                case .string(let a) where !a.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                    let want = a.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                    answer = options.firstIndex { $0.label.lowercased() == want } ?? -1
                default:
                    break
                }
                if answer < 0 { answer = flagged }
                guard let question, options.count >= 2, answer >= 0 else { continue }
                questions.append(.init(question: question, options: options, answer: answer, explanation: str(qo["explanation"], 800), hint: str(qo["hint"], 400)))
            }
            if questions.isEmpty { return nil }
            return .quiz(LiveQuizSpec(key: key, title: fromList != nil ? str(raw["title"]) : nil, questions: questions))
        case "callout":
            guard let text = str(raw["text"] ?? raw["content"] ?? raw["body"], LiveSpecLimits.text) else { return nil }
            var toneRaw = ""
            if case .string(let t) = raw["tone"] { toneRaw = t.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            let tone = LiveCalloutSpec.Tone(rawValue: tones.contains(toneRaw) ? toneRaw : tones.contains(typeRaw) ? typeRaw : "insight") ?? .insight
            return .callout(LiveCalloutSpec(key: key, tone: tone, title: str(raw["title"]), text: text, more: str(raw["more"] ?? raw["detail"], LiveSpecLimits.text)))
        case "timeline":
            var items: [LiveTimelineSpec.Item] = []
            for it in raw["items"]?.arrayValue ?? raw["steps"]?.arrayValue ?? [] {
                if items.count >= LiveSpecLimits.timeline { break }
                if case .string(let t) = it {
                    let trimmed = t.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty { items.append(.init(label: String(decoding: trimmed.utf16.prefix(200), as: UTF16.self))) }
                    continue
                }
                guard case .object(let io, _) = it, let label = str(io["label"] ?? io["title"] ?? io["name"], 200) else { continue }
                items.append(.init(label: label, detail: str(io["detail"] ?? io["description"] ?? io["text"], 600), time: str(io["time"] ?? io["when"] ?? io["date"], 40)))
            }
            if items.isEmpty { return nil }
            return .timeline(LiveTimelineSpec(key: key, title: str(raw["title"]), items: items))
        case "explorer":
            var parts: [LiveExplorerPart] = []
            var seen: Set<String> = []
            for p in raw["parts"]?.arrayValue ?? [] {
                if parts.count >= LiveSpecLimits.parts { break }
                guard case .object(let po, _) = p, let label = str(po["label"] ?? po["name"]) else { continue }
                var id = str(po["id"]) ?? label
                if seen.contains(id) { id = "\(id)-\(parts.count)" }
                seen.insert(id)
                var facts: [(label: String, value: String)] = []
                for f in po["facts"]?.arrayValue ?? [] {
                    if facts.count >= LiveSpecLimits.facts { break }
                    if case .object(let fo, _) = f, let fl = str(fo["label"]), let fv = str(fo["value"]) { facts.append((fl, fv)) }
                }
                var at: (x: Double, y: Double)?
                if let arr = po["at"]?.arrayValue, arr.count == 2, let x = num(arr[0]), let y = num(arr[1]) {
                    at = (Swift.min(Swift.max(x, 0), 100), Swift.min(Swift.max(y, 0), 100))
                }
                parts.append(LiveExplorerPart(
                    id: id, label: label, summary: str(po["summary"], 300),
                    detail: str(po["detail"] ?? po["description"], LiveSpecLimits.text) ?? str(po["summary"], 300) ?? "",
                    facts: facts, at: at
                ))
            }
            if parts.isEmpty { return nil }
            var links: [(String, String)] = []
            for l in raw["links"]?.arrayValue ?? [] {
                if links.count >= LiveSpecLimits.links { break }
                if let pair = l.arrayValue, pair.count == 2, case .string(let a) = pair[0], case .string(let b) = pair[1], seen.contains(a), seen.contains(b) {
                    links.append((a, b))
                }
            }
            let placed = parts.allSatisfy { $0.at != nil }
            if !placed { for i in parts.indices { parts[i].at = nil } }
            return .explorer(LiveExplorerSpec(key: key, title: str(raw["title"]), parts: parts, links: placed ? links : []))
        case "stops":
            var stops: [LiveStopsSpec.Stop] = []
            for s in raw["stops"]?.arrayValue ?? raw["items"]?.arrayValue ?? [] {
                if stops.count >= LiveSpecLimits.stops { break }
                if case .string(let t) = s {
                    let trimmed = t.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty {
                        stops.append(.init(name: String(decoding: trimmed.utf16.prefix(LiveSpecLimits.label), as: UTF16.self), time: nil, note: nil, query: String(decoding: trimmed.utf16.prefix(200), as: UTF16.self)))
                    }
                    continue
                }
                guard case .object(let so, _) = s, let name = str(so["name"] ?? so["label"]) else { continue }
                stops.append(.init(name: name, time: str(so["time"] ?? so["when"], 40), note: str(so["note"] ?? so["detail"], 400), query: str(so["query"] ?? so["address"], 200) ?? name))
            }
            if stops.isEmpty { return nil }
            return .stops(LiveStopsSpec(key: key, title: str(raw["title"]), stops: stops))
        case "checklist":
            var items: [(label: String, note: String?)] = []
            for it in raw["items"]?.arrayValue ?? [] {
                if items.count >= LiveSpecLimits.checklist { break }
                if case .string(let t) = it {
                    let trimmed = t.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty { items.append((String(decoding: trimmed.utf16.prefix(200), as: UTF16.self), nil)) }
                } else if case .object(let io, _) = it, let label = str(io["label"] ?? io["text"], 200) {
                    items.append((label, str(io["note"], 300)))
                }
            }
            if items.isEmpty { return nil }
            var id = "checklist_" + key.replacingOccurrences(of: ".", with: "_")
            if case .string(let idRaw) = raw["id"], isIdent(idRaw.trimmingCharacters(in: .whitespaces)) {
                id = idRaw.trimmingCharacters(in: .whitespaces)
            }
            return .checklist(LiveChecklistSpec(key: key, id: id, title: str(raw["title"]), items: items))
        case "button":
            guard let label = str(raw["label"]) else { return nil }
            let prompt = str(raw["prompt"] ?? raw["send"], LiveSpecLimits.text)
            let copy = expr(raw["copy"])
            if prompt == nil && copy == nil { return nil }
            return .button(LiveButtonSpec(key: key, label: label, prompt: prompt, copy: prompt == nil ? copy : nil))
        default:
            return nil
        }
    }

    /// Snap onto [min, max] and the step grid from min.
    public static func snap(_ value: Double, min lo: Double, max hi: Double, step: Double) -> Double {
        let clamped = Swift.min(Swift.max(value, lo), hi)
        guard step > 0 else { return clamped }
        let steps = ((clamped - lo) / step).rounded()
        let snapped = lo + steps * step
        let decimals = Swift.min(10, Swift.max(0, -Int(log10(step).rounded(.down)) + 2))
        let cleaned = Double(String(format: "%.\(decimals)f", snapped)) ?? snapped
        return Swift.min(Swift.max(cleaned, lo), hi)
    }

    static func input(_ raw: LiveJSONObject, kind: LiveInput.Kind, typeRaw: String, key: String, id: String, label: String) -> LiveInput? {
        switch kind {
        case .slider:
            let lo = num(raw["min"]) ?? 0
            let hi = num(raw["max"]) ?? 100
            guard hi > lo else { return nil }
            let stepRaw = num(raw["step"])
            let step = stepRaw.map { $0 > 0 ? Swift.min($0, hi - lo) : (hi - lo) / 100 } ?? (hi - lo) / 100
            let value = snap(num(raw["value"]) ?? lo, min: lo, max: hi, step: step)
            return LiveInput(key: key, kind: kind, id: id, label: label, min: lo, max: hi, step: step, value: .number(value), format: fmt(raw["format"]), unit: str(raw["unit"], 16))
        case .number:
            let lo = num(raw["min"]), hi = num(raw["max"])
            let stepRaw = num(raw["step"])
            var value = num(raw["value"]) ?? lo ?? 0
            if let lo { value = Swift.max(lo, value) }
            if let hi { value = Swift.min(hi, value) }
            return LiveInput(key: key, kind: kind, id: id, label: label, min: lo, max: hi, step: (stepRaw ?? 0) > 0 ? stepRaw : nil, value: .number(value), format: fmt(raw["format"]), unit: str(raw["unit"], 16))
        case .stepper:
            let lo = num(raw["min"]) ?? 0
            let hi = num(raw["max"]) ?? 100
            guard hi > lo else { return nil }
            let stepRaw = num(raw["step"])
            let step = (stepRaw ?? 0) > 0 ? stepRaw! : 1
            return LiveInput(key: key, kind: kind, id: id, label: label, min: lo, max: hi, step: step, value: .number(snap(num(raw["value"]) ?? lo, min: lo, max: hi, step: step)), unit: str(raw["unit"], 16))
        case .select:
            var options: [LiveSelectOption] = []
            for o in raw["options"]?.arrayValue ?? [] {
                if options.count >= LiveSpecLimits.options { break }
                switch o {
                case .string(let s):
                    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !t.isEmpty {
                        let cut = String(decoding: t.utf16.prefix(60), as: UTF16.self)
                        options.append(.init(label: cut, value: .string(cut)))
                    }
                case .number(let n):
                    options.append(.init(label: jsNumberString(n), value: .number(n)))
                case .object(let oo, _):
                    let v: LiveValue? = {
                        if case .number(let n) = oo["value"] { return .number(n) }
                        return (str(oo["value"], 60) ?? str(oo["label"], 60)).map { .string($0) }
                    }()
                    let l = str(oo["label"], 60) ?? v.map(liveValueString)
                    if let v, let l { options.append(.init(label: l, value: v)) }
                default:
                    break
                }
            }
            if options.isEmpty { return nil }
            let wanted: LiveValue? = raw["value"].map { LiveValue(json: $0) }
            let match = options.first { $0.value == wanted } ?? options.first { o in wanted.map { liveValueString(o.value) == liveValueString($0) } ?? false }
            let styleRaw: String? = {
                if case .string(let s) = raw["style"], s == "menu" || s == "segmented" { return s }
                return typeRaw == "segmented" ? "segmented" : nil
            }()
            let short = options.count <= 4 && options.allSatisfy { $0.label.utf16.count <= 14 }
            var input = LiveInput(key: key, kind: kind, id: id, label: label, value: (match ?? options[0]).value)
            input.options = options
            input.segmented = (styleRaw ?? (short ? "segmented" : "menu")) == "segmented"
            return input
        case .toggle:
            return LiveInput(key: key, kind: kind, id: id, label: label, value: .bool(raw["value"] == .bool(true)))
        case .date:
            var value = Self.todayISO()
            if case .string(let s) = raw["value"], LiveDates.parse(s) != nil { value = s }
            return LiveInput(key: key, kind: kind, id: id, label: label, value: .string(value))
        case .input:
            var input = LiveInput(key: key, kind: kind, id: id, label: label, value: .string(str(raw["value"], 200) ?? ""))
            input.placeholder = str(raw["placeholder"], 80)
            return input
        }
    }

    static func todayISO() -> String {
        let c = Calendar(identifier: .gregorian).dateComponents([.year, .month, .day], from: Date())
        return String(format: "%04d-%02d-%02d", c.year ?? 2026, c.month ?? 1, c.day ?? 1)
    }

    /// FNV-1a 32-bit over UTF-16 code units — the TypeScript `liveHash`.
    public static func hash(_ text: String) -> String {
        var h: UInt32 = 0x811C_9DC5
        for unit in text.utf16 {
            h ^= UInt32(unit)
            h = h &* 0x0100_0193
        }
        return String(format: "%08x", h)
    }

    public static func storageKey(messageID: String?, source: String) -> String {
        "live-ui:v1:\(messageID ?? "-"):\(hash(source.trimmingCharacters(in: .whitespacesAndNewlines)))"
    }
}
