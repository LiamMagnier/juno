import Foundation
import SwiftUI

// MARK: - The markup

/// A ```` ```juno-visual ```` fence: a small JSON document the model writes to
/// draw cards, a flow, a comparison, a quiz, a callout, a timeline or a step
/// lab inline — the web's `inline-visual-block.tsx`, ported.
///
/// The web still draws the legacy fence (`markdown.tsx` routes `juno-visual`,
/// `juno-ui`, `juno-block`, `visual` and `visual-block` to it); native printed
/// the JSON as a code block.
public enum JunoVisualMarkup {
    /// The fence names that carry a visual.
    public static let fenceNames: Set<String> = ["juno-visual", "juno-ui", "juno-block", "visual", "visual-block"]

    public static func isVisualFence(info: String?) -> Bool {
        guard let info else { return false }
        let name = info.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
        return fenceNames.contains(name.lowercased())
    }

    /// The web's `parseVisualBlock`: nil for anything that is not a JSON object
    /// of a known type.
    public static func parse(_ source: String) -> JunoVisualBlockModel? {
        guard let data = source.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data),
            let raw = object as? [String: Any]
        else { return nil }
        let typeName = (string(raw["type"] ?? raw["kind"]) ?? "cards").lowercased()
        guard let type = JunoVisualBlockModel.Kind(rawValue: typeName) else { return nil }
        return JunoVisualBlockModel(
            type: type,
            title: string(raw["title"]),
            subtitle: string(raw["subtitle"] ?? raw["description"]),
            body: string(raw["body"] ?? raw["text"]),
            items: items(raw["items"]),
            steps: items(raw["steps"]),
            cards: items(raw["cards"]),
            nodes: items(raw["nodes"]),
            edges: edges(raw["edges"]),
            columns: strings(raw["columns"]),
            rows: rows(raw["rows"]),
            question: string(raw["question"]),
            options: options(raw["options"])
        )
    }

    static func string(_ value: Any?) -> String? {
        switch value {
        case let text as String:
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case let number as NSNumber:
            // JSONSerialization hands booleans back as NSNumber too.
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
            return number.stringValue
        default:
            return nil
        }
    }

    static func strings(_ value: Any?) -> [String]? {
        guard let array = value as? [Any] else { return nil }
        let out = array.compactMap(string)
        return out.isEmpty ? nil : out
    }

    static func item(_ value: Any?) -> JunoVisualBlockModel.Item? {
        if let text = value as? String { return JunoVisualBlockModel.Item(body: text) }
        guard let map = value as? [String: Any] else { return nil }
        return JunoVisualBlockModel.Item(
            title: string(map["title"] ?? map["name"]),
            label: string(map["label"] ?? map["step"] ?? map["id"] ?? map["date"]),
            body: string(map["body"] ?? map["description"] ?? map["content"]),
            text: string(map["text"]),
            detail: string(map["detail"] ?? map["details"]),
            value: string(map["value"]),
            tone: string(map["tone"])
        )
    }

    static func items(_ value: Any?) -> [JunoVisualBlockModel.Item]? {
        guard let array = value as? [Any] else { return nil }
        let out = array.compactMap(item)
        return out.isEmpty ? nil : out
    }

    static func options(_ value: Any?) -> [JunoVisualBlockModel.Option]? {
        guard let array = value as? [Any] else { return nil }
        let out = array.compactMap { entry -> JunoVisualBlockModel.Option? in
            guard let base = item(entry) else { return nil }
            let map = entry as? [String: Any]
            return JunoVisualBlockModel.Option(
                item: base,
                correct: (map?["correct"] as? Bool) == true,
                explanation: string(map?["explanation"] ?? map?["why"])
            )
        }
        return out.isEmpty ? nil : out
    }

    static func rows(_ value: Any?) -> [JunoVisualBlockModel.Row]? {
        guard let array = value as? [Any] else { return nil }
        let out = array.compactMap { entry -> JunoVisualBlockModel.Row? in
            guard let base = item(entry) else { return nil }
            let map = entry as? [String: Any]
            let raw = map?["values"] ?? map?["cells"]
            let values: JunoVisualBlockModel.Row.Values
            if let list = raw as? [Any] {
                values = .list(list.map { string($0) ?? "" })
            } else if let keyed = raw as? [String: Any] {
                values = .keyed(keyed.compactMapValues { string($0) })
            } else {
                values = .none
            }
            return JunoVisualBlockModel.Row(item: base, values: values)
        }
        return out.isEmpty ? nil : out
    }

    static func edges(_ value: Any?) -> [JunoVisualBlockModel.Edge]? {
        guard let array = value as? [Any] else { return nil }
        let out = array.compactMap { entry -> JunoVisualBlockModel.Edge? in
            guard let map = entry as? [String: Any] else { return nil }
            let edge = JunoVisualBlockModel.Edge(from: string(map["from"]), to: string(map["to"]), label: string(map["label"]))
            return edge.from == nil && edge.to == nil && edge.label == nil ? nil : edge
        }
        return out.isEmpty ? nil : out
    }
}

