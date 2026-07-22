#if DEBUG
import Foundation

/// The selectable states the local UI Preview harness can present. Each maps to
/// a set of fixtures plus a network posture on ``PreviewSender`` — no real
/// server, token, or production storage is ever involved.
public enum PreviewScenario: String, CaseIterable, Identifiable, Sendable {
    case normal
    case manyItems
    case empty
    case loading
    case offline
    case error
    case conflict
    case mutating
    case longText
    case streaming

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .normal: "Normal"
        case .manyItems: "Many items"
        case .empty: "Empty"
        case .loading: "Loading"
        case .offline: "Offline"
        case .error: "Error"
        case .conflict: "Conflict"
        case .mutating: "Mutation in progress"
        case .longText: "Very long text"
        case .streaming: "Streaming"
        }
    }

    /// Whether ``PreviewSender`` should refuse requests (drives offline/error
    /// affordances without any real network).
    public var networkFails: Bool {
        switch self {
        case .offline, .error: true
        default: false
        }
    }

    /// The synchronization phase the harness pins on the sync model.
    public var isOffline: Bool { self == .offline }
}
#endif
