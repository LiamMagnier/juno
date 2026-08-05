import Foundation

// MARK: - What the planner is allowed to know about the world

/// What one location looked like at plan time.
public struct WorkPathFacts: Hashable, Sendable {
    public let exists: Bool
    public let isDirectory: Bool
    public let fingerprint: WorkContentFingerprint?

    public static let absent = WorkPathFacts(exists: false)

    public init(
        exists: Bool,
        isDirectory: Bool = false,
        fingerprint: WorkContentFingerprint? = nil
    ) {
        self.exists = exists
        self.isDirectory = isDirectory
        self.fingerprint = fingerprint
    }
}

/// A photograph of the parts of the grant a batch is about.
///
/// Deliberately a value handed *to* the planner rather than a filesystem the
/// planner reads. It keeps planning pure and testable, and it makes the staleness
/// impossible to forget: this is what the disk looked like when the preview was
/// built, and the person may have spent four minutes reading that preview on
/// their phone. The executor re-checks every conflict immediately before acting.
public struct WorkFileSnapshot: Hashable, Sendable {
    private let facts: [GrantedPath: WorkPathFacts]

    public init(_ facts: [GrantedPath: WorkPathFacts] = [:]) {
        self.facts = facts
    }

    public func facts(for path: GrantedPath) -> WorkPathFacts {
        facts[path] ?? .absent
    }

    public func exists(_ path: GrantedPath) -> Bool {
        facts(for: path).exists
    }

    public func fingerprint(_ path: GrantedPath) -> WorkContentFingerprint? {
        facts(for: path).fingerprint
    }
}

// MARK: - Failures that stop a plan being made at all

public enum WorkBatchPlanError: Error, Equatable, Sendable {
    case empty
    case tooManyOperations(count: Int, maximum: Int)
    /// A rename whose new name is not a single usable file name.
    case invalidRename(path: String, newName: String)
    /// Two operations write to the same place, so which one wins depends on the
    /// order they happen to run in.
    case destinationCollision(path: String)
    /// The operations depend on each other in a loop. Carries the locations
    /// involved so the message can name them.
    case dependencyCycle(paths: [String])
}

extension WorkBatchPlanError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .empty:
            "There was nothing to do."
        case .tooManyOperations(let count, let maximum):
            "That would change \(count) items at once, and Juno does at most \(maximum) in one go."
        case .invalidRename(let path, let newName):
            "\"\(newName)\" is not a name Juno can give \(path)."
        case .destinationCollision(let path):
            "Two of these changes both end up at \(path), so the result would depend on which ran first."
        case .dependencyCycle(let paths):
            "These changes depend on each other in a loop (\(paths.joined(separator: ", "))), so there is no order that works. Doing them in two batches will."
        }
    }
}

// MARK: - What a person needs to know before approving

public struct WorkBatchConflict: Hashable, Codable, Sendable {
    public enum Reason: String, Codable, Sendable {
        /// Something is already at the destination and would be replaced.
        case destinationExists
    }

    public let operationIndex: Int
    public let destination: GrantedPath
    public let reason: Reason

    public init(operationIndex: Int, destination: GrantedPath, reason: Reason) {
        self.operationIndex = operationIndex
        self.destination = destination
        self.reason = reason
    }
}

/// Items in the batch that hold byte-identical content.
public struct WorkBatchDuplicateGroup: Hashable, Codable, Sendable {
    public let fingerprint: WorkContentFingerprint
    /// Sorted, so the same batch always presents the same group.
    public let paths: [GrantedPath]

    public init(fingerprint: WorkContentFingerprint, paths: [GrantedPath]) {
        self.fingerprint = fingerprint
        self.paths = paths.sorted()
    }
}

public struct WorkBatchNoOp: Hashable, Codable, Sendable {
    public enum Reason: String, Codable, Sendable {
        case sourceIsDestination = "source_is_destination"
        case renameToSameName = "rename_to_same_name"
        case folderAlreadyExists = "folder_already_exists"
        case contentAlreadyMatches = "content_already_matches"
        case noTagsGiven = "no_tags_given"
        case nothingAtSource = "nothing_at_source"
    }

