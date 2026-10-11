import Foundation
import JunoCodeCore

/// The remote's model picker, as data: the Mac's Code picker's two kinds of
/// place (`CodeV2ModelCatalogue` on the Mac).
///
/// - **Alevr.** The API models Alevr serves on the Mac (its own engine, billed
///   to the Alevr plan) and the ones the Mac's own keys reach, each filed under
///   the lab that makes it.
/// - **Subscriptions.** The plans signed in on the Mac (Claude, ChatGPT through
///   Codex, the ACP agents), each with its own models.
///
/// Every entry carries its own thinking levels (the model's, else its
/// runtime's), and its id names both the source and the model, because the
/// same model can be offered by Alevr and by a subscription.
public struct CodeLinkPickerCatalogue: Equatable, Sendable {
    /// One model on the source that runs it.
    public struct Entry: Identifiable, Equatable, Sendable {
        public let instance: CodeV2.ProviderInstance
        public let model: CodeV2.ProviderModel
        /// The lab's id ("anthropic", "zhipu"…), "other" when the id names none.
        public let lab: String

        public var id: String { CodeLinkPickerCatalogue.entryID(instanceId: instance.id, model: model.id) }
        public var labName: String { CodeV2Labs.name(lab) }
        /// The model's own levels, else its runtime's.
        public var effortLevels: [CodeV2.EffortLevel] {
            model.effortLevels ?? instance.capabilities?.effortLevels ?? []
        }
        public var isSubscription: Bool { CodeV2.runsOnEnvServer(instance.kind) }
    }

    /// One subscription and its models.
    public struct Plan: Identifiable, Equatable, Sendable {
        public let instance: CodeV2.ProviderInstance
        public let entries: [Entry]
        public var id: String { instance.id }

        /// "Claude plan", "ChatGPT plan", or the agent's own name.
        public var title: String {
            instance.kind == .claudeAgent || instance.kind == .codex
                ? "\(CodeV2ProviderDirectory.vendorName(instance)) plan" : instance.label
        }

        /// The lab whose mark the plan wears ("anthropic" for Claude).
        public var lab: String {
            switch instance.kind {
            case .claudeAgent: "anthropic"
            case .codex: "openai"
            default: entries.first?.lab ?? "other"
            }
        }
    }

    /// Alevr's models (and the Mac's keys'), in the Mac's order.
    public let api: [Entry]
    public let subscriptions: [Plan]

    public init(_ catalogue: [CodeLinkModelGroup]) {
        var api: [Entry] = []
        var plans: [Plan] = []
        for group in catalogue {
            let entries = group.models.map { model in
                Entry(instance: group.instance, model: model, lab: Self.lab(model: model.id, instance: group.instance))
            }
            if group.isSubscription {
                plans.append(Plan(instance: group.instance, entries: entries))
            } else {
                api.append(contentsOf: entries)
            }
        }
        self.api = api
        self.subscriptions = plans
    }

    public var all: [Entry] { api + subscriptions.flatMap(\.entries) }

    public func entry(_ id: String) -> Entry? { all.first { $0.id == id } }

    public func entry(for selection: CodeV2.ModelSelection?) -> Entry? {
        guard let selection else { return nil }
        return entry(Self.entryID(instanceId: selection.instanceId, model: selection.model))
    }

    /// "<instanceId>|<model>": neither half ever holds a bar.
    public static func entryID(instanceId: String, model: String) -> String { "\(instanceId)|\(model)" }

    /// A subscription's model ids are the vendor's own ("claude-opus-5-5"),
    /// so its lab is the vendor's; Alevr's carry theirs as a prefix.
    static func lab(model: String, instance: CodeV2.ProviderInstance) -> String {
        if model.contains(":") || instance.kind == .byok { return CodeV2Labs.labID(model: model, instance: instance) }
        switch instance.kind {
        case .claudeAgent: return "anthropic"
        case .codex: return "openai"
        default: return CodeV2Labs.labID(model: model, instance: instance)
        }
    }
}

extension CodeLinkComposerState {
    /// Picks an entry of the picker: its source and model, keeping the effort
    /// where the new model offers it, else the model's default.
    public mutating func choose(_ entry: CodeLinkPickerCatalogue.Entry) {
        choose(instance: entry.instance, model: entry.model)
    }

    /// The picker entry for the current selection, as the picker names it.
    public var entryID: String? {
        selection.map { CodeLinkPickerCatalogue.entryID(instanceId: $0.instanceId, model: $0.model) }
    }
}
