import Foundation
import Observation
import SwiftUI
#if canImport(WebKit)
import WebKit
#endif

// MARK: - Presentation

/// How the code and the running artifact are arranged.
///
/// Both are offered rather than one being chosen for the user because the two
/// answer different questions: side by side is for *editing* (change a line,
/// watch it land), tabbed is for *reading* on a narrow window, where a split
/// leaves neither pane wide enough to be legible.
public enum ArtifactCanvasLayout: String, CaseIterable, Identifiable, Sendable {
    case tabbed
    case sideBySide

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .tabbed: "Tabs"
        case .sideBySide: "Split"
        }
    }
}

public enum ArtifactCanvasTab: String, CaseIterable, Identifiable, Sendable {
    case code
    case preview
    case console

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .code: "Code"
        case .preview: "Preview"
        case .console: "Console"
        }
    }
}

/// Whether this artifact can actually run here, and if not, why not.
///
/// A plain `Bool` was not enough. "React, but no runtime is bundled" and "a
/// Mermaid diagram, which this canvas has no renderer for" both mean "no live
/// preview", and they need opposite things from the user: one is a build
/// configuration the app is missing, the other is simply not a runnable
/// document. Collapsing them left the user staring at source with no
/// explanation and no idea which one they were looking at.
public enum ArtifactCanvasPreviewAvailability: Equatable, Sendable {
    /// The sandbox will render this document.
    case renderable
    /// Renderable in principle, but the JavaScript runtime it needs is not
    /// installed in this build. See ``ArtifactCanvasRuntime``.
    case runtimeNotInstalled(language: String)
    /// This kind has no rendered form in the shared canvas at all.
    case notRenderable

    public var isRenderable: Bool { self == .renderable }

    public var explanation: String? {
        switch self {
        case .renderable:
            nil
        case let .runtimeNotInstalled(language):
            "Showing source: this build does not bundle a \(language) runtime, and the preview sandbox cannot download one."
        case .notRenderable:
            "Showing source: this artifact kind has no live preview."
        }
    }
}

// MARK: - Runtime bundle

/// An offline JavaScript runtime the canvas may inject to render a component
/// artifact, supplied by the app rather than by this package.
///
/// It exists because the preview sandbox denies *all* network access — the CSP
/// says `default-src 'none'` and a WebKit rule list blocks every hierarchical
/// URL — and a React snippet is not a document: it needs React, ReactDOM and a
/// JSX transform present in the page before it means anything. The usual answer
/// (a `<script src="https://unpkg.com/react">` tag) is precisely the thing this
/// sandbox is built to refuse, so the only honest route is bytes the app already
/// has on disk.
///
/// No such bundle ships in the repository today. That is why the canvas reports
/// ``ArtifactCanvasPreviewAvailability/runtimeNotInstalled(language:)`` and
/// shows source rather than an empty white pane: absence of a runtime is a fact
/// about this build, and the user is told which fact it is.
public struct ArtifactCanvasRuntime: Equatable, Sendable {
    /// Full JavaScript sources, in load order. Typically the UMD builds of
    /// React, ReactDOM and the standalone JSX compiler.
    public let scripts: [String]
    /// The `type` attribute the artifact's own source is given. `text/babel`
    /// hands it to the standalone compiler instead of the JavaScript parser.
    public let sourceScriptType: String
    /// Value for `data-presets`, when the compiler wants one.
    public let presets: String?
    public let mountElementID: String
    /// The identifier the artifact is expected to define. Rendering looks this
    /// up rather than guessing at the last declaration in the file.
    public let componentIdentifier: String

    public init(
        scripts: [String],
        sourceScriptType: String = "text/babel",
        presets: String? = "react",
        mountElementID: String = "root",
        componentIdentifier: String = "App"
    ) {
        self.scripts = scripts
        self.sourceScriptType = sourceScriptType
        self.presets = presets
        self.mountElementID = mountElementID
        self.componentIdentifier = componentIdentifier
    }
}

// MARK: - Document

/// Builds the document the canvas loads.
///
/// Everything about *security* is delegated to ``NativeArtifactSandbox``: the
/// CSP, the escaping of non-executable kinds, and the injection of security
/// metadata ahead of artifact-supplied head content all stay in the one place
/// that is already tested for them. This type only decides *what content* goes
/// in, so a change to the policy cannot apply to the inline preview and miss the
/// canvas.
public enum ArtifactCanvasDocument {
    public static func make(
        kind: NativeArtifactKind,
        content: String,
        runtime: ArtifactCanvasRuntime? = nil
    ) -> String {
        guard kind == .react, let runtime else {
            return NativeArtifactSandbox.document(
                kind: kind,
                content: content,
                policy: .document
            )
        }
        // Presented to the sandbox as HTML, because that is what it now is: a
        // document with a mount point and inline scripts. Routing it through the
        // same `.html` branch means it gets the same CSP and the same treatment
        // as any other executable artifact.
        return NativeArtifactSandbox.document(
            kind: .html,
            content: reactHostBody(source: content, runtime: runtime),
            policy: .document
        )
    }

