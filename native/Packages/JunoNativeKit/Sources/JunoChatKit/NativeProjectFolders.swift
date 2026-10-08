import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

// Projects as folders — the native half of the web's project subfolders
// (src/lib/projects/project-tree.ts, src/app/api/projects/[id]/route.ts).
//
// A project's parent is another project of the same owner. The rules are the
// server's, mirrored here so a picker can refuse a move before it is sent:
// no project inside itself or its own descendants, at most four levels.
// The server checks again (`validateProjectMove`) and its answer wins.

/// What happens to a folder's subfolders when it is deleted
/// (`DELETE /api/projects/{id}?children=`).
public enum NativeProjectChildrenMode: String, Equatable, Sendable, CaseIterable {
    /// Subfolders move up to the deleted folder's own parent, with everything
    /// in them. The server's default.
    case lift
    /// The whole subtree is deleted. Chats are kept, unlinked.
    case cascade
}

/// Why a move (or a new folder) is refused. Raw values are the server's
/// `reason` strings (`MoveRefusal` in project-tree.ts).
public enum NativeProjectMoveRefusal: String, Equatable, Sendable, Error {
    case notFound = "not_found"
    case parentNotFound = "parent_not_found"
    case isSelf = "self"
    case cycle
    case depth

    /// The server's own sentences (`MOVE_REFUSAL_MESSAGES`).
    public var message: String {
        switch self {
        case .notFound: "That project was not found."
        case .parentNotFound: "That folder was not found."
        case .isSelf: "A project can’t go inside itself."
        case .cycle: "A project can’t go inside one of its own folders."
        case .depth: "Folders nest at most \(NativeProjectTree.maximumDepth) levels deep."
        }
    }

    /// The short reason a picker row shows beside a destination it refuses.
    public var shortLabel: String {
        switch self {
        case .depth: "Too deep"
        case .isSelf: "This project"
        case .cycle: "Inside it"
        case .notFound, .parentNotFound: "Unavailable"
        }
    }
}

/// One ancestor in a project's path, root first.
public struct NativeProjectCrumb: Identifiable, Equatable, Sendable, Decodable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// A subfolder directly inside a project, as `GET /api/projects/{id}` lists it.
public struct NativeProjectFolderChild: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let instructions: String
    public let starred: Bool
    public let updatedAt: Date?
    public let conversationCount: Int
    public let fileCount: Int
    public let childCount: Int

    public init(
        id: String,
        name: String,
        instructions: String = "",
        starred: Bool = false,
        updatedAt: Date? = nil,
        conversationCount: Int = 0,
        fileCount: Int = 0,
        childCount: Int = 0
    ) {
        self.id = id
        self.name = name
        self.instructions = instructions
        self.starred = starred
        self.updatedAt = updatedAt
        self.conversationCount = conversationCount
        self.fileCount = fileCount
        self.childCount = childCount
    }
}

/// An ancestor whose instructions or files every chat in this project also
/// receives, root first (`mergeInheritedProjectContext`).
public struct NativeProjectInheritance: Identifiable, Equatable, Sendable, Decodable {
    public let id: String
    public let name: String
    public let instructions: String
    public let fileCount: Int

    public init(id: String, name: String, instructions: String, fileCount: Int) {
        self.id = id
        self.name = name
        self.instructions = instructions
        self.fileCount = fileCount
    }
}

/// The folder half of `GET /api/projects/{id}`: where the project sits, what
/// is inside it, and what it inherits. Drawn for the owner only; a
/// collaborator gets empty lists and a nil parent.
public struct NativeProjectFolderDetail: Equatable, Sendable {
    public let projectID: String
    public let parentID: String?
    public let breadcrumbs: [NativeProjectCrumb]
    public let children: [NativeProjectFolderChild]
    public let inherited: [NativeProjectInheritance]

    public init(
        projectID: String,
        parentID: String?,
        breadcrumbs: [NativeProjectCrumb],
        children: [NativeProjectFolderChild],
        inherited: [NativeProjectInheritance]
    ) {
        self.projectID = projectID
        self.parentID = parentID
        self.breadcrumbs = breadcrumbs
        self.children = children
        self.inherited = inherited
    }

