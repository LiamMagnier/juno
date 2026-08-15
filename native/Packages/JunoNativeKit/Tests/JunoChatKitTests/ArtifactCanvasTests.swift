import Foundation
import XCTest

@testable import JunoChatKit

// MARK: - Bridge decoding

/// Everything here runs without WebKit, a window, or a run loop. The decoder was
/// written against `Any` precisely so that the awkward payloads — a line number
/// of zero, an error the page did not classify, a body that is not a string at
/// all — can be reproduced as Swift literals instead of being waited for.
final class ArtifactCanvasBridgeTests: XCTestCase {
    func testDecodesConsoleMessage() throws {
        let event = try XCTUnwrap(
            ArtifactCanvasBridge.decode(
                #"{"type":"console","level":"warn","text":"low memory","argumentCount":2,"sequence":7,"timestamp":1750000000000}"#
            )
        )

        guard case let .console(message) = event else {
            return XCTFail("Expected a console event, got \(event)")
        }
        XCTAssertEqual(message.level, .warn)
        XCTAssertEqual(message.origin, .console)
        XCTAssertEqual(message.text, "low memory")
        XCTAssertEqual(message.argumentCount, 2)
        XCTAssertEqual(message.sequence, 7)
        XCTAssertEqual(message.pageDate, Date(timeIntervalSince1970: 1_750_000_000))
        XCTAssertNil(message.location)
    }

    /// `window.onerror` uses `0` for "no location". Storing it would print
    /// "line 0" and send the reader to the top of a file that is fine.
    func testZeroLineAndColumnMeanUnknownNotTheFirstLine() throws {
        let event = try XCTUnwrap(
            ArtifactCanvasBridge.decode(
                #"{"type":"error","kind":"exception","message":"Script error.","line":0,"column":0,"source":""}"#
            )
        )

        guard case let .console(message) = event else {
            return XCTFail("Expected a console event, got \(event)")
        }
        XCTAssertEqual(message.level, .error)
        XCTAssertEqual(message.origin, .uncaughtException)
        // Every component was unknown, so there is no location at all rather
        // than an empty one that a UI would still render a row for.
        XCTAssertNil(message.location)
    }

    func testKeepsRealLocations() throws {
        let event = try XCTUnwrap(
            ArtifactCanvasBridge.decode(
                #"{"type":"error","kind":"exception","message":"x is not defined","line":12,"column":5,"source":"about:blank","stack":"at App"}"#
            )
        )

        guard case let .console(message) = event else {
            return XCTFail("Expected a console event, got \(event)")
        }
        XCTAssertEqual(
            message.location,
            ArtifactSourceLocation(source: "about:blank", line: 12, column: 5)
        )
        XCTAssertEqual(message.stack, "at App")
    }

    func testBlockedSubresourceIsItsOwnOrigin() throws {
        let event = try XCTUnwrap(
            ArtifactCanvasBridge.decode(
                #"{"type":"error","kind":"resource","message":"Blocked or failed to load: https://unpkg.com/react"}"#
            )
        )

        guard case let .console(message) = event else {
            return XCTFail("Expected a console event, got \(event)")
        }
        // Not an uncaught exception: the artifact did not stop, it was denied a
        // download. That difference is the whole diagnosis for a blank preview.
        XCTAssertEqual(message.origin, .blockedResource)
        XCTAssertEqual(message.level, .error)
    }

    func testUnhandledRejectionIsDistinguishedFromAnException() throws {
        let event = try XCTUnwrap(
            ArtifactCanvasBridge.decode(
                #"{"type":"error","kind":"rejection","message":"TypeError: nope"}"#
            )
        )

        guard case let .console(message) = event else {
            return XCTFail("Expected a console event, got \(event)")
        }
        XCTAssertEqual(message.origin, .unhandledRejection)
    }

