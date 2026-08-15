import Foundation

// Mermaid fences: detection, isolation, and the host document — all of it pure.
//
// **Nothing in this file imports WebKit or SwiftUI**, which is the point. The
// three things that can go wrong with a diagram are (1) a ```mermaid fence not
// being recognised, (2) a fence being recognised when it should not be, and (3)
// model-authored source escaping the JavaScript string literal it is embedded
// in and executing as code. All three are string problems, so all three are
// testable without a view, a run loop, or a browser.
//
// ── The security posture, and why it changed ─────────────────────────────────
//
// `JunoLearningBlockViews.swift` used to state that native would *not* render
// Mermaid, on the grounds that "a WKWebView loading a CDN inside the transcript
// is a different security posture". That reasoning was right about the CDN and
// wrong about the conclusion, and the distinction is worth stating precisely,
// because it is the contract the rest of this file implements:
//
//   * The engine is never fetched. ``JunoMermaidEngine`` holds JavaScript the
//     *host application* supplies from its own bundle, once, at launch. This
//     package ships no engine and no `URLSession`, so it stays offline-capable
//     and the SPM target gains no resources.
//   * The document declares `default-src 'none'`, so even if an engine were
//     compromised it has nowhere to send anything.
//   * `mermaid.initialize` runs with `securityLevel: 'strict'`, which is
//     Mermaid's own HTML-sanitising mode.
//   * The diagram source is embedded as a JSON string with `<`, `>` and `&`
//     escaped to `\uXXXX`, so `</script>` in a model's answer is inert.
//
// When no engine is registered, ``MermaidDiagramView`` shows the labelled
// source — the old behaviour, unchanged, and still the honest answer. That is
// the fallback, not the plan.

// MARK: - Fence detection

public enum JunoMermaidMarkup {
    /// Whether a fenced block's info string names Mermaid.
    ///
    /// Matches on the *first word* only, case-insensitively, so ```` ```mermaid ````
    /// and ```` ```Mermaid  ```` and ```` ```mermaid flowchart ```` all render
    /// while ```` ```mermaidjs-notes ```` — a plausible filename — does not. The
    /// info string is model output, so the test has to be a match rather than a
    /// prefix: a fence claiming to be a diagram gets a JavaScript engine pointed
    /// at it, and that is not a decision to make on a `hasPrefix`.
    public static func isMermaidFence(info: String?) -> Bool {
        guard let info else { return false }
        let first = info
            .trimmingCharacters(in: .whitespaces)
            .split(whereSeparator: { $0 == " " || $0 == "\t" })
            .first
        return first?.lowercased() == "mermaid"
    }

    /// The diagram's declared type, from its first meaningful line.
    ///
    /// Used for the header label and the VoiceOver description. It is
    /// deliberately *not* used to decide whether to render: Mermaid gains
    /// diagram types faster than this enum will, and refusing to draw an
    /// `unknown` would make every new type a silent regression. An unrecognised
    /// header renders and is announced as "diagram", which is true.
    public static func diagramKind(of source: String) -> JunoMermaidDiagramKind {
        guard let header = declarationLine(of: source) else { return .unknown }
        let lowered = header.lowercased()
        for kind in JunoMermaidDiagramKind.allCases {
            for keyword in kind.keywords where lowered.hasPrefix(keyword) {
                return kind
            }
        }
        return .unknown
    }

    /// The first line that declares something: YAML front matter, `%%`
    /// directives and comments, and blank lines are all skipped.
    ///
    /// Front matter matters more than it looks. `---\ntitle: X\n---\nflowchart LR`
    /// is common in generated diagrams, and a naive "first non-empty line" reads
    /// `---` and reports an unknown diagram for a perfectly ordinary flowchart.
    static func declarationLine(of source: String) -> String? {
        var lines = source.components(separatedBy: "\n")[...]

        if lines.first?.trimmingCharacters(in: .whitespaces) == "---" {
            lines = lines.dropFirst()
            while let line = lines.first, line.trimmingCharacters(in: .whitespaces) != "---" {
                lines = lines.dropFirst()
            }
            lines = lines.dropFirst()
        }

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("%%") { continue }
            return trimmed
        }
        return nil
    }
}

/// The diagram types Juno names in its chrome.
public enum JunoMermaidDiagramKind: String, CaseIterable, Sendable {
    case flowchart
    case sequence
    case classDiagram
    case stateDiagram
    case entityRelationship
    case userJourney
    case gantt
    case pie
    case quadrant
    case requirement
    case gitGraph
    case mindmap
    case timeline
    case unknown