    /// Decodes the route's whole response, reading only the folder fields.
    public static func decode(_ data: Data) throws -> NativeProjectFolderDetail {
        let wire: DetailWire
        do { wire = try JSONDecoder().decode(DetailWire.self, from: data) }
        catch { throw NativeProjectAPIError.malformedResponse }
        return NativeProjectFolderDetail(
            projectID: wire.project.id,
            parentID: wire.project.parentId,
            breadcrumbs: wire.breadcrumbs ?? [],
            children: (wire.children ?? []).map {
                NativeProjectFolderChild(
                    id: $0.id,
                    name: $0.name,
                    instructions: $0.instructions ?? "",
                    starred: $0.starred ?? false,
                    updatedAt: $0.updatedAt.flatMap(NativeProjectFolderDates.parse),
                    conversationCount: $0.conversationCount ?? 0,
                    fileCount: $0.fileCount ?? 0,
                    childCount: $0.childCount ?? 0
                )
            },
            inherited: wire.inherited ?? []
        )
    }

    private struct DetailWire: Decodable {
        struct Project: Decodable {
            let id: String
            let parentId: String?
        }

        struct Child: Decodable {
            let id: String
            let name: String
            let instructions: String?
            let starred: Bool?
            let updatedAt: String?
            let conversationCount: Int?
            let fileCount: Int?
            let childCount: Int?
        }

        let project: Project
        let breadcrumbs: [NativeProjectCrumb]?
        let children: [Child]?
        let inherited: [NativeProjectInheritance]?
    }
}

/// What a folder delete did: how many projects went, how many moved up.
public struct NativeProjectDeleteResult: Equatable, Sendable {
    public let deleted: Int
    public let moved: Int

    public init(deleted: Int, moved: Int) {
        self.deleted = deleted
        self.moved = moved
    }
}

/// A place a project can be moved to. `id == nil` is the top level.
public struct NativeProjectMoveDestination: Identifiable, Equatable, Sendable {
    public let projectID: String?
    public let name: String
    /// 0 for the top level, 1 for a top-level project, and so on.
    public let depth: Int
    /// Why this destination is refused, or nil when the move is allowed.
    public let refusal: NativeProjectMoveRefusal?
    /// Where the project already is.
    public let isCurrent: Bool

    public var id: String { projectID ?? "" }
    public var isAllowed: Bool { refusal == nil && !isCurrent }

    public init(
        projectID: String?,
        name: String,
        depth: Int,
        refusal: NativeProjectMoveRefusal?,
        isCurrent: Bool
    ) {
        self.projectID = projectID
        self.name = name
        self.depth = depth
        self.refusal = refusal
        self.isCurrent = isCurrent
    }
}

/// The owner's projects as a tree. Pure and cycle-safe: a corrupt row (a
/// parent that is missing, or a loop already in the data) is drawn at the top
/// level rather than hidden or followed forever, as the web's
/// `buildProjectForest` does.
public struct NativeProjectTree: Equatable, Sendable {
    /// Top level is depth 1; a folder four levels down is the deepest allowed.
    public static let maximumDepth = 4

    public struct Node: Equatable, Sendable {
        public let id: String
        public let parentID: String?

        public init(id: String, parentID: String?) {
            self.id = id
            self.parentID = parentID
        }
    }

    public let nodes: [Node]
    private let parentByID: [String: String]
    private let childrenByID: [String: [String]]

    public init(nodes: [Node]) {
        self.nodes = nodes
        var parents: [String: String] = [:]
        var children: [String: [String]] = [:]
        let ids = Set(nodes.map(\.id))
        for node in nodes {
            guard let parent = node.parentID, parent != node.id, ids.contains(parent) else { continue }
            parents[node.id] = parent
            children[parent, default: []].append(node.id)
        }
        parentByID = parents
        childrenByID = children
    }

    public init(projects: [NativeProject]) {
        self.init(nodes: projects.map { Node(id: $0.id, parentID: $0.parentID) })
    }

