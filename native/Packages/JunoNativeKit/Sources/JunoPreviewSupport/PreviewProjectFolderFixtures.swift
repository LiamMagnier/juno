import Foundation
import JunoAPI

/// A small folder tree for the preview world, so project subfolders render:
///
///     Astro research (proj-1)
///     ├ Observations (proj-1-obs)
///     │ └ Raw spectra (proj-1-obs-raw)
///     └ Report drafts (proj-1-drafts)
///     Native apps (proj-2)
///
/// The synced records are written by ``PreviewFixtures``; this answers the
/// two routes the folder screens read (`GET /api/projects`,
/// `GET /api/projects/{id}`) from the same tree, and acknowledges the writes.
public enum PreviewProjectFolderFixtures {
    public struct Folder: Sendable {
        public let id: String
        public let name: String
        public let parentID: String
        public let instructions: String
        let updated: TimeInterval
    }

    public static let folders: [Folder] = [
        Folder(
            id: "proj-1-obs", name: "Observations", parentID: "proj-1",
            instructions: "Group observations by epoch and instrument.", updated: -3_600
        ),
        Folder(
            id: "proj-1-obs-raw", name: "Raw spectra", parentID: "proj-1-obs",
            instructions: "", updated: -7_200
        ),
        Folder(
            id: "proj-1-drafts", name: "Report drafts", parentID: "proj-1",
            instructions: "", updated: -90_000
        ),
    ]

    /// id → (name, parent, instructions) for the whole tree, top level included.
    private static let tree: [String: (name: String, parent: String?, instructions: String)] = {
        var out: [String: (name: String, parent: String?, instructions: String)] = [
            "proj-1": ("Astro research", nil, "You are a research assistant on an observational astronomy project."),
            "proj-2": ("Native apps", nil, "Ship the macOS and iOS clients with real backend transport."),
        ]
        for folder in folders { out[folder.id] = (folder.name, folder.parentID, folder.instructions) }
        return out
    }()

    static func body(path: String, method: HTTPMethod) -> Data? {
        guard path.hasPrefix("/api/projects") else { return nil }
        if path == "/api/projects" {
            if method == .post { return Data(#"{"id":"proj-preview-new"}"#.utf8) }
            let rows = tree.keys.sorted().map { id in
                let parent = tree[id]?.parent.map { "\"\($0)\"" } ?? "null"
                return #"{"id":"\#(id)","name":"\#(tree[id]!.name)","parentId":\#(parent)}"#
            }
            return Data(#"{"projects":[\#(rows.joined(separator: ","))]}"#.utf8)
        }
        let id = String(path.dropFirst("/api/projects/".count))
        guard !id.contains("/"), let node = tree[id] else { return nil }
        switch method {
        case .patch: return Data(#"{"ok":true}"#.utf8)
        case .delete: return Data(#"{"ok":true,"deleted":1,"moved":0}"#.utf8)
        default: break
        }
        var lineage: [String] = []
        var cursor = node.parent
        while let next = cursor, !lineage.contains(next) {
            lineage.insert(next, at: 0)
            cursor = tree[next]?.parent
        }
        let crumbs = lineage.map { #"{"id":"\#($0)","name":"\#(tree[$0]!.name)"}"# }
        let children = tree.filter { $0.value.parent == id }.keys.sorted().map { child in
            let grandchildren = tree.values.filter { $0.parent == child }.count
            return #"{"id":"\#(child)","name":"\#(tree[child]!.name)","instructions":"","starred":false,"updatedAt":"2026-10-01T10:00:00.000Z","conversationCount":0,"fileCount":0,"childCount":\#(grandchildren)}"#
        }
        let inherited = lineage.compactMap { ancestor -> String? in
            let instructions = tree[ancestor]!.instructions
            guard !instructions.isEmpty else { return nil }
            return #"{"id":"\#(ancestor)","name":"\#(tree[ancestor]!.name)","instructions":"\#(instructions)","fileCount":\#(ancestor == "proj-1" ? 1 : 0)}"#
        }
        let parent = node.parent.map { "\"\($0)\"" } ?? "null"
        return Data("""
        {"project":{"id":"\(id)","name":"\(node.name)","parentId":\(parent),"instructions":"\(node.instructions)","starred":false,"updatedAt":"2026-10-01T10:00:00.000Z","workDefaults":{}},\
        "conversations":[],"files":[],"workspace":null,\
        "breadcrumbs":[\(crumbs.joined(separator: ","))],\
        "children":[\(children.joined(separator: ","))],\
        "inherited":[\(inherited.joined(separator: ","))]}
        """.utf8)
    }
}
