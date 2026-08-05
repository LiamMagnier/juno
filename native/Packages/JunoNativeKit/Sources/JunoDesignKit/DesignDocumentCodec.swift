import Foundation

/// Reading and writing design documents on the Mac.
///
/// Two jobs, and deliberately only two: decide whether a stored body is a
/// document this build can open, and produce bytes the website will accept back.
/// It does not edit — editing is the shared engine's, across the bridge.
public enum DesignDocumentCodec {
    public enum Failure: Error, Equatable, CustomStringConvertible {
        case notJSON
        case notADocument
        /// The document was written by a newer build. Refused, never truncated.
        case futureSchema(found: Int, supported: Int)
        case invalid(String)

        public var description: String {
            switch self {
            case .notJSON:
                "This design document is not valid JSON."
            case .notADocument:
                "This file is not a Juno Design document."
            case .futureSchema(let found, let supported):
                """
                This document was made with a newer version of Juno \
                (design format v\(found); this app reads v\(supported)). Update Juno to open it.
                """
            case .invalid(let reason):
                reason
            }
        }
    }

    /// Sorted keys so a document encoded here and one encoded in the browser
    /// produce the same bytes — which is what lets the round-trip test compare
    /// strings rather than parse trees, and what stops a no-op save creating a
    /// version whose diff shows nothing.
    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    public static func decode(_ data: Data) throws -> DesignDocument {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure.notJSON
        }
        guard let version = object["schemaVersion"] as? Int else {
            throw Failure.notADocument
        }
        guard version <= DesignSchema.version else {
            throw Failure.futureSchema(found: version, supported: DesignSchema.version)
        }
        do {
            return try JSONDecoder().decode(DesignDocument.self, from: data)
        } catch let error as DecodingError {
            throw Failure.invalid(readable(error))
        }
    }

    public static func decode(_ string: String) throws -> DesignDocument {
        try decode(Data(string.utf8))
    }

    public static func encode(_ document: DesignDocument) throws -> Data {
        try encoder().encode(document)
    }

    /// Structural checks the type system cannot make: children exist, parent
    /// links agree with child lists, and nothing is its own ancestor. Mirrors
    /// `validateHierarchy` on the website so both refuse the same documents.
    public static func validateHierarchy(_ document: DesignDocument) -> [String] {
        var issues: [String] = []
        var seen = Set<String>()

        for page in document.pages {
            for childID in page.children {
                guard let child = document.nodes[childID] else {
                    issues.append("page \(page.id) references missing node \(childID)")
                    continue
                }
                if child.parentId != nil {
                    issues.append("page-root \(childID) has parentId \(child.parentId ?? "")")
                }
                if !seen.insert(childID).inserted {
                    issues.append("node \(childID) appears in more than one parent")
                }
            }
        }

        for node in document.nodes.values {
            for childID in node.children ?? [] {
                guard let child = document.nodes[childID] else {
                    issues.append("node \(node.id) references missing child \(childID)")
                    continue
                }
                if child.parentId != node.id {
                    issues.append("child \(childID) claims parent \(child.parentId ?? "null") but is listed under \(node.id)")
                }
                if !seen.insert(childID).inserted {
                    issues.append("node \(childID) appears in more than one parent")
                }
            }
        }

        for node in document.nodes.values {
            if !seen.contains(node.id), node.parentId != nil {
                issues.append("node \(node.id) is orphaned (parent \(node.parentId ?? "") does not list it)")
            }
            var cursor = node.parentId
            var steps = 0
            while let current = cursor {
                if current == node.id {
                    issues.append("node \(node.id) is its own ancestor")
                    break
                }
                guard let parent = document.nodes[current] else {
                    issues.append("node \(node.id) has missing ancestor \(current)")
                    break
                }
                cursor = parent.parentId
                steps += 1
                if steps > document.nodes.count {
                    issues.append("node \(node.id) has a cyclic ancestry")
                    break
                }
            }
        }

        // Sorted so the message is stable across runs — dictionary iteration
        // order is not, and a test that compares diagnostics needs it to be.
        return issues.sorted()
    }

    /// Decode and structurally validate in one step.
    public static func load(_ data: Data) throws -> DesignDocument {
        let document = try decode(data)
        let issues = validateHierarchy(document)
        guard issues.isEmpty else {
            throw Failure.invalid("This design document is structurally invalid: \(issues.prefix(3).joined(separator: "; "))")
        }
        return document
    }

    private static func readable(_ error: DecodingError) -> String {
        switch error {
        case .keyNotFound(let key, let context):
            "Missing “\(key.stringValue)” at \(path(context))."
        case .typeMismatch(_, let context), .valueNotFound(_, let context):
            "Unexpected value at \(path(context)): \(context.debugDescription)"
        case .dataCorrupted(let context):
            context.debugDescription
        @unknown default:
            "This design document could not be read."
        }
    }

    private static func path(_ context: DecodingError.Context) -> String {
        let joined = context.codingPath.map(\.stringValue).joined(separator: ".")
        return joined.isEmpty ? "the document root" : joined
    }
}
