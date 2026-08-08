import Foundation

/// The product-level kind of something a user may want to resume.
///
/// The native clients used to own one recency list per feature. This is the
/// shared projection used to merge those feature-owned records without copying
/// them into a second store. The server remains authoritative for the source
/// records and their timestamps.
public enum JunoRecentKind: String, CaseIterable, Codable, Hashable, Sendable {
    case chat
    case work
    case code
    case project

    public var label: String {
        switch self {
        case .chat: "Chat"
        case .work: "Work"
        case .code: "Code"
        case .project: "Project"
        }
    }

    public var systemImage: String {
        switch self {
        case .chat: "bubble.left.and.bubble.right"
        case .work: "checklist"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .project: "folder"
        }
    }
}

/// Filters deliberately model the questions a user asks, not a product ×
/// state matrix. A waiting approval is not a running task, and a cancelled
/// task is not a failure; keeping those distinctions here prevents each native
/// surface from inventing its own interpretation.
public enum JunoRecentFilter: String, CaseIterable, Codable, Hashable, Sendable {
    case all
    case chat
    case work
    case code
    case projects
    case pinned
    case running
    case needsAttention = "needs_attention"
    case completed
    case failed
}

/// A display-safe projection of a server-backed source record.
///
/// This is intentionally not persisted and contains no platform route. The
/// owning app resolves `sourceID` back to its feature model when the row is
/// selected, which keeps navigation native on each platform and avoids a
/// duplicate, stale activity table.
public struct JunoRecentItem: Identifiable, Equatable, Hashable, Sendable {
    public let sourceID: String
    public let kind: JunoRecentKind
    public let title: String
    public let updatedAt: Date
    public let pinned: Bool
    public let status: String?
    public let needsAttention: Bool
    public let projectID: String?
    /// One line of display-safe context. Callers must not put absolute paths or
    /// connector secrets here.
    public let subtitle: String?

    public var id: String { "\(kind.rawValue):\(sourceID)" }

    public init(
        sourceID: String,
        kind: JunoRecentKind,
        title: String,
        updatedAt: Date,
        pinned: Bool = false,
        status: String? = nil,
        needsAttention: Bool = false,
        projectID: String? = nil,
        subtitle: String? = nil
    ) {
        self.sourceID = sourceID
        self.kind = kind
        self.title = title
        self.updatedAt = updatedAt
        self.pinned = pinned
        self.status = status
        self.needsAttention = needsAttention
        self.projectID = projectID
        self.subtitle = subtitle
    }
}

/// Pure rules for the cross-product activity projection.
public enum JunoRecentActivity {
    /// Whether one projected item belongs under a filter.
    public static func matches(
        _ item: JunoRecentItem,
        filter: JunoRecentFilter
    ) -> Bool {
        switch filter {
        case .all:
            true
        case .chat:
            item.kind == .chat
        case .work:
            item.kind == .work
        case .code:
            item.kind == .code
        case .projects:
            item.kind == .project
        case .pinned:
            item.pinned
        case .needsAttention:
            item.needsAttention || statusNeedsAttention(item.status)
        case .running:
            statusIsRunning(item.status)
                && !item.needsAttention
                && !statusNeedsAttention(item.status)
        case .completed:
            item.status == "completed" || item.status == "done"
        case .failed:
            statusIsTerminal(item.status)
                && item.status != "completed"
                && item.status != "done"
                && item.status != "cancelled"
        }
    }

    /// Merges already-authoritative source projections without mutating them.
    /// Pinned items remain visible before the time-ordered activity, and ties
    /// use the stable cross-product id so refreshes cannot make rows jump.
    public static func merge(
        _ sources: [[JunoRecentItem]],
        limit: Int
    ) -> [JunoRecentItem] {
        let sorted = sources.flatMap { $0 }.sorted { lhs, rhs in
            if lhs.pinned != rhs.pinned { return lhs.pinned }
            if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
            return lhs.id < rhs.id
        }
        return Array(sorted.prefix(max(0, limit)))
    }

    /// Each source should be asked for the complete requested page before the
    /// native projection merges it. Asking four sources for a quarter-page
    /// loses the newest items when one source is much busier than the others.
    public static func perSourceLimit(_ limit: Int) -> Int {
        min(max(limit, 1), 200)
    }

    public static func countByFilter(
        _ items: [JunoRecentItem]
    ) -> [JunoRecentFilter: Int] {
        var counts = Dictionary(
            uniqueKeysWithValues: JunoRecentFilter.allCases.map { ($0, 0) }
        )
        for item in items {
            for filter in JunoRecentFilter.allCases where matches(item, filter: filter) {
                counts[filter, default: 0] += 1
            }
        }
        return counts
    }

    public static func attentionItems(
        from items: [JunoRecentItem],
        limit: Int = 8
    ) -> [JunoRecentItem] {
        merge(
            [items.filter { matches($0, filter: .needsAttention) }],
            limit: limit
        )
    }

    private static func statusNeedsAttention(_ status: String?) -> Bool {
        switch status {
        case "waiting_input", "waiting_approval", "awaiting_approval", "host_offline":
            true
        default:
            false
        }
    }

    private static func statusIsRunning(_ status: String?) -> Bool {
        switch status {
        case "queued", "preparing", "running":
            true
        default:
            false
        }
    }

    private static func statusIsTerminal(_ status: String?) -> Bool {
        switch status {
        case "completed", "done", "failed", "cancelled", "interrupted",
             "host_offline", "budget_exceeded", "timed_out":
            true
        default:
            false
        }
    }
}