    public let operationIndex: Int
    public let reason: Reason

    public init(operationIndex: Int, reason: Reason) {
        self.operationIndex = operationIndex
        self.reason = reason
    }
}

/// Everything the planner worked out that a person could not see by reading the
/// list of operations.
///
/// Indices point into the plan's **ordered** operations, which is why the plan
/// is immutable: an index into a list somebody can reorder is a bug waiting for
/// a second reader.
public struct WorkBatchAnalysis: Hashable, Codable, Sendable {
    /// Every location the batch touches, sorted and de-duplicated.
    public let touchedPaths: [GrantedPath]
    public let conflicts: [WorkBatchConflict]
    public let duplicates: [WorkBatchDuplicateGroup]
    public let noOps: [WorkBatchNoOp]

    public init(
        touchedPaths: [GrantedPath],
        conflicts: [WorkBatchConflict],
        duplicates: [WorkBatchDuplicateGroup],
        noOps: [WorkBatchNoOp]
    ) {
        self.touchedPaths = touchedPaths
        self.conflicts = conflicts
        self.duplicates = duplicates
        self.noOps = noOps
    }
}

// MARK: - The plan

/// An ordered, content-addressed batch of file operations inside one grant,
/// together with the analysis a person needs before saying yes to all of it.
///
/// Two properties carry the weight.
///
/// The plan is **ordered at plan time**. A move into a folder an earlier
/// operation creates sorts after that operation, and a set of operations that
/// depend on each other in a loop is refused here rather than discovered
/// halfway through, with twenty files already moved and no way to describe the
/// state the person's folder is now in.
///
/// The plan is **content-addressed**. ``digest`` covers the grant and the exact
/// ordered operations, and an approval is bound to that digest. Somebody who
/// approved "move 42 PDFs into Reports" has approved that batch and no other:
/// if the plan is rebuilt — because the model reconsidered, because a file
/// appeared, because a relay message was replayed — the digest changes and the
/// approval stops matching.
public struct WorkBatchPlan: Hashable, Codable, Sendable {
    /// Enough for a year of scanned receipts, few enough that the preview stays
    /// a thing a person can actually read and the digest stays cheap to compute
    /// on every re-check.
    public static let maximumOperations = 2_000

    /// Namespaced and versioned so a digest can never be confused with one from
    /// another kind of approval, and so a future change to the canonical form
    /// invalidates old approvals loudly instead of colliding with them.
    public static let digestDomain = "juno.work.batch.v1"

    public let id: String
    public let grantID: WorkGrantID
    /// Ordered so that every dependency precedes its dependent.
    public let operations: [WorkFileOperation]
    public let analysis: WorkBatchAnalysis
    /// SHA-256 over ``digestDomain``, the grant, and every operation's canonical
    /// form, in order.
    public let digest: String

    // MARK: Planning

    /// Orders, analyses and seals a batch, or refuses to make one.
    public static func plan(
        id: String = UUID().uuidString.lowercased(),
        grantID: WorkGrantID,
        operations: [WorkFileOperation],
        against snapshot: WorkFileSnapshot = WorkFileSnapshot()
    ) throws -> WorkBatchPlan {
        guard !operations.isEmpty else { throw WorkBatchPlanError.empty }
        guard operations.count <= maximumOperations else {
            throw WorkBatchPlanError.tooManyOperations(
                count: operations.count,
                maximum: maximumOperations
            )
        }
        for operation in operations {
            if case .rename(let path, let newName) = operation, operation.destination == nil {
                throw WorkBatchPlanError.invalidRename(path: path.value, newName: newName)
            }
        }
        try rejectDestinationCollisions(in: operations)
        let ordered = try order(operations, against: snapshot)
        let analysis = analyse(ordered, against: snapshot)
        return WorkBatchPlan(
            id: id,
            grantID: grantID,
            operations: ordered,
            analysis: analysis,
            digest: computeDigest(grantID: grantID, operations: ordered)
        )
    }