    public func contains(_ id: String) -> Bool { nodes.contains { $0.id == id } }

    /// The ids above `id`, nearest first (parent, grandparent, …).
    public func ancestorIDs(of id: String) -> [String] {
        var out: [String] = []
        var seen: Set<String> = [id]
        var current = parentByID[id]
        while let next = current, !seen.contains(next) {
            out.append(next)
            seen.insert(next)
            current = parentByID[next]
        }
        return out
    }

    /// Every id below `id`, breadth first.
    public func descendantIDs(of id: String) -> [String] {
        var out: [String] = []
        var seen: Set<String> = [id]
        var queue = childrenByID[id] ?? []
        while !queue.isEmpty {
            let next = queue.removeFirst()
            guard !seen.contains(next) else { continue }
            seen.insert(next)
            out.append(next)
            queue.append(contentsOf: childrenByID[next] ?? [])
        }
        return out
    }

    /// The projects directly inside `id`.
    public func childIDs(of id: String) -> [String] { childrenByID[id] ?? [] }

    /// Whether `id` sits at the top level (no parent, or a parent this tree
    /// does not hold). A row caught in a loop has a parent and no root; it is
    /// top level too, so nothing an owner has can vanish from the index.
    public func isTopLevel(_ id: String) -> Bool {
        guard parentByID[id] != nil else { return true }
        // The walk stops at a root (no parent) or where it meets itself. Only
        // the second leaves the last ancestor with a parent of its own.
        guard let last = ancestorIDs(of: id).last else { return true }
        return parentByID[last] != nil
    }

    /// 1 for a top-level project.
    public func depth(of id: String) -> Int { ancestorIDs(of: id).count + 1 }

    /// Levels in the subtree rooted at `id`, itself included (a leaf is 1).
    public func subtreeHeight(of id: String) -> Int {
        func walk(_ node: String, _ seen: Set<String>) -> Int {
            var best = 0
            for child in childrenByID[node] ?? [] where !seen.contains(child) {
                best = max(best, walk(child, seen.union([child])))
            }
            return best + 1
        }
        return walk(id, [id])
    }

    /// Whether `id` may move under `newParentID` (nil = the top level).
    public func validateMove(_ id: String, to newParentID: String?) -> NativeProjectMoveRefusal? {
        guard contains(id) else { return .notFound }
        guard let newParentID else { return nil }
        if newParentID == id { return .isSelf }
        guard contains(newParentID) else { return .parentNotFound }
        if descendantIDs(of: id).contains(newParentID) { return .cycle }
        if depth(of: newParentID) + subtreeHeight(of: id) > Self.maximumDepth { return .depth }
        return nil
    }

    /// Whether a new folder may be created under `parentID`.
    public func validateNewChild(under parentID: String?) -> NativeProjectMoveRefusal? {
        guard let parentID else { return nil }
        guard contains(parentID) else { return .parentNotFound }
        if depth(of: parentID) + 1 > Self.maximumDepth { return .depth }
        return nil
    }

    /// Who would move where if `id` were deleted in `mode`
    /// (`planFolderDelete`): the ids deleted, deepest first, and the direct
    /// children lifted to `id`'s parent.
    public func planDelete(
        _ id: String,
        mode: NativeProjectChildrenMode
    ) -> (deleteIDs: [String], liftedIDs: [String]) {
        guard contains(id) else { return ([], []) }
        switch mode {
        case .cascade:
            return (Array(descendantIDs(of: id).reversed()) + [id], [])
        case .lift:
            return ([id], childIDs(of: id))
        }
    }
}

enum NativeProjectFolderDates {
    static func parse(_ value: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = precise.date(from: value) { return date }
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        return ordinary.date(from: value)
    }
}

