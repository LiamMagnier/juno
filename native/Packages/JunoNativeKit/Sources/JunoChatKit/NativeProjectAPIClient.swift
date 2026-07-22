import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

public enum NativeProjectFileAccess: Equatable, Sendable {
    case remote(URL)
    case downloaded(Data)
}

public struct NativeUploadedProjectFile: Equatable, Sendable {
    public let id: String
    public let fileName: String

    public init(id: String, fileName: String) {
        self.id = id
        self.fileName = fileName
    }
}

public enum NativeProjectAPIError: Error, Equatable, LocalizedError, Sendable {
    case invalidIdentifier
    case invalidFileName
    case invalidMIMEType
    case fileTooLarge(maximumBytes: Int)
    case malformedResponse
    case unsafeFileURL
    case server(statusCode: Int, message: String, retryable: Bool)

    public var errorDescription: String? {
        switch self {
        case .invalidIdentifier:
            "Juno could not safely address this project or file."
        case .invalidFileName:
            "Enter a valid file name."
        case .invalidMIMEType:
            "Juno could not determine a safe file type."
        case .fileTooLarge(let maximumBytes):
            "This native upload is limited to \(maximumBytes / 1_048_576) MB."
        case .malformedResponse:
            "Juno returned invalid project data."
        case .unsafeFileURL:
            "Juno returned an unsafe file address."
        case .server(_, let message, _):
            message
        }
    }
}

/// Reuses the existing bearer project, upload and attachment routes. Stable
/// entity state still arrives through JunoSync; this client only performs file
/// actions and refreshes short-lived attachment access URLs on demand.
public struct NativeProjectAPIClient: Sendable {
    public static let maximumUploadBytes = 50 * 1_024 * 1_024

    private let sender: any NativeAuthenticatedRequestSending
    private let syncClient: NativeSyncAPIClient

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
        syncClient = NativeSyncAPIClient(sender: sender)
    }

    public func upload(
        data: Data,
        fileName: String,
        mimeType: String,
        projectID: String,
        for accountID: AccountID
    ) async throws -> NativeUploadedProjectFile {
        try requireIdentifier(projectID)
        let safeName = try normalizedFileName(fileName)
        let safeMIME = try normalizedMIMEType(mimeType)
        guard data.count <= Self.maximumUploadBytes else {
            throw NativeProjectAPIError.fileTooLarge(
                maximumBytes: Self.maximumUploadBytes
            )
        }
        let boundary = "juno-native-\(UUID().uuidString.lowercased())"
        var body = Data()
        append("--\(boundary)\r\n", to: &body)
        append("Content-Disposition: form-data; name=\"projectId\"\r\n\r\n", to: &body)
        append("\(projectID)\r\n", to: &body)
        append("--\(boundary)\r\n", to: &body)
        append(
            "Content-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\n",
            to: &body
        )
        append("Content-Type: \(safeMIME)\r\n\r\n", to: &body)
        body.append(data)
        append("\r\n--\(boundary)--\r\n", to: &body)

        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/upload",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "multipart/form-data; boundary=\(boundary)",
                ]),
                body: body
            ),
            for: accountID
        )
        try requireSuccess(response)
        let wire: UploadResponseWire
        do { wire = try JSONDecoder().decode(UploadResponseWire.self, from: response.body) }
        catch { throw NativeProjectAPIError.malformedResponse }
        try requireIdentifier(wire.attachment.id)
        guard !wire.attachment.fileName.isEmpty else {
            throw NativeProjectAPIError.malformedResponse
        }
        return NativeUploadedProjectFile(
            id: wire.attachment.id,
            fileName: wire.attachment.fileName
        )
    }

    public func renameFile(
        id: String,
        fileName: String,
        for accountID: AccountID
    ) async throws {
        try requireIdentifier(id)
        let safeName = try normalizedFileName(fileName)
        let body = try JSONEncoder().encode(RenameRequestWire(fileName: safeName))
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/attachments/\(id)",
                method: .patch,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: body
            ),
            for: accountID
        )
        try requireSuccess(response)
    }

    public func deleteFile(id: String, for accountID: AccountID) async throws {
        try requireIdentifier(id)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/attachments/\(id)",
                method: .delete,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
    }

    public func accessFile(
        id: String,
        for accountID: AccountID
    ) async throws -> NativeProjectFileAccess {
        try requireIdentifier(id)
        let entities = try await syncClient.entities(
            type: "attachment",
            ids: [id],
            for: accountID
        )
        guard let entity = entities.first, entity.id == id,
            case .object(let object)? = entity.data,
            case .string(let rawURL)? = object["url"]
        else { throw NativeProjectAPIError.malformedResponse }

        if let url = URL(string: rawURL), url.scheme?.lowercased() == "https",
            url.host != nil
        {
            return .remote(url)
        }
        guard rawURL.hasPrefix("/api/files/"), !rawURL.contains("#"),
            !rawURL.contains("?")
        else { throw NativeProjectAPIError.unsafeFileURL }
        let response = try await sender.send(
            try NativeBearerRequest(path: rawURL),
            for: accountID
        )
        try requireSuccess(response)
        return .downloaded(response.body)
    }

    private func requireSuccess(_ response: HTTPResponse) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        throw NativeProjectAPIError.server(
            statusCode: response.statusCode,
            message: serverMessage(response.body) ?? "Juno could not complete the file request.",
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
        else { throw NativeProjectAPIError.invalidIdentifier }
    }

    private func normalizedFileName(_ value: String) throws -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 200 else {
            throw NativeProjectAPIError.invalidFileName
        }
        let normalized = trimmed.replacingOccurrences(of: "\"", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\r", with: "_")
            .replacingOccurrences(of: "\n", with: "_")
        guard !normalized.isEmpty else { throw NativeProjectAPIError.invalidFileName }
        return normalized
    }

    private func normalizedMIMEType(_ value: String) throws -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 200,
            trimmed.contains("/"), !trimmed.contains("\r"), !trimmed.contains("\n"),
            trimmed.unicodeScalars.allSatisfy({ $0.isASCII })
        else { throw NativeProjectAPIError.invalidMIMEType }
        return trimmed
    }

    private func append(_ value: String, to data: inout Data) {
        data.append(Data(value.utf8))
    }

    private func serverMessage(_ data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        if let message = object["message"] as? String, !message.isEmpty { return message }
        if let message = object["error"] as? String, !message.isEmpty { return message }
        if let error = object["error"] as? [String: Any],
            let message = error["message"] as? String, !message.isEmpty
        { return message }
        return nil
    }
}

private struct UploadResponseWire: Decodable {
    struct Attachment: Decodable {
        let id: String
        let fileName: String
    }

    let attachment: Attachment
}

private struct RenameRequestWire: Encodable {
    let fileName: String
}