    private init(
        id: String,
        grantID: WorkGrantID,
        operations: [WorkFileOperation],
        analysis: WorkBatchAnalysis,
        digest: String
    ) {
        self.id = id
        self.grantID = grantID
        self.operations = operations
        self.analysis = analysis
        self.digest = digest
    }

    private static func rejectDestinationCollisions(in operations: [WorkFileOperation]) throws {
        var seen: Set<GrantedPath> = []
        for operation in operations {
            guard let destination = operation.destination else { continue }
            guard seen.insert(destination).inserted else {
                throw WorkBatchPlanError.destinationCollision(path: destination.value)
            }
        }
    }

    /// Sorts operations so every dependency runs first, or refuses.
    ///
    /// Three kinds of edge, and each one exists because leaving it out produces
    /// a specific wrong outcome:
    ///
    /// 1. **Produce before require.** A move into `Reports` must follow the
    ///    operation that creates `Reports`, or the first item fails and the rest
    ///    of the batch runs against a folder that half exists. Only applied when
    ///    the required location is *absent* from the snapshot: a folder that is
    ///    already there imposes no ordering, and pretending it does invents
    ///    dependencies between unrelated operations.
    /// 2. **Require before remove.** Copying a file and then trashing it is a
    ///    backup; trashing it and then copying it is a failure.
    /// 3. **Remove before produce.** Renaming `a` to `old-a` and then `b` to `a`
    ///    works in that order and only that order.
    ///
    /// Rules 1 and 3 together are what catch the two-file swap: each operation
    /// needs the other's name freed first, there is no order that works, and
    /// saying so up front is far better than moving one file and stopping.
    private static func order(
        _ operations: [WorkFileOperation],
        against snapshot: WorkFileSnapshot
    ) throws -> [WorkFileOperation] {
        let count = operations.count
        var producers: [GrantedPath: [Int]] = [:]
        var removers: [GrantedPath: [Int]] = [:]
        var requirers: [GrantedPath: [Int]] = [:]
        for (index, operation) in operations.enumerated() {
            for path in operation.produces { producers[path, default: []].append(index) }
            for path in operation.removes { removers[path, default: []].append(index) }
            for path in operation.requires { requirers[path, default: []].append(index) }
        }

        var successors = [Set<Int>](repeating: [], count: count)
        var inDegree = [Int](repeating: 0, count: count)
        func addEdge(from earlier: Int, to later: Int) {
            guard earlier != later, successors[earlier].insert(later).inserted else { return }
            inDegree[later] += 1
        }

        for (path, requiringIndices) in requirers {
            if !snapshot.exists(path) {
                for producer in producers[path] ?? [] {
                    for requirer in requiringIndices { addEdge(from: producer, to: requirer) }
                }
            }
            for remover in removers[path] ?? [] {
                for requirer in requiringIndices { addEdge(from: requirer, to: remover) }
            }
        }
        for (path, producingIndices) in producers {
            for remover in removers[path] ?? [] {
                for producer in producingIndices { addEdge(from: remover, to: producer) }
            }
        }

        // Kahn's algorithm, always taking the lowest ready index. The caller's
        // order is the tie-break, so a batch that needs no reordering comes back
        // exactly as it was written — otherwise the digest of a plan would depend
        // on dictionary iteration order and no approval would ever match twice.
        var ready = Set((0..<count).filter { inDegree[$0] == 0 })
        var ordered: [Int] = []
        ordered.reserveCapacity(count)
        while let next = ready.min() {
            ready.remove(next)
            ordered.append(next)
            for successor in successors[next].sorted() {
                inDegree[successor] -= 1
                if inDegree[successor] == 0 { ready.insert(successor) }
            }
        }

        guard ordered.count == count else {
            let placed = Set(ordered)
            let stuck = (0..<count).filter { !placed.contains($0) }
            let paths = Set(stuck.flatMap { operations[$0].touchedPaths })
                .map(\.value)
                .sorted()
            throw WorkBatchPlanError.dependencyCycle(paths: paths)
        }
        return ordered.map { operations[$0] }
    }