/// A parsed `juno-visual` block — the web's `VisualBlock`.
public struct JunoVisualBlockModel: Equatable, Sendable {
    public enum Kind: String, Sendable, CaseIterable {
        case cards, steps, flow, flowchart, diagram, comparison, table, quiz, callout, timeline

        var isFlow: Bool { self == .flow || self == .flowchart || self == .diagram }
        var isComparison: Bool { self == .comparison || self == .table }

        /// The web's `typeLabel`.
        public var label: String {
            switch self {
            case .steps: "Step lab"
            case .flow, .flowchart, .diagram: "Flow map"
            case .comparison, .table: "Compare"
            case .quiz: "Quick check"
            case .callout: "Key idea"
            case .timeline: "Timeline"
            case .cards: "Visual cards"
            }
        }

        /// The web's `iconFor`, in the app's own marks.
        var icon: JunoIcon {
            switch self {
            case .steps: .listChecks
            case .flow, .flowchart, .diagram: .branch
            case .comparison, .table: .columns
            case .quiz: .circleHelp
            case .callout: .info
            case .timeline: .layoutList
            case .cards: .grid
            }
        }
    }

    public struct Item: Equatable, Sendable {
        public var title: String?
        public var label: String?
        public var body: String?
        public var text: String?
        public var detail: String?
        public var value: String?
        public var tone: String?

        /// The web's `primaryText`.
        public var primaryText: String { body ?? text ?? detail ?? value ?? "" }

        /// The web's `itemTitle`.
        public func title(fallback: String) -> String { title ?? label ?? fallback }
    }

    public struct Option: Equatable, Sendable {
        public var item: Item
        public var correct: Bool
        public var explanation: String?
    }

    public struct Row: Equatable, Sendable {
        public enum Values: Equatable, Sendable {
            case list([String])
            case keyed([String: String])
            case none
        }

        public var item: Item
        public var values: Values

        /// The web's `valueFor`.
        public func value(column: String, index: Int) -> String {
            switch values {
            case .list(let list): return index < list.count ? list[index] : ""
            case .keyed(let keyed): return keyed[column] ?? keyed[column.lowercased()] ?? keyed[String(index)] ?? ""
            case .none: return index == 0 ? item.primaryText : ""
            }
        }
    }

    public struct Edge: Equatable, Sendable {
        public var from: String?
        public var to: String?
        public var label: String?
    }

    public var type: Kind
    public var title: String?
    public var subtitle: String?
    public var body: String?
    public var items: [Item]?
    public var steps: [Item]?
    public var cards: [Item]?
    public var nodes: [Item]?
    public var edges: [Edge]?
    public var columns: [String]?
    public var rows: [Row]?
    public var question: String?
    public var options: [Option]?

    /// The web's `itemsFor`.
    public var parts: [Item] { items ?? steps ?? cards ?? nodes ?? [] }

