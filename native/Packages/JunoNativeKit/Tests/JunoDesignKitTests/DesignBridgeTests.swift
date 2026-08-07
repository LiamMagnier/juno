import XCTest
@testable import JunoDesignKit

/// The bridge is the only way the hosted editor can reach native code, so these
/// tests are the security boundary's tests: every message it will accept, and
/// every one it must refuse.
final class DesignBridgeTests: XCTestCase {
    private let nonce = "session-nonce-abc"

    private func documentBody() throws -> Any {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/sign-in.juno.design", withExtension: "json"))
        let data = try Data(contentsOf: url)
        return try JSONSerialization.jsonObject(with: data)
    }

    /// The fixture is at revision N; a transaction message claims N → N+1 and
    /// carries a document already stamped N+1.
    private func transactionBody(baseRevision: Int, revision: Int, nonce: String? = nil) throws -> [String: Any] {
        var document = try XCTUnwrap(try documentBody() as? [String: Any])
        document["revision"] = revision
        return [
            "type": "transaction",
            "nonce": nonce ?? self.nonce,
            "baseRevision": baseRevision,
            "revision": revision,
            "transactionId": "tx-1",
            "summary": "Rounded the button",
            "document": document,
        ]
    }

    private func baseRevision() throws -> Int {
        let object = try XCTUnwrap(try documentBody() as? [String: Any])
        return try XCTUnwrap(object["revision"] as? Int)
    }

    func testAcceptsAWellFormedTransactionAndAdvancesTheRevision() throws {
        let start = try baseRevision()
        var validator = DesignBridgeValidator(nonce: nonce, revision: start)

        let message = try validator.validate(transactionBody(baseRevision: start, revision: start + 1))
        guard case .transaction(_, let base, let next, let id, let summary, let document) = message else {
            return XCTFail("expected a transaction, got \(message)")
        }
        XCTAssertEqual(base, start)
        XCTAssertEqual(next, start + 1)
        XCTAssertEqual(id, "tx-1")
        XCTAssertEqual(summary, "Rounded the button")
        XCTAssertEqual(document.revision, start + 1)
        XCTAssertEqual(validator.revision, start + 1)
    }

    func testRejectsAReplayOfTheSameTransaction() throws {
        let start = try baseRevision()
        var validator = DesignBridgeValidator(nonce: nonce, revision: start)
        let body = try transactionBody(baseRevision: start, revision: start + 1)

        _ = try validator.validate(body)
        XCTAssertThrowsError(try validator.validate(body)) { error in
            XCTAssertEqual(error as? DesignBridgeError, .staleRevision(expected: start + 1, received: start))
        }
    }

    func testRejectsAMessageFromAnotherSession() throws {
        let start = try baseRevision()
        var validator = DesignBridgeValidator(nonce: nonce, revision: start)
        XCTAssertThrowsError(
            try validator.validate(transactionBody(baseRevision: start, revision: start + 1, nonce: "someone-elses-nonce"))
        ) { error in
            XCTAssertEqual(error as? DesignBridgeError, .nonceMismatch)
        }
    }

    func testRejectsATransactionWhoseDocumentDisagreesWithItsRevision() throws {
        let start = try baseRevision()
        var validator = DesignBridgeValidator(nonce: nonce, revision: start)
        var body = try transactionBody(baseRevision: start, revision: start + 1)
        var document = try XCTUnwrap(body["document"] as? [String: Any])
        document["revision"] = start + 99
        body["document"] = document

        XCTAssertThrowsError(try validator.validate(body)) { error in
            XCTAssertEqual(error as? DesignBridgeError, .badField("revision"))
        }
        XCTAssertEqual(validator.revision, start, "a refused message must not advance the revision")
    }

    func testRejectsATransactionThatSkipsARevision() throws {
        let start = try baseRevision()
        var validator = DesignBridgeValidator(nonce: nonce, revision: start)
        let body = try transactionBody(baseRevision: start, revision: start + 2)

        XCTAssertThrowsError(try validator.validate(body)) { error in
            XCTAssertEqual(error as? DesignBridgeError, .badField("revision"))
        }
        XCTAssertEqual(validator.revision, start, "a skipped revision must not advance the validator")
    }

    func testRejectsATransactionCarryingAnInvalidDocument() throws {
        let start = try baseRevision()
        var validator = DesignBridgeValidator(nonce: nonce, revision: start)
        var body = try transactionBody(baseRevision: start, revision: start + 1)
        var document = try XCTUnwrap(body["document"] as? [String: Any])
        var nodes = try XCTUnwrap(document["nodes"] as? [String: Any])
        var card = try XCTUnwrap(nodes["card"] as? [String: Any])
        card["children"] = ["ghost"]
        nodes["card"] = card
        document["nodes"] = nodes
        body["document"] = document

        XCTAssertThrowsError(try validator.validate(body)) { error in
            XCTAssertEqual(error as? DesignBridgeError, .badField("document"))
        }
    }