    public static func availability(
        kind: NativeArtifactKind,
        runtime: ArtifactCanvasRuntime?
    ) -> ArtifactCanvasPreviewAvailability {
        if kind.isDesignDocument { return .notRenderable }
        if kind == .react {
            return runtime == nil ? .runtimeNotInstalled(language: "React") : .renderable
        }
        return kind.supportsRenderedPreview ? .renderable : .notRenderable
    }

    static func reactHostBody(source: String, runtime: ArtifactCanvasRuntime) -> String {
        let presets = runtime.presets.map { " data-presets=\"\($0)\"" } ?? ""
        let runtimeScripts = runtime.scripts
            .map { "<script>\(escapedForInlineScript($0))</script>" }
            .joined(separator: "\n")
        // The mount block is compiled by the same transformer as the artifact,
        // and not emitted as a plain `<script>`, because the standalone JSX
        // compiler collects and runs its own script blocks after the document
        // has parsed. A plain script placed after them runs *first*, when the
        // component is still undefined, and every React artifact would mount
        // nothing and report a bug that is entirely the harness's.
        return """
        <div id="\(runtime.mountElementID)"></div>
        \(runtimeScripts)
        <script type="\(runtime.sourceScriptType)"\(presets)>
        \(escapedForInlineScript(source))
        </script>
        <script type="\(runtime.sourceScriptType)"\(presets)>
        (function () {
          var mount = document.getElementById("\(runtime.mountElementID)");
          var component = typeof \(runtime.componentIdentifier) !== "undefined"
            ? \(runtime.componentIdentifier)
            : null;
          if (!component) {
            console.error(
              "This artifact defines no `\(runtime.componentIdentifier)` component, so there is nothing to mount."
            );
            return;
          }
          if (typeof ReactDOM === "undefined" || typeof React === "undefined") {
            console.error("The bundled React runtime did not load.");
            return;
          }
          if (typeof ReactDOM.createRoot === "function") {
            ReactDOM.createRoot(mount).render(React.createElement(component));
          } else {
            ReactDOM.render(React.createElement(component), mount);
          }
        })();
        </script>
        """
    }

    /// Neutralises `</script` inside script bodies.
    ///
    /// The HTML tokenizer ends a script element at the first `</script`
    /// *anywhere* in its text, including inside a JavaScript string literal, so
    /// an artifact containing `const tag = "</script>"` would close its own
    /// block and drop the remainder of the file into the document as markup.
    /// `<\/` is an escape the JavaScript parser accepts and the HTML tokenizer
    /// does not recognise as a closing tag.
    static func escapedForInlineScript(_ source: String) -> String {
        source
            .replacingOccurrences(of: "</", with: "<\\/")
            .replacingOccurrences(of: "<!--", with: "<\\!--")
    }
}

// MARK: - Bridge protocol

public enum ArtifactConsoleLevel: String, Equatable, Sendable, CaseIterable {
    case debug
    case log
    case info
    case warn
    case error
}

/// Where a console line came from. Kept distinct from the level because an
/// uncaught exception and a `console.error` call are both errors and are not the
/// same event: one means the artifact stopped, the other means it complained.
public enum ArtifactConsoleOrigin: String, Equatable, Sendable {
    case console
    case uncaughtException
    case unhandledRejection
    /// A subresource the sandbox refused to load. Almost always a CDN script or
    /// font, and the single most common reason an otherwise-correct artifact
    /// renders blank, so it is surfaced rather than swallowed.
    case blockedResource
}

/// Where in the artifact something happened.
///
/// Every field is optional and `0` is never stored: `window.onerror` reports
/// line `0` when it has no location (a cross-origin script, a compiled bundle
/// without a source map), and a console pane that prints "line 0" sends the
/// reader to the top of a file that has nothing wrong with it.
public struct ArtifactSourceLocation: Equatable, Sendable {
    public let source: String?
    public let line: Int?
    public let column: Int?

    public init(source: String?, line: Int?, column: Int?) {
        self.source = source
        self.line = line
        self.column = column
    }

    public var isEmpty: Bool { source == nil && line == nil && column == nil }
}

/// One decoded console or error message, without identity.
///
/// Identity is added by ``ArtifactCanvasModel`` at ingest, which keeps this type
/// `Equatable` and lets a test assert on a decoded message directly instead of
/// picking it apart field by field around an unpredictable `UUID`.
public struct ArtifactConsoleMessage: Equatable, Sendable {
    public let level: ArtifactConsoleLevel
    public let origin: ArtifactConsoleOrigin
    public let text: String
    /// How many arguments the page passed to `console.log`. Nil when the message
    /// did not come from a console call at all — not `0`, which would claim a
    /// call was made with no arguments.
    public let argumentCount: Int?
    public let location: ArtifactSourceLocation?
    public let stack: String?
    /// The page's own monotonic counter. Ordering by arrival is not reliable:
    /// WebKit delivers script messages asynchronously and a burst logged inside
    /// one synchronous frame can arrive out of order.
    public let sequence: Int?
    /// Page wall-clock. Nil when the page did not stamp the message; the model
    /// does not substitute its own arrival time, which would be a different
    /// measurement wearing the same label.
    public let pageDate: Date?