    /// The web's `itemCount`.
    public var partCount: Int {
        if type == .quiz { return options?.count ?? 0 }
        if type.isComparison { return rows?.count ?? 0 }
        return parts.count
    }

    /// The comparison's columns, or the web's two placeholders.
    var comparisonColumns: [String] {
        columns?.isEmpty == false ? columns! : ["Option A", "Option B"]
    }

    /// The comparison's rows, or its items as one-value rows.
    var comparisonRows: [Row] {
        if let rows, !rows.isEmpty { return rows }
        return parts.map { Row(item: $0, values: .list([$0.primaryText])) }
    }
}

extension JunoStepLab {
    /// The web's `stepLabFromLegacySteps`: a `juno-visual` of type `steps`,
    /// drawn as the Step Lab it has since become.
    static func fromLegacySteps(title: String?, description: String?, steps: [JunoVisualBlockModel.Item]) -> JunoStepLab {
        var seen = Set<String>()
        let converted = steps.enumerated().map { index, step -> Step in
            let stepTitle = step.title ?? step.label ?? "Step \(index + 1)"
            let summary = step.body ?? step.text ?? step.detail ?? step.value ?? "Explore this stage of the process."
            var id = (step.label ?? "step_\(index + 1)")
                .map { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") ? $0 : "_" }
                .reduce(into: "") { $0.append($1) }
            while seen.contains(id) { id = "\(id)_\(index + 1)" }
            seen.insert(id)
            let detail = step.detail.flatMap { $0 != summary && !$0.isEmpty ? $0 : nil }
            return Step(
                id: id,
                title: stepTitle,
                summary: summary,
                detail: detail,
                notice: nil,
                visualType: legacyVisualType(hint: "\(step.label ?? stepTitle) \(stepTitle) \(summary)"),
                data: nil
            )
        }
        return JunoStepLab(
            blockId: stableId("\(title ?? ""):\(converted.map(\.title).joined(separator: "|"))"),
            title: title?.isEmpty == false ? title! : "Interactive learning lab",
            label: "Step Lab",
            description: description?.isEmpty == false ? description : nil,
            density: nil,
            steps: converted,
            submitLabel: "Finish",
            quiz: nil,
            takeaway: nil
        )
    }

    private static func legacyVisualType(hint raw: String) -> VisualType {
        let hint = raw.lowercased()
        if hint.contains("token") { return .tokenization }
        if hint.contains("embed") || hint.contains("vector") { return .embedding }
        if hint.contains("attention") || hint.contains("context") { return .attention }
        if hint.contains("transformer") || hint.contains("layer") { return .transformerProcessing }
        if hint.contains("probab") || hint.contains("distribution") || hint.contains("softmax") || hint.contains("candidate") {
            return .probabilityDistribution
        }
        if hint.contains("select") || hint.contains("output") || hint.contains("next") { return .nextTokenSelection }
        return .genericProcess
    }
}

// MARK: - The view

/// A `juno-visual` fence, drawn: a radius-16 card with a header — a neutral
/// icon tile, the kind, "N parts", the title and subtitle — over the body the
/// kind asks for. A `steps` block is a Step Lab, as it is on the web.
///
/// Selection is neutral (`junoSelected` under a hairline), never coral: the
/// web's `border-primary/55 bg-primary/10` spent the accent on a selection.
/// Quiz answers keep their semantic success and destructive tones.
public struct JunoVisualBlockView: View {
    private let source: String
    private let streaming: Bool

    public init(source: String, streaming: Bool) {
        self.source = source
        self.streaming = streaming
    }

    public var body: some View {
        if let block = JunoVisualMarkup.parse(source) {
            if block.type == .steps {
                JunoStepLabView(lab: JunoStepLab.fromLegacySteps(
                    title: block.title,
                    description: block.subtitle ?? block.body,
                    steps: block.parts
                ))
            } else {
                JunoVisualSection(block: block)
            }
        } else {
            notice
        }
    }

