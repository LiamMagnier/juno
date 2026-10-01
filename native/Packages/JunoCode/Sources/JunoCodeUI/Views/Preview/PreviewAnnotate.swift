import AppKit
import JunoCodeCore
import JunoCodeRuntime
import JunoDesignSystem
import SwiftUI
import WebKit

// Annotate (CODE_AGENT_SPEC §5.15): the reader points at an element in the
// Preview, writes a note, and sends it to the composer: a cropped screenshot
// as an image attachment, and a text block with the element's selector, role
// and name, box, a few computed styles and a source hint. Several per
// message. Codex's Annotation mode, Cursor's Design Mode.

/// One annotation the reader made.
public struct PreviewAnnotation: Sendable, Identifiable {
    public let id = UUID()
    public var route: String
    public var selector: String
    public var role: String
    public var name: String
    public var box: CGRect
    public var styles: [(String, String)]
    /// `src/components/SettingsMenu.tsx:41` from a React dev build, or a
    /// `data-*` attribute that names the component, when the page has one.
    public var sourceHint: String?
    public var note: String
    public var screenshot: ModelImage?

    /// "button \"Save\" on /settings": the attachment's name.
    public var title: String {
        let label = name.isEmpty ? role : "\(role) \"\(name.prefix(40))\""
        return "\(label) on \(route)"
    }

    /// The text the model reads with the image. Page details are data from
    /// the project, said as such.
    public var composerText: String {
        var lines = ["Preview note on \(route) — \(title):"]
        if !note.isEmpty { lines.append(note) }
        lines.append("Element: \(selector) (\(Int(box.minX)),\(Int(box.minY)) \(Int(box.width))×\(Int(box.height)) CSS px)")
        if let sourceHint { lines.append("Source: \(sourceHint)") }
        if !styles.isEmpty {
            lines.append("Styles: " + styles.map { "\($0.0): \($0.1)" }.joined(separator: "; "))
        }
        return lines.joined(separator: "\n")
    }
}

