import Foundation
import JunoCodeCore
import JunoDesignSystem

/// The Code model picker's arithmetic, free of SwiftUI so it can be tested
/// without a render pass. A port of `src/lib/code-v2/picker-catalogue.ts`: the
/// same model reads the same way in the Mac and the browser.
///
/// The picker has two kinds of place:
/// - **Labs.** Every model Alevr hosts, plus the models your own API keys
///   reach, filed under the lab that makes them (Anthropic, OpenAI, Google…),
///   in the web catalogue's lab order. Inside a lab the models are grouped by
///   where they run: "Alevr" first, then "Your <Lab> key".
/// - **Subscriptions.** The plans you connected on this Mac (your Claude plan,
///   ChatGPT through Codex, Gemini CLI, Grok…), each with its usage line. Keys
///   never appear here: a key is billed by the lab, not a plan.
///
/// Code is an agent, so only text models that can call tools are listed. The
/// Alevr instance is already filtered that way (``CodeV2AlevrCatalog``); image,
/// video and audio models are chosen in Settings › Generation models instead.
public enum CodeV2ModelCatalogue {

    // MARK: Labs

    /// The web's `PROVIDER_LIST`, which the Chat catalogue already ports.
    public static var labOrder: [String] { JunoModelSelectorCatalog.labOrder + ["openrouter"] }

    /// The rail's one word per lab: the first half of the web's
    /// `PROVIDERS[lab].label` ("Anthropic · Claude" → "Anthropic").
    public static let labNames: [String: String] = [
        "anthropic": "Anthropic", "openai": "OpenAI", "zhipu": "Zhipu", "moonshot": "Moonshot",
        "google": "Google", "meta": "Meta", "deepseek": "DeepSeek", "mistral": "Mistral",
        "xai": "SpaceXAI", "seedance": "ByteDance", "minimax": "MiniMax", "mimo": "MiMo",
        "qwen": "Alibaba", "longcat": "Meituan", "openrouter": "OpenRouter",
    ]

    public static func labName(_ id: String) -> String {
        labNames[id.lowercased()] ?? (id.prefix(1).uppercased() + id.dropFirst())
    }

    /// The lab a model belongs to: its id's routing prefix ("anthropic:claude-opus-5-5"),
    /// else the lab of the key it runs on, else "other".
    public static func labID(model: String, instance: CodeV2.ProviderInstance) -> String {
        if let colon = model.firstIndex(of: ":") { return model[..<colon].lowercased() }
        if instance.kind == .byok, let lab = byokLab(instance) { return lab.rawValue }
        return "other"
    }

    static func byokLab(_ instance: CodeV2.ProviderInstance) -> CodeV2.ByokProvider? {
        instance.id.split(separator: ":").last.flatMap { CodeV2.ByokProvider(rawValue: String($0)) }
    }

    static func labRank(_ id: String) -> Int { labOrder.firstIndex(of: id) ?? labOrder.count }

    /// A subscription: the vendor's own agent on this Mac, on the user's plan.
    public static func isSubscription(_ instance: CodeV2.ProviderInstance) -> Bool {
        instance.kind == .claudeAgent || instance.kind == .codex || instance.kind == .acp
    }

    public static func isConnected(_ instance: CodeV2.ProviderInstance) -> Bool {
        instance.status == .ready || instance.status == .limited
    }

    /// The models an Alevr-engine source offers. A key with no models of its own
    /// reaches the Alevr models of its lab, through the same engine, on the
    /// user's key (the web's `codeProviderModels({ provider })`).
    public static func models(of instance: CodeV2.ProviderInstance, in directory: CodeV2ProviderDirectory) -> [CodeV2.ProviderModel] {
        if let own = instance.models, !own.isEmpty { return own }
        guard instance.kind == .byok, let lab = byokLab(instance), lab != .openrouter,
              let alevr = directory.instances.first(where: { $0.kind == .alevr }) else { return [] }
        return (alevr.models ?? []).filter { labID(model: $0.id, instance: alevr) == lab.rawValue }
    }

