import Foundation
import JunoCodeRuntime
import JunoDesignSystem

/// Settings › Generation models: the image, video and music model the Code
/// agent uses when a task needs new media. The Code picker lists only text
/// models that can write code, so these are chosen here instead.
///
/// The same rules as the web's `src/lib/code-v2/generation-models.ts`:
/// - the choices are the catalogue's current models of that modality (no past
///   generations, nothing "coming soon"), in the catalogue's display order;
/// - the default is the newest of them by release, ties in display order;
/// - a stored choice the catalogue no longer offers falls back to the default.
///
/// TODO(server-side): kept in this Mac's preferences per account, because the
/// account settings row has no field for it yet. Move it to a Settings column
/// and `PATCH /api/settings` so the Mac and the web share one choice.
public enum CodeGenerationModels {
    /// One choice in a setting's menu.
    public struct Choice: Identifiable, Equatable, Sendable {
        public let id: String
        public let name: String
        public let lab: String
        public let released: String?
    }

    public static let defaultsKeyPrefix = "juno.code.generationModels"

    /// Per account, so two Alevr accounts on one Mac keep their own choices.
    public static func defaultsKey(account: String?) -> String {
        account.map { "\(defaultsKeyPrefix).\($0)" } ?? defaultsKeyPrefix
    }

    static func modality(_ kind: CodeMediaKind) -> JunoModelModality {
        switch kind {
        case .image: .image
        case .video: .video
        case .audio: .audio
        }
    }

    /// The menu for `kind`, in the catalogue's display order.
    public static func choices(_ kind: CodeMediaKind, in models: [ModelOption]) -> [Choice] {
        models.compactMap { option in
            guard let catalog = option.catalog,
                  catalog.modality == modality(kind),
                  !catalog.isLegacy,
                  !JunoModelSelectorCatalog.isComingSoon(catalog)
            else { return nil }
            return Choice(id: option.modelID, name: catalog.displayName, lab: catalog.shortProviderName, released: catalog.released)
        }
    }

    /// The newest current model of the kind; ties keep display order.
    public static func defaultModel(_ kind: CodeMediaKind, in choices: [Choice]) -> String? {
        choices.enumerated()
            .max { lhs, rhs in
                let l = lhs.element.released ?? "", r = rhs.element.released ?? ""
                return l == r ? lhs.offset > rhs.offset : l < r
            }?
            .element.id
    }

    public static func stored(_ kind: CodeMediaKind, defaults: UserDefaults = .standard, account: String? = nil) -> String? {
        guard let data = defaults.data(forKey: defaultsKey(account: account)),
              let map = try? JSONDecoder().decode([String: String].self, from: data) else { return nil }
        return map[kind.rawValue]
    }

    public static func store(_ id: String?, for kind: CodeMediaKind, defaults: UserDefaults = .standard, account: String? = nil) {
        let key = defaultsKey(account: account)
        var map = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode([String: String].self, from: $0) } ?? [:]
        map[kind.rawValue] = id
        if let data = try? JSONEncoder().encode(map) { defaults.set(data, forKey: key) }
    }

    /// What the agent uses: the stored choice while the catalogue offers it,
    /// else the default. Nil when the catalogue has no model of the kind.
    public static func resolved(_ kind: CodeMediaKind, in models: [ModelOption], defaults: UserDefaults = .standard, account: String? = nil) -> String? {
        let menu = choices(kind, in: models)
        if let stored = stored(kind, defaults: defaults, account: account), menu.contains(where: { $0.id == stored }) {
            return stored
        }
        return defaultModel(kind, in: menu)
    }

    /// The account's media models as last delivered, readable from any
    /// thread: the media tools resolve their model from it when they run.
    public static let catalogue = Catalogue()

    public final class Catalogue: @unchecked Sendable {
        private let lock = NSLock()
        private var models: [ModelOption] = []

        public func replace(_ models: [ModelOption]) {
            lock.withLock { self.models = models }
        }

        public var current: [ModelOption] { lock.withLock { models } }

        /// The model a media tool uses for `kind` right now.
        public func resolved(_ kind: CodeMediaKind, defaults: UserDefaults = .standard) -> String? {
            CodeGenerationModels.resolved(kind, in: current, defaults: defaults)
        }
    }

    /// The kinds the catalogue has at least one model for.
    public static func kinds(in models: [ModelOption]) -> [CodeMediaKind] {
        CodeMediaKind.allCases.filter { !choices($0, in: models).isEmpty }
    }
}
