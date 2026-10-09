import XCTest
import JunoAPI
import JunoAuth
import JunoCodeRuntime
import JunoCore
import JunoSync
@testable import JunoCodeBridge

private actor MediaSender: NativeAuthenticatedRequestSending {
    let stream: String
    private(set) var paths: [String] = []
    private(set) var generateBody: Data?

    init(stream: String) { self.stream = stream }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        paths.append(request.path)
        if request.path == "/api/generate" {
            generateBody = request.body
            return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data(stream.utf8))
        }
        return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data([1, 2, 3]))
    }
}

final class BackendCodeMediaClientTests: XCTestCase {
    private let accountID = try! AccountID("account-1")

    func testGeneratesWithTheChosenModelAndDownloadsTheFile() async throws {
        let stream = """
        data: {"type":"meta","conversationId":"c1"}

        data: {"type":"progress","stage":"generating"}

        data: {"type":"done","message":{"id":"m1","attachments":[{"id":"a1","fileName":"hero.png","mimeType":"image/png","url":"/api/files/u/1/hero.png"}]}}

        """
        let sender = MediaSender(stream: stream)
        let client = BackendCodeMediaClient(sender: sender, accountID: accountID) { kind in
            kind == .image ? "openai:gpt-image-2.5-sunburst" : nil
        }
        XCTAssertEqual(client.model(for: .image), "openai:gpt-image-2.5-sunburst")
        XCTAssertNil(client.model(for: .video))

        let files = try await client.generate(kind: .image, prompt: "a hero", model: "openai:gpt-image-2.5-sunburst")

        XCTAssertEqual(files, [CodeGeneratedFile(fileName: "hero.png", mimeType: "image/png", data: Data([1, 2, 3]))])
        let paths = await sender.paths
        XCTAssertEqual(paths, ["/api/generate", "/api/files/u/1/hero.png"])
        let sent = await sender.generateBody
        let body = try XCTUnwrap(sent)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["model"] as? String, "openai:gpt-image-2.5-sunburst")
        XCTAssertEqual(object["prompt"] as? String, "a hero")
    }

    func testTheStreamsErrorReachesTheAgent() {
        let body = Data(#"data: {"type":"error","message":"Requires Pro"}"#.utf8)
        XCTAssertThrowsError(try BackendCodeMediaClient.finishedAttachments(in: body)) { error in
            XCTAssertEqual(error as? BackendCodeMediaError, .generationFailed("Requires Pro"))
        }
    }

    func testOnlyTheOwnerCheckedFileRouteIsFetched() async {
        let stream = #"data: {"type":"done","message":{"attachments":[{"fileName":"x.png","mimeType":"image/png","url":"https://evil.example/x.png"}]}}"#
        let client = BackendCodeMediaClient(sender: MediaSender(stream: stream), accountID: accountID) { _ in "m" }
        do {
            _ = try await client.generate(kind: .image, prompt: "x", model: "m")
            XCTFail("followed a foreign URL")
        } catch {
            XCTAssertEqual(error as? BackendCodeMediaError, .malformedResponse)
        }
    }
}
