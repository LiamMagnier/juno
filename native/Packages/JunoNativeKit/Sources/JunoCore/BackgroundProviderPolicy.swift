import Foundation

/// Where Juno may send *background* work derived from an account's content.
///
/// Background work is everything the user did not explicitly address to a
/// model: memory extraction, title generation, research planning, moderation,
/// consolidation. It is invisible by definition, which is why it needs a stated
/// rule — and why the rule has to be visible on every client rather than only
/// on the web, where it happens to be set.
///
/// Mirrors `src/lib/background-provider-policy.ts`. Kept deliberately small and
/// string-backed so an unrecognised value from a newer server degrades to the
/// safe default instead of failing to decode.
public enum BackgroundProviderMode: String, Codable, CaseIterable, Sendable {
    /// The default. Background work stays with the provider of the model the
    /// user chose for the conversation it came from.
    case sameProvider = "same_provider"
    /// One provider, chosen by the user, handles all background work.
    case selectedProvider = "selected_provider"
    /// The only mode that may cross providers, and the only one a user has to
    /// opt into by name.
    case anyAllowedProvider = "any_allowed_provider"
    /// Background work runs only on a local utility model.
    case localOnly = "local_only"

    /// The privacy-preserving default, and what every unrecognised value
    /// resolves to.
    public static let `default`: BackgroundProviderMode = .sameProvider

    /// Never fails. A value written by a newer build must not be read as
    /// permission to cross providers, so anything unknown becomes the default.
    public init(storedValue: String?) {
        self = BackgroundProviderMode(rawValue: storedValue ?? "") ?? .default
    }

    /// Short label for a settings row.
    public var title: String {
        switch self {
        case .sameProvider: String(localized: "settings.background-provider.same.title")
        case .selectedProvider: String(localized: "settings.background-provider.selected.title")
        case .anyAllowedProvider: String(localized: "settings.background-provider.any.title")
        case .localOnly: String(localized: "settings.background-provider.local.title")
        }
    }

    /// What choosing it actually means, in terms of where content goes.
    public var explanation: String {
        switch self {
        case .sameProvider:
            String(localized: "settings.background-provider.same.detail")
        case .selectedProvider:
            String(localized: "settings.background-provider.selected.detail")
        case .anyAllowedProvider:
            String(localized: "settings.background-provider.any.detail")
        case .localOnly:
            String(localized: "settings.background-provider.local.detail")
        }
    }

    /// True for the one mode that lets content reach a provider the user did
    /// not pick for the conversation. Surfaces can flag it.
    public var permitsCrossProvider: Bool { self == .anyAllowedProvider }
}
