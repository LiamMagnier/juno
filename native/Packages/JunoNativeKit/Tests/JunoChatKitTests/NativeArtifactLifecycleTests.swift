import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest
@testable import JunoChatKit

/// Request building and response decoding for the lifecycle routes, against
/// the exact shapes `src/app/api/artifacts/**/route.ts` answer with.
final class NativeArtifactLifecycleTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    private static func json(_ body: String, status: Int = 200, headers: [String: String] = [:]) -> HTTPResponse {
        var all = ["content-type": "application/json"]
        for (key, value) in headers { all[key] = value }
        return HTTPResponse(statusCode: status, headers: try! HTTPHeaders(all), body: Data(body.utf8))
    }

    private static func artifactBody(id: String, version: Int = 1) -> String {
        """
        {"artifact":{"id":"\(id)","identifier":"plan","type":"SPREADSHEET","title":"Plan (copy)","language":null,
        "currentVersion":\(version),"content":"{}","versions":[{"version":\(version),"content":"{}","origin":"generated",
        "createdAt":"2026-10-08T09:00:00.000Z"}],"messageId":null,"createdAt":"2026-10-08T09:00:00.000Z",
        "updatedAt":"2026-10-08T09:00:00.000Z"}}
        """
    }

    func testDuplicatePostsTheVersionAndDecodesTheCopy() async throws {
        let sender = LifecycleQueueSender(responses: [
            Self.json(String(Self.artifactBody(id: "copy-1").dropLast()) + #","url":"/a/copy-1"}"#, status: 201),
        ])
        let copy = try await NativeArtifactAPIClient(sender: sender).duplicate(id: "art-1", version: 3, for: accountID)
        XCTAssertEqual(copy.artifact.id, "copy-1")
        XCTAssertEqual(copy.artifact.kind, .spreadsheet)
        XCTAssertEqual(copy.path, "/a/copy-1")
        let first = await sender.requests.first
        let request = try XCTUnwrap(first)
        XCTAssertEqual(request.method, .post)
        XCTAssertEqual(request.path, "/api/artifacts/art-1/duplicate")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Int], ["version": 3])
    }

    func testDownloadAsksForTheVersionOrTheZipWithHistory() async throws {
        let sender = LifecycleQueueSender(responses: [
            HTTPResponse(
                statusCode: 200,
                headers: try HTTPHeaders([
                    "content-type": "application/json",
                    "content-disposition": #"attachment; filename="Plan.json"; filename*=UTF-8''Pl%C3%A4n.json"#,
                ]),
                body: Data("{}".utf8)
            ),
            HTTPResponse(statusCode: 200, headers: try HTTPHeaders(["content-type": "application/zip"]), body: Data([0x50, 0x4b])),
        ])
        let client = NativeArtifactAPIClient(sender: sender)
        let file = try await client.download(id: "art-1", version: 2, format: .file, fallbackName: "plan.json", for: accountID)
        XCTAssertEqual(file.fileName, "Plän.json")
        XCTAssertEqual(file.contentType, "application/json")
        let zip = try await client.download(id: "art-1", version: 2, format: .zipWithHistory, fallbackName: "Plan", for: accountID)
        XCTAssertEqual(zip.fileName, "Plan.zip")
        let requests = await sender.requests
        XCTAssertEqual(requests[0].path, "/api/artifacts/art-1/download")
        XCTAssertEqual(requests[0].queryItems, [URLQueryItem(name: "version", value: "2")])
        XCTAssertEqual(requests[1].queryItems, [
            URLQueryItem(name: "version", value: "2"),
            URLQueryItem(name: "format", value: "zip"),
            URLQueryItem(name: "history", value: "1"),
        ])
    }

    func testDispositionFileNames() {
        XCTAssertEqual(NativeArtifactAPIClient.fileName(fromDisposition: #"attachment; filename="a b.html""#), "a b.html")
        XCTAssertEqual(NativeArtifactAPIClient.fileName(fromDisposition: #"attachment; filename*=UTF-8''..%2Fx.svg"#), ".. x.svg")
        XCTAssertNil(NativeArtifactAPIClient.fileName(fromDisposition: "attachment"))
        XCTAssertNil(NativeArtifactAPIClient.fileName(fromDisposition: nil))
    }

    static let pageOne = #"""
    {"currentVersion":3,"draft":null,"versions":[
      {"version":3,"origin":"edit","createdAt":"2026-10-08T09:00:00.000Z"},
      {"version":2,"origin":"restore","createdAt":"2026-10-07T09:00:00.000Z"}
    ],"nextBefore":2}
    """#
    static let pageTwo = #"""
    {"currentVersion":3,"draft":{"version":4,"updatedAt":"2026-10-08T10:00:00.000Z"},"versions":[
      {"version":1,"origin":null,"createdAt":"2026-10-06T09:00:00Z"}
    ],"nextBefore":null}
    """#

    func testVersionPagesDecodeAndCarryTheCursor() async throws {
        let sender = LifecycleQueueSender(responses: [Self.json(Self.pageOne), Self.json(Self.pageTwo)])
        let client = NativeArtifactAPIClient(sender: sender)
        let first = try await client.versionPage(id: "art-1", limit: 2, for: accountID)
        XCTAssertEqual(first.versions.map(\.version), [3, 2])
        XCTAssertEqual(first.versions.map(\.origin), [.edit, .restore])
        XCTAssertEqual(first.nextBefore, 2)
        let second = try await client.versionPage(id: "art-1", before: 2, limit: 2, for: accountID)
        XCTAssertEqual(second.versions.map(\.version), [1])
        XCTAssertNil(second.versions[0].origin)
        XCTAssertEqual(second.draftVersion, 4)
        XCTAssertNil(second.nextBefore)
        let requests = await sender.requests
        XCTAssertEqual(requests[0].path, "/api/artifacts/art-1/versions")
        XCTAssertEqual(requests[0].queryItems, [URLQueryItem(name: "limit", value: "2")])
        XCTAssertEqual(requests[1].queryItems, [URLQueryItem(name: "limit", value: "2"), URLQueryItem(name: "before", value: "2")])
    }

    func testOneVersionBody() async throws {
        let sender = LifecycleQueueSender(responses: [Self.json(
            #"{"version":{"version":2,"origin":"edit","content":"<p>two</p>","createdAt":"2026-10-07T09:00:00.000Z"}}"#
        )])
        let version = try await NativeArtifactAPIClient(sender: sender).versionContent(id: "art-1", version: 2, for: accountID)
        XCTAssertEqual(version.content, "<p>two</p>")
        XCTAssertEqual(version.origin, .edit)
        let path = await sender.requests.first?.path
        XCTAssertEqual(path, "/api/artifacts/art-1/versions/2")
    }

    static let deletedList = #"""
    {"items":[
      {"id":"art-9","identifier":"deck","title":"Board deck","type":"PRESENTATION","language":null,"version":4,
       "conversationId":null,"conversationTitle":null,"projectId":null,"derivedFromId":null,
       "createdAt":"2026-09-01T09:00:00.000Z","updatedAt":"2026-10-01T09:00:00.000Z",
       "deletedAt":"2026-10-05T09:00:00.000Z","purgeAt":"2026-11-04T09:00:00.000Z","preview":"{}"},
      {"id":"art-8","identifier":"future","title":"From the future","type":"HOLOGRAM","language":null,"version":1,
       "conversationId":"c1","conversationTitle":"Chat","projectId":null,"derivedFromId":null,
       "createdAt":"2026-09-01T09:00:00.000Z","updatedAt":"2026-10-01T09:00:00.000Z",
       "deletedAt":"2026-10-04T09:00:00.000Z","purgeAt":"2026-11-03T09:00:00.000Z","preview":null}
    ]}
    """#

    func testRecentlyDeletedListsEveryRowEvenUnknownKinds() async throws {
        let sender = LifecycleQueueSender(responses: [Self.json(Self.deletedList)])
        let items = try await NativeArtifactAPIClient(sender: sender).recentlyDeleted(for: accountID)
        XCTAssertEqual(items.map(\.id), ["art-9", "art-8"])
        XCTAssertEqual(items[0].kind, .presentation)
        XCTAssertNil(items[1].kind)
        XCTAssertNotNil(items[0].purgeAt)
        XCTAssertNil(items[0].conversationID)
        let first = await sender.requests.first
        let request = try XCTUnwrap(first)
        XCTAssertEqual(request.path, "/api/artifacts")
        XCTAssertEqual(request.queryItems, [URLQueryItem(name: "deleted", value: "1")])
    }

    func testRestorePostsAndDecodesTheArtifact() async throws {
        let sender = LifecycleQueueSender(responses: [Self.json(Self.artifactBody(id: "art-9", version: 4))])
        let restored = try await NativeArtifactAPIClient(sender: sender).restoreDeleted(id: "art-9", for: accountID)
        XCTAssertEqual(restored.currentVersion, 4)
        let first = await sender.requests.first
        let request = try XCTUnwrap(first)
        XCTAssertEqual(request.method, .post)
        XCTAssertEqual(request.path, "/api/artifacts/art-9/restore")
    }

    func testServerRefusalsSurfaceTheirMessage() async {
        let sender = LifecycleQueueSender(responses: [Self.json(#"{"error":"That version does not exist."}"#, status: 400)])
        do {
            _ = try await NativeArtifactAPIClient(sender: sender).duplicate(id: "art-1", version: 99, for: accountID)
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual((error as? LocalizedError)?.errorDescription, "That version does not exist.")
        }
    }

    // MARK: View models

    @MainActor
    func testHistoryPagesInAndStopsAtVersionOne() async {
        let sender = LifecycleQueueSender(responses: [Self.json(Self.pageOne), Self.json(Self.pageTwo)])
        let history = NativeArtifactHistory(
            artifactID: "art-1", client: NativeArtifactAPIClient(sender: sender), accountID: accountID, pageSize: 2
        )
        XCTAssertEqual(history.phase, .idle)
        await history.load()
        XCTAssertEqual(history.phase, .ready)
        XCTAssertEqual(history.entries.map(\.version), [3, 2])
        XCTAssertTrue(history.hasMore)
        await history.loadMore()
        XCTAssertEqual(history.entries.map(\.version), [3, 2, 1])
        XCTAssertFalse(history.hasMore)
        await history.loadMore()
        let count = await sender.requests.count
        XCTAssertEqual(count, 2)
    }

    @MainActor
    func testHistoryFailureIsAPhaseWithAMessage() async {
        let sender = LifecycleQueueSender(responses: [Self.json(#"{"error":"Not found"}"#, status: 404)])
        let history = NativeArtifactHistory(artifactID: "art-1", client: NativeArtifactAPIClient(sender: sender), accountID: accountID)
        await history.load()
        XCTAssertEqual(history.phase, .failed)
        XCTAssertNotNil(history.errorDescription)
    }

    @MainActor
    func testRecentlyDeletedRestoreRemovesTheRowAndTellsTheOwner() async {
        let sender = LifecycleQueueSender(responses: [
            Self.json(Self.deletedList),
            Self.json(Self.artifactBody(id: "art-9", version: 4)),
            Self.json(#"{"error":"Not found"}"#, status: 404),
        ])
        var restoredIDs: [String] = []
        let trash = NativeRecentlyDeletedArtifacts(client: NativeArtifactAPIClient(sender: sender), accountID: accountID) {
            restoredIDs.append($0.id)
        }
        await trash.load()
        XCTAssertEqual(trash.phase, .ready)
        XCTAssertEqual(trash.items.count, 2)
        let restored = await trash.restore(id: "art-9")
        XCTAssertTrue(restored)
        XCTAssertEqual(trash.items.map(\.id), ["art-8"])
        XCTAssertEqual(restoredIDs, ["art-9"])
        let failed = await trash.restore(id: "art-8")
        XCTAssertFalse(failed)
        XCTAssertEqual(trash.items.map(\.id), ["art-8"])
        XCTAssertNotNil(trash.errorDescription)
        XCTAssertTrue(trash.restoring.isEmpty)
    }
}

private actor LifecycleQueueSender: NativeAuthenticatedRequestSending {
    private var responses: [HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [HTTPResponse]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) throws -> HTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else { throw URLError(.badServerResponse) }
        return responses.removeFirst()
    }
}