    /// An error with no `kind` is not filed as an uncaught exception on a guess:
    /// that would tell the reader the artifact stopped running.
    func testUnclassifiedErrorIsRejectedRatherThanAssumed() {
        XCTAssertNil(
            ArtifactCanvasBridge.decode(#"{"type":"error","message":"something"}"#)
        )
    }

    func testUnknownLevelsAndShapesAreRejected() {
        XCTAssertNil(ArtifactCanvasBridge.decode(#"{"type":"console","level":"trace","text":"x"}"#))
        XCTAssertNil(ArtifactCanvasBridge.decode(#"{"type":"console","level":"log"}"#))
        XCTAssertNil(ArtifactCanvasBridge.decode(#"{"type":"invented"}"#))
        XCTAssertNil(ArtifactCanvasBridge.decode("not json"))
        // A dictionary body means the page bypassed JSON.stringify, which means
        // it is not the script this bridge installed.
        XCTAssertNil(ArtifactCanvasBridge.decode(["type": "ready"]))
    }

    func testReadyCarriesTheSequence() throws {
        let event = try XCTUnwrap(
            ArtifactCanvasBridge.decode(#"{"type":"ready","sequence":1}"#)
        )
        XCTAssertEqual(event, .ready(sequence: 1))
    }

    func testSuccessfulStateReadingCarriesTheValue() throws {
        let event = try XCTUnwrap(
            ArtifactCanvasBridge.decode(
                #"{"type":"state","ok":true,"path":"app.count","value":"3"}"#
            )
        )

        guard case let .state(reading) = event else {
            return XCTFail("Expected a state event, got \(event)")
        }
        XCTAssertEqual(reading.path, "app.count")
        XCTAssertEqual(reading.value, "3")
        XCTAssertTrue(reading.succeeded)
    }

    /// A path that does not exist carries no value at all. Reporting
    /// `"undefined"` would be indistinguishable from a path that exists and
    /// holds `undefined`, and only one of those means the caller mistyped.
    func testFailedStateReadingHasNoValue() throws {
        let event = try XCTUnwrap(
            ArtifactCanvasBridge.decode(
                #"{"type":"state","ok":false,"path":"app.nope","error":"no 'nope' here"}"#
            )
        )

        guard case let .state(reading) = event else {
            return XCTFail("Expected a state event, got \(event)")
        }
        XCTAssertNil(reading.value)
        XCTAssertEqual(reading.failure, "no 'nope' here")
        XCTAssertFalse(reading.succeeded)
    }

    /// The path reaches the page inside a script the host builds, so a quote in
    /// it must not be able to close the literal and run what follows — inside a
    /// page that is already executing untrusted artifact code.
    func testInspectionScriptEscapesHostilePaths() throws {
        let script = ArtifactCanvasBridge.inspectionScript(
            path: #"a"); fetch("https://evil.example"); ("#
        )

        XCTAssertFalse(script.contains("fetch(\"https"))
        XCTAssertTrue(script.contains(#"\"); fetch(\"https:"#))
        XCTAssertTrue(script.contains("juno:inspect"))
        XCTAssertTrue(ArtifactCanvasBridge.inspectionScript(path: nil).contains("path: null"))
    }

    func testPageScriptStaysInsideItsSandbox() {
        let script = ArtifactCanvasBridge.pageScript

        XCTAssertTrue(script.contains(ArtifactCanvasBridge.messageHandlerName))
        XCTAssertTrue(script.contains(ArtifactCanvasBridge.inspectionEventName))
        // The CSP carries no 'unsafe-eval', so these could not run anyway; the
        // assertion keeps a future edit from quietly needing it.
        XCTAssertFalse(script.contains("eval("))
        XCTAssertFalse(script.contains("new Function"))
        // Nothing reads storage or credentials. The web view's ephemeral data
        // store already makes them empty, but an auditor should not have to take
        // the configuration on trust to know this script never looks.
        XCTAssertFalse(script.contains("document.cookie"))
        XCTAssertFalse(script.contains("localStorage"))
        XCTAssertFalse(script.contains("XMLHttpRequest"))
        XCTAssertFalse(script.contains("fetch("))
    }
}

// MARK: - Document composition

final class ArtifactCanvasDocumentTests: XCTestCase {
    /// The canvas must not have its own copy of the security policy. This is the
    /// test that fails if someone gives it one.
    func testExecutableDocumentIsExactlyTheSharedSandboxDocument() {
        for kind in [NativeArtifactKind.html, .svg, .markdown, .code, .mermaid, .design] {
            XCTAssertEqual(
                ArtifactCanvasDocument.make(kind: kind, content: "<p>hi</p>"),
                NativeArtifactSandbox.document(
                    kind: kind,
                    content: "<p>hi</p>",
                    policy: .document
                ),
                "\(kind) diverged from the shared sandbox document"
            )
        }
    }

    func testReactWithoutARuntimeShowsSourceAndSaysWhy() {
        let document = ArtifactCanvasDocument.make(
            kind: .react,
            content: "const App = () => <b>hi</b>;"
        )

        // Escaped, inert source — never an executable script the page cannot
        // satisfy, and never a blank pane.
        XCTAssertTrue(document.contains("script-src 'none'"))
        XCTAssertTrue(document.contains("&lt;b&gt;hi&lt;/b&gt;"))
        XCTAssertEqual(
            ArtifactCanvasDocument.availability(kind: .react, runtime: nil),
            .runtimeNotInstalled(language: "React")
        )
        XCTAssertNotNil(
            ArtifactCanvasDocument.availability(kind: .react, runtime: nil).explanation
        )
    }

    func testReactWithABundledRuntimeMountsInsideTheSameSandbox() throws {
        let runtime = ArtifactCanvasRuntime(scripts: ["/* react umd */"])

        let document = ArtifactCanvasDocument.make(
            kind: .react,
            content: "const App = () => <b>hi</b>;",
            runtime: runtime
        )

        XCTAssertTrue(document.contains(#"<div id="root"></div>"#))
        XCTAssertTrue(document.contains("/* react umd */"))
        XCTAssertTrue(document.contains(#"<script type="text/babel" data-presets="react">"#))
        XCTAssertTrue(document.contains("React.createElement(component)"))
        // The sandbox is not relaxed to make this work: same CSP, still no
        // network of any kind.
        XCTAssertTrue(document.contains("default-src 'none'"))
        XCTAssertTrue(document.contains("connect-src 'none'"))
        XCTAssertTrue(document.contains("script-src 'unsafe-inline'"))
        XCTAssertEqual(
            ArtifactCanvasDocument.availability(kind: .react, runtime: runtime),
            .renderable
        )
    }

    /// The HTML tokenizer ends a script at the first `</script`, including one
    /// inside a JavaScript string. Without the escape, this artifact would close
    /// its own block and spill the rest of the file into the document as markup.
    func testInlineScriptEscapingNeutralisesAClosingTagInsideAStringLiteral() {
        let hostile = #"const tag = "</script><img src=x onerror=alert(1)>";"#

        let escaped = ArtifactCanvasDocument.escapedForInlineScript(hostile)
        XCTAssertFalse(escaped.contains("</script>"))
        XCTAssertTrue(escaped.contains(#"<\/script>"#))

        let document = ArtifactCanvasDocument.make(
            kind: .react,
            content: hostile,
            runtime: ArtifactCanvasRuntime(scripts: [])
        )
        XCTAssertFalse(document.contains("</script><img"))
    }

    func testAvailabilityMirrorsWhatTheSharedPreviewCanActuallyDraw() {
        XCTAssertEqual(ArtifactCanvasDocument.availability(kind: .html, runtime: nil), .renderable)
        XCTAssertEqual(ArtifactCanvasDocument.availability(kind: .svg, runtime: nil), .renderable)
        XCTAssertEqual(
            ArtifactCanvasDocument.availability(kind: .mermaid, runtime: nil),
            .notRenderable
        )
        // A design opens in the design editor, which this canvas is not.
        XCTAssertEqual(
            ArtifactCanvasDocument.availability(kind: .design, runtime: nil),
            .notRenderable
        )
    }
}

// MARK: - Model

@MainActor
final class ArtifactCanvasModelTests: XCTestCase {
    func testStartsOnPreviewOnlyWhenSomethingCanBePreviewed() {
        XCTAssertEqual(ArtifactCanvasModel(kind: .html).selectedTab, .preview)
        XCTAssertEqual(ArtifactCanvasModel(kind: .react).selectedTab, .code)
        XCTAssertEqual(
            ArtifactCanvasModel(kind: .react, runtime: ArtifactCanvasRuntime(scripts: []))
                .selectedTab,
            .preview
        )
        XCTAssertEqual(ArtifactCanvasModel(kind: .mermaid).selectedTab, .code)
    }

    /// Before the page reports in there is no verdict, and a "bridge
    /// disconnected" badge during the first frames of every load is a false
    /// alarm the user learns to ignore.
    func testBridgeConnectionIsUnknownUntilThePageReportsIn() {
        let model = ArtifactCanvasModel(kind: .html)
        XCTAssertNil(model.isBridgeConnected)

        model.ingest(#"{"type":"ready","sequence":1}"#)

        XCTAssertEqual(model.isBridgeConnected, true)
    }

    func testCountsErrorsAndWarningsSeparately() {
        let model = ArtifactCanvasModel(kind: .html)

        model.ingest(#"{"type":"console","level":"error","text":"bad"}"#)
        model.ingest(#"{"type":"error","kind":"exception","message":"worse"}"#)
        model.ingest(#"{"type":"console","level":"warn","text":"hmm"}"#)
        model.ingest(#"{"type":"console","level":"log","text":"fine"}"#)

        XCTAssertEqual(model.entries.count, 4)
        XCTAssertEqual(model.errorCount, 2)
        XCTAssertEqual(model.warningCount, 1)
    }

    /// A console that silently drops its beginning makes a reader trust a
    /// transcript that is missing the line they need.
    func testDiscardedLinesAreCountedNotHidden() {
        let model = ArtifactCanvasModel(kind: .html)
        let overflow = 5

        for index in 0..<(ArtifactCanvasModel.maximumEntries + overflow) {
            model.ingest(#"{"type":"console","level":"log","text":"line \#(index)"}"#)
        }

        XCTAssertEqual(model.entries.count, ArtifactCanvasModel.maximumEntries)
        XCTAssertEqual(model.discardedEntryCount, overflow)
        XCTAssertEqual(model.entries.first?.message.text, "line \(overflow)")
        XCTAssertEqual(model.entries.last?.message.text, "line \(ArtifactCanvasModel.maximumEntries + overflow - 1)")
    }

    /// A bridge that has silently stopped decoding looks exactly like an
    /// artifact that stopped logging, so the difference is recorded.
    func testUndecodablePayloadsAreCounted() {
        let model = ArtifactCanvasModel(kind: .html)

        model.ingest("garbage")
        model.ingest(#"{"type":"console","level":"nope","text":"x"}"#)
        model.ingest(#"{"type":"console","level":"log","text":"ok"}"#)

        XCTAssertEqual(model.undecodableMessageCount, 2)
        XCTAssertEqual(model.entries.count, 1)
    }

    func testReloadClearsThePreviousDocumentsTranscript() {
        let model = ArtifactCanvasModel(kind: .html)
        model.ingest(#"{"type":"ready"}"#)
        model.ingest(#"{"type":"console","level":"error","text":"stale"}"#)

        model.documentWillLoad()

        // Carrying an error across a reload makes a fixed artifact look broken.
        XCTAssertTrue(model.entries.isEmpty)
        XCTAssertEqual(model.errorCount, 0)
        XCTAssertNil(model.isBridgeConnected)
    }

    func testInspectSendsAPathAndSurfacesTheReply() {
        let model = ArtifactCanvasModel(kind: .html)
        let recorder = ScriptRecorder()
        model.attach { recorder.scripts.append($0) }

        model.inspect(path: "  app.count  ")
        model.ingest(#"{"type":"state","ok":true,"path":"app.count","value":"3"}"#)

        XCTAssertEqual(recorder.scripts.count, 1)
        XCTAssertTrue(try XCTUnwrap(recorder.scripts.first).contains(#""app.count""#))
        XCTAssertEqual(model.readings.first?.value, "3")
    }

    func testInspectWithoutAPathAsksForTheDocumentSnapshot() {
        let model = ArtifactCanvasModel(kind: .html)
        let recorder = ScriptRecorder()
        model.attach { recorder.scripts.append($0) }

        model.inspect()
        model.inspect(path: "   ")

        XCTAssertEqual(recorder.scripts.count, 2)
        XCTAssertTrue(recorder.scripts.allSatisfy { $0.contains("path: null") })
    }

    func testDetachStopsSendingIntoADeadPage() {
        let model = ArtifactCanvasModel(kind: .html)
        let recorder = ScriptRecorder()
        model.attach { recorder.scripts.append($0) }

        model.detach()
        model.inspect(path: "app")

        XCTAssertTrue(recorder.scripts.isEmpty)
    }

    @MainActor
    private final class ScriptRecorder {
        var scripts: [String] = []
    }
}