    /// Lower-cased prefixes of Mermaid's own declaration keywords.
    ///
    /// Order inside a case matters where one keyword prefixes another —
    /// `stateDiagram-v2` before `stateDiagram` would be a bug in the other
    /// direction, so the longer form is not listed separately: `hasPrefix`
    /// already covers it.
    var keywords: [String] {
        switch self {
        case .flowchart: ["flowchart", "graph "]
        case .sequence: ["sequencediagram"]
        case .classDiagram: ["classdiagram"]
        case .stateDiagram: ["statediagram"]
        case .entityRelationship: ["erdiagram"]
        case .userJourney: ["journey"]
        case .gantt: ["gantt"]
        case .pie: ["pie"]
        case .quadrant: ["quadrantchart"]
        case .requirement: ["requirementdiagram"]
        case .gitGraph: ["gitgraph"]
        case .mindmap: ["mindmap"]
        case .timeline: ["timeline"]
        case .unknown: []
        }
    }

    /// The chrome label. Sentence case, because it sits in a block header beside
    /// a filename, not in a title.
    public var label: String {
        switch self {
        case .flowchart: "Flowchart"
        case .sequence: "Sequence diagram"
        case .classDiagram: "Class diagram"
        case .stateDiagram: "State diagram"
        case .entityRelationship: "Entity relationship diagram"
        case .userJourney: "User journey"
        case .gantt: "Gantt chart"
        case .pie: "Pie chart"
        case .quadrant: "Quadrant chart"
        case .requirement: "Requirement diagram"
        case .gitGraph: "Git graph"
        case .mindmap: "Mind map"
        case .timeline: "Timeline"
        case .unknown: "Diagram"
        }
    }
}

// MARK: - The host document

public extension JunoMermaidMarkup {
    /// Builds the complete, self-contained HTML the diagram WebView loads.
    ///
    /// Pure and total: same inputs, same bytes, no I/O. That is what lets a unit
    /// test assert the properties that actually matter — that the CSP is
    /// present, that `</script>` in the diagram source cannot terminate the
    /// literal, that the requested appearance reaches Mermaid — without booting
    /// WebKit.
    ///
    /// - Parameters:
    ///   - source: the diagram's Mermaid source, exactly as the model wrote it.
    ///   - engine: the host application's bundled Mermaid JavaScript.
    ///   - isDark: the *current* appearance. Theme changes go through
    ///     `junoSetTheme` at runtime rather than by rebuilding the document,
    ///     because reloading resets the reader's zoom and pan.
    static func hostDocument(source: String, engine: String, isDark: Bool) -> String {
        let literal = escapedForJavaScript(source)
        let theme = isDark ? "dark" : "default"
        return """
            <!doctype html>
            <html>
            <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1, \
            maximum-scale=1, user-scalable=no">
            <meta http-equiv="Content-Security-Policy" content="\(contentSecurityPolicy)">
            <style>\(styleSheet)</style>
            </head>
            <body>
            <div id="juno-stage"><div id="juno-canvas"></div></div>
            <script>\(engine)</script>
            <script>
            \(bootScript(literal: literal, theme: theme))
            </script>
            </body>
            </html>
            """
    }

    /// `default-src 'none'` is the load-bearing clause: the diagram may not
    /// fetch, may not XHR, may not open a socket. `'unsafe-inline'` on script
    /// and style is unavoidable — the engine and the stylesheet are inlined into
    /// this very document, which is *why* they are inlined rather than fetched.
    /// `img-src data:` lets Mermaid emit its own inline icons without opening a
    /// remote origin.
    static var contentSecurityPolicy: String {
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
            + "img-src data:; font-src data:; connect-src 'none'; frame-src 'none'"
    }

    /// Escapes a string for embedding inside a double-quoted JavaScript literal.
    ///
    /// Beyond the obvious quote and backslash: `<`, `>` and `&` become `\uXXXX`
    /// so a diagram containing `</script>` — a label a model can and does write —
    /// cannot close the surrounding element and turn the rest of the source into
    /// markup. U+2028 and U+2029 are escaped because JavaScript treats them as
    /// line terminators inside a literal even though JSON does not, which is the
    /// classic way a "valid JSON" embedding still produces a syntax error.
    static func escapedForJavaScript(_ string: String) -> String {
        var output = ""
        output.reserveCapacity(string.count + 16)
        for scalar in string.unicodeScalars {
            switch scalar {
            case "\\": output += "\\\\"
            case "\"": output += "\\\""
            case "\n": output += "\\n"
            case "\r": output += "\\r"
            case "\t": output += "\\t"
            case "<": output += "\\u003C"
            case ">": output += "\\u003E"
            case "&": output += "\\u0026"
            case "\u{2028}": output += "\\u2028"
            case "\u{2029}": output += "\\u2029"
            default:
                if scalar.value < 0x20 {
                    output += String(format: "\\u%04X", scalar.value)
                } else {
                    output.unicodeScalars.append(scalar)
                }
            }
        }
        return output
    }