    // MARK: The rail

    public enum Place: Hashable, Sendable {
        case lab(String)
        case subscriptions
    }

    public struct Lab: Identifiable, Equatable, Sendable {
        public let id: String
        public let name: String
        public let count: Int
    }

    /// One entry of the list: a model on the source that runs it.
    public struct Entry: Identifiable, Equatable, Sendable {
        public let instance: CodeV2.ProviderInstance
        public let model: CodeV2.ProviderModel
        public var id: String { instance.id + "|" + model.id }
    }

    /// The Alevr and key sources, which file their models under labs.
    static func labSources(_ directory: CodeV2ProviderDirectory) -> [CodeV2.ProviderInstance] {
        directory.instances.filter { $0.kind == .alevr || ($0.kind == .byok && isConnected($0)) }
    }

    /// Every lab model, Alevr first and then the keys, each list in its own
    /// (display) order.
    static func labEntries(_ directory: CodeV2ProviderDirectory) -> [Entry] {
        labSources(directory).flatMap { instance in
            models(of: instance, in: directory).map { Entry(instance: instance, model: $0) }
        }
    }

    /// The rail's labs, in the web's order, each with at least one model.
    public static func labs(_ directory: CodeV2ProviderDirectory, query: String = "") -> [Lab] {
        var counts: [String: Int] = [:]
        var order: [String] = []
        for entry in labEntries(directory) where matches(entry, query: query) {
            let lab = labID(model: entry.model.id, instance: entry.instance)
            if counts[lab] == nil { order.append(lab) }
            counts[lab, default: 0] += 1
        }
        return order.enumerated()
            .sorted { lhs, rhs in
                let l = labRank(lhs.element), r = labRank(rhs.element)
                return l == r ? lhs.offset < rhs.offset : l < r
            }
            .map { Lab(id: $0.element, name: labName($0.element), count: counts[$0.element] ?? 0) }
    }

    /// The connected subscriptions, in the directory's rail order.
    public static func subscriptions(_ directory: CodeV2ProviderDirectory) -> [CodeV2.ProviderInstance] {
        directory.rail.filter { isSubscription($0) && isConnected($0) }
    }

    /// Where the picker opens: the selection's lab, or Subscriptions.
    public static func place(for selection: CodeV2.ModelSelection, in directory: CodeV2ProviderDirectory) -> Place {
        guard let instance = directory.instance(selection.instanceId) else {
            return labs(directory).first.map { .lab($0.id) } ?? .subscriptions
        }
        if isSubscription(instance) { return .subscriptions }
        return .lab(labID(model: selection.model, instance: instance))
    }

    /// The rail's walk for ⌘⇧↑ / ⌘⇧↓: the labs, then Subscriptions.
    public static func places(_ directory: CodeV2ProviderDirectory) -> [Place] {
        labs(directory).map { .lab($0.id) } + [.subscriptions]
    }

    // MARK: Groups

    /// One heading and its rows. `trailing` is the subscription's usage.
    public struct Group: Identifiable, Equatable, Sendable {
        public let id: String
        public let title: String
        public let trailing: String?
        public let entries: [Entry]
    }

    /// "Alevr", "Your Anthropic key", "Claude plan".
    public static func sourceTitle(_ instance: CodeV2.ProviderInstance) -> String {
        switch instance.kind {
        case .alevr: return "Alevr"
        case .byok: return "Your \(byokLab(instance)?.labName ?? "provider") key"
        default:
            // Claude and ChatGPT are plans; the ACP agents are named as such.
            return instance.kind == .claudeAgent || instance.kind == .codex
                ? "\(CodeV2ProviderDirectory.vendorName(instance)) plan" : instance.label
        }
    }

