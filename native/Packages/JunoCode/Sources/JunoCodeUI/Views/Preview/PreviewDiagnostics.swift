import Foundation
import JunoCodeCore
import WebKit

/// One console message from the page.
struct PreviewConsoleEntry: Equatable, Sendable, Identifiable {
    enum Level: String, Sendable {
        case error, warn, info, log, debug
    }

    let id: Int
    /// Which main-frame navigation it belongs to; entries survive navigation.
    let navigationID: Int
    let level: Level
    let text: String
    let at: Date
}

/// One request the page made, or a resource that failed.
struct PreviewNetworkEntry: Equatable, Sendable, Identifiable {
    enum Kind: String, Sendable {
        case document, fetch, xhr, websocket, resource
    }

    let id: Int
    let navigationID: Int
    let kind: Kind
    let method: String
    let url: String
    let status: Int?
    let failed: Bool
    let error: String?
    let durationMs: Int?
    let at: Date

    var summary: String {
        let statusText = status.map(String.init) ?? (failed ? "failed" : "pending")
        let duration = durationMs.map { " · \($0) ms" } ?? ""
        let reason = error.map { " · \($0)" } ?? ""
        return "#\(id) \(method) \(url) \(statusText)\(duration)\(reason)"
    }
}

/// Something the page did that the agent did not ask for and should hear
/// about: a blocked navigation, a cancelled download, a file chooser.
struct PreviewPageEvent: Equatable, Sendable, Identifiable {
    let id: Int
    let text: String
    let at: Date
}

/// The page's console, network and events since the Preview opened: 500 of
/// each, kept across navigations (each tagged with its navigation id), and
/// all of it untrusted page output (CODE_AGENT_SPEC §4.3, PV-22, PV-27).
@MainActor
final class PreviewDiagnostics {
    static let capacity = 500
    static let bodyCapacity = 50
    static let maximumBodyBytes = 64 * 1_024

    private(set) var console: [PreviewConsoleEntry] = []
    private(set) var network: [PreviewNetworkEntry] = []
    private(set) var events: [PreviewPageEvent] = []
    private var bodies: [Int: String] = [:]
    private var bodyOrder: [Int] = []
    private var nextID = 1
    private let redactor = SecretRedactor()

    /// Where "since the previous action" starts.
    struct Mark: Equatable, Sendable {
        var console: Int
        var network: Int
        var events: Int
    }

    var mark: Mark {
        Mark(console: console.last?.id ?? 0, network: network.last?.id ?? 0, events: events.last?.id ?? 0)
    }

    private func takeID() -> Int {
        defer { nextID += 1 }
        return nextID
    }

