import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

// MARK: - Suggested skills (procedural memory)

/// A method the person's own runs repeated, proposed as a skill
/// (`ClientSkillCandidate` in `src/lib/procedural-memory-store.ts`, shown by
/// `src/components/memory/skill-candidates.tsx`).
///
/// A proposal is a question, not a change: nothing happens until the person
/// makes it a skill (it lands in Skills with auto-selection off) or says it is
/// not one (it is never proposed again).
public struct NativeSkillCandidate: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let projectID: String?
    public let examples: [String]
    public let tools: [String]
    public let runCount: Int
    public let lastSeenAt: Date

    public init(
        id: String,
        title: String,
        projectID: String? = nil,
        examples: [String] = [],
        tools: [String] = [],
        runCount: Int,
        lastSeenAt: Date
    ) {
        self.id = id
        self.title = title
        self.projectID = projectID
        self.examples = examples
        self.tools = tools
        self.runCount = runCount
        self.lastSeenAt = lastSeenAt
    }

    /// "4 runs · last 2 days ago · web_search, fetch", as the web's annotation.
    public func detailLine(now: Date = Date(), locale: Locale = .current) -> String {
        var parts = ["\(runCount) run\(runCount == 1 ? "" : "s")"]
        parts.append("last \(NativeMemoryPresentation.relativeTime(lastSeenAt, now: now, locale: locale))")
        if !tools.isEmpty { parts.append(tools.joined(separator: ", ")) }
        return parts.joined(separator: " · ")
    }
}

/// What the person decided about a proposal.
public enum NativeSkillCandidateAction: String, Sendable {
    case accept, dismiss
}

/// `POST /api/memory/skill-candidates/[id]` → `{ ok, slug?, href? }`.
public struct NativeSkillCandidateOutcome: Equatable, Sendable {
    /// The new skill's slug, on accept.
    public let slug: String?
    /// The web path of the new skill (`/skills/<id>`), on accept.
    public let href: String?

    public init(slug: String?, href: String?) {
        self.slug = slug
        self.href = href
    }

    /// The skill's id, read from `href`, for opening it natively.
    public var skillID: String? {
        guard let href, href.hasPrefix("/skills/") else { return nil }
        let id = String(href.dropFirst("/skills/".count))
        return id.isEmpty ? nil : id
    }
}

extension NativeMemoryClient {
    /// `GET /api/memory/skill-candidates` → `{ candidates }`. A row that does
    /// not carry an id and a title is dropped rather than guessed at.
    public func skillCandidates(for accountID: AccountID) async throws -> [NativeSkillCandidate] {
        let root = try await object(.get, "/api/memory/skill-candidates", for: accountID)
        return Self.decodeSkillCandidates(root)
    }

    /// Makes a proposal a skill, or says it is not one. A refusal carries the
    /// route's own sentence ("You already have a skill with this name…").
    @discardableResult
    public func decideSkillCandidate(
        id: String,
        action: NativeSkillCandidateAction,
        for accountID: AccountID
    ) async throws -> NativeSkillCandidateOutcome {
        try Self.validate(id)
        let root = try await object(
            .post,
            "/api/memory/skill-candidates/\(id)",
            body: .object(["action": .string(action.rawValue)]),
            for: accountID
        )
        return NativeSkillCandidateOutcome(slug: root["slug"]?.stringValue, href: root["href"]?.stringValue)
    }

    static func decodeSkillCandidates(_ root: [String: JunoJSONValue]) -> [NativeSkillCandidate] {
        guard case .array(let values)? = root["candidates"] else { return [] }
        func strings(_ value: JunoJSONValue?) -> [String] {
            guard case .array(let items)? = value else { return [] }
            return items.compactMap(\.stringValue)
        }
        return values.compactMap { value in
            guard case .object(let object) = value,
                let id = object["id"]?.stringValue, !id.isEmpty,
                let title = object["title"]?.stringValue, !title.isEmpty
            else { return nil }
            // A row whose status moved on is no longer a question.
            if let status = object["status"]?.stringValue, status != "pending" { return nil }
            return NativeSkillCandidate(
                id: id,
                title: title,
                projectID: object["projectId"]?.stringValue,
                examples: strings(object["examples"]),
                tools: strings(object["tools"]),
                runCount: object["runCount"]?.numberValue.map { Int($0) } ?? 0,
                lastSeenAt: object["lastSeenAt"]?.date ?? .distantPast
            )
        }
    }
}

// MARK: - Provenance

/// The quiet trust line under a memory (`RowMeta` in `entry-row.tsx`): only
/// what changes how much to trust it, and only when it says something.
public enum NativeMemoryProvenance: Equatable, Sendable {
    /// Learned on its own with low confidence: inferred rather than told.
    case inferred
    /// Said again more than a day after it was learned.
    case confirmed(Date)
    /// Read into a reply (stamped by retrieval, so "used" means used).
    case used(Date)

    /// The web's confidence floor below which an automatic fact reads "Inferred".
    public static let inferredBelow = 0.6

    public static func of(_ fact: NativeMemoryFact) -> [NativeMemoryProvenance] {
        var parts: [NativeMemoryProvenance] = []
        if !fact.isRetired, fact.source == "AUTO", fact.confidence < inferredBelow {
            parts.append(.inferred)
        }
        if let verified = fact.lastVerifiedAt, verified.timeIntervalSince(fact.createdAt) > 24 * 60 * 60 {
            parts.append(.confirmed(verified))
        }
        if !fact.isRetired, let used = fact.lastUsedAt {
            parts.append(.used(used))
        }
        return parts
    }

    public func label(now: Date = Date(), locale: Locale = .current) -> String {
        switch self {
        case .inferred: return "Inferred"
        case .confirmed(let date): return "Confirmed \(NativeMemoryPresentation.relativeTime(date, now: now, locale: locale))"
        case .used(let date): return "Used \(NativeMemoryPresentation.relativeTime(date, now: now, locale: locale))"
        }
    }

    /// The longer sentence for a tooltip or accessibility hint.
    public var explanation: String {
        switch self {
        case .inferred: return "Alevr inferred this rather than being told it."
        case .confirmed: return "You said it again after it was first learned."
        case .used: return "Last used in a reply."
        }
    }

    /// "Inferred · Confirmed 3 days ago · Used yesterday", or nil when there is
    /// nothing worth saying.
    public static func line(for fact: NativeMemoryFact, now: Date = Date(), locale: Locale = .current) -> String? {
        let parts = of(fact).map { $0.label(now: now, locale: locale) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