    /// Still arriving, or not a visual: said on a radius-12 card.
    private var notice: some View {
        HStack(spacing: JunoSpace.snug) {
            if streaming {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityHidden(true)
            } else {
                JunoIconView(.warning, size: 16)
                    .foregroundStyle(Color.junoWarningInk)
                    .accessibilityHidden(true)
            }
            Text(streaming ? "Drawing inline visual..." : "This inline visual could not be rendered.")
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoSecondaryInk)
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous).fill(Color.junoCard))
        .overlay(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous).strokeBorder(Color.junoBorder, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

/// The section: header over body, on the card rung.
private struct JunoVisualSection: View {
    let block: JunoVisualBlockModel
    @State private var width: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Rectangle().fill(Color.junoBorder.opacity(0.7)).frame(height: 1).accessibilityHidden(true)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.junoCard)
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            JunoIconView(block.type.icon, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 36, height: 36)
                .background(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous).fill(Color.junoSecondary))
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .strokeBorder(Color.junoBorder.opacity(0.6), lineWidth: 1)
                )
                .padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: JunoSpace.snug) {
                    Text(block.type.label)
                        .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .padding(.horizontal, JunoSpace.snug)
                        .padding(.vertical, JunoSpace.hairline)
                        .background(RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous).fill(Color.junoMuted))
                        .overlay(
                            RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                                .strokeBorder(Color.junoBorder, lineWidth: 1)
                        )
                    if block.partCount > 0 {
                        Text(block.partCount == 1 ? "1 part" : "\(block.partCount) parts")
                            .junoFont(size: 11, relativeTo: .caption2)
                            .monospacedDigit()
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                }
                if let title = block.title {
                    Text(title)
                        .junoType(.heading)
                        .foregroundStyle(Color.junoForeground)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, JunoSpace.snug)
                        .accessibilityAddTraits(.isHeader)
                }
                if let subtitle = block.subtitle {
                    Text(subtitle)
                        .junoFont(size: 13, relativeTo: .callout)
                        .lineSpacing(3)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, JunoSpace.hairline)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
    }

    @ViewBuilder
    private var content: some View {
        let type = block.type
        if type.isFlow {
            JunoVisualFlow(block: block, width: width)
        } else if type.isComparison {
            JunoVisualComparison(block: block, width: width)
        } else if type == .quiz {
            JunoVisualQuiz(block: block)
        } else if type == .callout {
            JunoVisualCallout(block: block)
        } else if type == .timeline {
            JunoVisualTimeline(block: block)
        } else {
            JunoVisualCards(block: block, width: width)
        }
    }
}

// MARK: Shared pieces

/// A radius-12 tile on the card rung that lights neutrally when chosen.
private struct JunoVisualTileStyle: ButtonStyle {
    var isActive: Bool
    var minHeight: CGFloat = 44

    func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration, isActive: isActive, minHeight: minHeight)
    }

    private struct Face: View {
        let configuration: ButtonStyleConfiguration
        let isActive: Bool
        let minHeight: CGFloat
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var hovered = false

        var body: some View {
            configuration.label
                .padding(JunoSpace.cozy)
                .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .topLeading)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .fill(isActive ? Color.junoSelected : hovered ? Color.junoHover : Color.junoCard)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .strokeBorder(
                            isActive ? Color.junoForeground.opacity(0.28) : Color.junoBorder,
                            lineWidth: 1
                        )
                )
                .contentShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
                .scaleEffect(configuration.isPressed ? JunoMotion.scaleFrom(0.985, reduceMotion: reduceMotion) : 1)
                #if os(macOS)
                .onHover { hovered = $0 }
                #endif
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: isActive)
                .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion), value: configuration.isPressed)
        }
    }
}

/// The detail panel under a selection: `junoSecondary`, radius 12.
private struct JunoVisualPanel<Content: View>: View {
    let icon: JunoIcon
    let label: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(icon, size: 14).accessibilityHidden(true)
                Text(label).junoFont(size: 11, relativeTo: .caption2, weight: .medium)
            }
            .foregroundStyle(Color.junoSecondaryInk)
            content
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous).fill(Color.junoSecondary))
        .overlay(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous).strokeBorder(Color.junoBorder, lineWidth: 1))
    }
}

