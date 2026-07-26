import Foundation

/// Reads a development server's address out of the server's own startup output.
///
/// This exists because there is no honest alternative. Every port Juno could
/// guess is wrong somewhere: Next defaults to 3000 but moves to 3001 when 3000
/// is taken, Vite uses 5173, Astro 4321, `serve` 3000, Rails 3000, Django 8000 —
/// and a project's config can change any of them. Assuming 3000 is what produced
/// the preview that pointed at whatever else happened to be listening.
///
/// So the address is *observed*, never assumed: the process prints where it is
/// listening, and until that line appears the server is "starting", not running.
///
/// Only addresses reachable from this Mac are accepted. A loopback host is taken
/// first, because Next and Vite print both a Local and a Network line and the
/// Local one is the one that works when the LAN interface changes.
public enum DevServerURLDetector {
    /// The first address in `line`, or nil when the line contains none.
    ///
    /// Deliberately per-line: the caller feeds whole lines as they are assembled,
    /// keeps the first hit, and ignores the rest — so a later "Network:" line
    /// cannot replace the address the preview is already showing.
    public static func detect(in line: String) -> URL? {
        if let url = firstURL(in: line, pattern: loopbackURL, normalizingHost: true) {
            return url
        }
        if let url = firstURL(in: line, pattern: privateURL, normalizingHost: false) {
            return url
        }
        // "localhost:5173" or "0.0.0.0:4000" with no scheme — Rails, Django and
        // several Node servers print the authority alone.
        if let port = firstCapturedPort(in: line, pattern: bareLocalhost) {
            return URL(string: "http://localhost:\(port)")
        }
        // Last resort: a sentence that names a port. Anchored on a serving verb
        // so a version number or a PID can never be mistaken for one.
        if let port = firstCapturedPort(in: line, pattern: spokenPort) {
            return URL(string: "http://localhost:\(port)")
        }
        return nil
    }

    // MARK: - Patterns

    /// Loopback in every spelling a server prints it, including the `0.0.0.0`
    /// bind address, which is a wildcard rather than a destination.
    private static let loopbackURL = expression(
        #"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])(?::\d{1,5})?(?:/[^\s"'`<>,;)\]]*)?"#
    )

    /// RFC 1918 addresses, kept as printed. A server that only advertises its LAN
    /// address is still reachable from this Mac, and rewriting the host to
    /// localhost would be a guess about which interfaces it bound.
    private static let privateURL = expression(
        #"https?://(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d{1,5})?(?:/[^\s"'`<>,;)\]]*)?"#
    )

    private static let bareLocalhost = expression(
        #"(?<![\w.:/])(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{1,5})\b"#
    )

    private static let spokenPort = expression(
        #"\b(?:listening|running|serving|started|starting|available|ready|bound)\b[^\n]{0,60}?\bport\s*[:=]?\s*(\d{2,5})\b"#
    )

    private static func expression(_ pattern: String) -> NSRegularExpression? {
        try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    }

    // MARK: - Matching

    private static func firstURL(
        in line: String,
        pattern: NSRegularExpression?,
        normalizingHost: Bool
    ) -> URL? {
        guard let pattern,
              let match = pattern.firstMatch(
                  in: line,
                  range: NSRange(line.startIndex..., in: line)
              ),
              let range = Range(match.range, in: line)
        else { return nil }

        let trimmed = trimTrailingPunctuation(String(line[range]))
        guard var components = URLComponents(string: trimmed) else { return nil }
        if let port = components.port, !(1...65_535).contains(port) { return nil }
        if normalizingHost, let host = components.host?.lowercased(),
           ["0.0.0.0", "::", "[::]"].contains(host)
        {
            // A wildcard bind is not an address a browser can open; the
            // equivalent destination on this machine is loopback.
            components.host = "localhost"
        }
        guard let url = components.url, url.host != nil else { return nil }
        return url
    }

    private static func firstCapturedPort(in line: String, pattern: NSRegularExpression?) -> Int? {
        guard let pattern,
              let match = pattern.firstMatch(
                  in: line,
                  range: NSRange(line.startIndex..., in: line)
              ),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: line),
              let port = Int(line[range]),
              (1...65_535).contains(port)
        else { return nil }
        return port
    }

    /// Trailing sentence punctuation is not part of the address. `.` and `/`
    /// are kept when they are a path, so `http://localhost:3000/` survives but
    /// `at http://localhost:3000.` does not lose its port.
    private static func trimTrailingPunctuation(_ value: String) -> String {
        var result = value
        while let last = result.last, ",;:.!?)]}'\"".contains(last) {
            result.removeLast()
        }
        return result
    }
}

/// Turns raw pipe bytes into printable lines.
///
/// Dev servers colour their output whether or not `NO_COLOR` is set — Vite's
/// banner and Next's ready line both arrive full of escape sequences — and this
/// log pane interprets none of them, exactly like the console drawer. Left in,
/// every line reads as `[36m➜ [39m`. They are removed here rather than in the
/// view so URL detection sees clean text too.
enum DevServerOutputSanitizer {
    /// CSI (`ESC[…`), OSC (`ESC]…BEL`) and single-character escapes.
    /// `\x{…}` rather than `\u{…}`: this is ICU's syntax, not Swift's.
    private static let ansi = try? NSRegularExpression(
        pattern: #"\x{1B}(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x{07}\x{1B}]*(?:\x{07}|\x{1B}\\)|[@-Z\\-_])"#
    )

    static func sanitize(_ text: String) -> String {
        var value = text
        if let ansi {
            value = ansi.stringByReplacingMatches(
                in: value,
                range: NSRange(value.startIndex..., in: value),
                withTemplate: ""
            )
        }
        // A progress line rewrites itself with a carriage return; keep only what
        // it settled on rather than showing the overwritten fragments.
        if let lastSegment = value.split(separator: "\r", omittingEmptySubsequences: false).last {
            value = String(lastSegment)
        }
        // Remaining C0 controls would render as empty boxes in a monospaced log.
        return String(
            String.UnicodeScalarView(
                value.unicodeScalars.filter { scalar in
                    scalar == "\t" || (scalar.value >= 0x20 && scalar.value != 0x7F)
                }
            )
        )
    }
}
