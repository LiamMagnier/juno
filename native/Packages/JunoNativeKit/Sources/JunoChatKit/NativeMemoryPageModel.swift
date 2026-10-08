import Foundation
import JunoCore
import Observation

/// Something the memory page says in a toast, in the web's sentence.
public struct NativeMemoryNotice: Equatable, Sendable {
    public enum Tone: Sendable, Equatable {
        case success
        case error
        case info
    }

    public let tone: Tone
    public let title: String
    public let detail: String?
    /// A removal waiting in its Undo window: the toast offers Undo for it.
    public let undoID: String?

    public init(_ tone: Tone, _ title: String, detail: String? = nil, undoID: String? = nil) {
        self.tone = tone
        self.title = title
        self.detail = detail
        self.undoID = undoID
    }

    public static func success(_ title: String, detail: String? = nil) -> Self { Self(.success, title, detail: detail) }
    public static func error(_ title: String, detail: String? = nil) -> Self { Self(.error, title, detail: detail) }
    public static func info(_ title: String) -> Self { Self(.info, title) }
}

/// What a row's removal does: Forget also blocks it from being learned again.
public enum NativeMemoryRemovalKind: Sendable, Equatable {
    case forget
    case delete
}

/// The memory page's whole state machine (the web's `useMemory`, `useBackfill`
/// and `useDeferredRemoval`), over ``NativeMemoryClient``.
///
/// **It does not own the switch.** On/Off is `memoryEnabled`, the setting
/// ``NativeMemorySettingsModel`` writes through the sync outbox, so the page
/// and Settings › Memory can never disagree; the page reads it from there.
///
/// Every write answers with the sentence the page shows (a
/// ``NativeMemoryNotice``) rather than posting one itself, so the view owns
/// its window's toast host. The one exception is a deferred removal that
/// fails after its Undo window has closed, which is said through `onNotice`.
@MainActor
@Observable
public final class NativeMemoryPageModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case failed
    }

    public private(set) var phase: Phase = .idle
    /// Every row, facts and never-remember entries, newest first.
    public private(set) var facts: [NativeMemoryFact] = []
    public private(set) var summary: NativeMemoryPageSummary?
    public private(set) var projectSummaries: [NativeProjectMemorySummary] = []
    /// The edit ledger, newest first.
    public private(set) var edits: [NativeMemoryEdit] = []
    /// Rows with a write in flight: their controls disable.
    public private(set) var busyIDs: Set<String> = []
    public private(set) var busyEditIDs: Set<String> = []
    /// A background-provider policy refused the work, with its reason.
    public private(set) var policyNotice: String?
    /// The instruction being drafted, while it is.
    public private(set) var draftingInstruction: String?
    public private(set) var isRebuilding = false
    public private(set) var isResetting = false
    /// Rows removed on screen whose request waits out the Undo window.
    public private(set) var hiddenIDs: Set<String> = []
    /// Chats Juno has not learned from; nil until the first count lands.
    public private(set) var backfillRemaining: Int?
    public private(set) var isBackfilling = false
    /// The queue's length when this run started.
    public private(set) var backfillTotal = 0
    /// Edits applied from the prompt dock, and when: each keeps its inline
    /// Undo for ``appliedHold``.
    public private(set) var justApplied: [String: Date] = [:]
    /// Methods the person's runs repeated, proposed as skills; empty until
    /// ``loadSkillCandidates()`` lands, and absent from the page while empty.
    public private(set) var skillCandidates: [NativeSkillCandidate] = []
    /// Proposals with a decision in flight.
    public private(set) var busyCandidateIDs: Set<String> = []
    /// Proposals made into skills this session, by candidate id: the row
    /// stays, saying so, with a way to open the new skill.
    public private(set) var madeSkills: [String: NativeSkillCandidateOutcome] = [:]
    /// A project's memory being cleared.
    public private(set) var clearingProjectID: String?
    /// A deferred removal that failed after its Undo window closed.
    public var onNotice: (@MainActor (NativeMemoryNotice) -> Void)?

    /// How long a removal's Undo stays on offer (`UNDO_WINDOW_MS`).
    public let undoWindow: Duration
    /// How long an applied change keeps its inline Undo (`APPLIED_HOLD_MS`).
    public nonisolated static let appliedHold: TimeInterval = 4.5
    /// Hard stop on one "Learn from past chats" press.
    nonisolated static let maximumBackfillBatches = 40

    private let client: NativeMemoryClient
    private var accountID: AccountID?
    private var pendingRemovals: [String: Task<Void, Never>] = [:]
    private var loadedOnce = false

    public init(client: NativeMemoryClient, undoWindow: Duration = .seconds(5)) {
        self.client = client
        self.undoWindow = undoWindow
    }

    // MARK: Lifecycle

    /// Remembers the account. Nothing is read until the page asks
    /// (``loadIfNeeded()``): a signed-in Mac does not read its memory on launch.
    public func start(for accountID: AccountID) {
        guard self.accountID != accountID else { return }
        stop()
        self.accountID = accountID
    }

    public func stop() {
        flushRemovals()
        accountID = nil
        phase = .idle
        facts = []
        summary = nil
        projectSummaries = []
        edits = []
        busyIDs = []
        busyEditIDs = []
        policyNotice = nil
        draftingInstruction = nil
        hiddenIDs = []
        backfillRemaining = nil
        isBackfilling = false
        justApplied = [:]
        skillCandidates = []
        busyCandidateIDs = []
        madeSkills = [:]
        clearingProjectID = nil
        loadedOnce = false
    }

    public func loadIfNeeded() async {
        guard phase == .idle else { return }
        await reload()
        await loadSideData()
    }

    /// The rows, the summary and the project summaries. A failure after a
    /// list has been shown keeps the list and says so (the web's
    /// `loadedOnce`): "Couldn’t load your memory. Nothing has been changed" is
    /// false the moment the change it followed went through.
    @discardableResult
    public func reload() async -> NativeMemoryNotice? {
        guard let accountID else { return nil }
        if !loadedOnce { phase = .loading }
        do {
            apply(try await client.snapshot(for: accountID))
            loadedOnce = true
            phase = .ready
            return nil
        } catch {
            guard self.accountID == accountID else { return nil }
            if loadedOnce {
                return .error("Couldn’t refresh your memory. Reload the page to see the latest.")
            }
            phase = .failed
            return nil
        }
    }

    /// The ledger and the unread-chat count, both best effort: a page that
    /// cannot reach either still edits memory perfectly well.
    public func loadSideData() async {
        guard let accountID else { return }
        if let list = try? await client.edits(for: accountID), self.accountID == accountID {
            edits = list
        }
        if let remaining = try? await client.backfillRemaining(for: accountID), self.accountID == accountID {
            backfillRemaining = remaining
        }
        await loadSkillCandidates()
    }

    // MARK: Suggested skills

    /// Best effort, as the web's: a page that cannot read proposals simply
    /// shows none.
    public func loadSkillCandidates() async {
        guard let accountID else { return }
        if let list = try? await client.skillCandidates(for: accountID), self.accountID == accountID {
            skillCandidates = list
        }
    }

    /// Makes a proposal a skill (it stays on the page, saying so) or dismisses
    /// it (it leaves the page and is never proposed again).
    @discardableResult
    public func decide(
        _ candidate: NativeSkillCandidate,
        _ action: NativeSkillCandidateAction
    ) async -> NativeMemoryNotice? {
        guard let accountID, !busyCandidateIDs.contains(candidate.id) else { return nil }
        busyCandidateIDs.insert(candidate.id)
        defer { busyCandidateIDs.remove(candidate.id) }
        do {
            let outcome = try await client.decideSkillCandidate(id: candidate.id, action: action, for: accountID)
            switch action {
            case .accept:
                madeSkills[candidate.id] = outcome
                return .success("Added to your skills.", detail: "Auto-selection is off until you turn it on.")
            case .dismiss:
                skillCandidates.removeAll { $0.id == candidate.id }
                return nil
            }
        } catch let error as NativeMemoryRequestError where error.statusCode == 404 {
            // Already decided elsewhere: it is no longer a question here either.
            skillCandidates.removeAll { $0.id == candidate.id }
            return .error(error.message)
        } catch let error as NativeMemoryRequestError where error.statusCode != 0 {
            return .error(error.message)
        } catch {
            return .error("That didn’t work. Try again.")
        }
    }

    private func apply(_ snapshot: NativeMemorySnapshot) {
        facts = snapshot.facts
        summary = snapshot.summary
        projectSummaries = snapshot.projectSummaries
    }

    // MARK: Derived

    /// Anything remembered at all: a fact, a summary, or a project's summary.
    public var anythingRemembered: Bool {
        facts.contains(where: \.isFact) || summary != nil || !projectSummaries.isEmpty
    }

    /// Facts Juno believes, account-wide.
    public var accountActiveCount: Int {
        facts.filter { $0.isFact && !$0.isRetired }.count
    }

    public var pendingEdits: [NativeMemoryEdit] { edits.filter { $0.status == .pending } }

    /// Applied edits still holding their inline Undo at `now`.
    public func recentlyApplied(now: Date = Date()) -> [NativeMemoryEdit] {
        edits.filter { edit in
            edit.status == .applied
                && (justApplied[edit.id].map { now.timeIntervalSince($0) < Self.appliedHold } ?? false)
        }
    }

    /// Below this many memories, unread history is worth a notice.
    public nonisolated static let thinMemory = 12

    // MARK: Changes in words

    /// Drafts an instruction into a reviewable change. Writes nothing.
    /// Returns nil once drafted (the draft appears under the field that asked
    /// for it), or the sentence to show.
    public func instruct(_ instruction: String) async -> (drafted: Bool, notice: NativeMemoryNotice?) {
        guard let accountID else { return (false, nil) }
        let trimmed = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, draftingInstruction == nil else { return (false, nil) }
        draftingInstruction = trimmed
        defer { draftingInstruction = nil }
        do {
            let answer = try await client.draft(instruction: trimmed, for: accountID)
            policyNotice = nil
            switch answer {
            case .refusal(let refusal):
                // Recorded, not discarded: the reader should not have to
                // retype the sentence to learn whether it went through.
                if let list = try? await client.createEdits(
                    [NativeMemoryEditDraft(instruction: trimmed, note: refusal, status: .rejected, operations: [])],
                    for: accountID
                ) {
                    edits = list
                }
                return (true, .info(refusal))
            case let .proposal(summary, operations):
                guard !operations.isEmpty else { return (false, .error(NativeMemoryRequestError.generic)) }
                edits = try await client.createEdits(
                    [NativeMemoryEditDraft(
                        instruction: trimmed, summary: summary, status: .pending, operations: operations
                    )],
                    for: accountID
                )
                return (true, nil)
            }
        } catch let error as NativeMemoryRequestError where error.code == "background_policy_denied" {
            policyNotice = error.message
            return (false, nil)
        } catch {
            return (false, .error(Self.sentence(error)))
        }
    }

    /// Commits a drafted change. The ledger is written after the apply, with
    /// the server's inverse, never one guessed here.
    @discardableResult
    public func accept(_ edit: NativeMemoryEdit, fromDock: Bool = false) async -> NativeMemoryNotice? {
        guard let accountID else { return nil }
        busyEditIDs.insert(edit.id)
        defer { busyEditIDs.remove(edit.id) }
        do {
            let result = try await client.apply(edit.operations, for: accountID)
            facts = result.snapshot.facts
            summary = result.snapshot.summary
            edits = try await client.updateEdit(
                id: edit.id, status: .applied, inverse: .some(result.inverse), for: accountID
            )
            if fromDock { justApplied[edit.id] = Date() }
            return nil
        } catch let error as NativeMemoryRequestError where error.statusCode != 0 {
            // A stale or refused edit stays in the ledger, marked and explained.
            if let list = try? await client.updateEdit(
                id: edit.id, status: .rejected, note: error.message, for: accountID
            ) {
                edits = list
            }
            return .error(error.message)
        } catch {
            return .error(NativeMemoryRequestError.generic)
        }
    }

    /// Puts the memory back. The edit returns to pending with its original
    /// operations, so it can be applied again.
    @discardableResult
    public func undo(_ edit: NativeMemoryEdit) async -> NativeMemoryNotice? {
        guard let accountID, let inverse = edit.inverse, !inverse.isEmpty else { return nil }
        busyEditIDs.insert(edit.id)
        defer { busyEditIDs.remove(edit.id) }
        do {
            let result = try await client.apply(inverse, for: accountID)
            facts = result.snapshot.facts
            summary = result.snapshot.summary
            edits = try await client.updateEdit(id: edit.id, status: .pending, inverse: .some(nil), for: accountID)
            justApplied[edit.id] = nil
            return .success("Change undone.")
        } catch {
            return .error(Self.sentence(error))
        }
    }

    /// Discards a waiting change, or removes one from the history.
    @discardableResult
    public func deleteEdit(_ id: String) async -> NativeMemoryNotice? {
        guard let accountID else { return nil }
        do {
            edits = try await client.deleteEdit(id: id, for: accountID)
            justApplied[id] = nil
            return nil
        } catch {
            return .error("Couldn’t remove that from the history.")
        }
    }

    /// Lets an applied change's inline Undo fold away.
    public func expireApplied(now: Date = Date()) {
        justApplied = justApplied.filter { now.timeIntervalSince($0.value) < Self.appliedHold }
    }

    // MARK: Rows

    /// Saves a fact by hand, account-wide or in one project.
    public func add(_ content: String, projectID: String?) async -> NativeMemoryNotice {
        guard let accountID else { return .error(NativeMemoryRequestError.generic) }
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .error(NativeMemoryRequestError.generic) }
        do {
            let fact = try await client.add(content: trimmed, projectID: projectID, for: accountID)
            facts.insert(fact, at: 0)
            return .success(projectID == nil ? "Added to memory." : "Added to this project’s memory.")
        } catch {
            return .error(Self.sentence(error))
        }
    }

    /// Rewrites a fact. Reloaded rather than patched: a rewrite reclassifies
    /// and re-dates it.
    public func edit(_ id: String, content: String) async -> NativeMemoryNotice? {
        guard let accountID else { return nil }
        busyIDs.insert(id)
        defer { busyIDs.remove(id) }
        do {
            try await client.edit(id: id, content: content, for: accountID)
            return await reload()
        } catch {
            return .error(Self.sentence(error))
        }
    }

    /// Files a fact in a project, or back under the whole account.
    public func move(_ fact: NativeMemoryFact, toProject projectID: String?) async -> NativeMemoryNotice {
        guard let accountID else { return .error(NativeMemoryRequestError.generic) }
        busyIDs.insert(fact.id)
        defer { busyIDs.remove(fact.id) }
        do {
            try await client.move(id: fact.id, toProject: projectID, for: accountID)
            _ = await reload()
            return .success(
                projectID == nil
                    ? "Moved. Every chat can use it now."
                    : "Moved. Only chats in that project will use it."
            )
        } catch {
            return .error(Self.sentence(error))
        }
    }

    /// Removes a row on screen at once and sends the request only once the
    /// Undo window has passed (`useDeferredRemoval`): the API has no undo, so
    /// an Undo inside the window is exact because nothing was ever sent.
    public func remove(_ fact: NativeMemoryFact, kind: NativeMemoryRemovalKind) -> NativeMemoryNotice {
        hiddenIDs.insert(fact.id)
        pendingRemovals[fact.id]?.cancel()
        removalKinds[fact.id] = kind
        let window = undoWindow
        pendingRemovals[fact.id] = Task { [weak self] in
            try? await Task.sleep(for: window)
            guard !Task.isCancelled else { return }
            await self?.commitRemoval(fact, kind: kind)
        }
        switch kind {
        case .forget:
            return NativeMemoryNotice(.success, "Forgotten. Juno won’t learn this again.", undoID: fact.id)
        case .delete:
            return NativeMemoryNotice(
                .success, "Deleted. Juno may learn it again from the chat it came from.", undoID: fact.id
            )
        }
    }

    /// Undo, inside the window: nothing was sent, so the row simply returns.
    public func undoRemoval(_ id: String) {
        guard let task = pendingRemovals.removeValue(forKey: id) else { return }
        task.cancel()
        removalKinds[id] = nil
        hiddenIDs.remove(id)
    }

    /// Sends every waiting removal now: the page is going away.
    public func flushRemovals() {
        let waiting = pendingRemovals
        pendingRemovals = [:]
        for (id, task) in waiting {
            task.cancel()
            guard let fact = facts.first(where: { $0.id == id }), let kind = removalKinds[id] else { continue }
            Task { await self.commitRemoval(fact, kind: kind) }
        }
    }

    private var removalKinds: [String: NativeMemoryRemovalKind] = [:]

    private func commitRemoval(_ fact: NativeMemoryFact, kind: NativeMemoryRemovalKind) async {
        pendingRemovals[fact.id] = nil
        removalKinds[fact.id] = nil
        guard let accountID else { return }
        busyIDs.insert(fact.id)
        defer {
            busyIDs.remove(fact.id)
            hiddenIDs.remove(fact.id)
        }
        do {
            switch kind {
            case .forget:
                try await client.forget(id: fact.id, for: accountID)
                _ = await reload()
            case .delete:
                try await client.delete(id: fact.id, for: accountID)
                facts.removeAll { $0.id == fact.id }
            }
        } catch {
            onNotice?(.error(
                kind == .forget
                    ? "Couldn’t forget that. Nothing was changed."
                    : "Couldn’t delete that. Nothing was changed."
            ))
        }
    }

    /// Deletes everything remembered. Waiting removals are dropped with it.
    public func reset() async -> NativeMemoryNotice {
        guard let accountID else { return .error("Couldn’t reset memory. Nothing was deleted.") }
        isResetting = true
        defer { isResetting = false }
        do {
            try await client.reset(for: accountID)
            for task in pendingRemovals.values { task.cancel() }
            pendingRemovals = [:]
            removalKinds = [:]
            hiddenIDs = []
            facts = []
            summary = nil
            projectSummaries = []
            edits = []
            justApplied = [:]
            return .success("Memory reset. Juno starts fresh.")
        } catch {
            return .error("Couldn’t reset memory. Nothing was deleted.")
        }
    }

    /// Deletes one project's memory, its facts and its summary, and nothing
    /// else (`clearProjectMemory` in `use-memory.ts`).
    public func clearProject(_ projectID: String) async -> NativeMemoryNotice {
        let failure = NativeMemoryNotice.error("Couldn’t clear this project’s memory. Nothing was deleted.")
        guard let accountID, clearingProjectID == nil else { return failure }
        clearingProjectID = projectID
        defer { clearingProjectID = nil }
        do {
            try await client.clearProject(projectID, for: accountID)
            facts.removeAll { $0.isFact && $0.projectID == projectID }
            projectSummaries.removeAll { $0.projectID == projectID }
            return .success("This project’s memory is cleared.")
        } catch {
            return failure
        }
    }

    // MARK: Summary

    /// Rebuilds the account's summary, or one project's.
    public func regenerate(projectID: String?) async -> NativeMemoryNotice? {
        guard let accountID else { return nil }
        isRebuilding = true
        defer { isRebuilding = false }
        do {
            _ = try await client.consolidate(projectID: projectID, for: accountID)
            policyNotice = nil
            _ = await reload()
            return .success(
                projectID == nil
                    ? "Summary rebuilt from your chats and projects."
                    : "Summary rebuilt from this project’s chats."
            )
        } catch let error as NativeMemoryRequestError where error.code == "background_policy_denied" {
            policyNotice = error.message
            return nil
        } catch {
            return .error(Self.sentence(error))
        }
    }

    // MARK: Past chats

    /// Reads past chats in batches until the queue is empty, no model
    /// answers, or the batch cap is reached, and says what happened.
    public func runBackfill() async -> NativeMemoryNotice? {
        guard let accountID, !isBackfilling else { return nil }
        isBackfilling = true
        backfillTotal = backfillRemaining ?? 0
        defer { isBackfilling = false }
        var learned = 0
        var read = 0
        var left: Int?
        do {
            for _ in 0..<Self.maximumBackfillBatches {
                let step = try await client.backfill(for: accountID)
                guard self.accountID == accountID else { return nil }
                learned += step.created
                read += step.processedConversations
                left = step.remaining
                backfillRemaining = step.remaining
                if step.remaining == 0 || step.processedConversations == 0 { break }
            }
            _ = await reload()
            let newMemories = learned == 1 ? "1 new memory." : "\(learned) new memories."
            if left == nil || left == 0 {
                return learned > 0
                    ? .success("Finished reading your past chats.", detail: newMemories)
                    : .success("Finished reading your past chats. Nothing new was worth remembering.")
            }
            if read == 0 {
                return .error("Couldn’t read your past chats right now. Try again in a little while.")
            }
            let unread = left == 1 ? "1 chat is still unread." : "\(left ?? 0) chats are still unread."
            return .success(
                "Read some of your past chats.",
                detail: learned > 0 ? "\(newMemories) \(unread)" : "Nothing new so far. \(unread)"
            )
        } catch let error as NativeMemoryRequestError where error.statusCode != 0 {
            return .error(error.message == NativeMemoryRequestError.generic
                ? "Couldn’t read your past chats right now." : error.message)
        } catch {
            return .error("Couldn’t read your past chats right now.")
        }
    }

    // MARK: Recap and import

    public func recapExtras(days: Int) async -> NativeMemoryRecapExtras {
        guard let accountID else { return NativeMemoryRecapExtras(themes: [], conversations: 0) }
        // Themes are the one part that needs the server; without them the
        // recap is still a recap.
        return (try? await client.recap(days: days, for: accountID))
            ?? NativeMemoryRecapExtras(themes: [], conversations: 0)
    }

    public func importPreview(_ text: String) async -> Result<[NativeMemoryImportCandidate], NativeMemoryRequestError> {
        guard let accountID else { return .failure(.malformed) }
        do {
            return .success(try await client.importPreview(text: text, for: accountID))
        } catch let error as NativeMemoryRequestError {
            return .failure(error.statusCode == 0
                ? NativeMemoryRequestError(statusCode: 0, message: "Couldn’t read that list.")
                : error)
        } catch {
            return .failure(NativeMemoryRequestError(statusCode: 0, message: "Couldn’t read that list."))
        }
    }

    public func importFacts(_ facts: [String]) async -> (imported: Bool, notice: NativeMemoryNotice) {
        guard let accountID, !facts.isEmpty else { return (false, .error("Couldn’t import those.")) }
        do {
            let result = try await client.importFacts(facts, for: accountID)
            _ = await reload()
            let created = result.created
            return (true, .success(
                created > 0
                    ? "Imported \(created) \(created == 1 ? "fact" : "facts") into Juno’s memory."
                    : "Nothing new to import. Juno already knew all of that."
            ))
        } catch let error as NativeMemoryRequestError where error.statusCode != 0 {
            return (false, .error(error.message == NativeMemoryRequestError.generic ? "Couldn’t import those." : error.message))
        } catch {
            return (false, .error("Couldn’t import those."))
        }
    }

    // MARK: Export

    /// The file the web's Export writes: the summary, the project summaries
    /// and every row, as JSON.
    public func exportData(now: Date = Date()) -> Data {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        func summaryObject(_ summary: NativeMemoryPageSummary) -> [String: Any] {
            ["content": summary.content, "updatedAt": iso.string(from: summary.updatedAt), "entryCount": summary.entryCount]
        }
        let memories: [[String: Any]] = facts.map { fact in
            var object: [String: Any] = [
                "id": fact.id, "content": fact.content, "source": fact.source, "kind": fact.kind,
                "createdAt": iso.string(from: fact.createdAt), "status": fact.status,
                "confidence": fact.confidence,
            ]
            object["sourceRef"] = fact.sourceRef ?? NSNull()
            object["category"] = fact.category ?? NSNull()
            object["projectId"] = fact.projectID ?? NSNull()
            object["projectName"] = fact.projectName ?? NSNull()
            object["reason"] = fact.reason ?? NSNull()
            return object
        }
        let payload: [String: Any] = [
            "exportedAt": iso.string(from: now),
            "summary": summary.map(summaryObject) ?? NSNull(),
            "projectSummaries": projectSummaries.map { project -> [String: Any] in
                var object = summaryObject(project.summary)
                object["projectId"] = project.projectID
                object["projectName"] = project.projectName
                return object
            },
            "memories": memories,
        ]
        return (try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])) ?? Data()
    }

    public static func exportFileName(now: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return "juno-memory-\(formatter.string(from: now))"
    }

    // MARK: Preview

    /// Puts the page in a known state for the preview harness and snapshots.
    public func preview(
        _ snapshot: NativeMemorySnapshot,
        edits: [NativeMemoryEdit] = [],
        backfillRemaining: Int? = nil,
        skillCandidates: [NativeSkillCandidate] = [],
        phase: Phase = .ready
    ) {
        apply(snapshot)
        self.edits = edits
        self.skillCandidates = skillCandidates
        self.backfillRemaining = backfillRemaining
        self.phase = phase
        loadedOnce = phase == .ready
    }

    // MARK: Helpers

    static func sentence(_ error: any Error) -> String {
        if let request = error as? NativeMemoryRequestError { return request.message }
        return NativeMemoryRequestError.generic
    }
}