    public init(
        level: ArtifactConsoleLevel,
        origin: ArtifactConsoleOrigin,
        text: String,
        argumentCount: Int? = nil,
        location: ArtifactSourceLocation? = nil,
        stack: String? = nil,
        sequence: Int? = nil,
        pageDate: Date? = nil
    ) {
        self.level = level
        self.origin = origin
        self.text = text
        self.argumentCount = argumentCount
        self.location = location
        self.stack = stack
        self.sequence = sequence
        self.pageDate = pageDate
    }
}

/// The answer to one state-inspection request.
public struct ArtifactStateReading: Equatable, Sendable {
    /// The dotted path that was asked for, or nil for the document snapshot.
    public let path: String?
    /// The rendered value, present only when the read succeeded.
    ///
    /// A failed read carries no value at all rather than `"undefined"`: a path
    /// that does not exist and a path holding `undefined` are different facts,
    /// and only one of them means the caller typed the wrong name.
    public let value: String?
    public let failure: String?
    public let sequence: Int?
    public let pageDate: Date?

    public init(
        path: String?,
        value: String?,
        failure: String?,
        sequence: Int? = nil,
        pageDate: Date? = nil
    ) {
        self.path = path
        self.value = value
        self.failure = failure
        self.sequence = sequence
        self.pageDate = pageDate
    }

    public var succeeded: Bool { value != nil && failure == nil }
}

public enum ArtifactCanvasEvent: Equatable, Sendable {
    /// The bridge installed itself. Sent once per document load, so a canvas
    /// that never receives it knows its JavaScript never ran.
    case ready(sequence: Int?)
    case console(ArtifactConsoleMessage)
    case state(ArtifactStateReading)
}

/// The page half of the canvas bridge: the handler name, the script that runs
/// inside the sandbox, and a decoder for what comes back.
///
/// The decoder is deliberately free of WebKit. `WKScriptMessage.body` is
/// `Any`, and every interesting failure — a level the page invented, a line
/// number of `0`, a payload that is not a dictionary at all — can be reproduced
/// with a Swift literal, so none of these tests need a web view, a run loop, or
/// a window.
public enum ArtifactCanvasBridge {
    /// Must match the identifier used inside ``pageScript``.
    public static let messageHandlerName = "junoArtifactCanvas"

    /// The event the host dispatches into the page to request a reading.
    public static let inspectionEventName = "juno:inspect"

    // MARK: Decoding

    /// - Parameter body: the raw `WKScriptMessage.body`. Expected to be the
    ///   JSON string the page produced.
    /// - Returns: nil for anything unrecognised. The caller counts those rather
    ///   than ignoring them, because a bridge that has silently stopped
    ///   decoding looks exactly like an artifact that stopped logging.
    public static func decode(_ body: Any) -> ArtifactCanvasEvent? {
        guard let text = body as? String,
            let data = text.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return decode(object: object)
    }

    static func decode(object: [String: Any]) -> ArtifactCanvasEvent? {
        let sequence = positiveInt(object["sequence"])
        let pageDate = epochMilliseconds(object["timestamp"])
        switch object["type"] as? String {
        case "ready":
            return .ready(sequence: sequence)
        case "console":
            guard let level = (object["level"] as? String)
                .flatMap(ArtifactConsoleLevel.init(rawValue:))
            else { return nil }
            guard let text = object["text"] as? String else { return nil }
            return .console(
                ArtifactConsoleMessage(
                    level: level,
                    origin: .console,
                    text: text,
                    argumentCount: nonNegativeInt(object["argumentCount"]),
                    location: nil,
                    stack: nil,
                    sequence: sequence,
                    pageDate: pageDate
                )
            )
        case "error":
            guard let message = object["message"] as? String else { return nil }
            let origin: ArtifactConsoleOrigin
            switch object["kind"] as? String {
            case "rejection": origin = .unhandledRejection
            case "resource": origin = .blockedResource
            case "exception": origin = .uncaughtException
            // An error whose kind the page did not name is still an error, but
            // it must not be filed as an uncaught exception on a guess: that
            // would tell the reader the artifact stopped running.
            default: return nil
            }
            let location = ArtifactSourceLocation(
                source: nonEmptyString(object["source"]),
                line: positiveInt(object["line"]),
                column: positiveInt(object["column"])
            )
            return .console(
                ArtifactConsoleMessage(
                    level: .error,
                    origin: origin,
                    text: message,
                    argumentCount: nil,
                    location: location.isEmpty ? nil : location,
                    stack: nonEmptyString(object["stack"]),
                    sequence: sequence,
                    pageDate: pageDate
                )
            )
        case "state":
            let succeeded = (object["ok"] as? NSNumber).map(\.boolValue) ?? false
            return .state(
                ArtifactStateReading(
                    path: nonEmptyString(object["path"]),
                    value: succeeded ? (object["value"] as? String) ?? "" : nil,
                    failure: succeeded ? nil : nonEmptyString(object["error"])
                        ?? "The page could not read that value.",
                    sequence: sequence,
                    pageDate: pageDate
                )
            )
        default:
            return nil
        }
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let text = value as? String, !text.isEmpty else { return nil }
        return text
    }