    /// A lab's models: Alevr's, then each key's.
    public static func groups(lab: String, directory: CodeV2ProviderDirectory, query: String = "") -> [Group] {
        labSources(directory).compactMap { instance in
            let entries = models(of: instance, in: directory)
                .filter { labID(model: $0.id, instance: instance) == lab }
                .map { Entry(instance: instance, model: $0) }
                .filter { matches($0, query: query) }
            guard !entries.isEmpty else { return nil }
            return Group(id: "\(lab)/\(instance.id)", title: sourceTitle(instance), trailing: nil, entries: entries)
        }
    }

    /// One group per connected subscription, with its usage on the heading.
    public static func subscriptionGroups(_ directory: CodeV2ProviderDirectory, query: String = "") -> [Group] {
        subscriptions(directory).compactMap { instance in
            let entries = (instance.models ?? []).map { Entry(instance: instance, model: $0) }.filter { matches($0, query: query) }
            guard !entries.isEmpty || query.isEmpty else { return nil }
            return Group(id: "sub/\(instance.id)", title: sourceTitle(instance), trailing: CodeV2PickerCopy.usage(instance), entries: entries)
        }
    }

    /// What the list shows for a place, or for a search across every place:
    /// one group per lab (headed by the lab), then the subscriptions.
    public static func groups(place: Place, directory: CodeV2ProviderDirectory, query: String) -> [Group] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !needle.isEmpty {
            var out: [Group] = labs(directory, query: needle).map { lab in
                Group(
                    id: "search/\(lab.id)", title: lab.name, trailing: nil,
                    entries: groups(lab: lab.id, directory: directory, query: needle).flatMap(\.entries)
                )
            }
            let subs = subscriptionGroups(directory, query: needle).flatMap(\.entries)
            if !subs.isEmpty { out.append(Group(id: "search/subscriptions", title: "Subscriptions", trailing: nil, entries: subs)) }
            return out
        }
        switch place {
        case .lab(let lab): return groups(lab: lab, directory: directory)
        case .subscriptions: return subscriptionGroups(directory)
        }
    }

    public static func matches(_ entry: Entry, query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return true }
        return entry.model.label.localizedCaseInsensitiveContains(needle)
            || entry.model.id.localizedCaseInsensitiveContains(needle)
            || entry.instance.label.localizedCaseInsensitiveContains(needle)
            || labName(labID(model: entry.model.id, instance: entry.instance)).localizedCaseInsensitiveContains(needle)
    }

    // MARK: Row words

    /// The row's second line. The heading already names the source, so the
    /// row says only what differs: "$5 / $25 · 1M", "Your key · 200K",
    /// "Included in your plan · 1M". In search results, where rows of every
    /// source mix under one lab, an Alevr row says "Alevr · $5 / $25 · 1M".
    public static func rowLine(_ model: CodeV2.ProviderModel, in instance: CodeV2.ProviderInstance, namesSource: Bool = false) -> String {
        let tiers = CodeV2ContextMath.sorted(model.contextTiers ?? [])
        let window = tiers.last.map { CodeV2ContextMath.label(tokens: $0.tokens) }
        var parts: [String] = []
        switch instance.kind {
        case .alevr:
            if namesSource { parts.append("Alevr") }
            if let base = tiers.first, base.inputPerMTok > 0 {
                parts.append(price(base.inputPerMTok) + " / " + price(base.outputPerMTok))
            } else if !namesSource {
                parts.append("Alevr")
            }
        case .byok:
            parts.append("Your key")
        default:
            parts.append(namesSource ? "Your \(CodeV2ProviderDirectory.vendorName(instance)) plan" : "Included in your plan")
        }
        if let window { parts.append(window) }
        return parts.joined(separator: " · ")
    }

    static func price(_ value: Double) -> String {
        CodeV2ContextMath.dollars(value).replacingOccurrences(of: ".00", with: "")
    }

    /// The subscriptions the empty state names: "Claude, ChatGPT, Gemini and more, on this Mac".
    public static let connectSubtitle = "Claude, ChatGPT, Gemini and more, on this Mac"
}
