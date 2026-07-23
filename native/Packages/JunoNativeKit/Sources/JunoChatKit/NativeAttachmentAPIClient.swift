import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

public struct NativeUploadedAttachment: Equatable, Sendable, Identifiable {
    public let id: String
    public let fileName: String
    public let mimeType: String
    public let size: Int
    public let kind: String

    public init(id: String, fileName: String, mimeType: String, size: Int, kind: String) {
        self.id = id
        self.fileName = fileName
        self.mimeType = mimeType
        self.size = size
        self.kind = kind
    }

    public var isImage: Bool { kind.uppercased() == "IMAGE" }
}

public enum NativeAttachmentAPIError: Error, Equatable, LocalizedError, Sendable {
    case invalidFileName
    case invalidMIMEType
    case fileTooLarge(maximumBytes: Int)
    case malformedResponse
    case server(statusCode: Int, code: String?, message: String, retryable: Bool)

    public var errorDescription: String? {
        switch self {
        case .invalidFileName: "Enter a valid file name."
        case .invalidMIMEType: "Juno could not determine a safe file type."
        case .fileTooLarge(let maximumBytes):
            "This upload is limited to \(maximumBytes / 1_048_576) MB."
        case .malformedResponse: "Juno returned an invalid upload response."
        case .server(_, _, let message, _): message
        }
    }

    /// Whether trying the same upload again could plausibly succeed. Drives
    /// whether the composer offers Retry, so a 415 must not offer one: the file
    /// will be the same file next time.
    public var isRetryable: Bool {
        if case .server(_, _, _, let retryable) = self { return retryable }
        return false
    }
}

/// Uploads composer attachments through the native `/api/v1/attachments` route.
///
/// The idempotency key is generated once per attachment and reused across every
/// retry of *that* attachment. That is the whole point: a native client retries
/// on a flaky network by design, and a key generated per request would make
/// every retry a fresh upload, leaving duplicates behind exactly when the
/// network is worst.
public struct NativeAttachmentAPIClient: Sendable {
    /// Matches the largest plan ceiling the server enforces. Checked here too so
    /// an obviously oversized file fails instantly instead of after uploading
    /// megabytes to earn a 413.
    public static let maximumUploadBytes = 50 * 1_024 * 1_024

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func upload(
        data: Data,
        fileName: String,
        mimeType: String,
        conversationID: String?,
        idempotencyKey: String,
        for accountID: AccountID
    ) async throws -> NativeUploadedAttachment {
        let safeName = try normalizedFileName(fileName)
        let safeMIME = try normalizedMIMEType(mimeType)
        guard data.count <= Self.maximumUploadBytes else {
            throw NativeAttachmentAPIError.fileTooLarge(
                maximumBytes: Self.maximumUploadBytes
            )
        }

        let boundary = "juno-native-\(UUID().uuidString.lowercased())"
        var body = Data()
        if let conversationID, !conversationID.isEmpty {
            append("--\(boundary)\r\n", to: &body)
            append("Content-Disposition: form-data; name=\"conversationId\"\r\n\r\n", to: &body)
            append("\(conversationID)\r\n", to: &body)
        }
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
                path: "/api/v1/attachments",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "multipart/form-data; boundary=\(boundary)",
                    "idempotency-key": idempotencyKey,
                ]),
                body: body
            ),
            for: accountID
        )

        guard (200...299).contains(response.statusCode) else {
            throw decodeError(response)
        }
        guard let decoded = try? JSONDecoder().decode(
            AttachmentEnvelope.self, from: response.body
        ) else { throw NativeAttachmentAPIError.malformedResponse }

        return NativeUploadedAttachment(
            id: decoded.attachment.id,
            fileName: decoded.attachment.fileName,
            mimeType: decoded.attachment.mimeType,
            size: decoded.attachment.size,
            kind: decoded.attachment.kind
        )
    }

    private func decodeError(_ response: HTTPResponse) -> NativeAttachmentAPIError {
        let envelope = try? JSONDecoder().decode(
            NativeAPIErrorEnvelope.self, from: response.body
        )
        return .server(
            statusCode: response.statusCode,
            code: envelope?.error.code,
            message: envelope?.error.message
                ?? "Juno could not upload this file (\(response.statusCode)).",
            // Trust the server's own verdict when it gives one. A 429 or 503 is
            // worth retrying; a 415 never will be, however many times it is
            // tried.
            retryable: envelope?.error.retryable ?? (500...599).contains(response.statusCode)
        )
    }

    private func normalizedFileName(_ name: String) throws -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        // Quotes and CR/LF would break out of the multipart header they are
        // written into, and path separators have no business in a file name.
        guard !trimmed.isEmpty, trimmed.count <= 200,
            !trimmed.contains("\""), !trimmed.contains("\r"), !trimmed.contains("\n"),
            !trimmed.contains("/"), !trimmed.contains("\\")
        else { throw NativeAttachmentAPIError.invalidFileName }
        return trimmed
    }

    private func normalizedMIMEType(_ mime: String) throws -> String {
        let trimmed = mime.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty, trimmed.count <= 160,
            !trimmed.contains("\r"), !trimmed.contains("\n"),
            trimmed.contains("/")
        else { throw NativeAttachmentAPIError.invalidMIMEType }
        return trimmed
    }

    private func append(_ string: String, to data: inout Data) {
        data.append(Data(string.utf8))
    }
}

private struct AttachmentEnvelope: Decodable {
    let attachment: AttachmentWire

    struct AttachmentWire: Decodable {
        let id: String
        let fileName: String
        let mimeType: String
        let size: Int
        let kind: String
    }
}
