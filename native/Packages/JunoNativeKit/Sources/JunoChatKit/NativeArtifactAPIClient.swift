import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

public enum NativeArtifactOrigin: String, Codable, CaseIterable, Sendable {
    case generated
    case edit
    case restore
}

public enum NativeArtifactKind: String, Codable, CaseIterable, Sendable {
    case html = "HTML"
    case react = "REACT"
    case code = "CODE"
    case markdown = "MARKDOWN"
    case svg = "SVG"
    case mermaid = "MERMAID"

    public var supportsRenderedPreview: Bool {
        switch self {
        case .html, .markdown, .svg: true
        case .react, .code, .mermaid: false
        }
    }
}

public struct NativeArtifactVersion: Identifiable, Equatable, Sendable {
    public let id: String
    public let version: Int
    public let content: String
    public let origin: NativeArtifactOrigin?
    public let createdAt: Date

    public init(
        id: String,
        version: Int,
        content: String,
        origin: NativeArtifactOrigin?,
        createdAt: Date
    ) {
        self.id = id
        self.version = version
        self.content = content
        self.origin = origin
        self.createdAt = createdAt
    }
}

public struct NativeArtifactDetail: Equatable, Sendable {
    public let id: String
    public let identifier: String
    public let title: String
    public let kind: NativeArtifactKind
    public let language: String?
    public let currentVersion: Int
    public let messageID: String?
    public let versions: [NativeArtifactVersion]
    public let createdAt: Date
    public let updatedAt: Date