@MainActor
private func bodyText(_ text: String, size: CGFloat = 14) -> some View {
    Text(text)
        .junoFont(size: size, relativeTo: .body)
        .lineSpacing(size * 0.6 - 2)
        .foregroundStyle(Color.junoSecondaryInk)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
}

// MARK: Cards

private struct JunoVisualCards: View {
    let block: JunoVisualBlockModel
    let width: CGFloat
    @State private var active = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var items: [JunoVisualBlockModel.Item] { block.parts }
    /// `@[36rem]`: the list beside its focus panel.
    private var isWide: Bool { width >= 576 }
    /// `@[24rem]`: two columns of cards when stacked.
    private var listColumns: Int { !isWide && width >= 384 ? 2 : 1 }

    var body: some View {
        if items.isEmpty {
            EmptyView()
        } else if isWide {
            // `grid-cols-[0.95fr_1.25fr]`, as widths: the list, then the focus.
            let available = max(0, width - 2 * JunoSpace.cozy - JunoSpace.cozy)
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                list.frame(width: available * 0.95 / 2.2)
                focus.frame(width: available * 1.25 / 2.2)
            }
            .padding(JunoSpace.cozy)
        } else {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                list
                focus
            }
            .padding(JunoSpace.cozy)
        }
    }

    private var list: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: JunoSpace.snug, alignment: .top), count: listColumns),
            alignment: .leading,
            spacing: JunoSpace.snug
        ) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                cardButton(item, index: index)
            }
        }
    }

    private func cardButton(_ item: JunoVisualBlockModel.Item, index: Int) -> some View {
        Button {
            active = index
        } label: {
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                Text(item.label ?? "\(index + 1)")
                    .junoFont(size: 12, relativeTo: .caption, weight: .semibold, design: .monospaced)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .frame(minWidth: 28, minHeight: 28)
                    .background(RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous).fill(Color.junoCard))
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                            .strokeBorder(Color.junoBorder, lineWidth: 1)
                    )
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(item.title(fallback: "Card \(index + 1)"))
                        .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                        .foregroundStyle(Color.junoForeground)
                        .fixedSize(horizontal: false, vertical: true)
                    if !item.primaryText.isEmpty {
                        Text(item.primaryText)
                            .junoFont(size: 12, relativeTo: .caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            .multilineTextAlignment(.leading)
            .frame(minHeight: 44, alignment: .topLeading)
        }
        .buttonStyle(JunoVisualTileStyle(isActive: index == active, minHeight: 80))
        .contentShape(.rect)
        .accessibilityAddTraits(index == active ? .isSelected : [])
    }

    private var focus: some View {
        let selected = items[min(active, items.count - 1)]
        return JunoVisualPanel(icon: .maximize, label: "Focus") {
            Text(selected.title(fallback: "Selected card"))
                .junoFont(size: 16, relativeTo: .headline, weight: .semibold)
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, JunoSpace.cozy)
            if !selected.primaryText.isEmpty {
                bodyText(selected.primaryText).padding(.top, JunoSpace.snug)
            }
            if let detail = selected.detail, detail != selected.primaryText {
                bodyText(detail)
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.snug)
                    .background(RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous).fill(Color.junoHover))
                    .padding(.top, JunoSpace.cozy)
            }
        }
        .id(active)
        .transition(.opacity)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: active)
    }
}

// MARK: Flow

private struct JunoVisualFlow: View {
    let block: JunoVisualBlockModel
    let width: CGFloat
    @State private var active = 0

    private var nodes: [JunoVisualBlockModel.Item] { block.parts }
    private var isWide: Bool { width >= 384 }

