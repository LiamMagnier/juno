import Foundation
import JunoDesignSystem

public extension NativeSessionCostTotals {
    /// The design system's render-ready shape.
    ///
    /// The mapping lives on THIS side of the boundary because the dependency
    /// runs this way: `JunoChatKit` can see `JunoDesignSystem`, never the
    /// reverse. Putting `JunoCostMetrics` in the design system is what keeps the
    /// badge previewable with no client, no session and no network — and the
    /// `reporting…` counts travel with it so the view can still tell an
    /// unreported zero from a real one.
    var costMetrics: JunoCostMetrics {
        JunoCostMetrics(
            turns: turns,
            inputTokens: promptTokens,
            outputTokens: completionTokens,
            cacheReadTokens: cacheReadTokens,
            cacheWriteTokens: cacheWriteTokens,
            costUsd: costUsd,
            turnsReportingCache: turnsReportingCache,
            turnsReportingCost: turnsReportingCost
        )
    }
}

/// One turn's billed usage, exactly as the server reported it.
///
/// Every field is optional and `nil` means UNKNOWN, never zero. Providers
/// differ in what they report, and a turn that failed before the provider
/// answered has no usage at all. A ledger that defaulted any of these to 0
/// would quietly under-report a session instead of admitting it cannot say.
///
/// The prompt-cache split reaches this type only from the live `done` frame.
/// The server now persists it (`Message.cacheReadTokens`/`cacheWriteTokens`)
/// and ships it on the `message` sync entity, so hydrating a reloaded
/// transcript into a ledger has become possible — but it is not wired, and
/// doing it means reversing the deliberate "since this launch" scope documented
/// on `sessionCostLedgers`, not just decoding two more fields.
public struct NativeTurnUsage: Identifiable, Equatable, Sendable {
    /// The assistant message this usage belongs to. Also the dedupe key: a
    /// stream that re-emits `done` (a resumed generation, a partial saved and
    /// then completed) must correct the turn, not double-bill it.
    public let messageID: String
    public let model: String?
    /// Full prompt size, cache included — the same convention the server's
    /// `totalInput` uses, so this is NOT additive with `cacheReadTokens`.
    public let promptTokens: Int?
    public let completionTokens: Int?
    public let cacheReadTokens: Int?
    public let cacheWriteTokens: Int?
    /// US dollars for this turn, computed server-side from the exact streamed
    /// usage (cache buckets and tool fees included). Never recomputed here —
    /// see the type-level note on ``NativeSessionCostTotals``.
    public let costUsd: Double?
    public let recordedAt: Date

    public var id: String { messageID }

    public init(
        messageID: String,
        model: String? = nil,
        promptTokens: Int? = nil,
        completionTokens: Int? = nil,
        cacheReadTokens: Int? = nil,
        cacheWriteTokens: Int? = nil,
        costUsd: Double? = nil,
        recordedAt: Date = Date()
    ) {
        self.messageID = messageID
        self.model = model
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.costUsd = costUsd
        self.recordedAt = recordedAt
    }

    /// Input tokens billed at the full rate: the prompt minus whatever was
    /// served from cache. `nil` when either half is unknown — subtracting an
    /// assumed-zero cache read would report a cheap turn as a full-price one.
    ///
    /// Clamped at zero: the two counters come from different provider fields
    /// and a rounding disagreement must not produce negative tokens.
    public var freshInputTokens: Int? {
        guard let promptTokens, let cacheReadTokens else { return nil }
        return max(0, promptTokens - cacheReadTokens)
    }

    /// Builds a record from a completed turn, carrying `nil` through unchanged.
    public init(message: NativeCompletedChatMessage) {
        self.init(
            messageID: message.id,
            model: message.model,
            promptTokens: message.promptTokens,
            completionTokens: message.completionTokens,
            cacheReadTokens: message.cacheReadTokens,
            cacheWriteTokens: message.cacheWriteTokens,
            costUsd: message.costUsd,
            recordedAt: message.createdAt
        )
    }
}