    func recordConsole(level: PreviewConsoleEntry.Level, text: String, navigationID: Int) {
        let clean = redactor.redact(String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2_000)))
        guard !clean.isEmpty else { return }
        console.append(PreviewConsoleEntry(id: takeID(), navigationID: navigationID, level: level, text: clean, at: Date()))
        if console.count > Self.capacity { console.removeFirst(console.count - Self.capacity) }
    }

    @discardableResult
    func recordNetwork(
        kind: PreviewNetworkEntry.Kind,
        method: String,
        url: String,
        status: Int?,
        failed: Bool,
        error: String?,
        durationMs: Int?,
        navigationID: Int,
        body: String? = nil
    ) -> Int {
        let id = takeID()
        network.append(PreviewNetworkEntry(
            id: id,
            navigationID: navigationID,
            kind: kind,
            method: String(method.prefix(12)).uppercased(),
            url: redactor.redact(String(url.prefix(600))),
            status: status,
            failed: failed,
            error: error.map { redactor.redact(String($0.prefix(300))) },
            durationMs: durationMs,
            at: Date()
        ))
        if network.count > Self.capacity { network.removeFirst(network.count - Self.capacity) }
        if let body {
            let bounded = String(decoding: Data(body.utf8).prefix(Self.maximumBodyBytes), as: UTF8.self)
            bodies[id] = redactor.redact(bounded)
            bodyOrder.append(id)
            if bodyOrder.count > Self.bodyCapacity {
                bodies.removeValue(forKey: bodyOrder.removeFirst())
            }
        }
        return id
    }

    func recordEvent(_ text: String) {
        events.append(PreviewPageEvent(id: takeID(), text: redactor.redact(text), at: Date()))
        if events.count > Self.capacity { events.removeFirst(events.count - Self.capacity) }
    }

    func body(for id: Int) -> String? { bodies[id] }

    func consoleSince(_ mark: Mark) -> [PreviewConsoleEntry] { console.filter { $0.id > mark.console } }
    func networkSince(_ mark: Mark) -> [PreviewNetworkEntry] { network.filter { $0.id > mark.network } }
    func eventsSince(_ mark: Mark) -> [PreviewPageEvent] { events.filter { $0.id > mark.events } }

    /// Console errors (and uncaught exceptions) after `mark`.
    func consoleErrors(since mark: Mark) -> [PreviewConsoleEntry] {
        consoleSince(mark).filter { $0.level == .error }
    }

    /// Requests after `mark` that failed or answered 4xx/5xx.
    func failedRequests(since mark: Mark) -> [PreviewNetworkEntry] {
        networkSince(mark).filter { $0.failed || ($0.status ?? 0) >= 400 }
    }

    // MARK: - The page shim

    static let messageName = "junoPreviewDiagnostics"

    /// Installed in the page's own world at document start, because console
    /// and fetch live there. Everything it reports is labelled untrusted, and
    /// a message is accepted only from a frame on the preview origin (the
    /// handler checks `frameInfo.securityOrigin`, PV-27).
    static let pageShim = """
    (() => {
      if (window.__junoPreviewShim) return;
      Object.defineProperty(window, "__junoPreviewShim", { value: true });
      const post = (payload) => {
        try { window.webkit.messageHandlers.junoPreviewDiagnostics.postMessage(payload); } catch (_) {}
      };
      const text = (value) => {
        try {
          if (value instanceof Error) return value.stack || value.message || String(value);
          if (typeof value === "string") return value;
          if (value === undefined) return "undefined";
          if (typeof value === "object") return JSON.stringify(value);
          return String(value);
        } catch (_) { return String(value); }
      };
      ["error", "warn", "info", "log", "debug"].forEach((level) => {
        const original = console[level];
        console[level] = function (...values) {
          post({ type: "console", level, text: values.map(text).join(" ").slice(0, 2000) });
          if (original) return original.apply(this, values);
        };
      });
      window.addEventListener("error", (event) => {
        const target = event.target;
        if (target && target !== window && (target.src || target.href)) {
          post({ type: "network", kind: "resource", method: "GET", url: String(target.src || target.href), failed: true, error: "failed to load " + (target.tagName || "").toLowerCase() });
          return;
        }
        post({ type: "console", level: "error", text: "Uncaught " + (event.error ? text(event.error) : (event.message + " (" + event.filename + ":" + event.lineno + ")")) });
      }, true);
      window.addEventListener("unhandledrejection", (event) => {
        post({ type: "console", level: "error", text: "Unhandled rejection: " + text(event.reason) });
      });
      const isText = (type) => /json|text|javascript|xml|html|graphql/i.test(type || "");
      const originalFetch = window.fetch;
      if (originalFetch) {
        window.fetch = async function (input, init) {
          const started = performance.now();
          const method = (init && init.method) || (input && input.method) || "GET";
          const url = typeof input === "string" ? input : (input && input.url) || String(input);
          try {
            const response = await originalFetch.apply(this, arguments);
            const entry = { type: "network", kind: "fetch", method, url: new URL(url, location.href).href, status: response.status, failed: false, durationMs: Math.round(performance.now() - started) };
            try {
              const length = Number(response.headers.get("content-length") || "0");
              if (isText(response.headers.get("content-type")) && length <= 65536) {
                response.clone().text().then((body) => post(Object.assign(entry, { body: body.slice(0, 65536) }))).catch(() => post(entry));
              } else { post(entry); }
            } catch (_) { post(entry); }
            return response;
          } catch (error) {
            post({ type: "network", kind: "fetch", method, url: String(url), failed: true, error: text(error), durationMs: Math.round(performance.now() - started) });
            throw error;
          }
        };
      }
      const OriginalXHR = window.XMLHttpRequest;
      if (OriginalXHR) {
        const open = OriginalXHR.prototype.open;
        const send = OriginalXHR.prototype.send;
        OriginalXHR.prototype.open = function (method, url) {
          this.__juno = { method: method || "GET", url: String(url) };
          return open.apply(this, arguments);
        };
        OriginalXHR.prototype.send = function () {
          const info = this.__juno || { method: "GET", url: "" };
          const started = performance.now();
          this.addEventListener("loadend", () => {
            let url = info.url;
            try { url = new URL(info.url, location.href).href; } catch (_) {}
            const failed = this.status === 0;
            const entry = { type: "network", kind: "xhr", method: info.method, url, status: failed ? null : this.status, failed, error: failed ? "network error" : null, durationMs: Math.round(performance.now() - started) };
            try {
              if (!failed && isText(this.getResponseHeader("content-type")) && typeof this.responseText === "string" && this.responseText.length <= 65536) entry.body = this.responseText;
            } catch (_) {}
            post(entry);
          });
          return send.apply(this, arguments);
        };
      }
      const OriginalSocket = window.WebSocket;
      if (OriginalSocket) {
        window.WebSocket = function (url, protocols) {
          const socket = protocols === undefined ? new OriginalSocket(url) : new OriginalSocket(url, protocols);
          socket.addEventListener("error", () => post({ type: "network", kind: "websocket", method: "GET", url: String(url), failed: true, error: "websocket error" }));
          return socket;
        };
        window.WebSocket.prototype = OriginalSocket.prototype;
        Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
      }
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.initiatorType === "fetch" || entry.initiatorType === "xmlhttprequest") continue;
            const status = typeof entry.responseStatus === "number" && entry.responseStatus > 0 ? entry.responseStatus : null;
            if (status && status >= 400) post({ type: "network", kind: "resource", method: "GET", url: entry.name, status, failed: false, durationMs: Math.round(entry.duration) });
          }
        }).observe({ type: "resource", buffered: true });
      } catch (_) {}
    })();
    """
}
