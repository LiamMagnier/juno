import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoChatKit

/// The composer's attachment rules, driven through the real model.
@MainActor
final class NativeComposerAttachmentModelTests: XCTestCase {
    private let png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

    /// The rule that makes retrying safe. A key generated per *request* would
    /// make every retry a fresh upload, leaving duplicates behind exactly when
    /// the network is worst — which is the only time retries happen.
    func testRetryReusesTheSameIdempotencyKey() async throws {
        let transport = RecordingTransport(outcomes: [.failure, .success])
        let model = NativeComposerAttachmentModel(
            client: NativeAttachmentAPIClient(sender: transport)
        )
        model.start(for: try AccountID("account-a"))

        model.add(
            data: png, fileName: "a.png", mimeType: "image/png",
            conversationID: "conv-1", isImage: true
        )
        try await settle(model)
        let attachment = try XCTUnwrap(model.attachments.first)
        guard case .failed = attachment.state else {
            return XCTFail("precondition: the first attempt must fail")
        }

        model.retry(attachment.id, conversationID: "conv-1")
        try await settle(model)

        let keys = await transport.idempotencyKeys
        XCTAssertEqual(keys.count, 2, "precondition: two uploads were attempted")
        XCTAssertEqual(
            keys[0], keys[1],
            "A retry must reuse the attachment's key, or the server creates a second attachment."
        )
    }

    /// Sending a message that references an attachment the server has not
    /// accepted produces a message with a missing file, and nothing on the
    /// client can repair it afterwards.
    func testSendIsBlockedUntilEveryUploadHasLanded() async throws {
        let transport = RecordingTransport(outcomes: [.success])
        let model = NativeComposerAttachmentModel(
            client: NativeAttachmentAPIClient(sender: transport)
        )
        model.start(for: try AccountID("account-a"))

        model.add(
            data: png, fileName: "a.png", mimeType: "image/png",
            conversationID: nil, isImage: true
        )
        XCTAssertFalse(model.canSend, "An in-flight upload must block Send.")

        try await settle(model)
        XCTAssertTrue(model.canSend)
        XCTAssertEqual(model.uploadedIDs, ["attachment-1"])
    }

    /// A failed attachment stays on screen. Removing it would look exactly like
    /// a successful send that quietly lost a file.
    func testAFailedAttachmentIsKeptWithItsReason() async throws {
        let transport = RecordingTransport(outcomes: [.failure])
        let model = NativeComposerAttachmentModel(
            client: NativeAttachmentAPIClient(sender: transport)
        )
        model.start(for: try AccountID("account-a"))

        model.add(
            data: png, fileName: "a.png", mimeType: "image/png",
            conversationID: nil, isImage: true
        )
        try await settle(model)

        XCTAssertEqual(model.attachments.count, 1)
        guard case .failed(let message, _) = model.attachments[0].state else {
            return XCTFail("a failure must be visible on the chip")
        }
        XCTAssertFalse(message.isEmpty)
        XCTAssertFalse(model.canSend, "A failed attachment must still block Send.")
    }

    /// A rejected file type never becomes acceptable, so offering Retry there is
    /// a button that is guaranteed to fail again.
    func testUnsupportedTypeOffersNoRetry() async throws {
        let transport = RecordingTransport(outcomes: [
            .rejected(status: 415, code: "unsupported_media_type", retryable: false)
        ])
        let model = NativeComposerAttachmentModel(
            client: NativeAttachmentAPIClient(sender: transport)
        )
        model.start(for: try AccountID("account-a"))

        model.add(
            data: png, fileName: "a.png", mimeType: "image/png",
            conversationID: nil, isImage: true
        )
        try await settle(model)

        guard case .failed(_, let retryable) = model.attachments[0].state else {
            return XCTFail("expected a failure")
        }
        XCTAssertFalse(retryable)
    }

    /// A 503 is worth another attempt, and the server says so.
    func testServerSideOutageOffersRetry() async throws {
        let transport = RecordingTransport(outcomes: [
            .rejected(status: 503, code: "storage_unavailable", retryable: true)
        ])
        let model = NativeComposerAttachmentModel(
            client: NativeAttachmentAPIClient(sender: transport)
        )
        model.start(for: try AccountID("account-a"))

        model.add(
            data: png, fileName: "a.png", mimeType: "image/png",
            conversationID: nil, isImage: true
        )
        try await settle(model)

        guard case .failed(_, let retryable) = model.attachments[0].state else {
            return XCTFail("expected a failure")
        }
        XCTAssertTrue(retryable)
    }

    func testTheAttachmentCeilingIsEnforced() async throws {
        let transport = RecordingTransport(
            outcomes: Array(repeating: .success, count: 12)
        )
        let model = NativeComposerAttachmentModel(
            client: NativeAttachmentAPIClient(sender: transport)
        )
        model.start(for: try AccountID("account-a"))

        for index in 0..<12 {
            model.add(
                data: png, fileName: "a\(index).png", mimeType: "image/png",
                conversationID: nil, isImage: true
            )
        }

        XCTAssertEqual(model.attachments.count, NativeComposerAttachmentModel.maximumAttachments)
        XCTAssertNotNil(model.lastErrorDescription)
    }

    /// Removing an in-flight attachment must cancel its upload, not leave it
    /// racing to attach a file the reader has already discarded.
    func testRemovingAnAttachmentCancelsItsUpload() async throws {
        let transport = RecordingTransport(outcomes: [.success])
        let model = NativeComposerAttachmentModel(
            client: NativeAttachmentAPIClient(sender: transport)
        )
        model.start(for: try AccountID("account-a"))

        model.add(
            data: png, fileName: "a.png", mimeType: "image/png",
            conversationID: nil, isImage: true
        )
        let id = try XCTUnwrap(model.attachments.first).id
        model.remove(id)

        XCTAssertTrue(model.attachments.isEmpty)
        XCTAssertTrue(model.canSend)
    }

    private func settle(_ model: NativeComposerAttachmentModel) async throws {
        for _ in 0..<200 {
            if !model.isUploading { return }
            await Task.yield()
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }
}

/// Records what each upload actually sent, so the idempotency rule can be
/// checked against the wire rather than against the model's intentions.
private actor RecordingTransport: NativeAuthenticatedRequestSending {
    enum Outcome {
        case success
        case failure
        case rejected(status: Int, code: String, retryable: Bool)
    }

    private var outcomes: [Outcome]
    private var index = 0
    private(set) var idempotencyKeys: [String] = []

    init(outcomes: [Outcome]) { self.outcomes = outcomes }

    func send(_ request: NativeBearerRequest, for accountID: AccountID) async throws
        -> HTTPResponse
    {
        idempotencyKeys.append(request.headers["idempotency-key"] ?? "")
        let outcome = index < outcomes.count ? outcomes[index] : .success
        index += 1

        switch outcome {
        case .failure:
            throw URLError(.networkConnectionLost)
        case .rejected(let status, let code, let retryable):
            let body = """
            {"error":{"code":"\(code)","message":"Rejected.","requestId":"req_1",\
            "retryable":\(retryable),"retryAfterMs":null}}
            """
            return HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
        case .success:
            let body = """
            {"attachment":{"id":"attachment-\(index)","fileName":"a.png",\
            "mimeType":"image/png","size":12,"kind":"IMAGE"}}
            """
            return HTTPResponse(statusCode: 201, headers: HTTPHeaders(), body: Data(body.utf8))
        }
    }
}