    func testRejectsUnknownTypesMalformedBodiesAndMissingFields() throws {
        var validator = DesignBridgeValidator(nonce: nonce, revision: 0)
        XCTAssertThrowsError(try validator.validate("hello")) { XCTAssertEqual($0 as? DesignBridgeError, .notAnObject) }
        XCTAssertThrowsError(try validator.validate(["type": "exec", "cmd": "rm -rf /"])) {
            XCTAssertEqual($0 as? DesignBridgeError, .unknownType("exec"))
        }
        XCTAssertThrowsError(try validator.validate(["nonce": nonce])) {
            XCTAssertEqual($0 as? DesignBridgeError, .missingField("type"))
        }
        XCTAssertThrowsError(try validator.validate(["type": "selection", "nonce": nonce])) {
            XCTAssertEqual($0 as? DesignBridgeError, .missingField("revision"))
        }
    }

    func testRefusesAnEditorSpeakingADifferentProtocolVersion() throws {
        var validator = DesignBridgeValidator(nonce: nonce, revision: 0)
        XCTAssertThrowsError(
            try validator.validate(["type": "ready", "protocolVersion": DesignBridge.protocolVersion + 1, "editorVersion": "9.9.9"])
        ) { error in
            XCTAssertEqual(error as? DesignBridgeError, .unsupportedProtocol(DesignBridge.protocolVersion + 1))
        }

        let ok = try validator.validate([
            "type": "ready", "protocolVersion": DesignBridge.protocolVersion, "editorVersion": "1.0.0",
        ])
        XCTAssertEqual(ok, .ready(protocolVersion: DesignBridge.protocolVersion, editorVersion: "1.0.0"))
    }

    func testSelectionFromTheFutureIsRefusedButFromThePastIsTolerated() throws {
        var validator = DesignBridgeValidator(nonce: nonce, revision: 5)
        let past = try validator.validate(["type": "selection", "nonce": nonce, "revision": 4, "nodeIds": ["button"]])
        XCTAssertEqual(past, .selection(nonce: nonce, revision: 4, nodeIDs: ["button"]))

        XCTAssertThrowsError(
            try validator.validate(["type": "selection", "nonce": nonce, "revision": 6, "nodeIds": ["button"]])
        ) { error in
            XCTAssertEqual(error as? DesignBridgeError, .staleRevision(expected: 5, received: 6))
        }
    }

    func testFailureMessagesAreSurfacedAndBounded() throws {
        var validator = DesignBridgeValidator(nonce: nonce, revision: 0)
        let long = String(repeating: "x", count: 5_000)
        guard case .failure(_, let message) = try validator.validate(["type": "failure", "message": long]) else {
            return XCTFail("expected a failure message")
        }
        XCTAssertEqual(message.count, 2_000)
    }

    // MARK: Host → editor

    func testHostCommandsEmbedTheDocumentAsDataNotSource() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/sign-in.juno.design", withExtension: "json"))
        var document = try DesignDocumentCodec.load(Data(contentsOf: url))
        // The kind of content that breaks naive string interpolation.
        document.nodes["buttonLabel"]?.characters = "</script>'\"\u{2028}\\"

        let script = try DesignHostCommand.openDocument(nonce: nonce, document: document, readOnly: false).javaScript()

        XCTAssertTrue(script.hasPrefix("window.__junoDesignHost"))
        XCTAssertTrue(script.contains("JSON.parse("))
        XCTAssertFalse(script.contains("</script>"), "user text must not terminate the script element")
        XCTAssertFalse(script.contains("\u{2028}"), "U+2028 must be escaped or it ends the JS line")
        // One statement, one entry point: no way to smuggle a second call in.
        XCTAssertEqual(script.components(separatedBy: "window.__junoDesignHost").count - 1, 2)
    }

    func testSelectionAndReadOnlyCommandsSerialize() throws {
        let selection = try DesignHostCommand.setSelection(nonce: nonce, nodeIDs: ["a", "b"]).javaScript()
        XCTAssertTrue(selection.contains("setSelection"))
        XCTAssertTrue(selection.contains(nonce))

        let readOnly = try DesignHostCommand.setReadOnly(nonce: nonce, readOnly: true).javaScript()
        XCTAssertTrue(readOnly.contains("setReadOnly"))
    }
}