/// The REST half of folders. Stable project state still arrives through
/// JunoSync; these are the four calls sync has no mutation for — creating a
/// project inside another, moving one, deleting a folder with a mode, and the
/// owner-only folder view of one project.
public struct NativeProjectFoldersClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    /// `GET /api/projects`: every project's folder, id → parent id (nil for
    /// the top level). Used to fill in records a cache stored before the sync
    /// projection carried `parentId`.
    public func parentIndex(for accountID: AccountID) async throws -> [String: String?] {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/projects",
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
        let wire: ListWire
        do { wire = try JSONDecoder().decode(ListWire.self, from: response.body) }
        catch { throw NativeProjectAPIError.malformedResponse }
        var out: [String: String?] = [:]
        for project in wire.projects { out[project.id] = .some(project.parentId) }
        return out
    }

    /// `GET /api/projects/{id}`, its folder fields.
    public func detail(id: String, for accountID: AccountID) async throws -> NativeProjectFolderDetail {
        try requireSegment(id)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/projects/\(id)",
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
        return try NativeProjectFolderDetail.decode(response.body)
    }

    /// `POST /api/projects` with `parentId`: a new folder inside `parentID`
    /// (or a top-level project when nil). Returns the new id.
    public func createFolder(
        name: String,
        parentID: String?,
        for accountID: AccountID
    ) async throws -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 120 else {
            throw NativeProjectStoreError.invalidName
        }
        if let parentID { try requireSegment(parentID) }
        var object: [String: Any] = ["name": trimmed]
        object["parentId"] = parentID ?? NSNull()
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/projects",
                method: .post,
                headers: jsonHeaders(),
                body: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            ),
            for: accountID
        )
        try requireSuccess(response)
        guard let created = try? JSONDecoder().decode(CreatedWire.self, from: response.body),
            !created.id.isEmpty
        else { throw NativeProjectAPIError.malformedResponse }
        return created.id
    }

    /// `PATCH /api/projects/{id}` with `parentId` (null = the top level).
    public func move(id: String, to parentID: String?, for accountID: AccountID) async throws {
        try requireSegment(id)
        if let parentID { try requireSegment(parentID) }
        let object: [String: Any] = ["parentId": parentID ?? NSNull()]
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/projects/\(id)",
                method: .patch,
                headers: jsonHeaders(),
                body: try JSONSerialization.data(withJSONObject: object)
            ),
            for: accountID
        )
        try requireSuccess(response)
    }

    /// `DELETE /api/projects/{id}?children=lift|cascade`.
    public func delete(
        id: String,
        children mode: NativeProjectChildrenMode,
        for accountID: AccountID
    ) async throws -> NativeProjectDeleteResult {
        try requireSegment(id)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/projects/\(id)",
                method: .delete,
                queryItems: [URLQueryItem(name: "children", value: mode.rawValue)],
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
        let wire = try? JSONDecoder().decode(DeletedWire.self, from: response.body)
        return NativeProjectDeleteResult(deleted: wire?.deleted ?? 1, moved: wire?.moved ?? 0)
    }

    private func jsonHeaders() throws -> HTTPHeaders {
        try HTTPHeaders(["accept": "application/json", "content-type": "application/json"])
    }

    private func requireSegment(_ value: String) throws {
        guard !value.isEmpty, value.utf8.count <= 200,
            value.utf8.allSatisfy({ byte in
                switch byte {
                case 45, 46, 48...57, 65...90, 95, 97...122: true
                default: false
                }
            })
        else { throw NativeProjectAPIError.invalidIdentifier }
    }

    private func requireSuccess(_ response: HTTPResponse) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]
        if let reason = (object?["reason"] as? String).flatMap(NativeProjectMoveRefusal.init(rawValue:)) {
            throw reason
        }
        let message = (object?["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        throw NativeProjectAPIError.server(
            statusCode: response.statusCode,
            message: message ?? "Alevr could not complete the project request.",
            retryable: response.statusCode == 408 || response.statusCode == 429
                || response.statusCode >= 500
        )
    }

    private struct ListWire: Decodable {
        struct Project: Decodable {
            let id: String
            let parentId: String?
        }

        let projects: [Project]
    }

    private struct CreatedWire: Decodable { let id: String }

    private struct DeletedWire: Decodable {
        let deleted: Int?
        let moved: Int?
    }
}

extension NativeProjectMoveRefusal: LocalizedError {
    public var errorDescription: String? { message }
}
