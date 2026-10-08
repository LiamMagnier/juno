import Foundation
import Observation

/// Find in a transcript: the query, every match in reading order, and which
/// one is current — the iPhone's port of the Mac's `TranscriptFindModel`.
///
/// What counts as a match is the app's to say, through ``setSource(_:)``: it
/// must count over what its rows draw, with the same ``JunoFindText``
/// functions the prose highlights with, or the current match would be painted
/// on the wrong words. This model only keeps the order and the cursor.
@MainActor
@Observable
public final class JunoFindModel {
    public struct Match: Equatable, Sendable {
        public let itemID: String
        /// This match's place among its item's matches.
        public let ordinal: Int

        public init(itemID: String, ordinal: Int) {
            self.itemID = itemID
            self.ordinal = ordinal
        }
    }

    /// Every item's match count for a query, in reading order.
    public typealias Counter = @MainActor (_ query: String) -> [(id: String, count: Int)]

    public private(set) var isOpen = false
    public var query = "" {
        didSet { if query != oldValue { recount() } }
    }
    public private(set) var matches: [Match] = []
    public private(set) var current: Int?

    @ObservationIgnored private var counter: Counter = { _ in [] }

    public init() {}

    public var currentMatch: Match? {
        current.flatMap { matches.indices.contains($0) ? matches[$0] : nil }
    }

    public var isActive: Bool {
        isOpen && !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// "3 of 12", "No results", or nothing before a query.
    public var status: String {
        guard isActive else { return "" }
        guard let current, !matches.isEmpty else { return "No results" }
        return "\(current + 1) of \(matches.count)"
    }

    public func open() {
        isOpen = true
        recount()
    }

    public func close() {
        isOpen = false
        query = ""
        matches = []
        current = nil
    }

    /// Where the matches come from. Recounts at once; call it again when the
    /// transcript changes.
    public func setSource(_ counter: @escaping Counter) {
        self.counter = counter
        recount()
    }

    /// Counts again. The current match stays on its item and ordinal when it
    /// still exists, so a streamed reply growing below does not move it.
    public func recount() {
        let previous = currentMatch
        guard isActive else {
            matches = []
            current = nil
            return
        }
        var found: [Match] = []
        for item in counter(query) where item.count > 0 {
            found += (0..<item.count).map { Match(itemID: item.id, ordinal: $0) }
        }
        matches = found
        if found.isEmpty {
            current = nil
        } else if let previous, let same = found.firstIndex(of: previous) {
            current = same
        } else {
            current = 0
        }
    }

    public func next() {
        guard !matches.isEmpty else { return }
        current = ((current ?? -1) + 1) % matches.count
    }

    public func previous() {
        guard !matches.isEmpty else { return }
        current = ((current ?? 0) - 1 + matches.count) % matches.count
    }

    /// The highlight one item's text is drawn with, or nil when find is idle
    /// or nothing matches.
    public func highlight(for itemID: String) -> JunoFindHighlight? {
        guard isActive, !matches.isEmpty else { return nil }
        let ordinal = currentMatch.flatMap { $0.itemID == itemID ? $0.ordinal : nil }
        return JunoFindHighlight(query: query, current: ordinal)
    }
}