    /// Zero means "unknown" for every numeric field the page reports about a
    /// location: lines and columns are 1-based in every JavaScript engine, and
    /// `window.onerror` uses `0` as its "no idea" value.
    private static func positiveInt(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber,
            CFGetTypeID(number) != CFBooleanGetTypeID()
        else { return nil }
        let raw = number.doubleValue
        guard raw.rounded() == raw, raw >= 1, raw <= Double(Int.max) else { return nil }
        return Int(raw)
    }

    private static func nonNegativeInt(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber,
            CFGetTypeID(number) != CFBooleanGetTypeID()
        else { return nil }
        let raw = number.doubleValue
        guard raw.rounded() == raw, raw >= 0, raw <= Double(Int.max) else { return nil }
        return Int(raw)
    }

    private static func epochMilliseconds(_ value: Any?) -> Date? {
        guard let number = value as? NSNumber,
            CFGetTypeID(number) != CFBooleanGetTypeID()
        else { return nil }
        let raw = number.doubleValue
        guard raw.isFinite, raw > 0 else { return nil }
        return Date(timeIntervalSince1970: raw / 1_000)
    }

    // MARK: Page script

    /// Installed at document start, in the main frame only.
    ///
    /// Reads nothing but the artifact's own page. There is no access to
    /// `document.cookie` worth having — the web view runs on a fresh
    /// `WKWebsiteDataStore.nonPersistent()` and the document is loaded with a nil
    /// base URL, so its origin is opaque and shares no storage with anything —
    /// and this script deliberately does not touch it, so that a reader auditing
    /// the sandbox does not have to take the store configuration on trust.
    ///
    /// It also never calls `eval` or `new Function`. The CSP omits
    /// `'unsafe-eval'`, so it could not, and that constraint shaped the
    /// inspection design: reading `window.state.count` walks the path property by
    /// property. Adding `'unsafe-eval'` to make an inspector marginally more
    /// flexible would hand every artifact in the app the ability to assemble code
    /// at runtime, which is a far larger grant than the feature is worth.
    public static var pageScript: String {
        """
        (function () {
          "use strict";
          if (window.__junoArtifactCanvasInstalled) { return; }
          window.__junoArtifactCanvasInstalled = true;

          var HANDLER = "\(messageHandlerName)";
          var MAX_TEXT = 8192;
          var MAX_DEPTH = 4;
          var MAX_ITEMS = 40;
          var sequence = 0;

          function post(payload) {
            try {
              payload.sequence = ++sequence;
              payload.timestamp = Date.now();
              window.webkit.messageHandlers[HANDLER].postMessage(JSON.stringify(payload));
            } catch (error) {
              /* No host is attached. Reporting this through console.* would
                 recurse straight back into here, so it is dropped; the host
                 already knows, because it never received the ready message. */
            }
          }

          function truncate(text) {
            if (typeof text !== "string") { return String(text); }
            return text.length > MAX_TEXT
              ? text.slice(0, MAX_TEXT) + "… [" + (text.length - MAX_TEXT) + " more characters]"
              : text;
          }

          function describe(value, depth, seen) {
            if (value === null) { return "null"; }
            var type = typeof value;
            if (type === "undefined") { return "undefined"; }
            if (type === "string") { return value; }
            if (type === "number" || type === "boolean" || type === "bigint") {
              return String(value);
            }
            if (type === "symbol" || type === "function") { return String(value); }
            if (value instanceof Error) {
              return value.name + ": " + value.message;
            }
            if (typeof Node !== "undefined" && value instanceof Node) {
              var name = value.nodeName ? value.nodeName.toLowerCase() : "node";
              var id = value.id ? "#" + value.id : "";
              return "<" + name + id + ">";
            }
            if (depth >= MAX_DEPTH) { return "[…]"; }
            if (seen.indexOf(value) !== -1) { return "[circular]"; }
            seen.push(value);
            try {
              if (Array.isArray(value)) {
                var items = [];
                for (var i = 0; i < value.length && i < MAX_ITEMS; i++) {
                  items.push(describe(value[i], depth + 1, seen));
                }
                if (value.length > MAX_ITEMS) {
                  items.push("… " + (value.length - MAX_ITEMS) + " more");
                }
                return "[" + items.join(", ") + "]";
              }
              var keys = Object.keys(value);
              var parts = [];
              for (var k = 0; k < keys.length && k < MAX_ITEMS; k++) {
                parts.push(keys[k] + ": " + describe(value[keys[k]], depth + 1, seen));
              }
              if (keys.length > MAX_ITEMS) {
                parts.push("… " + (keys.length - MAX_ITEMS) + " more");
              }
              return "{" + parts.join(", ") + "}";
            } catch (error) {
              return "[unreadable]";
            } finally {
              seen.pop();
            }
          }

          var levels = ["debug", "log", "info", "warn", "error"];
          for (var l = 0; l < levels.length; l++) {
            (function (level) {
              var original = console[level];
              console[level] = function () {
                var args = Array.prototype.slice.call(arguments);
                var rendered = [];
                for (var a = 0; a < args.length; a++) {
                  rendered.push(describe(args[a], 0, []));
                }
                post({
                  type: "console",
                  level: level,
                  text: truncate(rendered.join(" ")),
                  argumentCount: args.length
                });
                /* The original is still called so Safari's Web Inspector, when a
                   developer attaches it, shows the same transcript this pane
                   does rather than an empty console. */
                if (typeof original === "function") {
                  try { original.apply(console, args); } catch (error) {}
                }
              };
            })(levels[l]);
          }

          window.addEventListener("error", function (event) {
            var target = event ? event.target : null;
            if (target && target !== window && target.tagName) {
              /* A subresource, not a script error: the sandbox blocks every
                 network URL, so this is how "your artifact asked for a CDN" is
                 reported instead of as an unexplained blank page. */
              post({
                type: "error",
                kind: "resource",
                message: "Blocked or failed to load: "
                  + truncate(String(target.src || target.href || target.tagName))
              });
              return;
            }
            post({
              type: "error",
              kind: "exception",
              message: truncate(String((event && event.message) || "Uncaught error")),
              source: (event && event.filename) || null,
              line: (event && typeof event.lineno === "number") ? event.lineno : null,
              column: (event && typeof event.colno === "number") ? event.colno : null,
              stack: (event && event.error && event.error.stack)
                ? truncate(String(event.error.stack))
                : null
            });
          }, true);

          window.addEventListener("unhandledrejection", function (event) {
            var reason = event ? event.reason : null;
            post({
              type: "error",
              kind: "rejection",
              message: truncate(describe(reason, 0, [])),
              stack: (reason && reason.stack) ? truncate(String(reason.stack)) : null
            });
          });

          function snapshot() {
            return {
              readyState: document.readyState,
              title: document.title,
              elementCount: document.getElementsByTagName("*").length,
              bodyChildren: document.body ? document.body.children.length : 0,
              location: String(window.location && window.location.protocol)
            };
          }

          function read(path) {
            var parts = String(path).split(".");
            var current = window;
            for (var i = 0; i < parts.length; i++) {
              var part = parts[i];
              if (current === null || current === undefined) {
                return { found: false, reason: "'" + parts.slice(0, i).join(".") + "' is not an object" };
              }
              if (!(part in Object(current))) {
                /* Missing and holding undefined are reported differently on
                   purpose: only one of them means the path is wrong. */
                return { found: false, reason: "no '" + part + "' here" };
              }
              current = current[part];
            }
            return { found: true, value: current };
          }

          window.addEventListener("\(inspectionEventName)", function (event) {
            var path = (event && event.detail && event.detail.path) || null;
            if (!path) {
              post({ type: "state", ok: true, path: null, value: describe(snapshot(), 0, []) });
              return;
            }
            var result;
            try {
              result = read(path);
            } catch (error) {
              post({ type: "state", ok: false, path: path, error: truncate(String(error)) });
              return;
            }
            if (!result.found) {
              post({ type: "state", ok: false, path: path, error: result.reason });
              return;
            }
            post({ type: "state", ok: true, path: path, value: truncate(describe(result.value, 0, [])) });
          });

          post({ type: "ready" });
        })();
        """
    }