    var body: some View {
        if nodes.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                grid
                detail
                if let edges = block.edges {
                    JunoChipFlow(spacing: JunoSpace.snug, lineSpacing: JunoSpace.snug) {
                        ForEach(Array(edges.enumerated()), id: \.offset) { _, edge in
                            Text([edge.from, edge.label, edge.to].compactMap { $0 }.joined(separator: " → "))
                                .junoFont(size: 11, relativeTo: .caption2)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .padding(.horizontal, JunoSpace.snug)
                                .padding(.vertical, JunoSpace.hairline)
                                .background(RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous).fill(Color.junoMuted))
                                .overlay(
                                    RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                                        .strokeBorder(Color.junoBorder, lineWidth: 1)
                                )
                        }
                    }
                }
            }
            .padding(JunoSpace.cozy)
        }
    }

    /// The nodes in reading order with an arrow between each, wrapping to the
    /// next line when they do not fit — the web's
    /// `repeat(auto-fit, minmax(8rem, 1fr))` with arrow cells, laid out so an
    /// arrow is only as wide as an arrow. Stacked, without arrows, when narrow.
    @ViewBuilder
    private var grid: some View {
        if isWide {
            let available = max(0, width - 2 * JunoSpace.cozy)
            let arrow: CGFloat = 16
            let count = CGFloat(nodes.count)
            let nodeWidth = min(max(128, (available - (count - 1) * (arrow + 2 * JunoSpace.snug)) / count), 224)
            JunoChipFlow(spacing: JunoSpace.snug, lineSpacing: JunoSpace.snug) {
                ForEach(Array(nodes.enumerated()), id: \.offset) { index, node in
                    nodeButton(node, index: index).frame(width: nodeWidth)
                    if index < nodes.count - 1 {
                        JunoIconView(.arrowRight, size: 16)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .frame(width: arrow, height: 72)
                            .accessibilityHidden(true)
                    }
                }
            }
        } else {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                ForEach(Array(nodes.enumerated()), id: \.offset) { index, node in
                    nodeButton(node, index: index)
                }
            }
        }
    }

    private func nodeButton(_ node: JunoVisualBlockModel.Item, index: Int) -> some View {
        Button {
            active = index
        } label: {
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                JunoIconView(index == active ? .circleDot : .circle, size: 14)
                    .foregroundStyle(index == active ? Color.junoForeground : Color.junoSecondaryInk)
                    .padding(.top, 2)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(node.title(fallback: "Node \(index + 1)"))
                        .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                        .foregroundStyle(Color.junoForeground)
                        .fixedSize(horizontal: false, vertical: true)
                    if !node.primaryText.isEmpty {
                        Text(node.primaryText)
                            .junoFont(size: 12, relativeTo: .caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .multilineTextAlignment(.leading)
            .frame(minHeight: 44, alignment: .topLeading)
        }
        .buttonStyle(JunoVisualTileStyle(isActive: index == active))
        .contentShape(.rect)
        .accessibilityAddTraits(index == active ? .isSelected : [])
    }

    private var detail: some View {
        let selected = nodes[min(active, nodes.count - 1)]
        return JunoVisualPanel(icon: .cornerDownRight, label: "Selected node") {
            Text(selected.title(fallback: "Node \(active + 1)"))
                .junoType(.heading)
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, JunoSpace.cozy)
            if !selected.primaryText.isEmpty {
                bodyText(selected.primaryText).padding(.top, JunoSpace.snug)
            }
        }
    }
}

// MARK: Comparison

private struct JunoVisualComparison: View {
    let block: JunoVisualBlockModel
    let width: CGFloat

    private var columns: [String] { block.comparisonColumns }
    private var rows: [JunoVisualBlockModel.Row] { block.comparisonRows }

    /// `minmax(7rem, 0.8fr) repeat(n, minmax(9rem, 1fr))` over at least
    /// 34rem: the label column and the value columns, sized once.
    private var widths: (label: CGFloat, value: CGFloat) {
        let gap = JunoSpace.snug
        let total = max(544, width - 2 * JunoSpace.cozy) - gap * CGFloat(columns.count)
        let unit = total / (0.8 + CGFloat(columns.count))
        return (max(112, unit * 0.8), max(144, unit))
    }

