import AppKit
import JunoDesignSystem
import Quartz
import SwiftUI

/// A file read beside the conversation: Quick Look's own preview, hosted in
/// the trailing panel the way the website opens a file in its panel shell —
/// not the floating Quick Look window. Open With and Close sit in the
/// panel's header, in the website's glyphs.
struct DesktopFilePreviewPanel: View {
    let url: URL
    let close: () -> Void

    var body: some View {
        DesktopQuickLookView(url: url)
            .background(Color.junoCanvas)
            .safeAreaInset(edge: .top, spacing: 0) {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(.file, size: 16)
                        .foregroundStyle(Color.junoSecondaryInk)
                    Text(url.lastPathComponent)
                        .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: JunoSpace.snug)
                    DesktopPanelIconButton(icon: .externalLink, help: "Open in its app") {
                        NSWorkspace.shared.open(url)
                    }
                    DesktopPanelIconButton(icon: .close, help: "Close", action: close)
                        .keyboardShortcut(.cancelAction)
                }
                .padding(.leading, JunoSpace.regular)
                .padding(.trailing, JunoSpace.tight)
                .frame(height: 52)
                .background(.bar)
            }
            .id(url)
            .accessibilityIdentifier("juno.desktop.file-preview")
    }
}

/// `QLPreviewView`, the view Finder and Mail embed, for one file.
private struct DesktopQuickLookView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> QLPreviewView {
        let view = QLPreviewView(frame: .zero, style: .normal) ?? QLPreviewView()
        view.autostarts = true
        view.previewItem = url as NSURL
        return view
    }

    func updateNSView(_ view: QLPreviewView, context: Context) {
        if (view.previewItem as? NSURL) as URL? != url {
            view.previewItem = url as NSURL
        }
    }

    static func dismantleNSView(_ view: QLPreviewView, coordinator: ()) {
        view.close()
    }
}

/// A panel asked for from outside the conversation view — a research
/// notification's Open: the window opens the chat, then the conversation
/// view shows the report in its trailing panel.
@MainActor @Observable
final class DesktopPanelRequests {
    static let shared = DesktopPanelRequests()
    var report: String?
    var file: URL?
}