    /// Built by the host and evaluated in the page. `path` is embedded through
    /// `JSONSerialization`, never string interpolation: a path typed by a user
    /// containing a quote would otherwise close the literal and run whatever
    /// followed it, inside a page that is executing untrusted artifact code.
    static func inspectionScript(path: String?) -> String {
        let detail: String
        if let path, let data = try? JSONSerialization.data(withJSONObject: [path]),
            let array = String(data: data, encoding: .utf8)
        {
            detail = "{ path: \(array)[0] }"
        } else {
            detail = "{ path: null }"
        }
        return """
        window.dispatchEvent(
          new CustomEvent("\(inspectionEventName)", { detail: \(detail) })
        );
        """
    }
}

// MARK: - Model

public struct ArtifactConsoleEntry: Identifiable, Equatable, Sendable {
    public let id: Int
    public let message: ArtifactConsoleMessage

    public init(id: Int, message: ArtifactConsoleMessage) {
        self.id = id
        self.message = message
    }
}

/// View state for one artifact canvas: what the page has said, what the user is
/// looking at, and the one handle back into the page.
@MainActor
@Observable
public final class ArtifactCanvasModel {
    /// Above this the oldest lines are discarded. A runaway `setInterval` that
    /// logs every frame reaches five figures in under a minute, and the pane has
    /// to stay responsive for the run that produced it.
    public static let maximumEntries = 500