    public init(
        id: String,
        identifier: String,
        title: String,
        kind: NativeArtifactKind,
        language: String?,
        currentVersion: Int,
        messageID: String?,
        versions: [NativeArtifactVersion],
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.identifier = identifier
        self.title = title
        self.kind = kind
        self.language = language
        self.currentVersion = currentVersion
        self.messageID = messageID
        self.versions = versions
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public enum NativeArtifactExportFormat: String, Codable, CaseIterable, Sendable {
    case docx
    case xlsx
    case pptx
}

public struct NativeArtifactExport: Equatable, Sendable {
    public let data: Data
    public let fileName: String
    public let contentType: String

    public init(data: Data, fileName: String, contentType: String) {
        self.data = data
        self.fileName = fileName
        self.contentType = contentType
    }
}

public enum NativeArtifactAPIError: Error, Equatable, LocalizedError, Sendable {
    case invalidIdentifier
    case invalidTitle
    case invalidContent
    case malformedResponse
    case stale(NativeArtifactDetail?)
    case server(statusCode: Int, message: String, retryable: Bool)

    public var errorDescription: String? {
        switch self {
        case .invalidIdentifier:
            "Juno could not safely address this artifact."
        case .invalidTitle:
            "Enter an artifact title between 1 and 200 characters."
        case .invalidContent:
            "Artifact content cannot exceed 200,000 characters."
        case .malformedResponse:
            "Juno returned invalid artifact data."
        case .stale:
            "This artifact changed on another device. The latest version has been loaded."
        case .server(_, let message, _):
            message
        }
    }
}

/// Uses the existing owner-scoped artifact routes. Durable list and version
/// state arrive through JunoSync; direct reads keep an opened editor current.
public struct NativeArtifactAPIClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func artifact(
        id: String,
        for accountID: AccountID
    ) async throws -> NativeArtifactDetail {
        try requireIdentifier(id)
        let response = try await sender.send(
            try NativeBearerRequest(path: "/api/artifacts/\(id)"),
            for: accountID
        )
        try requireSuccess(response)
        return try decodeArtifact(response.body, expectedID: id)
    }

    public func save(
        id: String,
        content: String,
        baseVersion: Int,
        origin: NativeArtifactOrigin,
        for accountID: AccountID
    ) async throws -> NativeArtifactDetail {
        try requireIdentifier(id)
        guard content.utf16.count <= 200_000, baseVersion > 0,
            origin == .edit || origin == .restore
        else { throw NativeArtifactAPIError.invalidContent }
        let body = try JSONEncoder().encode(SaveRequestWire(
            content: content,
            baseVersion: baseVersion,
            origin: origin
        ))
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/artifacts/\(id)",
                method: .post,
                headers: try JSONHeaders.value(),
                body: body
            ),
            for: accountID
        )
        if response.statusCode == 409 {
            let latest = try? decodeArtifact(response.body, expectedID: id)
            throw NativeArtifactAPIError.stale(latest)
        }
        try requireSuccess(response)
        return try decodeArtifact(response.body, expectedID: id)
    }

    public func rename(
        id: String,
        title: String,
        for accountID: AccountID
    ) async throws -> NativeArtifactDetail {
        try requireIdentifier(id)
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 200 else {
            throw NativeArtifactAPIError.invalidTitle
        }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/artifacts/\(id)",
                method: .patch,
                headers: try JSONHeaders.value(),
                body: try JSONEncoder().encode(RenameArtifactRequestWire(title: trimmed))
            ),
            for: accountID
        )
        try requireSuccess(response)
        return try decodeArtifact(response.body, expectedID: id)
    }

    public func delete(id: String, for accountID: AccountID) async throws {
        try requireIdentifier(id)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/artifacts/\(id)",
                method: .delete,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
    }

    public func exportFormats(
        id: String,
        for accountID: AccountID
    ) async throws -> [NativeArtifactExportFormat] {
        try requireIdentifier(id)
        let response = try await sender.send(
            try NativeBearerRequest(path: "/api/artifacts/\(id)/export"),
            for: accountID
        )
        try requireSuccess(response)
        let wire: ExportFormatsWire
        do { wire = try JSONDecoder().decode(ExportFormatsWire.self, from: response.body) }
        catch { throw NativeArtifactAPIError.malformedResponse }
        let formats = wire.formats.compactMap(NativeArtifactExportFormat.init(rawValue:))
        guard formats.count == wire.formats.count, Set(formats).count == formats.count else {
            throw NativeArtifactAPIError.malformedResponse
        }
        return formats
    }

    public func export(
        id: String,
        title: String,
        format: NativeArtifactExportFormat,
        for accountID: AccountID
    ) async throws -> NativeArtifactExport {
        try requireIdentifier(id)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/artifacts/\(id)/export",
                queryItems: [URLQueryItem(name: "format", value: format.rawValue)]
            ),
            for: accountID
        )
        try requireSuccess(response)
        guard !response.body.isEmpty else { throw NativeArtifactAPIError.malformedResponse }
        return NativeArtifactExport(
            data: response.body,
            fileName: safeFileName(title: title, extension: format.rawValue),
            contentType: response.headers["content-type"] ?? "application/octet-stream"
        )
    }

    private func decodeArtifact(_ data: Data, expectedID: String) throws -> NativeArtifactDetail {
        let wire: ArtifactResponseWire
        do { wire = try JSONDecoder().decode(ArtifactResponseWire.self, from: data) }
        catch { throw NativeArtifactAPIError.malformedResponse }
        let artifact = wire.artifact
        guard artifact.id == expectedID, !artifact.identifier.isEmpty,
            !artifact.title.isEmpty, artifact.currentVersion > 0,
            let kind = NativeArtifactKind(rawValue: artifact.type),
            let createdAt = parseDate(artifact.createdAt),
            let updatedAt = parseDate(artifact.updatedAt)
        else { throw NativeArtifactAPIError.malformedResponse }

        var seen = Set<Int>()
        let versions = try artifact.versions.map { version -> NativeArtifactVersion in
            guard version.version > 0, seen.insert(version.version).inserted,
                version.content.utf16.count <= 200_000,
                let createdAt = parseDate(version.createdAt)
            else { throw NativeArtifactAPIError.malformedResponse }
            return NativeArtifactVersion(
                id: "\(artifact.id)#\(version.version)",
                version: version.version,
                content: version.content,
                origin: version.origin,
                createdAt: createdAt
            )
        }.sorted { $0.version < $1.version }
        guard versions.contains(where: { $0.version == artifact.currentVersion }) else {
            throw NativeArtifactAPIError.malformedResponse
        }
        return NativeArtifactDetail(
            id: artifact.id,
            identifier: artifact.identifier,
            title: artifact.title,
            kind: kind,
            language: artifact.language,
            currentVersion: artifact.currentVersion,
            messageID: artifact.messageId,
            versions: versions,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }

    private func requireSuccess(_ response: HTTPResponse) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        throw NativeArtifactAPIError.server(
            statusCode: response.statusCode,
            message: serverMessage(response.body) ?? "Juno could not complete the artifact request.",
            retryable: response.statusCode == 408 || response.statusCode == 429
                || response.statusCode >= 500
        )
    }

    private func requireIdentifier(_ value: String) throws {
        guard !value.isEmpty, value.utf8.count <= 200,
            value.utf8.allSatisfy({ byte in
                switch byte {
                case 45, 46, 48...57, 58, 65...90, 95, 97...122: true
                default: false
                }
            })
        else { throw NativeArtifactAPIError.invalidIdentifier }
    }

    private func parseDate(_ value: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = precise.date(from: value) { return date }
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        return ordinary.date(from: value)
    }

    private func serverMessage(_ data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        if let message = object["message"] as? String, !message.isEmpty { return message }
        if let message = object["error"] as? String, !message.isEmpty { return message }
        return nil
    }

    private func safeFileName(title: String, extension value: String) -> String {
        let cleaned = title.unicodeScalars.map { scalar -> Character in
            let forbidden = CharacterSet(charactersIn: "\\/:*?\"<>|")
                .union(.controlCharacters)
            return forbidden.contains(scalar) ? " " : Character(String(scalar))
        }
        let base = String(cleaned).trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(base.isEmpty ? "artifact" : String(base.prefix(80))).\(value)"
    }
}

private enum JSONHeaders {
    static func value() throws -> HTTPHeaders {
        try HTTPHeaders([
            "accept": "application/json",
            "content-type": "application/json",
        ])
    }
}

private struct SaveRequestWire: Encodable {
    let content: String
    let baseVersion: Int
    let origin: NativeArtifactOrigin
}

private struct RenameArtifactRequestWire: Encodable {
    let title: String
}

private struct ExportFormatsWire: Decodable {
    let formats: [String]
}

private struct ArtifactResponseWire: Decodable {
    struct Artifact: Decodable {
        struct Version: Decodable {
            let version: Int
            let content: String
            let origin: NativeArtifactOrigin?
            let createdAt: String
        }

        let id: String
        let identifier: String
        let type: String
        let title: String
        let language: String?
        let currentVersion: Int
        let messageId: String?
        let versions: [Version]
        let createdAt: String
        let updatedAt: String
    }

    let artifact: Artifact
}