    var body: some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                row(label: cell("Focus", header: true, isLabel: true)) { index in
                    cell(columns[index], header: true, isLabel: false)
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { rowIndex, entry in
                    row(label: cell(entry.item.title(fallback: "Row \(rowIndex + 1)"), header: false, isLabel: true)) { index in
                        cell(entry.value(column: columns[index], index: index), header: false, isLabel: false)
                    }
                }
            }
            .padding(JunoSpace.cozy)
        }
        .scrollIndicators(.automatic)
    }

    private func row<Label: View, Cell: View>(label: Label, @ViewBuilder cell: @escaping (Int) -> Cell) -> some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            label.frame(width: widths.label)
            ForEach(columns.indices, id: \.self) { index in
                cell(index).frame(width: widths.value)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Headers and row labels are chrome (`junoSecondary`); values are content
    /// (`junoCard`) — the web's two rungs.
    private func cell(_ text: String, header: Bool, isLabel: Bool) -> some View {
        let chrome = header || isLabel
        return Text(text)
            .junoFont(
                size: header && isLabel ? 11 : chrome ? 13 : 14,
                relativeTo: chrome ? .callout : .body,
                weight: chrome && !(header && isLabel) ? .semibold : .regular
            )
            .foregroundStyle(chrome && !(header && isLabel) ? Color.junoForeground : Color.junoSecondaryInk)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, header ? JunoSpace.snug : JunoSpace.cozy)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .fill(chrome ? Color.junoSecondary : Color.junoCard)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
    }
}

// MARK: Quiz

private struct JunoVisualQuiz: View {
    let block: JunoVisualBlockModel
    @State private var selected: Int?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var options: [JunoVisualBlockModel.Option] { block.options ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("Quick check")
                    .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
                    .foregroundStyle(Color.junoSecondaryInk)
                Text(block.question ?? block.title ?? "Which option fits best?")
                    .junoFont(size: 16, relativeTo: .headline, weight: .semibold)
                    .foregroundStyle(Color.junoForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                    optionButton(option, index: index)
                }
            }
            if let selected, selected < options.count {
                verdict(options[selected])
                    .transition(.opacity.combined(with: .offset(y: JunoMotion.shift(JunoMotion.riseDistance, reduceMotion: reduceMotion))))
            }
        }
        .padding(JunoSpace.regular)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion), value: selected)
    }

    private func optionButton(_ option: JunoVisualBlockModel.Option, index: Int) -> some View {
        let isActive = selected == index
        let tone: Color? = isActive ? (option.correct ? .junoSuccessInk : .junoDestructiveInk) : nil
        return Button {
            selected = index
        } label: {
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                Group {
                    if isActive {
                        JunoIconView(option.correct ? .check : .close, size: 14)
                            .foregroundStyle(tone ?? Color.junoForeground)
                    } else {
                        Text("\(index + 1)")
                            .junoFont(size: 11, relativeTo: .caption2, weight: .semibold, design: .monospaced)
                            .foregroundStyle(Color.junoForeground)
                    }
                }
                .frame(width: 24, height: 24)
                .background(RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous).fill(Color.junoCard))
                .overlay(RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous).strokeBorder(Color.junoBorder, lineWidth: 1))
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(option.item.title(fallback: "Option \(index + 1)"))
                        .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                        .foregroundStyle(Color.junoForeground)
                        .fixedSize(horizontal: false, vertical: true)
                    if !option.item.primaryText.isEmpty {
                        Text(option.item.primaryText)
                            .junoFont(size: 12, relativeTo: .caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .multilineTextAlignment(.leading)
            .frame(minHeight: 44, alignment: .topLeading)
        }
        .buttonStyle(JunoVisualAnswerStyle(tone: tone))
        .contentShape(.rect)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    private func verdict(_ option: JunoVisualBlockModel.Option) -> some View {
        let tone: Color = option.correct ? .junoSuccessInk : .junoDestructiveInk
        let lead = Text(option.correct ? "Correct. " : "Not quite. ")
            .fontWeight(.semibold)
            .foregroundStyle(Color.junoForeground)
        let explanation = Text(option.explanation ?? option.item.detail ?? "Try comparing the options against the main idea above.")
            .foregroundStyle(Color.junoSecondaryInk)
        return Text("\(lead)\(explanation)")
        .junoFont(size: 14, relativeTo: .body)
        .fixedSize(horizontal: false, vertical: true)
        .padding(JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous).fill(tone.opacity(0.1)))
        .overlay(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous).strokeBorder(tone.opacity(0.45), lineWidth: 1))
    }
}