    public let kind: NativeArtifactKind
    public let availability: ArtifactCanvasPreviewAvailability

    public var layout: ArtifactCanvasLayout
    public var selectedTab: ArtifactCanvasTab

    public private(set) var entries: [ArtifactConsoleEntry] = []
    /// How many lines the cap discarded. Shown, never hidden: a console that
    /// quietly drops its beginning makes a reader trust a transcript that is
    /// missing the line they need.
    public private(set) var discardedEntryCount = 0
    /// Payloads the decoder refused. A non-zero count here means the page and
    /// this decoder disagree about the protocol, which is a bug in Juno and not
    /// in the artifact — worth surfacing rather than absorbing.
    public private(set) var undecodableMessageCount = 0
    public private(set) var readings: [ArtifactStateReading] = []
    /// Nil until the page reports in. Three-valued, because "the bridge has not
    /// spoken yet" during load is not the same as "the bridge failed", and a
    /// disconnected badge shown for the first 200 ms of every artifact is noise.
    public private(set) var isBridgeConnected: Bool?

    @ObservationIgnored
    private var nextEntryID = 0
    @ObservationIgnored
    private var evaluator: (@MainActor (String) -> Void)?

    public init(
        kind: NativeArtifactKind,
        runtime: ArtifactCanvasRuntime? = nil,
        layout: ArtifactCanvasLayout = .sideBySide
    ) {
        self.kind = kind
        availability = ArtifactCanvasDocument.availability(kind: kind, runtime: runtime)
        self.layout = layout
        // Opening on Preview for something that cannot be previewed shows an
        // explanation where the artifact should be; the code is the useful view
        // in that case and is what the canvas opens on.
        selectedTab = availability.isRenderable ? .preview : .code
    }

    public var errorCount: Int {
        entries.count { $0.message.level == .error }
    }

    public var warningCount: Int {
        entries.count { $0.message.level == .warn }
    }

    /// Called by the web view coordinator once the page exists.
    public func attach(evaluator: @escaping @MainActor (String) -> Void) {
        self.evaluator = evaluator
    }

    public func detach() {
        evaluator = nil
    }

    /// Clears everything the previous document said. Called on reload, because
    /// carrying a stale error across a reload makes a fixed artifact look broken.
    public func documentWillLoad() {
        entries.removeAll()
        readings.removeAll()
        discardedEntryCount = 0
        undecodableMessageCount = 0
        isBridgeConnected = nil
    }

    /// Entry point from ``WKScriptMessageHandler``.
    public func ingest(_ body: Any) {
        guard let event = ArtifactCanvasBridge.decode(body) else {
            undecodableMessageCount += 1
            return
        }
        apply(event)
    }

    public func apply(_ event: ArtifactCanvasEvent) {
        switch event {
        case .ready:
            isBridgeConnected = true
        case let .console(message):
            append(message)
        case let .state(reading):
            readings.append(reading)
            if readings.count > 20 { readings.removeFirst(readings.count - 20) }
        }
    }

    public func clearConsole() {
        entries.removeAll()
        discardedEntryCount = 0
        undecodableMessageCount = 0
    }

    /// Asks the page for a value. The answer arrives asynchronously as a
    /// ``ArtifactCanvasEvent/state(_:)`` message and lands in ``readings``.
    ///
    /// Deliberately not `async`: awaiting a reply the page may never send —
    /// because its JavaScript is disabled, or it crashed, or it is mid-navigation
    /// — leaves a continuation that never resumes. A one-way request whose result
    /// simply appears cannot leak, and the absence of a reading is itself the
    /// honest report that nothing answered.
    public func inspect(path: String? = nil) {
        let trimmed = path?.trimmingCharacters(in: .whitespacesAndNewlines)
        evaluator?(
            ArtifactCanvasBridge.inspectionScript(
                path: (trimmed?.isEmpty ?? true) ? nil : trimmed
            )
        )
    }

    private func append(_ message: ArtifactConsoleMessage) {
        entries.append(ArtifactConsoleEntry(id: nextEntryID, message: message))
        nextEntryID += 1
        if entries.count > Self.maximumEntries {
            let excess = entries.count - Self.maximumEntries
            entries.removeFirst(excess)
            discardedEntryCount += excess
        }
    }
}

// MARK: - View

/// A code-and-preview canvas over one artifact.
///
/// The web view is isolated from the rest of the app on four independent
/// boundaries, each documented at its call site below: an ephemeral website data
/// store (no app cookies, no persisted storage, nothing shared with another
/// canvas), a nil base URL (an opaque origin, so no real origin's storage is
/// reachable), the shared `WKContentRuleList` that blocks every hierarchical URL
/// scheme including `file:`, and the CSP in the document itself. The keychain is
/// not reachable from web content at all, and no `URLCredentialStorage` or
/// `NSHTTPCookieStorage` is ever handed to this configuration.
public struct ArtifactCanvasView: View {
    private let content: String
    private let runtime: ArtifactCanvasRuntime?
    @Bindable private var model: ArtifactCanvasModel