    /// Walks the ordered operations keeping a running picture of what exists, so
    /// that "this destination is already taken" is judged against the folder as
    /// it will be at that point in the batch, not as it is now. Without the
    /// running picture, renaming `a` to `old-a` and then `b` to `a` reports a
    /// conflict on a name the batch itself frees two lines earlier.
    private static func analyse(
        _ operations: [WorkFileOperation],
        against snapshot: WorkFileSnapshot
    ) -> WorkBatchAnalysis {
        var present: [GrantedPath: Bool] = [:]
        func isPresent(_ path: GrantedPath) -> Bool { present[path] ?? snapshot.exists(path) }

        var conflicts: [WorkBatchConflict] = []
        var noOps: [WorkBatchNoOp] = []

        for (index, operation) in operations.enumerated() {
            let reason = noOpReason(for: operation, isPresent: isPresent, snapshot: snapshot)
            if let reason {
                noOps.append(WorkBatchNoOp(operationIndex: index, reason: reason))
                // A no-op changes nothing, so it neither conflicts with anything
                // nor moves the running picture on. Reporting "this will
                // overwrite Report.pdf" about an operation that will not happen
                // is warning somebody about a fiction.
                continue
            }
            if operation.overwritesDestination, let destination = operation.destination,
                isPresent(destination)
            {
                conflicts.append(
                    WorkBatchConflict(
                        operationIndex: index,
                        destination: destination,
                        reason: .destinationExists
                    )
                )
            }
            for removed in operation.removes { present[removed] = false }
            for produced in operation.produces { present[produced] = true }
        }

        var touched: [GrantedPath] = []
        var seen: Set<GrantedPath> = []
        for operation in operations {
            for path in operation.touchedPaths where seen.insert(path).inserted {
                touched.append(path)
            }
        }
        touched.sort()

        var byFingerprint: [WorkContentFingerprint: [GrantedPath]] = [:]
        for path in touched {
            guard let fingerprint = snapshot.fingerprint(path) else { continue }
            byFingerprint[fingerprint, default: []].append(path)
        }
        let duplicates = byFingerprint
            .filter { $0.value.count > 1 }
            .map { WorkBatchDuplicateGroup(fingerprint: $0.key, paths: $0.value) }
            .sorted { $0.fingerprint < $1.fingerprint }

        return WorkBatchAnalysis(
            touchedPaths: touched,
            conflicts: conflicts,
            duplicates: duplicates,
            noOps: noOps
        )
    }

    private static func noOpReason(
        for operation: WorkFileOperation,
        isPresent: (GrantedPath) -> Bool,
        snapshot: WorkFileSnapshot
    ) -> WorkBatchNoOp.Reason? {
        switch operation {
        case .createFolder(let path):
            return isPresent(path) ? .folderAlreadyExists : nil
        case .copy(let source, let destination), .move(let source, let destination):
            if source == destination { return .sourceIsDestination }
            return isPresent(source) ? nil : .nothingAtSource
        case .rename(let path, _):
            if operation.destination == path { return .renameToSameName }
            return isPresent(path) ? nil : .nothingAtSource
        case .write(let path, let content, _):
            guard isPresent(path) else { return nil }
            return snapshot.fingerprint(path) == content ? .contentAlreadyMatches : nil
        case .trash(let path):
            return isPresent(path) ? nil : .nothingAtSource
        case .tag(let path, let tags):
            if tags.isEmpty { return .noTagsGiven }
            return isPresent(path) ? nil : .nothingAtSource
        case .archive(let sources, _):
            if sources.isEmpty { return .nothingAtSource }
            return sources.contains(where: isPresent) ? nil : .nothingAtSource
        case .unarchive(let archive, _):
            return isPresent(archive) ? nil : .nothingAtSource
        }
    }

    private static func computeDigest(
        grantID: WorkGrantID,
        operations: [WorkFileOperation]
    ) -> String {
        // The snapshot is deliberately excluded. It describes the world, and the
        // world moves; what the person approved is the *intent*. Binding the
        // approval to a photograph of the disk would expire every approval the
        // moment an unrelated file changed, while binding it to the operations
        // says exactly what it means — and the executor re-checks the world
        // anyway, immediately before it acts.
        WorkDigests.sha256Hex(
            WorkDigests.canonicalRecord(
                [digestDomain, grantID.value] + operations.map(\.canonicalForm)
            )
        )
    }