/// A quiz option: a card tile that takes the answer's tone once chosen.
private struct JunoVisualAnswerStyle: ButtonStyle {
    let tone: Color?

    func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration, tone: tone)
    }

    private struct Face: View {
        let configuration: ButtonStyleConfiguration
        let tone: Color?
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var hovered = false

        var body: some View {
            configuration.label
                .padding(JunoSpace.cozy)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .topLeading)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .fill(tone.map { $0.opacity(0.1) } ?? (hovered ? Color.junoHover : Color.junoCard))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .strokeBorder(tone.map { $0.opacity(0.55) } ?? Color.junoBorder, lineWidth: 1)
                )
                .contentShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
                .scaleEffect(configuration.isPressed ? JunoMotion.scaleFrom(0.985, reduceMotion: reduceMotion) : 1)
                #if os(macOS)
                .onHover { hovered = $0 }
                #endif
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
                .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion), value: configuration.isPressed)
        }
    }
}

// MARK: Callout

private struct JunoVisualCallout: View {
    let block: JunoVisualBlockModel

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if let body = block.body {
                bodyText(body)
            }
            ForEach(Array(block.parts.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .top, spacing: JunoSpace.snug) {
                    JunoIconView(.info, size: 14)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .padding(.top, 3)
                        .accessibilityHidden(true)
                    Text("\(Text(item.title(fallback: "Point \(index + 1)")).fontWeight(.semibold).foregroundStyle(Color.junoForeground))\(Text(item.primaryText.isEmpty ? "" : " - \(item.primaryText)").foregroundStyle(Color.junoSecondaryInk))")
                    .junoFont(size: 14, relativeTo: .body)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
                .background(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous).fill(Color.junoSecondary))
            }
        }
        .padding(JunoSpace.regular)
    }
}

// MARK: Timeline

private struct JunoVisualTimeline: View {
    let block: JunoVisualBlockModel

    /// The label pill's width; the spine runs through its centre.
    private static let pill: CGFloat = 64

    var body: some View {
        let items = block.parts
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .top, spacing: JunoSpace.cozy) {
                    Text(item.label ?? "\(index + 1)")
                        .junoFont(size: 11, relativeTo: .caption2)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                        .padding(.horizontal, JunoSpace.hairline)
                        .frame(width: Self.pill, height: 24)
                        .background(Capsule(style: .continuous).fill(Color.junoCard))
                        .overlay(Capsule(style: .continuous).strokeBorder(Color.junoBorder, lineWidth: 1))
                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        Text(item.title(fallback: "Moment \(index + 1)"))
                            .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                            .foregroundStyle(Color.junoForeground)
                            .fixedSize(horizontal: false, vertical: true)
                        if !item.primaryText.isEmpty {
                            bodyText(item.primaryText)
                        }
                    }
                    .padding(.top, 3)
                    Spacer(minLength: 0)
                }
                .padding(.bottom, index == items.count - 1 ? 0 : JunoSpace.regular)
                // The spine: one hairline through every pill, behind it.
                .background(alignment: .topLeading) {
                    if index < items.count - 1 {
                        Rectangle()
                            .fill(Color.junoBorder)
                            .frame(width: 1)
                            .frame(maxHeight: .infinity)
                            .padding(.leading, Self.pill / 2 - 0.5)
                            .padding(.top, 12)
                            .padding(.bottom, -12)
                            .accessibilityHidden(true)
                    }
                }
            }
        }
        .padding(JunoSpace.regular)
    }
}
