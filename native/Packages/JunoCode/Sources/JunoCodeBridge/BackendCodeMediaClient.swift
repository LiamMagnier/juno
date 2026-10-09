import Foundation
import JunoAPI
import JunoAuth
import JunoCodeRuntime
import JunoCore
import JunoSync

/// Authenticated adapter for Code's media tools (`generate_image`,
/// `generate_video`, `generate_audio`). It calls Alevr's own generation route,
/// `POST /api/generate`, which meters the generation on the reader's plan and
/// keeps every provider key on the server, then downloads the finished files
/// through the owner-checked `/api/files` route.
///
/// The route files each generation in the reader's Library as a conversation
/// of its own, as a generation from Chat would be: the reader can find what the
/// agent made, and the Code session keeps only the saved file.
public struct BackendCodeMediaClient: CodeMediaGenerating {
    private let sender: any NativeAuthenticatedRequestSending
    private let accountID: AccountID
    private let chooseModel: @Sendable (CodeMediaKind) -> String?

    /// `chooseModel` answers Settings › Generation models (see
    /// `CodeGenerationModels.resolved`).
    public init(
        sender: any NativeAuthenticatedRequestSending,
        accountID: AccountID,
        chooseModel: @escaping @Sendable (CodeMediaKind) -> String?
    ) {
        self.sender = sender
        self.accountID = accountID
        self.chooseModel = chooseModel
    }

    public func model(for kind: CodeMediaKind) -> String? { chooseModel(kind) }

    public func generate(kind _: CodeMediaKind, prompt: String, model: String) async throws -> [CodeGeneratedFile] {
        let body = try JSONEncoder().encode(GenerateRequest(prompt: prompt, model: model))
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/generate",
                method: .post,
                headers: HTTPHeaders([
                    "Accept": "text/event-stream",
                    "Content-Type": "application/json",
                ]),
                body: body
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorWire.self, from: response.body))?.error
                ?? "Alevr's generation service returned HTTP \(response.statusCode)."
            throw BackendCodeMediaError.server(statusCode: response.statusCode, message: message)
        }
        let attachments = try Self.finishedAttachments(in: response.body)
        var files: [CodeGeneratedFile] = []
        for attachment in attachments {
            files.append(try await download(attachment))
        }
        return files
    }

    /// The files the stream's `done` chunk carries, or the stream's error.
    static func finishedAttachments(in body: Data) throws -> [Attachment] {
        let text = String(decoding: body, as: UTF8.self)
        var lastError: String?
        for line in text.split(whereSeparator: \.isNewline) where line.hasPrefix("data:") {
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard let data = payload.data(using: .utf8),
                  let chunk = try? JSONDecoder().decode(Chunk.self, from: data) else { continue }
            switch chunk.type {
            case "done":
                let attachments = chunk.message?.attachments ?? []
                guard !attachments.isEmpty else { throw BackendCodeMediaError.malformedResponse }
                return attachments
            case "error":
                lastError = chunk.message?.text ?? chunk.errorMessage
            default:
                continue
            }
        }
        if let lastError { throw BackendCodeMediaError.generationFailed(lastError) }
        throw BackendCodeMediaError.malformedResponse
    }

    private func download(_ attachment: Attachment) async throws -> CodeGeneratedFile {
        // Only the owner-checked file route, never an arbitrary URL from the
        // stream: the bearer token goes nowhere else.
        guard attachment.url.hasPrefix("/api/files/") else { throw BackendCodeMediaError.malformedResponse }
        let response = try await sender.send(try NativeBearerRequest(path: attachment.url), for: accountID)
        guard (200...299).contains(response.statusCode), !response.body.isEmpty else {
            throw BackendCodeMediaError.server(statusCode: response.statusCode, message: "Could not download \(attachment.fileName).")
        }
        return CodeGeneratedFile(fileName: attachment.fileName, mimeType: attachment.mimeType, data: response.body)
    }

    struct Attachment: Decodable, Equatable {
        let fileName: String
        let mimeType: String
        let url: String
    }

    private struct Chunk: Decodable {
        let type: String
        let message: Message?
        let errorMessage: String?

        struct Message: Decodable {
            let attachments: [Attachment]?
            let text: String?
        }

        enum CodingKeys: String, CodingKey { case type, message }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            type = try container.decode(String.self, forKey: .type)
            // `done` carries a message object, `error` a plain string.
            if let text = try? container.decode(String.self, forKey: .message) {
                message = nil
                errorMessage = text
            } else {
                message = try? container.decode(Message.self, forKey: .message)
                errorMessage = nil
            }
        }
    }

    private struct GenerateRequest: Encodable {
        let prompt: String
        let model: String
    }

    private struct ErrorWire: Decodable {
        let error: String?
    }
}

public enum BackendCodeMediaError: Error, Equatable, LocalizedError, Sendable {
    case server(statusCode: Int, message: String)
    case generationFailed(String)
    case malformedResponse

    public var errorDescription: String? {
        switch self {
        case let .server(_, message): message
        case let .generationFailed(message): message
        case .malformedResponse: "Alevr returned an unexpected generation response."
        }
    }
}
