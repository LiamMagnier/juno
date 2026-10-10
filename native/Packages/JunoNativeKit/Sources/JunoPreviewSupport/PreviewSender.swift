#if DEBUG
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoSync

/// A request sender for the UI Preview harness that performs **no real
/// network I/O**. It returns canned in-process responses (or fails, for the
/// offline/error scenarios) so the real screens exercise their real code paths
/// against local fixtures. It holds no URLSession, no token, and no transport.
public actor PreviewSender: NativeChatRequestSending {
    private let fails: Bool
    /// Whether the account has no content. Work's fixtures are served from here
    /// rather than seeded into the repository, because Work is a relay-backed
    /// product with no local store — so "empty" has to be answered by the
    /// transport the same way the server would answer it.
    private let empty: Bool
    private(set) public var sentRequestCount = 0
    private(set) public var streamRequestCount = 0

    public init(networkFails: Bool, empty: Bool = false) {
        self.fails = networkFails
        self.empty = empty
    }

    public func send(
        _ request: NativeBearerRequest,
        for _: AccountID
    ) async throws -> HTTPResponse {
        sentRequestCount += 1
        if fails { throw URLError(.notConnectedToInternet) }
        if request.path.hasPrefix("/api/work/artifacts/") && request.path.hasSuffix("/download") {
            return HTTPResponse(
                statusCode: 200,
                headers: try HTTPHeaders([
                    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "content-length": String(PreviewWorkFixtures.artifactDownloadBytes.count),
                    "x-juno-artifact-version": "2",
                    "x-juno-validated": "true",
                ]),
                body: PreviewWorkFixtures.artifactDownloadBytes
            )
        }
        // The semantic artifacts' detail, history, copy, download and
        // Recently deleted (`PreviewArtifactFixtures`).
        if let response = PreviewArtifactFixtures.response(for: request) {
            return response
        }
        // A design's picture, as the transcript's inline design card asks for
        // it: the server's SVG export of the stored document.
        if request.path == "/api/design/art-design/export" {
            let svg = Data(PreviewFixtures.designSVG.utf8)
            return HTTPResponse(
                statusCode: 200,
                headers: try HTTPHeaders([
                    "content-type": "image/svg+xml",
                    "content-length": String(svg.count),
                ]),
                body: svg
            )
        }
        // The transcript's pictures. A real PNG so the row's decode path runs.
        // An attachment's signed location, as the Library asks for it before
        // drawing a thumbnail: every id points at `/api/files/<id>` below,
        // which answers with real bytes where a fixture draws them.
        if request.path == "/api/v1/entities",
            request.queryItems.first(where: { $0.name == "type" })?.value == "attachment",
            let ids = request.queryItems.first(where: { $0.name == "ids" })?.value
        {
            let items = ids.split(separator: ",").map { id in
                #"{"type":"attachment","id":"\#(id)","revision":2,"deletedAt":null,"data":{"id":"\#(id)","url":"/api/files/\#(id)"}}"#
            }
            let body = Data(#"{"entities":[\#(items.joined(separator: ","))]}"#.utf8)
            return HTTPResponse(
                statusCode: 200,
                headers: try HTTPHeaders(["content-type": "application/json"]),
                body: body
            )
        }
        // `/api/files/<id>` too: the Library's thumbnails fetch through the
        // attachment's own `url`, which the showcase points here.
        if request.path.hasPrefix("/api/attachments/") || request.path.hasPrefix("/api/files/") {
            let id = String(request.path.split(separator: "/").last ?? "")
            if id == PreviewImageFixtures.generatedAudioID {
                let wav = PreviewAudioFixtures.wav
                return HTTPResponse(
                    statusCode: 200,
                    headers: try HTTPHeaders([
                        "content-type": "audio/wav",
                        "content-length": String(wav.count),
                    ]),
                    body: wav
                )
            }
            if let png = PreviewImageFixtures.png(for: id) {
                return HTTPResponse(
                    statusCode: 200,
                    headers: try HTTPHeaders([
                        "content-type": "image/png",
                        "content-length": String(png.count),
                    ]),
                    body: png
                )
            }
            if let document = PreviewDocumentFixtures.document(for: id) {
                return HTTPResponse(
                    statusCode: 200,
                    headers: try HTTPHeaders([
                        "content-type": document.contentType,
                        "content-length": String(document.data.count),
                    ]),
                    body: document.data
                )
            }
            return HTTPResponse(
                statusCode: 404,
                headers: try HTTPHeaders(["content-type": "application/json"]),
                body: Data(#"{"error":"Image not found."}"#.utf8)
            )
        }
        if let research = PreviewResearchRunFixtures.body(for: request) {
            return HTTPResponse(
                statusCode: 200,
                headers: try HTTPHeaders(["content-type": "application/json"]),
                body: research
            )
        }
        if let appended = PreviewChatStream.appendResponse(for: request) {
            return HTTPResponse(
                statusCode: 200,
                headers: try HTTPHeaders(["content-type": "application/json"]),
                body: appended
            )
        }
        return HTTPResponse(
            statusCode: 200,
            headers: try HTTPHeaders(["content-type": "application/json"]),
            body: cannedBody(for: request)
        )
    }

    public func stream(
        _ request: NativeBearerRequest,
        for _: AccountID
    ) async throws -> HTTPByteStreamResponse {
        streamRequestCount += 1
        if fails { throw URLError(.notConnectedToInternet) }
        if let generated = PreviewChatStream.generateBytes(for: request) {
            return HTTPByteStreamResponse(
                statusCode: 200,
                headers: try HTTPHeaders(["content-type": "text/event-stream"]),
                bytes: generated
            )
        }
        if let paced = PreviewChatStream.bytes(for: request) {
            return HTTPByteStreamResponse(
                statusCode: 200,
                headers: try HTTPHeaders(["content-type": "text/event-stream"]),
                bytes: paced
            )
        }
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: try HTTPHeaders(["content-type": "text/event-stream"]),
            bytes: Self.heldChatStream(for: request) ?? streamBytes(for: request.path)
        )
    }

    /// `--juno-preview-hold-stream`: a chat reply that is mid-answer and stays
    /// that way — its reasoning, the first lines of its answer, then an open
    /// stream — so the working state can be looked at instead of raced.
    private nonisolated static func heldChatStream(
        for request: NativeBearerRequest
    ) -> AsyncThrowingStream<UInt8, any Error>? {
        guard CommandLine.arguments.contains("--juno-preview-hold-stream"),
              request.path == "/api/chat"
        else { return nil }
        func frame(_ object: [String: Any]) -> [UInt8] {
            let json = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
            return Array("data: ".utf8) + Array(json) + Array("\n\n".utf8)
        }
        let answerStarts = CommandLine.arguments.contains("--juno-preview-hold-answer")
        return AsyncThrowingStream { continuation in
            Task {
                // No `meta` frame: the conversation is the one the turn was
                // sent in, and a frame naming another would be refused.
                for part in [
                    "Three angles: the date, the one feature people asked for most, and a quiet promise. ",
                    "Keep each under 45 characters so it survives a phone's preview.",
                ] {
                    try? await Task.sleep(for: .milliseconds(300))
                    for byte in frame(["type": "reasoning", "text": part]) { continuation.yield(byte) }
                }
                guard answerStarts else { return }
                for part in [
                    "Here are three, from plainest to boldest:\n\n",
                    "1. **Field Notes 2.0 is here** — the notes app you asked for\n",
                    "2. **Your notes, finally searchable**",
                ] {
                    try? await Task.sleep(for: .milliseconds(400))
                    for byte in frame(["type": "delta", "text": part]) { continuation.yield(byte) }
                }
                // Never finished: the reply is still being written.
            }
        }
    }

    /// The bytes a stream request gets.
    ///
    /// Everything except a live Work task hands back an immediately-finished
    /// stream, which is what the harness has always done and what keeps a chat
    /// or change stream from hanging.
    ///
    /// A Work task that is *not* terminal is the exception, and it has to be:
    /// `NativeWorkModel.follow` reconnects as soon as a stream ends and only
    /// stops when the task reaches a terminal status. Finishing the stream for a
    /// running task therefore puts the model into a 200ms reconnect loop that
    /// burns a core for as long as the window is open — during which every
    /// screenshot is taken against a view that is being rebuilt underneath it.
    /// Holding the stream open is also the more faithful fixture: a running task
    /// really does have a stream that has not ended.
    private nonisolated func streamBytes(for path: String) -> AsyncThrowingStream<UInt8, any Error> {
        if path.hasPrefix("/api/code/tasks/"), path.hasSuffix("/events") {
            return codeStreamBytes(taskID: PreviewCodeFixtures.taskID(in: path) ?? "")
        }
        guard path.hasPrefix("/api/work/sessions/"), path.hasSuffix("/events"),
            PreviewWorkFixtures.liveSessionIDs.contains(Self.workSessionID(in: path) ?? "")
        else {
            return AsyncThrowingStream { $0.finish() }
        }
        // Deliberately never finished. The consuming task is cancelled when the
        // model closes the stream, which terminates this one with it.
        return AsyncThrowingStream { _ in }
    }

    /// One Juno Code task's log, as the SSE bytes the real route would write.
    ///
    /// The whole backlog arrives in a single `snapshot` frame, which is what the
    /// server sends on every connect. A terminal task's stream then ends, exactly
    /// as it does in production; a live one is held open for the same reason
    /// Work's is — `NativeCodeModel.follow` reconnects the instant a stream
    /// finishes and only stops at a terminal status, so a finished stream on a
    /// running task is a reconnect loop under every screenshot.
    private nonisolated func codeStreamBytes(
        taskID: String
    ) -> AsyncThrowingStream<UInt8, any Error> {
        guard let frame = PreviewCodeFixtures.snapshotFrame(taskID: taskID) else {
            return AsyncThrowingStream { $0.finish() }
        }
        let live = PreviewCodeFixtures.liveTaskIDs.contains(taskID)
        return AsyncThrowingStream { continuation in
            for byte in frame { continuation.yield(byte) }
            if !live { continuation.finish() }
        }
    }

    /// `wk-invoices` out of `/api/work/sessions/wk-invoices/events`.
    private nonisolated static func workSessionID(in path: String) -> String? {
        let parts = path.split(separator: "/")
        guard parts.count >= 4, parts[0] == "api", parts[1] == "work", parts[2] == "sessions"
        else { return nil }
        return String(parts[3])
    }

    /// Minimal, valid canned bodies keyed by path so any incidental call from a
    /// real code path decodes cleanly. Never fetched from a server.
    private func cannedBody(for request: NativeBearerRequest) -> Data {
        let path = request.path
        if let body = PreviewShowcaseServer.body(path: path, method: request.method.rawValue, query: request.queryItems) {
            return body
        }
        if let body = PreviewPracticeFixtures.body(for: request) {
            return body
        }
        // A question appended to a saved chat before its reply streams: the
        // route echoes the turn back with the id it stored it under.
        if request.method == .post, path.hasPrefix("/api/conversations/"), path.hasSuffix("/messages"),
           let body = request.body.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
           let turn = (body["turns"] as? [[String: Any]])?.first,
           let clientID = turn["clientId"] as? String
        {
            let conversationID = String(path.dropFirst("/api/conversations/".count).dropLast("/messages".count))
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let reply: [String: Any] = [
                "conversationId": conversationID,
                "messages": [[
                    "clientId": clientID, "id": "msg-\(clientID)", "role": "USER",
                    "content": turn["content"] as? String ?? "", "createdAt": formatter.string(from: Date()),
                ]],
            ]
            return (try? JSONSerialization.data(withJSONObject: reply)) ?? Data()
        }
        // Code first, and by request rather than by path alone: `/api/code/tasks`
        // is the session list on GET and creates a run on POST, and a list handed
        // to a create is refused by the wrapper decoder that reads it.
        if let body = PreviewCodeFixtures.body(
            path: path, method: request.method, empty: empty
        ) {
            return body
        }
        // Profile, @username and the Mac's billing extras.
        if let body = PreviewProfileFixtures.body(for: request, empty: empty) {
            return body
        }
        // Memory, Skills and Assistants (Phase 4 Stage B): the pages' own
        // wire shapes, ahead of the generic memory answer below.
        if let body = PreviewAccountPageFixtures.body(path: path, method: request.method, empty: empty) {
            return body
        }
        if let body = PreviewProjectFolderFixtures.body(path: path, method: request.method) {
            return body
        }
        // The iPhone's parity screens: inbox, announcement, server search,
        // sign-in security and Routines.
        if let body = PreviewParityFixtures.body(
            path: path, method: request.method, query: request.queryItems, empty: empty
        ) {
            return body
        }
        if path == "/api/voice/relay-token" {
            // A deliberately closed local port: enough to exercise the real
            // Voice authorization and typed relay-recovery UI, with no network
            // access and no fake provider response.
            return Data(#"{"token":"preview-voice-token","url":"ws://127.0.0.1:9"}"#.utf8)
        }
        if path == "/api/work/artifacts" {
            return PreviewWorkFixtures.artifactsBody(sessionID: PreviewWorkFixtures.openSessionID)
        }
        if path.hasPrefix("/api/work/artifacts/") {
            return PreviewWorkFixtures.artifactDetailBody(id: "art-exceptions")
        }
        if path.hasPrefix("/api/work/hosts") {
            return PreviewWorkFixtures.hostsBody(empty: empty)
        }
        // Both before the session route, which matches the same prefix and would
        // otherwise answer a start with a session and a message with a task
        // list — bodies whose own decoders correctly refuse them.
        if path.hasPrefix("/api/work/sessions"), path.hasSuffix("/runs") {
            return PreviewWorkFixtures.startedRunBody(
                sessionID: Self.workSessionID(in: path) ?? PreviewWorkFixtures.openSessionID
            )
        }
        if path.hasPrefix("/api/work/sessions"), path.hasSuffix("/answer") {
            return PreviewWorkFixtures.instructionOutcomeBody
        }
        if path.hasPrefix("/api/work/sessions") {
            if let sessionID = Self.workSessionID(in: path) {
                return PreviewWorkFixtures.sessionBody(id: sessionID, empty: empty)
            }
            // The product shots' chats carry no tasks: a task card in Maya's
            // launch plan would be a fixture showing through a story.
            if CommandLine.arguments.contains("showcase"),
               request.queryItems.contains(where: { $0.name == "conversationId" })
            {
                return PreviewWorkFixtures.sessionsBody(empty: true)
            }
            return PreviewWorkFixtures.sessionsBody(empty: empty)
        }
        if path.hasPrefix("/api/tasks") {
            return Data(#"{"tasks":[{"id":"task-1","name":"Daily market pulse","prompt":"Summarise key European indices and overnight macro moves.","model":"google:gemini-3.7-flash","modelName":"Gemini 3.7 Flash","cadence":"DAILY","hour":8,"minute":30,"weekday":null,"monthday":null,"timezone":"Europe/Paris","webSearch":true,"enabled":true,"lastRunAt":"2026-08-20T06:30:00Z","nextRunAt":"2026-08-21T06:30:00Z","conversationId":null,"latestRun":{"id":"run-1","status":"done","error":null,"costMicroUsd":1200,"startedAt":"2026-08-20T06:30:00Z","finishedAt":"2026-08-20T06:30:05Z"}}],"limit":10}"#.utf8)
        }
        if path.hasPrefix("/api/connectors") {
            return Data(#"{"connectors":[{"id":"github","kind":"oauth_app","label":"GitHub","description":"Pull requests, issues, and code browsing.","configured":true,"connected":true,"accountLabel":"LiamMagnier"},{"id":"notion","kind":"oauth_app","label":"Notion","description":"Search and read pages across your workspace.","configured":true,"connected":false,"accountLabel":null}],"composioConfigured":false}"#.utf8)
        }
        if path.contains("/memory") {
            return Data(#"{"memories":[],"summary":null}"#.utf8)
        }
        if path == "/api/library/made" {
            return Self.libraryMadeBody(empty: empty)
        }
        if path.hasPrefix("/api/library") {
            return Data(#"{"items":[],"attachments":[]}"#.utf8)
        }
        if path.contains("/mutations") {
            return Data(#"{"entity":{"id":"preview","revision":1},"entityMappings":{}}"#.utf8)
        }
        if path.hasSuffix("/models") {
            return Data(PreviewModelCatalog.json.utf8)
        }
        // Revoking a paired computer in the harness: the browser model only
        // requires a 2xx, so the fixture confirms without modelling a server
        // row — the row removal itself is the model's local convergence, which
        // is what the screenshot exercises.
        if path.hasPrefix("/api/v1/code/devices/"), request.method == .delete {
            return Data(#"{"revoked":true,"deviceId":"preview"}"#.utf8)
        }
        return Data("{}".utf8)
    }
}

extension PreviewSender {
    /// What Alevr made (`GET /api/library/made`): artifacts and task
    /// deliverables, one made by an Orbit member, newest first.
    static func libraryMadeBody(empty: Bool) -> Data {
        if empty { return Data(#"{"items":[],"nextCursor":null}"#.utf8) }
        return Data(#"""
        {"items":[
          {"kind":"artifact","id":"art-launch","type":"HTML","title":"Field Notes 2.0 launch page","version":4,"projectId":null,
           "createdAt":"2026-10-07T09:00:00Z","updatedAt":"2026-10-08T08:10:00Z","href":"/a/art-launch","conversationId":"conv-launch"},
          {"kind":"deliverable","id":"art-exceptions","type":"SPREADSHEET","title":"Q3 pricing model","version":2,"projectId":null,
           "createdAt":"2026-10-06T09:00:00Z","updatedAt":"2026-10-07T16:40:00Z","href":"/api/work/artifacts/art-exceptions/download",
           "conversationId":null,"mimeType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","validated":true,
           "agent":{"id":"agent-mira","name":"Mira"}},
          {"kind":"deliverable","id":"del-deck","type":"PRESENTATION","title":"Board update, October","version":1,"projectId":null,
           "createdAt":"2026-10-05T09:00:00Z","updatedAt":"2026-10-05T11:00:00Z","href":"/api/work/artifacts/del-deck/download",
           "conversationId":null,"mimeType":"application/vnd.openxmlformats-officedocument.presentationml.presentation","validated":true},
          {"kind":"artifact","id":"art-flow","type":"MERMAID","title":"Onboarding flow","version":1,"projectId":null,
           "createdAt":"2026-10-02T09:00:00Z","updatedAt":"2026-10-02T09:30:00Z","href":"/a/art-flow","conversationId":null},
          {"kind":"deliverable","id":"del-brief","type":"DOCUMENT","title":"Competitive brief: note-taking apps","version":3,"projectId":null,
           "createdAt":"2026-09-28T09:00:00Z","updatedAt":"2026-09-30T10:00:00Z","href":"/api/work/artifacts/del-brief/download",
           "conversationId":null,"mimeType":"application/vnd.openxmlformats-officedocument.wordprocessingml.document","validated":true}
        ],"nextCursor":null}
        """#.utf8)
    }
}

/// A synthetic model manifest in the exact v1 wire shape, covering every state
/// the pickers have to render: Auto, a full reasoning ladder, a restricted
/// two-tier model, an on/off model, a model with no reasoning at all, a
/// plan-gated model, a coming-soon model, and a deliberately long name. It
/// exists so those states can be inspected without an account or a network.
public enum PreviewModelCatalog {
    public static let json = """
    {
      "manifestVersion": "v1-preview",
      "contractDigest": "\(String(repeating: "a", count: 64))",
      "generatedAt": "2026-07-20T12:00:00.000Z",
      "models": [
        \(model(
            id: "juno:auto", provider: "juno", providerName: "Juno", name: "Auto",
            description: "Picks the cheapest model and thinking depth that can handle each prompt.",
            highlights: [
                "Short or simple asks go to budget models, answered instantly.",
                "Coding and analysis go to the mid tier with light thinking.",
                "Hard reasoning goes to a flagship with deep thinking.",
            ],
            context: nil, cost: nil, speed: nil, intelligence: nil,
            efforts: [], canDisable: true, reasoning: true, automatic: true
        )),
        \(model(
            id: "anthropic:claude-opus-4-8", provider: "anthropic",
            providerName: "Anthropic · Claude", name: "Claude Opus 4.8",
            description: "Anthropic's most capable model for deep reasoning and long agentic work.",
            context: 500_000, cost: "premium", speed: 3, intelligence: 10,
            efforts: ["low", "medium", "high", "xhigh", "max"], canDisable: true, reasoning: true,
            // The one Anthropic model with a real fast tier, so the preview
            // harness actually renders a Flash toggle. It stamped every model
            // with no modes at all, which would have let a screenshot review
            // report "no regression" for a feature that never drew.
            fastRateMultiplier: 2
        )),
        \(model(
            id: "anthropic:claude-haiku-4-5", provider: "anthropic",
            providerName: "Anthropic · Claude", name: "Claude Haiku 4.5",
            description: "Fast and cheap, with a single thinking mode rather than depths.",
            context: 200_000, cost: "economy", speed: 9, intelligence: 6,
            efforts: [], canDisable: true, reasoning: true, onOffOnly: true
        )),
        \(model(
            id: "openai:gpt-5-6", provider: "openai", providerName: "OpenAI · GPT",
            name: "GPT-5.6",
            description: "OpenAI's flagship with a six-step effort ladder.",
            context: 400_000, cost: "standard", speed: 6, intelligence: 9,
            efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
            canDisable: true, reasoning: true,
            // The only line with all three speed and depth modes, so the
            // preview shows Fast, Ultra fast and Pro side by side — the
            // layout most likely to clip.
            proMode: true, fastRateMultiplier: 2, ultraFastRateMultiplier: 6
        )),
        \(model(
            id: "openai:gpt-5-4-pro", provider: "openai", providerName: "OpenAI · GPT",
            name: "GPT-5.4 Pro",
            description: "Always reasons; only the deeper half of the ladder is available.",
            context: 400_000, cost: "premium", speed: 2, intelligence: 10,
            efforts: ["medium", "high", "xhigh"], canDisable: false, reasoning: true,
            legacy: true, released: "2026-03"
        )),
        \(model(
            id: "google:gemini-3-flash", provider: "google", providerName: "Google · Gemini",
            name: "Gemini 3 Flash",
            description: "A quick non-reasoning model for everyday questions.",
            context: 1_000_000, cost: "economy", speed: 10, intelligence: 6,
            efforts: [], canDisable: true, reasoning: false,
            legacy: true, released: "2025-12"
        )),
        \(model(
            id: "moonshot:kimi-k3", provider: "moonshot", providerName: "Moonshot · Kimi",
            name: "Kimi K3",
            description: "Moonshot's flagship — a 2.5T-parameter reasoner with 1M context.",
            context: 1_000_000, cost: "premium", speed: 2, intelligence: 10,
            efforts: ["low", "high", "max"], canDisable: false, reasoning: true
        )),
        \(model(
            id: "xai:grok-5", provider: "xai", providerName: "xAI · Grok", name: "Grok 5",
            description: "Plan-gated in this fixture so the locked state can be inspected.",
            context: 256_000, cost: "premium", speed: 5, intelligence: 9,
            efforts: ["low", "high"], canDisable: true, reasoning: true,
            availability: "requires_plan", requiredPlan: "max"
        )),
        \(model(
            id: "meta:llama-5-405b-instruct-preview", provider: "meta",
            providerName: "Meta · Llama",
            name: "Llama 5 405B Instruct Preview (Research Release)",
            description: "A deliberately long name, for truncation behaviour.",
            context: 128_000, cost: "standard", speed: 4, intelligence: 8,
            efforts: [], canDisable: true, reasoning: false,
            legacy: true, released: "2025-10"
        )),
        \(model(
            id: "mistral:mistral-large-3", provider: "mistral",
            providerName: "Mistral · Le Chat", name: "Mistral Large 3",
            description: "Announced but not yet callable.",
            context: 256_000, cost: "standard", speed: 7, intelligence: 7,
            efforts: [], canDisable: true, reasoning: false,
            availability: "coming_soon"
        )),
        \(model(
            id: "deepseek:deepseek-v4", provider: "deepseek", providerName: "DeepSeek",
            name: "DeepSeek V4",
            description: "An open-weight reasoner.",
            context: 128_000, cost: "economy", speed: 6, intelligence: 8,
            efforts: ["low", "medium", "high"], canDisable: true, reasoning: true
        )),
        \(model(
            id: "openai:gpt-image-2.5-sunburst", provider: "openai", providerName: "OpenAI · GPT",
            name: "GPT Image 2.5 Sunburst",
            description: "Precision-first: the highest quality and the most control over an edit.",
            context: nil, cost: nil, efforts: [], canDisable: true, reasoning: false,
            modality: "image"
        )),
        \(model(
            id: "openai:gpt-image-2.5-flare", provider: "openai", providerName: "OpenAI · GPT",
            name: "GPT Image 2.5 Flare",
            description: "The everyday default: GPT Image 2 quality at half the latency.",
            context: nil, cost: nil, efforts: [], canDisable: true, reasoning: false,
            modality: "image"
        )),
        \(model(
            id: "google:gemini-nano-banana-2.1", provider: "google", providerName: "Google · Gemini",
            name: "Nano Banana 2.1",
            description: "Sharper text and layouts, 1K to 4K, up to 14 references.",
            context: nil, cost: nil, efforts: [], canDisable: true, reasoning: false,
            modality: "image"
        )),
        \(model(
            id: "xai:grok-imagine-image-2.0", provider: "xai", providerName: "xAI · Grok",
            name: "Grok Imagine 2.0",
            description: "xAI's latest image generation and editing model.",
            context: nil, cost: nil, efforts: [], canDisable: true, reasoning: false,
            modality: "image"
        )),
        \(model(
            id: "google:gemini-omni-1.1-flash", provider: "google", providerName: "Google · Gemini",
            name: "Gemini Omni Flash",
            description: "Short clips with sound, from a prompt or a still.",
            context: nil, cost: nil, efforts: [], canDisable: true, reasoning: false,
            modality: "video"
        )),
        \(model(
            id: "google:veo-3.1-generate-preview", provider: "google", providerName: "Google · Gemini",
            name: "Veo 3.1",
            description: "Cinematic clips with native sound, up to 4K.",
            context: nil, cost: nil, efforts: [], canDisable: true, reasoning: false,
            modality: "video"
        )),
        \(model(
            id: "google:lyria-3.5", provider: "google", providerName: "Google · Gemini",
            name: "Lyria 3.5",
            description: "Full songs with vocals or instrumentals, from a prompt.",
            context: nil, cost: nil, efforts: [], canDisable: true, reasoning: false,
            modality: "audio"
        ))
      ]
    }
    """

    // swiftlint:disable:next function_parameter_count
    private static func model(
        id: String,
        provider: String,
        providerName: String,
        name: String,
        description: String,
        highlights: [String] = [],
        context: Int?,
        cost: String?,
        speed: Int? = nil,
        intelligence: Int? = nil,
        efforts: [String],
        canDisable: Bool,
        reasoning: Bool,
        onOffOnly: Bool = false,
        automatic: Bool = false,
        availability: String = "available",
        requiredPlan: String = "free",
        modality: String = "chat",
        legacy: Bool = false,
        released: String? = nil,
        proMode: Bool = false,
        fastRateMultiplier: Double? = nil,
        ultraFastRateMultiplier: Double? = nil
    ) -> String {
        let highlightsJSON = highlights.isEmpty
            ? "null"
            : "[" + highlights.map { "\"\($0)\"" }.joined(separator: ",") + "]"
        let pricing = cost.map {
            """
            {"class":"\($0)","inputPerMillion":3,"outputPerMillion":15,"currency":"USD","source":"official"}
            """
        } ?? "null"
        let metrics = (speed != nil && intelligence != nil)
            ? "{\"speed\":\(speed!),\"intelligence\":\(intelligence!)}"
            : "null"
        return """
        {
          "id": "\(id)",
          "provider": {"id":"\(provider)","displayName":"\(providerName)"},
          "displayName": "\(name)",
          "description": "\(description)",
          "highlights": \(highlightsJSON),
          "lifecycle": "\(legacy ? "legacy" : "active")",
          "modality": "\(modality)",
          "legacy": \(legacy),
          "released": \(released.map { "\"\($0)\"" } ?? "null"),
          "availability": "\(availability)",
          "minimumPlan": "free",
          "requiredPlan": "\(requiredPlan)",
          "modalities": {"input":["text","image"],"output":["text"]},
          "contextWindowTokens": \(context.map(String.init) ?? "null"),
          "pricing": \(pricing),
          "metrics": \(metrics),
          "supportedReasoningEfforts": [\(efforts.map { "\"\($0)\"" }.joined(separator: ","))],
          "reasoning": {
            "supported": \(reasoning), "canDisable": \(canDisable),
            "onOffOnly": \(onOffOnly), "supportsProMode": \(proMode), "automatic": \(automatic)
          },
          "capabilities": {
            "tools": true, "vision": true, "webSearch": true,
            "attachments": true, "streaming": \(modality == "chat")
          },
          "fastMode": \(fastRateMultiplier.map { "{\"rateMultiplier\": \($0)}" } ?? "null"),
          "ultraFastMode": \(ultraFastRateMultiplier.map { "{\"rateMultiplier\": \($0)}" } ?? "null"),
          "deprecationNote": null,
          "mediaParams": \(PreviewMediaParams.json[id] ?? "null")
        }
        """
    }
}
#endif