    // MARK: Reading the plan

    /// Indices of operations the given mode does not permit.
    ///
    /// Answered here as well as at execution because a preview that shows a
    /// person a "Move to Trash" row they are not allowed to approve wastes the
    /// one decision they were asked to make.
    public func operationsForbidden(under mode: WorkAccessMode) -> [Int] {
        operations.enumerated()
            .filter { !mode.permits($0.element.kind) }
            .map(\.offset)
    }

    /// A display-safe summary of the batch.
    ///
    /// **Names and counts only, never a path.** This structure is what a phone
    /// renders, sometimes on a lock screen, and a grant-relative path still
    /// describes how somebody organises their life — `Clients/Ashworth v Reid/`
    /// on a notification is a disclosure whether or not it starts with a slash.
    /// The last component is the most a preview ever needs, and the executor has
    /// the real locations.
    public func preview(itemLimit: Int = 20) -> WorkBatchPreview {
        let conflicting = Set(analysis.conflicts.map(\.operationIndex))
        let noOp = Set(analysis.noOps.map(\.operationIndex))

        var countsByKind: [WorkFileOperation.Kind: Int] = [:]
        for operation in operations { countsByKind[operation.kind, default: 0] += 1 }
        let counts = WorkFileOperation.Kind.allCases.compactMap { kind in
            countsByKind[kind].map { WorkBatchPreview.KindCount(kind: kind, count: $0) }
        }

        let items = operations.prefix(itemLimit).enumerated().map { index, operation in
            WorkBatchPreview.Item(
                kind: operation.kind,
                displayName: operation.touchedPaths.first?.displayName ?? "",
                destinationFolderName: operation.destination?.parent?.displayName,
                isConflict: conflicting.contains(index),
                isNoOp: noOp.contains(index)
            )
        }

        return WorkBatchPreview(
            planDigest: digest,
            operationCount: operations.count,
            itemCount: analysis.touchedPaths.count,
            conflictCount: analysis.conflicts.count,
            duplicateItemCount: analysis.duplicates.reduce(0) { $0 + $1.paths.count },
            noOpCount: analysis.noOps.count,
            counts: counts,
            items: items,
            additionalItemCount: max(0, operations.count - items.count),
            headline: Self.headline(for: operations, counts: counts)
        )
    }

    private static func headline(
        for operations: [WorkFileOperation],
        counts: [WorkBatchPreview.KindCount]
    ) -> String {
        let total = operations.count
        let itemWord = total == 1 ? "item" : "items"
        guard counts.count == 1, let only = counts.first else {
            return "\(total) changes across your folder"
        }
        let destinationFolders = Set(
            operations.compactMap { $0.destination?.parent?.displayName }
        )
        if destinationFolders.count == 1, let folder = destinationFolders.first {
            return "\(only.kind.verb) \(total) \(itemWord) into \(folder)"
        }
        return "\(only.kind.verb) \(total) \(itemWord)"
    }

    // MARK: Codable

    /// Decoding re-derives the digest and refuses a mismatch.
    ///
    /// A plan arrives over the relay next to an approval that names a digest. If
    /// the stored digest were taken on trust, a plan whose operations had been
    /// edited in transit could carry the digest of the batch the person actually
    /// approved, and every downstream check — all of which compare digests —
    /// would pass. Recomputing costs one hash and closes the hole.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let id = try container.decode(String.self, forKey: .id)
        let grantID = try container.decode(WorkGrantID.self, forKey: .grantID)
        let operations = try container.decode([WorkFileOperation].self, forKey: .operations)
        let analysis = try container.decode(WorkBatchAnalysis.self, forKey: .analysis)
        let digest = try container.decode(String.self, forKey: .digest)
        guard digest == Self.computeDigest(grantID: grantID, operations: operations) else {
            throw DecodingError.dataCorruptedError(
                forKey: .digest,
                in: container,
                debugDescription: "Batch digest does not match the operations it travelled with"
            )
        }
        self.init(
            id: id,
            grantID: grantID,
            operations: operations,
            analysis: analysis,
            digest: digest
        )
    }
}