/// What a session adds up to.
///
/// **Sums are of KNOWN values only, and each carries its own count.** A session
/// of five turns where two providers reported no cache split has
/// `turnsReportingCache == 3`; the badge can then say "3 of 5 turns" rather
/// than implying the other two were misses. This is the whole reason the totals
/// are a type instead of a handful of `reduce` calls at the call site.
///
/// **Cost is never computed here.** The server prices each turn from the exact
/// streamed usage — cache writes at their TTL premium, web-search fees, fast-mode
/// multipliers — using the live pricing catalog. Re-deriving a number from token
/// counts and a client-side rate table is what produced the web's "~$0.0006" bug,
/// so this type only ever adds up what the server billed.
public struct NativeSessionCostTotals: Equatable, Sendable {
    public let turns: Int
    public let promptTokens: Int
    public let completionTokens: Int
    public let cacheReadTokens: Int
    public let cacheWriteTokens: Int
    public let costUsd: Double

    /// How many turns contributed to each sum, so a reader can tell a real zero
    /// from an unreported one.
    public let turnsReportingTokens: Int
    public let turnsReportingCache: Int
    public let turnsReportingCost: Int

    public init(
        turns: Int = 0,
        promptTokens: Int = 0,
        completionTokens: Int = 0,
        cacheReadTokens: Int = 0,
        cacheWriteTokens: Int = 0,
        costUsd: Double = 0,
        turnsReportingTokens: Int = 0,
        turnsReportingCache: Int = 0,
        turnsReportingCost: Int = 0
    ) {
        self.turns = turns
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.costUsd = costUsd
        self.turnsReportingTokens = turnsReportingTokens
        self.turnsReportingCache = turnsReportingCache
        self.turnsReportingCost = turnsReportingCost
    }

    public static let empty = NativeSessionCostTotals()

    /// Input tokens billed at the full rate across the session.
    public var freshInputTokens: Int { max(0, promptTokens - cacheReadTokens) }

    /// Every token the session moved, in and out.
    public var totalTokens: Int { promptTokens + completionTokens }

    /// The share of prompt tokens served from cache, or `nil` when no turn
    /// reported a split — an unknown ratio, not a 0% one.
    public var cacheHitRate: Double? {
        guard turnsReportingCache > 0, promptTokens > 0 else { return nil }
        return min(1, Double(cacheReadTokens) / Double(promptTokens))
    }

    /// True when at least one turn's usage never arrived, which is what makes
    /// the badge show "≥" in front of the total instead of a bare figure.
    public var isPartial: Bool { turnsReportingCost < turns }
}

/// The live ledger for one conversation.
///
/// A value type on purpose: it is pure arithmetic over an append-only list, so
/// it unit-tests with no actor, no clock and no main thread. ``SessionCostTracker``
/// is the thin `@Observable` shell SwiftUI reads.
///
/// Distinct from `NativeUsageBreakdown`, which is the ACCOUNT's billing history
/// over days and surfaces, fetched from the server. This one is the current
/// session, assembled from the frames already streaming past.
public struct SessionCostLedger: Equatable, Sendable {
    /// Insertion-ordered so the UI can show the turns as they happened.
    public private(set) var turns: [NativeTurnUsage]

    public init(turns: [NativeTurnUsage] = []) {
        self.turns = []
        for turn in turns { record(turn) }
    }

    /// Records a turn, replacing any earlier record for the same message.
    ///
    /// Replacement rather than append is what keeps a resumed or partially-saved
    /// generation from being billed twice: the server sends `done` again with
    /// the final numbers, and the later frame is the authoritative one. The
    /// original position is kept so the list does not reorder under the reader.
    public mutating func record(_ turn: NativeTurnUsage) {
        if let existing = turns.firstIndex(where: { $0.messageID == turn.messageID }) {
            turns[existing] = turn
        } else {
            turns.append(turn)
        }
    }

