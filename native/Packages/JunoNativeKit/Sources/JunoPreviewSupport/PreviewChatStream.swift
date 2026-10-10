#if DEBUG
import Foundation
import JunoAPI
import JunoAuth

/// A chat turn the harness can actually *watch*: the question is stored and
/// the reply streams in at a reader's pace — a few seconds of thinking, then
/// the answer a few words at a time — and the stream is held open at the end,
/// so a screenshot can land on the thinking row or mid-answer with Stop up.
///
/// Off unless the launch asked for a turn (`--juno-preview-send <prompt>`).
/// Every other harness run keeps the old behaviour — a chat stream that ends at
/// once — so nothing that previews a finished transcript starts streaming.
enum PreviewChatStream {
    static var isEnabled: Bool {
        CommandLine.arguments.contains("--juno-preview-send")
    }

    /// `POST /api/conversations/<id>/messages`: echoes the appended question
    /// in the route's shape, so the send path stores it and moves on to `/api/chat`.
    static func appendResponse(for request: NativeBearerRequest) -> Data? {
        guard isEnabled, request.method == .post,
            request.path.hasPrefix("/api/conversations/"), request.path.hasSuffix("/messages"),
            let body = request.body,
            let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let turn = (object["turns"] as? [[String: Any]])?.first,
            let clientID = turn["clientId"] as? String
        else { return nil }
        let conversationID = request.path
            .dropFirst("/api/conversations/".count)
            .dropLast("/messages".count)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let response: [String: Any] = [
            "conversationId": String(conversationID),
            "messages": [[
                "clientId": clientID,
                "id": "preview-user-\(clientID.prefix(8))",
                "role": "USER",
                "content": turn["content"] as? String ?? "",
                "createdAt": formatter.string(from: Date()),
            ]],
        ]
        return try? JSONSerialization.data(withJSONObject: response)
    }

    /// `POST /api/chat`: `meta`, then reasoning for about four seconds, then the
    /// answer three words at a time. Never `done` — the turn stays live.
    static func bytes(for request: NativeBearerRequest) -> AsyncThrowingStream<UInt8, any Error>? {
        guard isEnabled, request.method == .post, request.path == "/api/chat" else { return nil }
        let conversationID = request.body
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["conversationId"]
            as? String ?? "preview-stream"
        return AsyncThrowingStream { continuation in
            let task = Task {
                func frame(_ object: [String: Any]) {
                    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
                    for byte in Array("data: ".utf8) + Array(data) + Array("\n\n".utf8) {
                        continuation.yield(byte)
                    }
                }
                frame(["type": "meta", "conversationId": conversationID, "title": ""])
                for sentence in PreviewShowcaseFixtures.streamedReasoning.split(separator: ".") {
                    try? await Task.sleep(for: .milliseconds(900))
                    frame(["type": "reasoning", "text": String(sentence) + ".", "part": 0, "round": 0])
                }
                // `--juno-preview-stream-hold thinking` stops here, so the
                // thinking row can be captured without racing the clock.
                if CommandLine.arguments.contains("thinking"),
                    CommandLine.arguments.contains("--juno-preview-stream-hold")
                {
                    return
                }
                try? await Task.sleep(for: .milliseconds(1_200))
                let words = PreviewShowcaseFixtures.streamedAnswer.split(separator: " ", omittingEmptySubsequences: false)
                var index = 0
                while index < words.count, !Task.isCancelled {
                    let chunk = words[index..<min(index + 3, words.count)].joined(separator: " ")
                    index += 3
                    frame(["type": "delta", "text": chunk + (index < words.count ? " " : ""), "round": 0, "phase": "answer"])
                    try? await Task.sleep(for: .milliseconds(140))
                }
                // Held open: the reply is still "arriving" for as long as the
                // screenshot needs it to be.
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    /// `POST /api/generate`: a picture made in the harness, as the route
    /// streams one — `meta`, `progress` stages, then `done` with the file on
    /// the answer (`PreviewImageFixtures.generatedID`, served at
    /// `/api/files/<id>`). `--juno-preview-generate-hold` stops at the
    /// generating stage so the placeholder can be captured.
    /// A 1K picture's pixels at a ratio ("16:9" → 1536×864), as the fixture draws it.
    static func previewFrame(aspect: String?) -> (Int, Int) {
        let parts = (aspect ?? "").split(separator: ":").compactMap { Double($0) }
        guard parts.count == 2, parts[0] > 0, parts[1] > 0, parts[0] != parts[1] else { return (1024, 1024) }
        let ratio = parts[0] / parts[1]
        let area = 1024.0 * 1024.0
        func round16(_ value: Double) -> Int { max(64, Int((value / 16).rounded()) * 16) }
        return (round16((area * ratio).squareRoot()), round16((area / ratio).squareRoot()))
    }

    static func generateBytes(for request: NativeBearerRequest) -> AsyncThrowingStream<UInt8, any Error>? {
        guard request.method == .post, request.path == "/api/generate" else { return nil }
        let body = request.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let conversationID = body?["conversationId"] as? String ?? "preview-generate"
        let modelID = body?["model"] as? String ?? "openai:gpt-image-2.5-flare"
        let hold = CommandLine.arguments.contains("--juno-preview-generate-hold")
        let requestedAspect = (body?["params"] as? [String: Any])?["aspect"] as? String
        return AsyncThrowingStream { continuation in
            let task = Task {
                func frame(_ object: [String: Any]) {
                    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
                    for byte in Array("data: ".utf8) + Array(data) + Array("\n\n".utf8) {
                        continuation.yield(byte)
                    }
                }
                frame(["type": "meta", "conversationId": conversationID, "title": "", "userMessageId": "preview-gen-user"])
                for (stage, pct) in [("queued", 0.0), ("generating", 0.35), ("generating", 0.7)] {
                    try? await Task.sleep(for: .milliseconds(900))
                    frame(["type": "progress", "stage": stage, "pct": pct])
                }
                if hold { return }
                try? await Task.sleep(for: .milliseconds(900))
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                // What the request asked for: a music model answers with a
                // track (`FILE`, audio/*), a picture model with a picture at
                // the frame its `params.aspect` chose.
                let isAudio = PreviewMediaParams.json[modelID]?.contains(#""kind":"audio""#) == true
                let attachment: [String: Any]
                if isAudio {
                    let id = PreviewImageFixtures.generatedAudioID
                    attachment = [
                        "id": id, "kind": "FILE", "fileName": "evening-drive.wav",
                        "mimeType": "audio/wav", "size": PreviewAudioFixtures.wav.count,
                        "url": "/api/files/\(id)",
                    ]
                } else {
                    let (width, height) = previewFrame(aspect: requestedAspect)
                    let id = width == height ? PreviewImageFixtures.generatedID
                        : PreviewImageFixtures.generatedID(width: width, height: height)
                    attachment = [
                        "id": id, "kind": "IMAGE", "fileName": "generated.png",
                        "mimeType": "image/png", "size": 182_000,
                        "width": width, "height": height, "url": "/api/files/\(id)",
                    ]
                }
                frame([
                    "type": "done",
                    "message": [
                        "id": "preview-gen-answer",
                        "role": "ASSISTANT",
                        "content": isAudio ? "**Evening Drive**\n\nSoft synths over a slow arpeggio, no vocals." : "",
                        "model": modelID,
                        "createdAt": formatter.string(from: Date()),
                        "attachments": [attachment],
                    ],
                ])
                continuation.finish()
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }
}
#endif