enum PreviewAnnotateScript {
    /// Geometry, selector, ARIA and styles, from the isolated world.
    static let describe = #"""
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const clean = (v, n = 80) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
    const selectorOf = (node) => {
      const parts = [];
      let current = node;
      while (current && current.nodeType === 1 && parts.length < 4) {
        if (current.id) { parts.unshift("#" + CSS.escape(current.id)); break; }
        let part = current.tagName.toLowerCase();
        const classes = Array.from(current.classList).filter((c) => !/^(css-|sc-|_)/.test(c)).slice(0, 2);
        if (classes.length) part += "." + classes.map((c) => CSS.escape(c)).join(".");
        const parent = current.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
          if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(current) + 1) + ")";
        }
        parts.unshift(part);
        current = current.parentElement;
      }
      return parts.join(" > ");
    };
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const keys = ["display", "position", "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "padding", "margin", "border-radius", "gap", "width", "height"];
    const styles = keys.map((k) => [k, style.getPropertyValue(k)]).filter(([, v]) => v && v !== "normal" && v !== "none" && v !== "0px" && v !== "auto");
    let source = null;
    for (const attr of ["data-source", "data-component", "data-testid", "data-test", "data-cy"]) {
      let node = el;
      while (node && node.nodeType === 1 && !source) {
        if (node.getAttribute(attr)) source = attr + "=\"" + node.getAttribute(attr) + "\"";
        node = node.parentElement;
      }
      if (source) break;
    }
    return {
      selector: selectorOf(el),
      role: (el.getAttribute("role") || el.tagName.toLowerCase()),
      name: clean(el.getAttribute("aria-label") || el.innerText || el.getAttribute("alt") || el.getAttribute("title")),
      x: rect.left, y: rect.top, w: rect.width, h: rect.height,
      styles, source
    };
    """#

    /// React dev builds keep the source location on the fiber, which only
    /// the page's own world can see. A hint, never trusted.
    static let reactSource = #"""
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    let node = el;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"));
      if (!key) continue;
      let fiber = node[key];
      for (let hops = 0; fiber && hops < 20; hops++, fiber = fiber.return) {
        const source = fiber._debugSource;
        if (source && source.fileName) return source.fileName.replace(/^.*?\/src\//, "src/") + ":" + source.lineNumber;
      }
    }
    return null;
    """#
}

extension PreviewPage {
    /// The element at `point` (viewport CSS px), described for an annotation.
    func describeElement(at point: CGPoint) async -> PreviewAnnotation? {
        guard let info = (try? await webView.callAsyncJavaScript(
            PreviewAnnotateScript.describe, arguments: ["x": point.x, "y": point.y], in: nil, contentWorld: PreviewSnapshotScript.world
        )) as? [String: Any] else { return nil }
        let box = CGRect(
            x: (info["x"] as? NSNumber)?.doubleValue ?? 0,
            y: (info["y"] as? NSNumber)?.doubleValue ?? 0,
            width: (info["w"] as? NSNumber)?.doubleValue ?? 0,
            height: (info["h"] as? NSNumber)?.doubleValue ?? 0
        )
        let styles = ((info["styles"] as? [[String]]) ?? []).compactMap { pair -> (String, String)? in
            pair.count == 2 ? (pair[0], pair[1]) : nil
        }
        var source = info["source"] as? String
        if source == nil {
            source = (try? await webView.callAsyncJavaScript(
                PreviewAnnotateScript.reactSource, arguments: ["x": point.x, "y": point.y], in: nil, contentWorld: .page
            )) as? String
        }
        let crop = box.insetBy(dx: -8, dy: -8).intersection(CGRect(origin: .zero, size: webView.bounds.size))
        let shot = crop.isEmpty ? nil : try? await PreviewScreenshot.capture(webView, rect: crop, nativeDensity: true)
        return PreviewAnnotation(
            route: currentURL.map(PreviewBrowserEngine.route(of:)) ?? "/",
            selector: info["selector"] as? String ?? "",
            role: info["role"] as? String ?? "element",
            name: info["name"] as? String ?? "",
            box: box,
            styles: styles,
            sourceHint: source,
            note: "",
            screenshot: shot?.model
        )
    }
}

/// While annotating: a highlight follows the pointer over the page, and a
/// click picks the element.
struct PreviewAnnotateLayer: View {
    let page: PreviewPage
    let picked: (PreviewAnnotation) -> Void
    @State private var highlight: CGRect?

    var body: some View {
        GeometryReader { proxy in
            Color.clear
                .contentShape(Rectangle())
                .onContinuousHover { phase in
                    guard case let .active(location) = phase else {
                        highlight = nil
                        return
                    }
                    let point = cssPoint(location, in: proxy.size)
                    Task { @MainActor in
                        guard let info = (try? await page.webView.callAsyncJavaScript(
                            "const el = document.elementFromPoint(x, y); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height];",
                            arguments: ["x": point.x, "y": point.y], in: nil, contentWorld: PreviewSnapshotScript.world
                        )) as? [NSNumber], info.count == 4 else { return }
                        highlight = viewRect(
                            CGRect(x: info[0].doubleValue, y: info[1].doubleValue, width: info[2].doubleValue, height: info[3].doubleValue),
                            in: proxy.size
                        )
                    }
                }
                .onTapGesture { location in
                    let point = cssPoint(location, in: proxy.size)
                    Task { @MainActor in
                        if let annotation = await page.describeElement(at: point) { picked(annotation) }
                    }
                }
                .overlay(alignment: .topLeading) {
                    if let highlight {
                        Rectangle()
                            .strokeBorder(Studio.Ink.accent, lineWidth: 2)
                            .background(Studio.Ink.accent.opacity(0.08))
                            .frame(width: highlight.width, height: highlight.height)
                            .offset(x: highlight.minX, y: highlight.minY)
                            .allowsHitTesting(false)
                    }
                }
        }
        .accessibilityLabel("Pick an element to annotate")
    }

    /// The pane may scale a fixed viewport to fit; points map back to CSS px.
    private func scale(in size: CGSize) -> (CGFloat, CGPoint) {
        guard let viewport = page.viewport.size, size.width > 0, size.height > 0 else { return (1, .zero) }
        let factor = min(1, size.width / viewport.width, size.height / viewport.height)
        let origin = CGPoint(x: (size.width - viewport.width * factor) / 2, y: (size.height - viewport.height * factor) / 2)
        return (factor, origin)
    }

    private func cssPoint(_ location: CGPoint, in size: CGSize) -> CGPoint {
        let (factor, origin) = scale(in: size)
        return CGPoint(x: (location.x - origin.x) / factor, y: (location.y - origin.y) / factor)
    }

    private func viewRect(_ rect: CGRect, in size: CGSize) -> CGRect {
        let (factor, origin) = scale(in: size)
        return CGRect(x: origin.x + rect.minX * factor, y: origin.y + rect.minY * factor, width: rect.width * factor, height: rect.height * factor)
    }
}

/// The annotate toolbar: what was picked, a note, and where it goes.
struct PreviewAnnotateToolbar: View {
    @Binding var annotation: PreviewAnnotation
    let send: () -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                if let image = annotation.screenshot.flatMap({ NSImage(data: $0.data) }) {
                    Image(nsImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(maxWidth: 96, maxHeight: 56)
                        .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous).strokeBorder(Studio.Surface.hairline))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(annotation.title)
                        .font(Studio.Font.labelEmphasis)
                        .lineLimit(1)
                    Text(annotation.selector)
                        .font(Studio.Font.monoSmall)
                        .foregroundStyle(Studio.Ink.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let source = annotation.sourceHint {
                        Text(source)
                            .font(Studio.Font.monoSmall)
                            .foregroundStyle(Studio.Ink.tertiary)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            TextField("What should change here?", text: $annotation.note, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
                .onSubmit(send)
            HStack {
                Spacer()
                Button("Cancel", action: cancel)
                    .buttonStyle(StudioQuietButtonStyle())
                    .keyboardShortcut(.cancelAction)
                Button("Add to message", action: send)
                    .buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.primary))
            }
        }
        .padding(JunoSpace.cozy)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous).strokeBorder(Studio.Surface.hairline))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.code.preview.annotate")
    }
}