    public mutating func record(message: NativeCompletedChatMessage) {
        record(NativeTurnUsage(message: message))
    }

    public mutating func reset() { turns.removeAll() }

    /// Adds up only what was reported. See ``NativeSessionCostTotals``.
    public var totals: NativeSessionCostTotals {
        var promptTokens = 0
        var completionTokens = 0
        var cacheReadTokens = 0
        var cacheWriteTokens = 0
        var costUsd = 0.0
        var reportingTokens = 0
        var reportingCache = 0
        var reportingCost = 0

        for turn in turns {
            // A turn counts as "reporting tokens" if it named either half; a
            // provider that reports output but not input is still evidence.
            if turn.promptTokens != nil || turn.completionTokens != nil {
                reportingTokens += 1
            }
            if let value = turn.promptTokens { promptTokens += value }
            if let value = turn.completionTokens { completionTokens += value }
            if turn.cacheReadTokens != nil || turn.cacheWriteTokens != nil {
                reportingCache += 1
            }
            if let value = turn.cacheReadTokens { cacheReadTokens += value }
            if let value = turn.cacheWriteTokens { cacheWriteTokens += value }
            if let value = turn.costUsd {
                costUsd += value
                reportingCost += 1
            }
        }

        return NativeSessionCostTotals(
            turns: turns.count,
            promptTokens: promptTokens,
            completionTokens: completionTokens,
            cacheReadTokens: cacheReadTokens,
            cacheWriteTokens: cacheWriteTokens,
            costUsd: costUsd,
            turnsReportingTokens: reportingTokens,
            turnsReportingCache: reportingCache,
            turnsReportingCost: reportingCost
        )
    }

    /// Per-model subtotals, heaviest spend first, for the expanded badge.
    ///
    /// Turns whose model the server never named are grouped under `nil` rather
    /// than dropped, so the rows always add back up to the session total.
    public func totalsByModel() -> [(model: String?, totals: NativeSessionCostTotals)] {
        var order: [String?] = []
        var grouped: [String?: SessionCostLedger] = [:]
        for turn in turns {
            if grouped[turn.model] == nil {
                grouped[turn.model] = SessionCostLedger()
                order.append(turn.model)
            }
            grouped[turn.model]?.record(turn)
        }
        return order
            .map { (model: $0, totals: grouped[$0]?.totals ?? .empty) }
            .sorted { lhs, rhs in
                // Ties broken by token volume so two free turns still order
                // stably rather than by dictionary chance.
                if lhs.totals.costUsd != rhs.totals.costUsd {
                    return lhs.totals.costUsd > rhs.totals.costUsd
                }
                return lhs.totals.totalTokens > rhs.totals.totalTokens
            }
    }
}

/// The observable shell the conversation header reads.
///
/// Main-actor bound because it exists to drive a view; all the arithmetic lives
/// in ``SessionCostLedger`` so none of it needs the main thread to be tested.
@Observable
@MainActor
public final class SessionCostTracker {
    public private(set) var ledger: SessionCostLedger

    /// Whether the reader has expanded the badge. Kept here rather than in the
    /// view so the disclosure survives the header being rebuilt mid-stream.
    public var isExpanded: Bool = false

    public init(ledger: SessionCostLedger = SessionCostLedger()) {
        self.ledger = ledger
    }

    public var totals: NativeSessionCostTotals { ledger.totals }

    public func record(message: NativeCompletedChatMessage) {
        ledger.record(message: message)
    }

    public func record(_ turn: NativeTurnUsage) {
        ledger.record(turn)
    }

    /// Clears the ledger when the reader switches conversations. The badge is
    /// per-session, so carrying totals across a switch would bill the new
    /// conversation for the old one.
    public func reset() {
        ledger.reset()
        isExpanded = false
    }
}