    public init(
        content: String,
        runtime: ArtifactCanvasRuntime? = nil,
        model: ArtifactCanvasModel
    ) {
        self.content = content
        self.runtime = runtime
        _model = Bindable(model)
    }

    private var document: String {
        ArtifactCanvasDocument.make(kind: model.kind, content: content, runtime: runtime)
    }

    public var body: some View {
        VStack(spacing: 0) {
            controls
            Divider()
            panes
        }
        .accessibilityIdentifier("juno.artifact-canvas")
    }

    @ViewBuilder
    private var controls: some View {
        HStack(spacing: 12) {
            Picker("Layout", selection: $model.layout) {
                ForEach(ArtifactCanvasLayout.allCases) { layout in
                    Text(layout.title).tag(layout)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 160)

            if model.layout == .tabbed {
                Picker("Pane", selection: $model.selectedTab) {
                    ForEach(ArtifactCanvasTab.allCases) { tab in
                        Text(tab.title).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(maxWidth: 260)
            }

            Spacer(minLength: 0)
            consoleBadges
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var consoleBadges: some View {
        HStack(spacing: 8) {
            if model.errorCount > 0 {
                Label("\(model.errorCount)", systemImage: "xmark.octagon")
                    .foregroundStyle(.red)
            }
            if model.warningCount > 0 {
                Label("\(model.warningCount)", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            }
            Button("Clear") { model.clearConsole() }
                .buttonStyle(.borderless)
                .disabled(model.entries.isEmpty)
        }
        .font(.caption)
    }

    @ViewBuilder
    private var panes: some View {
        switch model.layout {
        case .tabbed:
            switch model.selectedTab {
            case .code: codePane
            case .preview: previewPane
            case .console: consolePane
            }
        case .sideBySide:
            HStack(spacing: 0) {
                codePane
                Divider()
                VStack(spacing: 0) {
                    previewPane
                    Divider()
                    consolePane.frame(maxHeight: 180)
                }
            }
        }
    }

    /// Reuses ``NativeArtifactPreview`` in source mode rather than restating its
    /// monospaced, selectable, horizontally-scrolling text layout.
    private var codePane: some View {
        NativeArtifactPreview(kind: model.kind, content: content, mode: .source)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var previewPane: some View {
        if let explanation = model.availability.explanation {
            VStack(spacing: 12) {
                Text(explanation)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                NativeArtifactPreview(kind: model.kind, content: content, mode: .source)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            #if canImport(WebKit)
            ArtifactCanvasWebView(document: document, model: model)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            #else
            // No WebKit on this platform, so nothing can run. Source is shown
            // with the reason attached rather than an empty rectangle.
            VStack(spacing: 12) {
                Text("Live preview needs WebKit, which is not available on this platform.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                NativeArtifactPreview(kind: model.kind, content: content, mode: .source)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            #endif
        }
    }

    private var consolePane: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4) {
                if model.discardedEntryCount > 0 {
                    Text("\(model.discardedEntryCount) earlier lines were discarded.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ForEach(model.entries) { entry in
                    ArtifactConsoleRow(message: entry.message)
                }
                ForEach(Array(model.readings.enumerated()), id: \.offset) { _, reading in
                    ArtifactStateRow(reading: reading)
                }
                if model.undecodableMessageCount > 0 {
                    Text("\(model.undecodableMessageCount) bridge messages could not be read.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
        }
        .accessibilityIdentifier("juno.artifact-canvas.console")
    }
}

private struct ArtifactConsoleRow: View {
    let message: ArtifactConsoleMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(label)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(tint)
                Text(message.text)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
            }
            if let location = message.location, let description = describe(location) {
                Text(description)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var label: String {
        switch message.origin {
        case .console: message.level.rawValue.uppercased()
        case .uncaughtException: "UNCAUGHT"
        case .unhandledRejection: "REJECTED"
        case .blockedResource: "BLOCKED"
        }
    }

    private var tint: Color {
        switch message.level {
        case .error: .red
        case .warn: .orange
        case .info, .log, .debug: .secondary
        }
    }

    /// Renders only the parts the page actually reported. A location with no
    /// line number prints the file alone, never "file:0".
    private func describe(_ location: ArtifactSourceLocation) -> String? {
        var parts: [String] = []
        if let source = location.source { parts.append(source) }
        if let line = location.line { parts.append("line \(line)") }
        if let column = location.column { parts.append("column \(column)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

private struct ArtifactStateRow: View {
    let reading: ArtifactStateReading

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("STATE")
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.blue)
            Text(text)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var text: String {
        let subject = reading.path ?? "document"
        if let value = reading.value { return "\(subject) = \(value)" }
        return "\(subject): \(reading.failure ?? "no reading")"
    }
}

// MARK: - Sandboxed web view

#if canImport(WebKit)
/// Hosts the sandboxed document and owns the two-way bridge.
struct ArtifactCanvasWebView {
    let document: String
    let model: ArtifactCanvasModel

    /// Handles page → host traffic and holds no reference to the web view.
    ///
    /// `WKUserContentController` retains its handlers, and the configuration
    /// retains the controller, so a handler holding the web view is a retain
    /// cycle that keeps a whole web process alive for every artifact ever
    /// opened. Host → page traffic goes the other way, through the coordinator's
    /// evaluator closure, which the model drops in `detach()`.
    @MainActor
    final class Bridge: NSObject, WKScriptMessageHandler {
        private let model: ArtifactCanvasModel

        init(model: ArtifactCanvasModel) {
            self.model = model
        }

        func userContentController(
            _ controller: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == ArtifactCanvasBridge.messageHandlerName else { return }
            model.ingest(message.body)
        }
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let model: ArtifactCanvasModel
        var lastDocument = ""
        var networkRulesInstalled = false

        init(model: ArtifactCanvasModel) {
            self.model = model
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            // Same rule as the inline preview: a canvas never navigates itself
            // to the network. A link the user activated is handed to the system
            // browser, where it is visibly outside the app.
            if let url = navigationAction.request.url,
                let scheme = url.scheme?.lowercased(),
                scheme == "http" || scheme == "https"
            {
                if navigationAction.navigationType == .linkActivated {
                    Self.openExternally(url)
                }
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            nil
        }

        private static func openExternally(_ url: URL) {
            #if os(macOS)
            NSWorkspace.shared.open(url)
            #elseif canImport(UIKit)
            UIApplication.shared.open(url)
            #endif
        }
    }

    @MainActor
    func makeCoordinator() -> Coordinator {
        Coordinator(model: model)
    }

    @MainActor
    private func makeWebView(coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Isolation 1: an ephemeral store, created fresh here. The app's cookies
        // and credentials live in the app; this store starts empty, is never
        // written to disk, and is not shared with another canvas or with the
        // inline preview.
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let controller = configuration.userContentController
        controller.add(Bridge(model: model), name: ArtifactCanvasBridge.messageHandlerName)
        // At document start, so a `console.log` in the artifact's first inline
        // script is captured. Main frame only: the CSP forbids frames, and a
        // bridge in a frame that should not exist is a second place to audit.
        controller.addUserScript(
            WKUserScript(
                source: ArtifactCanvasBridge.pageScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        #if os(iOS)
        webView.scrollView.bounces = false
        #endif

        coordinator.lastDocument = document
        model.attach { [weak webView] script in
            webView?.evaluateJavaScript(script)
        }

        // Isolation 3: the same compiled rule list the inline preview uses,
        // blocking every hierarchical URL scheme — including `file:`, so the
        // page cannot read the user's disk even if the CSP were bypassed.
        NativeArtifactContentRules.shared.install(into: controller) { installed in
            coordinator.networkRulesInstalled = installed
            model.documentWillLoad()
            // Fails closed: with no rule list there is no second boundary, so
            // the artifact is not loaded at all.
            let html = installed
                ? coordinator.lastDocument
                : NativeArtifactSandbox.previewUnavailableDocument
            // Isolation 2: a nil base URL gives the document an opaque origin,
            // so `localStorage`, `indexedDB` and any same-origin fetch resolve
            // against nothing the app owns.
            webView.loadHTMLString(html, baseURL: nil)
        }
        return webView
    }

    @MainActor
    private func updateWebView(_ webView: WKWebView, coordinator: Coordinator) {
        guard coordinator.lastDocument != document else { return }
        coordinator.lastDocument = document
        guard coordinator.networkRulesInstalled else { return }
        model.documentWillLoad()
        webView.loadHTMLString(document, baseURL: nil)
    }

    @MainActor
    private static func dismantle(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.model.detach()
        let controller = webView.configuration.userContentController
        // Without this the controller keeps the bridge, and the bridge keeps the
        // model, for as long as the configuration lives.
        controller.removeScriptMessageHandler(
            forName: ArtifactCanvasBridge.messageHandlerName
        )
        controller.removeAllUserScripts()
    }
}

#if os(macOS)
extension ArtifactCanvasWebView: NSViewRepresentable {
    @MainActor
    func makeNSView(context: Context) -> WKWebView {
        makeWebView(coordinator: context.coordinator)
    }

    @MainActor
    func updateNSView(_ nsView: WKWebView, context: Context) {
        updateWebView(nsView, coordinator: context.coordinator)
    }

    @MainActor
    static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
        dismantle(nsView, coordinator: coordinator)
    }
}
#else
extension ArtifactCanvasWebView: UIViewRepresentable {
    @MainActor
    func makeUIView(context: Context) -> WKWebView {
        makeWebView(coordinator: context.coordinator)
    }

    @MainActor
    func updateUIView(_ uiView: WKWebView, context: Context) {
        updateWebView(uiView, coordinator: context.coordinator)
    }

    @MainActor
    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        dismantle(uiView, coordinator: coordinator)
    }
}
#endif
#endif