// MARK: - Preview

/// The batch as a phone renders it: names, counts, and nothing that describes
/// where anything lives.
public struct WorkBatchPreview: Hashable, Codable, Sendable {
    public struct KindCount: Hashable, Codable, Sendable {
        public let kind: WorkFileOperation.Kind
        public let count: Int

        public init(kind: WorkFileOperation.Kind, count: Int) {
            self.kind = kind
            self.count = count
        }
    }

    public struct Item: Hashable, Codable, Sendable {
        public let kind: WorkFileOperation.Kind
        /// The item's own name, never its location.
        public let displayName: String
        /// The name of the folder it ends up in, when it goes somewhere.
        public let destinationFolderName: String?
        public let isConflict: Bool
        public let isNoOp: Bool

        public init(
            kind: WorkFileOperation.Kind,
            displayName: String,
            destinationFolderName: String?,
            isConflict: Bool,
            isNoOp: Bool
        ) {
            self.kind = kind
            self.displayName = displayName
            self.destinationFolderName = destinationFolderName
            self.isConflict = isConflict
            self.isNoOp = isNoOp
        }
    }

    /// The digest of the plan this describes, so the phone can send back an
    /// approval bound to the batch it actually showed.
    public let planDigest: String
    public let operationCount: Int
    public let itemCount: Int
    public let conflictCount: Int
    public let duplicateItemCount: Int
    public let noOpCount: Int
    public let counts: [KindCount]
    public let items: [Item]
    /// How many operations the item list left out, so the reader is never given
    /// a truncated list that looks complete.
    public let additionalItemCount: Int
    public let headline: String

    public init(
        planDigest: String,
        operationCount: Int,
        itemCount: Int,
        conflictCount: Int,
        duplicateItemCount: Int,
        noOpCount: Int,
        counts: [KindCount],
        items: [Item],
        additionalItemCount: Int,
        headline: String
    ) {
        self.planDigest = planDigest
        self.operationCount = operationCount
        self.itemCount = itemCount
        self.conflictCount = conflictCount
        self.duplicateItemCount = duplicateItemCount
        self.noOpCount = noOpCount
        self.counts = counts
        self.items = items
        self.additionalItemCount = additionalItemCount
        self.headline = headline
    }
}

// MARK: - Approval

/// A person's yes, bound to one exact batch.
public struct WorkBatchApproval: Hashable, Codable, Sendable {
    /// Matches `APPROVAL_TTL_MS` in `src/lib/work/domain.ts`. Approvals expire
    /// closed: an unanswered one is not a standing yes.
    public static let timeToLive: TimeInterval = 15 * 60

    public let id: String
    public let grantID: WorkGrantID
    public let planDigest: String
    public let decidedAt: Date
    public let expiresAt: Date

    public init(
        id: String = UUID().uuidString.lowercased(),
        grantID: WorkGrantID,
        planDigest: String,
        decidedAt: Date,
        expiresAt: Date
    ) {
        self.id = id
        self.grantID = grantID
        self.planDigest = planDigest
        self.decidedAt = decidedAt
        self.expiresAt = expiresAt
    }

    /// Whether this approval authorises this plan, right now.
    ///
    /// Checks the grant as well as the digest. Two grants can hold folders with
    /// the same shape — a `Reports` folder on each of two disks — and an
    /// approval for one must not carry to the other.
    public func authorizes(_ plan: WorkBatchPlan, at date: Date) -> Bool {
        plan.digest == planDigest && plan.grantID == grantID && date < expiresAt
    }
}

// MARK: - Helpers

extension WorkFileOperation {
    /// Whether landing on something that already exists would destroy it.
    ///
    /// A folder creation finds the folder already there and does nothing; a
    /// write is *expected* to land on an existing file and pins the version it
    /// believed it was changing. Neither is a conflict, and reporting them as
    /// one trains people to approve past the warnings that matter.
    fileprivate var overwritesDestination: Bool {
        switch kind {
        case .copy, .move, .rename, .archive, .unarchive: true
        case .createFolder, .write, .trash, .tag: false
        }
    }
}
