import Foundation
import JunoCodeCore

/// Reads one web page as text: documentation, a changelog, an issue.
///
/// Network access is a `critical` action — a URL can carry data out as easily
/// as bring it in — so it asks below Full Access, and a
/// `WebFetch(domain:docs.swift.org)` rule is how a reader stops being asked
/// about a site they trust. Only `http` and `https`; nothing is executed, and
/// the page's markup is reduced to text before the model sees it.
public struct WebFetchTool: CodeTool {
    public static let maximumDownloadBytes = 2 * 1_024 * 1_024
    public static let defaultCharacters = 40_000

    private let session: URLSession

    public init(session: URLSession = WebFetchTool.makeSession()) {
        self.session = session
    }

    public static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.httpAdditionalHeaders = ["User-Agent": "JunoCode/1.0 (+https://juno)"]
        return URLSession(configuration: configuration)
    }

    public let name = "web_fetch"
    public let description = """
        Fetch a web page over HTTP(S) and return its readable text. Use it for \
        documentation, changelogs, issues and API references the task needs. \
        Pass the full URL. Long pages are cut; pass max_characters to ask for \
        more or less. A redirect to another host is not followed: the result \
        names where it points, and you can fetch that URL next.
        """

    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "url": ["type": "string", "description": "An http or https URL"],
                "max_characters": ["type": "integer", "description": "Upper bound on returned text"],
            ],
            "required": ["url"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .critical }

    public func summary(input: JSONValue) -> String {
        let text = input["url"]?.stringValue ?? "?"
        return "Fetch " + (URL(string: text)?.host ?? text)
    }

    public func precheck(input: JSONValue) -> ToolError? {
        guard let text = input["url"]?.stringValue,
              let url = URL(string: text),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host?.isEmpty == false
        else {
            return .invalidInput(message: "web_fetch needs a full http or https URL.")
        }
        return nil
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let text = input["url"]?.stringValue, let url = URL(string: text) else {
            throw ToolError.invalidInput(message: "Missing 'url'.")
        }
        let limit = min(max(input["max_characters"]?.intValue ?? Self.defaultCharacters, 1_000), 200_000)

        // The guard is per request, not per session, so it holds whatever
        // session the tool was given.
        let (bytes, response) = try await session.bytes(from: url, delegate: RedirectGuard(origin: url))
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        if let http, let location = Self.refusedRedirect(http) {
            // A redirect off the approved host stops here rather than being
            // followed, and nothing of it is read. The model's next call names
            // the new URL itself, so the rules and the mode check that host.
            return ToolResult(
                content: """
                    URL: \(url.absoluteString)
                    Status: \(status)

                    Redirected to \(location.absoluteString). This fetch stopped there because \
                    the redirect leaves \(url.host ?? "the original host"). Call web_fetch on \
                    that URL to continue.
                    """,
                isError: false
            )
        }
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count >= Self.maximumDownloadBytes { break }
        }
        let contentType = http?.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
        let body = String(decoding: data, as: UTF8.self)
        let readable = contentType.contains("html") || body.prefix(512).lowercased().contains("<html")
            ? Self.text(fromHTML: body)
            : body
        let clipped = readable.count > limit
            ? String(readable.prefix(limit)) + "\n… [page truncated at \(limit) characters]"
            : readable
        let finalURL = response.url?.absoluteString ?? url.absoluteString
        return ToolResult(
            content: "URL: \(finalURL)\nStatus: \(status)\n\n" + clipped,
            isError: !(200..<400).contains(status)
        )
    }

    // MARK: - Redirects

    /// Keeps one fetch on the host its permission check approved.
    ///
    /// `ToolRuleSubjects` checks a `WebFetch(domain:…)` rule, and the mode, against
    /// the host of the URL the model asked for — nothing later. URLSession,
    /// left alone, follows a 3xx to any host, scheme or address, so an allow
    /// rule for one site covered wherever that site redirected: an open
    /// redirect or a shortener carried the query string, and any data in it,
    /// to a host the reader never approved, loopback and private ranges
    /// included. It also stepped round a deny rule, since any allowed URL
    /// that redirected to the denied host reached it.
    ///
    /// So a hop is followed only when it stays on the original host and does
    /// not drop from https to http. Every other one ends the fetch, and the
    /// model is told where it pointed.
    final class RedirectGuard: NSObject, URLSessionTaskDelegate, Sendable {
        let origin: URL

        init(origin: URL) {
            self.origin = origin
        }

        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest
        ) async -> URLRequest? {
            guard let target = request.url, WebFetchTool.mayFollow(from: origin, to: target) else {
                return nil
            }
            return request
        }
    }

    /// Whether a redirect from `origin` to `target` stays inside what the
    /// permission check approved.
    static func mayFollow(from origin: URL, to target: URL) -> Bool {
        guard let from = origin.host?.lowercased(), let to = target.host?.lowercased(), from == to,
              let fromScheme = origin.scheme?.lowercased(), let toScheme = target.scheme?.lowercased()
        else { return false }
        switch (fromScheme, toScheme) {
        case ("https", "https"), ("http", "http"), ("http", "https"): return true
        default: return false
        }
    }

    /// Where a redirect that was not followed pointed, if this response is one.
    static func refusedRedirect(_ response: HTTPURLResponse) -> URL? {
        guard [301, 302, 303, 307, 308].contains(response.statusCode),
              let location = response.value(forHTTPHeaderField: "Location"),
              let target = URL(string: location, relativeTo: response.url)?.absoluteURL
        else { return nil }
        return target
    }

    /// Markup to reading text: scripts, styles and tags out; block elements
    /// become line breaks; common entities decoded; whitespace collapsed.
    static func text(fromHTML html: String) -> String {
        var text = html
        for element in ["script", "style", "noscript", "svg", "head"] {
            text = text.replacingOccurrences(
                of: "<\(element)[^>]*>[\\s\\S]*?</\(element)>",
                with: " ",
                options: [.regularExpression, .caseInsensitive]
            )
        }
        text = text.replacingOccurrences(
            of: "<(br|/p|/div|/li|/h[1-6]|/tr|/pre|/section|/article)[^>]*>",
            with: "\n",
            options: [.regularExpression, .caseInsensitive]
        )
        text = text.replacingOccurrences(of: "<li[^>]*>", with: "\n• ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        for (entity, value) in [
            ("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
            ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&mdash;", "—"), ("&ndash;", "–"),
        ] {
            text = text.replacingOccurrences(of: entity, with: value)
        }
        text = text.replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\n\\s*\\n\\s*\\n+", with: "\n\n", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