    /// The name of the script-message handler the document posts through. One
    /// constant so the Swift side and the JavaScript side cannot drift — a typo
    /// here is a diagram that renders and then reports no height, which looks
    /// like a layout bug and is not.
    static var messageHandlerName: String { "junoDiagram" }
}

private extension JunoMermaidMarkup {
    /// The page's own chrome. Transparent background so the transcript's paper
    /// shows through — a diagram on its own white card inside a warm canvas is
    /// the "stack of panels" look the Markdown renderer exists to avoid.
    static var styleSheet: String {
        """
        html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
          -webkit-text-size-adjust: 100%;
        }
        #juno-stage {
          width: 100%; height: 100vh; overflow: hidden;
          touch-action: none; cursor: grab;
        }
        #juno-stage.juno-dragging { cursor: grabbing; }
        #juno-canvas { transform-origin: 0 0; will-change: transform; }
        #juno-canvas svg { max-width: none !important; height: auto; display: block; }
        .juno-error {
          font: 13px ui-monospace, SFMono-Regular, monospace;
          padding: 12px; white-space: pre-wrap;
        }
        """
    }

    /// Render, measure, and hand the reader zoom and pan.
    ///
    /// Height is measured and posted back rather than guessed, because a
    /// diagram's natural height is a property of the diagram and nothing on the
    /// Swift side can know it before the engine has laid it out. Until that
    /// message arrives the view shows a placeholder height — *not* zero. A
    /// zero-height WebView is indistinguishable from a diagram that failed, and
    /// collapsing the transcript around a block that is about to appear is the
    /// jump this whole measurement dance exists to prevent.
    static func bootScript(literal: String, theme: String) -> String {
        """
        (function () {
          var SOURCE = "\(literal)";
          var stage = document.getElementById("juno-stage");
          var canvas = document.getElementById("juno-canvas");
          var scale = 1, panX = 0, panY = 0;

          function post(payload) {
            try {
              window.webkit.messageHandlers.\(messageHandlerName).postMessage(payload);
            } catch (ignored) {}
          }

          function applyTransform() {
            canvas.style.transform =
              "translate(" + panX + "px," + panY + "px) scale(" + scale + ")";
          }

          function reportHeight() {
            var svg = canvas.querySelector("svg");
            if (!svg) { return; }
            var box = svg.getBoundingClientRect();
            if (box.height > 0) { post({ kind: "height", value: box.height }); }
          }

          function draw(themeName) {
            if (typeof mermaid === "undefined") {
              post({ kind: "error", value: "engine-missing" });
              return;
            }
            try {
              mermaid.initialize({
                startOnLoad: false,
                securityLevel: "strict",
                theme: themeName,
                fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'
              });
              var result = mermaid.render("juno-diagram-" + Date.now(), SOURCE);
              Promise.resolve(result).then(function (out) {
                canvas.innerHTML = (out && out.svg) ? out.svg : out;
                requestAnimationFrame(reportHeight);
              }).catch(function (error) {
                post({ kind: "error", value: String(error && error.message || error) });
              });
            } catch (error) {
              post({ kind: "error", value: String(error && error.message || error) });
            }
          }

          window.junoSetTheme = function (themeName) {
            scale = 1; panX = 0; panY = 0; applyTransform();
            draw(themeName);
          };
          window.junoResetView = function () {
            scale = 1; panX = 0; panY = 0; applyTransform();
          };

          stage.addEventListener("wheel", function (event) {
            if (!event.ctrlKey && !event.metaKey) { return; }
            event.preventDefault();
            var next = Math.min(6, Math.max(0.25, scale * (1 - event.deltaY / 300)));
            var rect = stage.getBoundingClientRect();
            var originX = event.clientX - rect.left, originY = event.clientY - rect.top;
            panX = originX - (originX - panX) * (next / scale);
            panY = originY - (originY - panY) * (next / scale);
            scale = next;
            applyTransform();
          }, { passive: false });

          stage.addEventListener("gesturechange", function (event) {
            event.preventDefault();
            scale = Math.min(6, Math.max(0.25, scale * event.scale));
            applyTransform();
          });

          var dragging = false, lastX = 0, lastY = 0;
          stage.addEventListener("pointerdown", function (event) {
            dragging = true; lastX = event.clientX; lastY = event.clientY;
            stage.classList.add("juno-dragging");
            stage.setPointerCapture(event.pointerId);
          });
          stage.addEventListener("pointermove", function (event) {
            if (!dragging) { return; }
            panX += event.clientX - lastX; panY += event.clientY - lastY;
            lastX = event.clientX; lastY = event.clientY;
            applyTransform();
          });
          function endDrag() { dragging = false; stage.classList.remove("juno-dragging"); }
          stage.addEventListener("pointerup", endDrag);
          stage.addEventListener("pointercancel", endDrag);

          window.addEventListener("resize", reportHeight);
          draw("\(theme)");
        })();
        """
    }
}
