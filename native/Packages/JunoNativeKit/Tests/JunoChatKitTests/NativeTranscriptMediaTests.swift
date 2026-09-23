import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import XCTest

@testable import JunoChatKit

/// The data under the transcript's pictures and file tiles (Phase 2, stage 2):
/// what a caption calls a file and how big it says it is, the file's address
/// surviving the local store, and the loader's promise to ask for a broken
/// thing once.
final class NativeTranscriptMediaTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    // MARK: - formatLabel (the web's `formatLabelOf`)

    func testFormatLabelMatchesTheWebForEveryKind() {
        let table: [(fileName: String, mimeType: String, kind: String, label: String)] = [
            ("quasar-notes.pdf", "application/pdf", "FILE", "PDF"),
            ("scan", "application/pdf", "FILE", "PDF"),
            ("IMG_4821.jpg", "image/jpeg", "IMAGE", "Image"),
            ("poster.webp", "image/webp", "FILE", "Image"),
            ("Rings.mp4", "video/mp4", "FILE", "Video"),
            ("memo.m4a", "audio/mp4", "FILE", "Audio"),
            ("Brief.docx", "application/octet-stream", "FILE", "Word document"),
            ("Brief.docm", "application/octet-stream", "FILE", "Word document"),
            ("Launch plan.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "FILE", "PowerPoint deck"),
            ("Deck.pptm", "application/octet-stream", "FILE", "PowerPoint deck"),
            ("Q3 forecast.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "FILE", "Excel workbook"),
            ("Model.xlsm", "application/octet-stream", "FILE", "Excel workbook"),
            ("notes.odt", "application/vnd.oasis.opendocument.text", "FILE", "OpenDocument text"),
            ("sheet.ods", "application/vnd.oasis.opendocument.spreadsheet", "FILE", "OpenDocument spreadsheet"),
            ("slides.odp", "application/vnd.oasis.opendocument.presentation", "FILE", "OpenDocument presentation"),
            ("letter.rtf", "text/rtf", "FILE", "Rich text"),
            ("README.md", "text/markdown", "FILE", "Markdown"),
            ("signups.csv", "text/csv", "FILE", "CSV"),
            ("export.tsv", "text/tab-separated-values", "FILE", "TSV"),
            ("notes.txt", "text/plain", "FILE", "Text"),
            ("server.log", "text/plain", "FILE", "Text"),
            ("Cache.swift", "text/x-swift", "FILE", "SWIFT"),
            ("config.json", "application/json", "FILE", "JSON"),
            // Office by MIME alone, when the name has no extension.
            ("Report", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "FILE", "Document"),
            ("archive.zip", "application/zip", "FILE", "ZIP"),
            ("blob", "application/octet-stream", "FILE", "File"),
        ]
        for row in table {
            let attachment = NativeChatAttachment(
                id: "a", fileName: row.fileName, mimeType: row.mimeType, kind: row.kind,
                size: 1, width: nil, height: nil
            )
            XCTAssertEqual(attachment.formatLabel, row.label, row.fileName)
        }
    }

    // MARK: - byteLabel (the web's `formatBytes`)

    func testByteLabelMatchesTheWebAtEveryBoundary() {
        let table: [(bytes: Int, label: String)] = [
            (0, "0 B"),
            (1, "1 B"),
            (1_023, "1023 B"),
            (1_024, "1 KB"),
            (1_536, "1.5 KB"),
            (90_112, "88 KB"),
            (248_000, "242.2 KB"),
            (1_048_575, "1024 KB"),
            (1_048_576, "1 MB"),
            (1_258_291, "1.2 MB"),
            (52_428_800, "50 MB"),
            (1_073_741_824, "1 GB"),
        ]
        for row in table {
            XCTAssertEqual(NativeChatAttachment.byteLabel(row.bytes), row.label, "\(row.bytes)")
        }
    }

    func testCaptionPartsReadAsTheWebsTile() {
        let workbook = NativeChatAttachment(
            id: "a", fileName: "Q3 forecast.xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            kind: "FILE", size: 90_112, width: nil, height: nil
        )
        XCTAssertEqual(workbook.stem, "Q3 forecast")
        XCTAssertEqual(workbook.captionMeta, "Excel workbook · 88 KB")
        XCTAssertEqual(workbook.extensionBadge, "XLSX")

        let unsized = NativeChatAttachment(
            id: "b", fileName: ".env", mimeType: "text/plain", kind: "FILE", size: 0,
            width: nil, height: nil
        )
        XCTAssertEqual(unsized.stem, ".env", "a leading dot is not an extension")
        XCTAssertEqual(unsized.captionMeta, "Text")
        XCTAssertEqual(unsized.extensionBadge, "PLAIN", "no extension: the MIME subtype")
    }

    // MARK: - The address survives

    func testOnlyTheStableFilePathIsKept() {
        func url(_ raw: String?) -> String? {
            NativeChatAttachment(
                id: "a", fileName: "a.pdf", mimeType: "application/pdf", kind: "FILE",
                size: 1, width: nil, height: nil, url: raw
            ).url
        }
        XCTAssertEqual(url("/api/files/u1/a.pdf"), "/api/files/u1/a.pdf")
        XCTAssertNil(url("https://cdn.example/u1/a.pdf?sig=abc"))
        XCTAssertNil(url("/api/files/u1/a.pdf?download=1"))
        XCTAssertNil(url(nil))
    }

    /// The local store reads `url` off the attachment entity — which sync now
    /// keeps — and joins it onto its message.
    func testTheStoreReadsTheAttachmentURL() async throws {
        let repository = InMemoryTransactionalStore()
        let account = StorageAccountID("account-a")
        func record(_ namespace: String, _ id: String, _ json: String) -> StoredRecord {
            StoredRecord(
                accountID: account,
                key: RecordKey(namespace: namespace, id: id),
                revision: 1,
                updatedAt: Date(timeIntervalSince1970: 10),
                payload: Data(json.utf8)
            )
        }
        _ = try await repository.apply(StorageTransaction(accountID: account, operations: [
            .upsert(record("conversation", "conv-1", """
            {"id":"conv-1","title":"Files","model":"openai:gpt-5","kind":"chat","pinned":false,\
            "archivedAt":null,"createdAt":"2026-07-21T12:00:00.000Z","updatedAt":"2026-07-21T12:01:00.000Z",\
            "lastMessageAt":"2026-07-21T12:02:00.000Z"}
            """)),
            .upsert(record("message", "msg-1", """
            {"id":"msg-1","conversationId":"conv-1","role":"user","content":"Can you read this?",\
            "createdAt":"2026-07-21T12:02:00.000Z"}
            """)),
            .upsert(record("attachment", "file-1", """
            {"id":"file-1","conversationId":"conv-1","messageId":"msg-1","kind":"FILE",\
            "fileName":"quasar-notes.pdf","mimeType":"application/pdf","size":248000,\
            "url":"/api/files/u1/file-1.pdf","parserState":"READY","createdAt":"2026-07-21T12:02:00.000Z"}
            """)),
        ]))
        let store = NativeConversationStore(repository: repository, outbox: InMemoryMutationOutbox())
        let snapshot = try await store.load(accountID: account)
        let attachment = try XCTUnwrap(snapshot.messagesByConversation["conv-1"]?.first?.attachments.first)
        XCTAssertEqual(attachment.url, "/api/files/u1/file-1.pdf")
        XCTAssertEqual(attachment.parserState, "READY")
        XCTAssertEqual(attachment.captionMeta, "PDF · 242.2 KB")
    }

    /// The live `done` frame carries the path too, so a generated picture can
    /// be opened before sync has delivered its row.
    func testTheDoneFrameCarriesTheFilePath() async throws {
        let stream = """
        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"","reasoning":null,"model":"openai:gpt-image-2","createdAt":"2026-08-07T00:02:00.000Z","sources":[],"attachments":[{"id":"img-gen-1","kind":"IMAGE","fileName":"poster.png","mimeType":"image/png","size":812345,"url":"/api/files/u1/img-gen-1.png","width":1024,"height":1024,"parserState":null},{"id":"img-gen-2","kind":"IMAGE","fileName":"b.png","mimeType":"image/png","size":10,"url":"https://signed.example/b.png?sig=1"}]},"finishReason":"stop"}


        """
        let client = NativeChatAPIClient(
            sender: MediaTestSender(responses: [:]),
            streamer: MediaTestStreamer(body: stream)
        )
        let events = try await client.mediaGenerationEvents(
            NativeMediaGenerationRequest(
                conversationID: "conv_12345678",
                prompt: "A poster",
                modelID: "openai:gpt-image-2",
                modality: .image
            ),
            for: accountID
        )
        var completed: NativeCompletedChatMessage?
        for try await event in events {
            if case .completed(let message) = event { completed = message }
        }
        let attachments = try XCTUnwrap(completed?.attachments)
        XCTAssertEqual(attachments.map(\.url), ["/api/files/u1/img-gen-1.png", nil])
    }

    // MARK: - The loader

    /// A picture the server will not serve is asked for once. A long
    /// transcript scrolled back and forth must not re-request it on every
    /// appearance.
    @MainActor
    func testTheLoaderRemembersAFailureAndDoesNotRetryIt() async throws {
        let sender = MediaTestSender(responses: [:])
        let loader = NativeChatMediaLoader(sender: sender, accountID: accountID, cacheRoot: nil)
        let picture = NativeChatAttachment(
            id: "img-broken", fileName: "a.png", mimeType: "image/png", kind: "IMAGE",
            size: 10, width: nil, height: nil
        )
        await loader.loadImage(picture)
        await loader.loadImage(picture)
        XCTAssertEqual(loader.imageState(for: picture), .failed)
        let imagePaths = await sender.paths
        XCTAssertEqual(imagePaths, ["/api/attachments/img-broken"])

        let document = NativeChatAttachment(
            id: "file-gone", fileName: "a.pdf", mimeType: "application/pdf", kind: "FILE",
            size: 10, width: nil, height: nil, url: "/api/files/u1/file-gone.pdf"
        )
        for _ in 0..<2 {
            do {
                _ = try await loader.fileURL(for: document)
                XCTFail("a 404 must not produce a file")
            } catch {
                XCTAssertEqual(error as? NativeTranscriptFileError, .unavailable)
            }
        }
        let filePaths = await sender.paths.filter { $0.hasPrefix("/api/files/") }
        XCTAssertEqual(filePaths, ["/api/files/u1/file-gone.pdf"])
    }

    /// A picture decodes off the wire, downsampled, and a second load is free.
    @MainActor
    func testAPictureDecodesOnceAndIsDownsampled() async throws {
        let png = try Self.png(width: 2_048, height: 1_024)
        let sender = MediaTestSender(responses: ["/api/attachments/img-1": png])
        let loader = NativeChatMediaLoader(sender: sender, accountID: accountID, cacheRoot: nil)
        let picture = NativeChatAttachment(
            id: "img-1", fileName: "a.png", mimeType: "image/png", kind: "IMAGE",
            size: png.count, width: 2_048, height: 1_024
        )
        await loader.loadImage(picture)
        await loader.loadImage(picture)
        guard case .ready(let image) = loader.imageState(for: picture) else {
            return XCTFail("the picture did not decode")
        }
        XCTAssertEqual(image.width, NativeChatMediaLoader.imagePixelSize)
        XCTAssertEqual(image.height, NativeChatMediaLoader.imagePixelSize / 2)
        let paths = await sender.paths
        XCTAssertEqual(paths.count, 1)
    }

    /// Bytes this Mac already has draw the sent picture without a request.
    @MainActor
    func testASeededPictureNeedsNoRequest() async throws {
        let sender = MediaTestSender(responses: [:])
        let loader = NativeChatMediaLoader(sender: sender, accountID: accountID, cacheRoot: nil)
        let picture = NativeChatAttachment(
            id: "img-sent", fileName: "a.png", mimeType: "image/png", kind: "IMAGE",
            size: 10, width: nil, height: nil
        )
        loader.seed(try Self.png(width: 64, height: 48), for: picture.id)
        await loader.loadImage(picture)
        guard case .ready(let image) = loader.imageState(for: picture) else {
            return XCTFail("the seeded picture did not decode")
        }
        XCTAssertEqual(image.width, 64)
        let paths = await sender.paths
        XCTAssertTrue(paths.isEmpty)
    }

    /// A file is fetched through its stable path with the bearer transport,
    /// written under the account and attachment, and read from disk after.
    @MainActor
    func testAFileIsDownloadedOnceIntoTheAccountsCache() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-media-tests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let bytes = Data("%PDF-1.7 fixture".utf8)
        let sender = MediaTestSender(responses: ["/api/files/u1/file-1.pdf": bytes])
        let loader = NativeChatMediaLoader(sender: sender, accountID: accountID, cacheRoot: root)
        let document = NativeChatAttachment(
            id: "file-1", fileName: "Quasar: notes/final.pdf", mimeType: "application/pdf", kind: "FILE",
            size: bytes.count, width: nil, height: nil, url: "/api/files/u1/file-1.pdf"
        )
        let first = try await loader.fileURL(for: document)
        let second = try await loader.fileURL(for: document)
        XCTAssertEqual(first, second)
        XCTAssertEqual(try Data(contentsOf: first), bytes)
        XCTAssertEqual(
            first.path,
            root.appendingPathComponent("account-a/file-1/Quasar- notes-final.pdf").path,
            "one folder per account and attachment, and a name that is safe as a path"
        )
        let paths = await sender.paths
        XCTAssertEqual(paths, ["/api/files/u1/file-1.pdf"])
        let accept = await sender.acceptHeaders
        XCTAssertEqual(accept, ["*/*"])

        NativeChatMediaLoader.purgeCachedFiles(at: root)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path), "sign-out removes every file")
    }

    /// Larger than the transport can carry: refused before a byte is asked for.
    @MainActor
    func testAFileOverTheCeilingIsRefusedWithoutARequest() async throws {
        let sender = MediaTestSender(responses: [:])
        let loader = NativeChatMediaLoader(sender: sender, accountID: accountID, cacheRoot: nil)
        let clip = NativeChatAttachment(
            id: "vid-1", fileName: "long.mp4", mimeType: "video/mp4", kind: "FILE",
            size: NativeChatMediaLoader.fileByteLimit + 1, width: nil, height: nil,
            url: "/api/files/u1/vid-1.mp4"
        )
        do {
            _ = try await loader.fileURL(for: clip)
            XCTFail("an oversized file must be refused")
        } catch {
            XCTAssertEqual(
                error as? NativeTranscriptFileError,
                .tooLarge(maximumBytes: NativeChatMediaLoader.fileByteLimit)
            )
        }
        let paths = await sender.paths
        XCTAssertTrue(paths.isEmpty)
    }

    /// A tile's page: the excerpt from the preview route, and a thumbnail
    /// fetched only from the route this client knows for this attachment.
    @MainActor
    func testAPreviewReadsTheExcerptAndOnlyTheKnownThumbnailRoute() async throws {
        let sender = MediaTestSender(responses: [
            "/api/attachments/file-1/preview": Data(#"{"text":"Launch plan\nQ4","previewable":true,"thumbnailUrl":"https://evil.example/x.jpg","truncated":false}"#.utf8),
            "/api/attachments/file-2/preview": Data(#"{"text":null,"previewable":false,"thumbnailUrl":"/api/attachments/file-2/thumbnail"}"#.utf8),
            "/api/attachments/file-2/thumbnail": try Self.png(width: 640, height: 480),
        ])
        let loader = NativeChatMediaLoader(sender: sender, accountID: accountID, cacheRoot: nil)
        let deck = NativeChatAttachment(
            id: "file-1", fileName: "Launch plan.zip", mimeType: "application/zip", kind: "FILE",
            size: 1_258_291, width: nil, height: nil
        )
        await loader.loadPreview(deck)
        XCTAssertEqual(loader.previewState(for: deck), .ready(NativeTranscriptFilePreview(excerpt: "Launch plan\nQ4")))

        let report = NativeChatAttachment(
            id: "file-2", fileName: "report.zip", mimeType: "application/zip", kind: "FILE",
            size: 10, width: nil, height: nil
        )
        await loader.loadPreview(report)
        guard case .ready(let preview) = loader.previewState(for: report), let page = preview.thumbnail else {
            return XCTFail("the server's page was not drawn")
        }
        XCTAssertEqual(page.width, NativeChatMediaLoader.pagePixelSize)
        let paths = await sender.paths
        XCTAssertFalse(paths.contains { $0.contains("evil") })
    }

    /// Which files are worth reading whole for a page picture.
    func testLocalPagesAreDrawnOnlyForDocumentsWorthReading() {
        func kind(_ name: String, _ mime: String, size: Int = 1_000) -> NativeChatMediaLoader.LocalThumbnail? {
            NativeChatMediaLoader.localThumbnailKind(for: NativeChatAttachment(
                id: "a", fileName: name, mimeType: mime, kind: "FILE", size: size, width: nil, height: nil
            ))
        }
        XCTAssertEqual(kind("a.pdf", "application/pdf"), .pdf)
        XCTAssertEqual(kind("a.png", "image/png"), .image)
        XCTAssertEqual(kind("a.xlsx", "application/octet-stream"), .quickLook)
        XCTAssertEqual(kind("a.key", "application/octet-stream"), .quickLook)
        XCTAssertNil(kind("a.csv", "text/csv"), "text has its excerpt")
        XCTAssertNil(kind("a.mp4", "video/mp4"))
        XCTAssertNil(kind("a.pdf", "application/pdf", size: NativeChatMediaLoader.thumbnailByteLimit + 1))
    }

    // MARK: - Helpers

    private static func png(width: Int, height: Int) throws -> Data {
        let space = CGColorSpaceCreateDeviceRGB()
        let context = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.setFillColor(CGColor(red: 0.9, green: 0.5, blue: 0.4, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(
            CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil)
        )
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }
}

/// A picture or video turn through the store: `/api/generate` writes the
/// reader's question itself, so the store must not append it first — it did,
/// and every picture conversation stored its question twice — and the pending
/// question must take the id `meta` reports, or it stays beside the stored one.
@MainActor
final class NativeMediaTurnStoreTests: XCTestCase {
    private let pictureStream = """
    data: {"type":"meta","conversationId":"conv_12345678","userMessageId":"msg-user-1","title":""}

    data: {"type":"progress","stage":"generating","pct":40}

    data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"","reasoning":null,"model":"openai:gpt-image-2","createdAt":"2026-08-07T00:02:00.000Z","sources":[],"promptTokens":140,"completionTokens":0,"costUsd":0.042,"attachments":[{"id":"img-gen-2","kind":"IMAGE","fileName":"poster.png","mimeType":"image/png","size":812345,"url":"/api/files/u1/img-gen-2.png","width":1024,"height":1024}]},"finishReason":"stop"}


    """

    /// The region editor's Edit, from a picture in this chat: the edit is a
    /// turn here — its instructions as the question, the edited picture as the
    /// answer — not a new conversation, and the source rides on the request.
    func testAnImageEditRunsAsATurnInThisConversation() async throws {
        let (model, sender, streamer) = try await makeModel(stream: pictureStream)
        XCTAssertTrue(model.sendImageEdit(
            conversationID: "conv_12345678",
            prompt: "Make the sky violet",
            modelID: "openai:gpt-image-2",
            edit: NativeMediaGenerationRequest.Edit(
                attachmentID: "img-gen-1",
                region: NativeMediaGenerationRequest.Region(x: 0, y: 0, width: 0.5, height: 0.5)
            )
        ))
        try await waitUntilIdle(model)

        let asked = await sender.paths
        XCTAssertFalse(asked.contains { $0.hasSuffix("/messages") })
        let bodies = await streamer.bodies
        let body = try XCTUnwrap(bodies.first)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["conversationId"] as? String, "conv_12345678")
        XCTAssertEqual(object["prompt"] as? String, "Make the sky violet")
        XCTAssertEqual((object["edit"] as? [String: Any])?["attachmentId"] as? String, "img-gen-1")

        let messages = model.selectedMessages
        XCTAssertEqual(messages.map(\.role), [.user, .assistant])
        XCTAssertEqual(messages.first?.content, "Make the sky violet")
        XCTAssertEqual(messages.last?.attachments.map(\.id), ["img-gen-2"])
    }

    /// Only an image model can edit a picture.
    func testAnImageEditIsRefusedForAModelThatDoesNotMakePictures() async throws {
        let (model, _, streamer) = try await makeModel(stream: pictureStream)
        XCTAssertFalse(model.sendImageEdit(
            conversationID: "conv_12345678",
            prompt: "Make the sky violet",
            modelID: "openai:gpt-5",
            edit: NativeMediaGenerationRequest.Edit(attachmentID: "img-gen-1")
        ))
        XCTAssertNotNil(model.chatErrorDescription)
        let streamed = await streamer.paths
        XCTAssertTrue(streamed.isEmpty)
    }

    private func waitUntilIdle(_ model: NativeConversationModel<InMemoryTransactionalStore>) async throws {
        let deadline = Date().addingTimeInterval(10)
        while model.isGenerating, Date() < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertFalse(model.isGenerating, "the turn never finished")
    }

    private func makeModel(
        stream: String
    ) async throws -> (NativeConversationModel<InMemoryTransactionalStore>, MediaTestSender, MediaTurnStreamer) {
        let account = "account-a"
        let repository = InMemoryTransactionalStore()
        _ = try await repository.apply(StorageTransaction(
            accountID: StorageAccountID(account),
            operations: [
                .upsert(StoredRecord(
                    accountID: StorageAccountID(account),
                    key: RecordKey(namespace: "conversation", id: "conv_12345678"),
                    revision: 1,
                    updatedAt: Date(timeIntervalSince1970: 10),
                    payload: Data("""
                    {"id":"conv_12345678","title":"Posters","model":"openai:gpt-image-2","kind":"chat",\
                    "pinned":false,"archivedAt":null,"createdAt":"2026-07-21T12:00:00.000Z",\
                    "updatedAt":"2026-07-21T12:01:00.000Z","lastMessageAt":"2026-07-21T12:02:00.000Z"}
                    """.utf8)
                ))
            ]
        ))
        let catalog = Data(#"{"manifestVersion":"v1-catalog","contractDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","generatedAt":"2026-07-22T00:00:00.000Z","models":[{"id":"openai:gpt-image-2","provider":{"id":"openai","displayName":"OpenAI"},"displayName":"GPT Image 2","availability":"available","modality":"image","minimumPlan":"free","supportedReasoningEfforts":[],"reasoning":{"canDisable":true},"capabilities":{"streaming":true,"imageEdit":"mask"}},{"id":"openai:gpt-5","provider":{"id":"openai","displayName":"OpenAI"},"displayName":"GPT-5","availability":"available","minimumPlan":"free","supportedReasoningEfforts":["low","high"],"reasoning":{"canDisable":true},"capabilities":{"streaming":true}}]}"#.utf8)
        let sender = MediaTestSender(responses: ["/api/v1/models": catalog])
        let streamer = MediaTurnStreamer(body: stream)
        let offline = OfflineTestSender()
        let outbox = InMemoryMutationOutbox()
        let coordinator = NativeSyncCoordinator(repository: repository, sender: offline)
        let model = NativeConversationModel(
            repository: repository,
            outbox: outbox,
            drainer: NativeMutationDrainer(repository: repository, outbox: outbox, sender: offline),
            syncModel: NativeSyncModel(
                coordinator: coordinator,
                monitor: NativeSyncMonitor(coordinator: coordinator, streamer: offline)
            ),
            chatClient: NativeChatAPIClient(sender: sender, streamer: streamer),
            opensMostRecentConversationOnLoad: false
        )
        await model.start(for: try AccountID(account))
        model.selectedConversationID = "conv_12345678"
        return (model, sender, streamer)
    }

    func testAPictureTurnIsNotAppendedAndTakesTheServersQuestionID() async throws {
        let (model, sender, streamer) = try await makeModel(stream: pictureStream)
        XCTAssertTrue(model.sendMessage(
            conversationID: "conv_12345678",
            prompt: "A poster of the view",
            modelID: "openai:gpt-image-2",
            reasoningEffort: nil
        ))
        try await waitUntilIdle(model)

        let asked = await sender.paths
        XCTAssertFalse(
            asked.contains { $0.hasSuffix("/messages") },
            "the question must not be appended: /api/generate writes it"
        )
        let streamed = await streamer.paths
        XCTAssertEqual(streamed, ["/api/generate"])

        let messages = model.selectedMessages
        XCTAssertEqual(messages.filter { $0.role == .user }.map(\.id), ["msg-user-1"])
        let answer = try XCTUnwrap(messages.last)
        XCTAssertEqual(answer.role, .assistant)
        XCTAssertNil(answer.mediaProgress)
        XCTAssertEqual(answer.attachments.map(\.url), ["/api/files/u1/img-gen-2.png"])
    }
}

/// Answers each path it knows with 200 and its bytes, and everything else
/// with 404 — and records what was asked, in order.
private actor MediaTestSender: NativeAuthenticatedRequestSending {
    private let responses: [String: Data]
    private(set) var paths: [String] = []
    private(set) var acceptHeaders: [String] = []

    init(responses: [String: Data]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        paths.append(request.path)
        if request.path.hasPrefix("/api/files/") {
            acceptHeaders.append(request.headers["accept"] ?? "")
        }
        guard let body = responses[request.path] else {
            return HTTPResponse(statusCode: 404, headers: HTTPHeaders(), body: Data())
        }
        return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: body)
    }
}

private actor MediaTestStreamer: NativeAuthenticatedByteStreaming {
    private let body: String

    init(body: String) { self.body = body }

    func stream(_: NativeBearerRequest, for _: AccountID) async throws -> HTTPByteStreamResponse {
        let data = Data(body.utf8)
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: try HTTPHeaders(["content-type": "text/event-stream; charset=utf-8"]),
            bytes: AsyncThrowingStream { continuation in
                Task {
                    for byte in data { continuation.yield(byte) }
                    continuation.finish()
                }
            }
        )
    }
}

private actor MediaTurnStreamer: NativeAuthenticatedByteStreaming {
    private let body: String
    private(set) var paths: [String] = []
    private(set) var bodies: [Data] = []

    init(body: String) { self.body = body }

    func stream(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPByteStreamResponse {
        paths.append(request.path)
        if let sent = request.body { bodies.append(sent) }
        let data = Data(body.utf8)
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: try HTTPHeaders(["content-type": "text/event-stream; charset=utf-8"]),
            bytes: AsyncThrowingStream { continuation in
                Task {
                    for byte in data { continuation.yield(byte) }
                    continuation.finish()
                }
            }
        )
    }
}

/// Sync with no network: every request fails at once, so the store's refresh
/// after a turn is a no-op and the transcript is what the turn left behind.
private struct OfflineTestSender: NativeAuthenticatedRequestSending, NativeAuthenticatedByteStreaming, Sendable {
    func send(_: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }

    func stream(_: NativeBearerRequest, for _: AccountID) async throws -> HTTPByteStreamResponse {
        throw URLError(.notConnectedToInternet)
    }
}
