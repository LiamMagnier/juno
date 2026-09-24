import JunoAuth
import JunoChatKit
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

/// The Chat window's detail column: one stable container that switches
/// destinations *inside* itself, and the one place the window's title,
/// subtitle, title menu and toolbar are declared (§1.2, §1.3, §3).
///
/// **Why a container.** The toolbar used to hang off whatever the destination
/// switch produced, so a change of page could change which view owned the
/// toolbar. Declared here, above the switch, the toolbar and the title have
/// one owner whose identity never changes while the window lives; the
/// destination underneath can come and go.
///
/// **The tint is applied below the toolbar's owner** (§0.4). `.junoAccentTint()`
/// sits on the content, inside `.toolbar`, so toggles, sliders, progress and the
/// one prominent button take the account's accent while the toolbar's glyphs —
/// and the system's own sidebar toggle — stay monochrome.
///
/// **No background.** The window paints `Color.junoCanvas` once as its
/// container background, so the transcript scrolls under the toolbar and the
/// system's scroll-edge effect has warm paper to fade into. The opaque
/// `junoReadingCanvas()` that used to sit here stopped content at the
/// toolbar's edge and gave the glass nothing to sample.
///
/// **The title is kept on pages too.** §1.3 would remove it on pages with
/// `toolbar(removing: .title)`, but that changes the toolbar's default items
/// per destination — the crash class of rule 3 (errata 10) — so the title
/// stays, reading the page's name, and pages draw their own header under it
/// until the page template lands (Phase 4).
struct ChatDetail<Content: View>: View {
    let title: String
    let subtitle: String
    /// The saved conversation the title menu acts on. Nil on a draft, a
    /// private chat and every page — which is what leaves the menu empty
    /// there.
    let titleMenuConversation: NativeConversation?
    let projects: [NativeProject]
    let actions: DesktopConversationActions
    let isChatRoute: Bool
    /// Why this Mac cannot reach Juno right now, if it cannot.
    let offline: DesktopOfflineState?
    let retryConnection: () -> Void
    let toolbar: ChatToolbar
    /// The window's toasts, drawn once over this column (§7.7).
    let toasts: JunoToastCenter
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            // One quiet row at the top of the chat column while offline (§1.5).
            // A bar rather than an inset so it is part of the scroll-edge
            // effect the toolbar draws; empty — and zero-high — otherwise.
            .safeAreaBar(edge: .top, spacing: 0) {
                if isChatRoute, let offline {
                    DesktopOfflineCaption(state: offline, retry: retryConnection)
                }
            }
            // The window's one toast host: 12pt above the composer where one
            // is docked, 24pt above the bottom otherwise — never in a sheet.
            .junoToastHost(toasts)
            .junoAccentTint()
            .navigationTitle(title)
            .navigationSubtitle(subtitle)
            .toolbarTitleMenu {
                if let conversation = titleMenuConversation {
                    DesktopConversationMenu(
                        conversation: conversation,
                        projects: projects,
                        actions: actions,
                        renameTitle: "Rename…",
                        showsOpenProject: true
                    )
                }
            }
            .toolbar { toolbar }
    }
}

// MARK: - Offline

/// The two ways this Mac can be out of touch, kept apart on purpose (errata 7).
enum DesktopOfflineState: Equatable {
    /// A session restored from the Keychain that the server has not confirmed:
    /// everything here is real and local, only its freshness is unknown.
    /// Retrying the restore is the right response, so it carries a Retry.
    case unreachable(cause: String)
    /// Sync cannot reach the server. The sync loop retries on its own, and
    /// queued messages send when it does, so there is nothing to press.
    case offline

    /// The state to show, if any. An unconfirmed session wins: it is the
    /// broader failure, and it has an action.
    static func resolve(
        connectivity: NativeAuthModel.Connectivity,
        syncPhase: NativeSyncModel<SQLiteAccountRepository>.Phase?
    ) -> DesktopOfflineState? {
        if case .unreachable(let cause) = connectivity { return .unreachable(cause: cause) }
        if syncPhase == .offline { return .offline }
        return nil
    }
}

/// One 28pt caption row: what is wrong, in 12pt secondary ink, with no fill —
/// and, for an unconfirmed session, the Retry the old full-window banner
/// carried.
///
/// It replaced a banner that spanned the whole window above both columns: a
/// status line was the loudest thing on screen, and it pushed the sidebar
/// down with it. The footer's sync mark carries the same state on every page.
struct DesktopOfflineCaption: View {
    let state: DesktopOfflineState
    let retry: () -> Void
    /// The column's width, which picks the gutter the transcript keeps.
    @State private var columnWidth: CGFloat = 0

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(.cloudOff, size: 12)
            switch state {
            case .offline:
                Text("Offline · messages send when you're back")
            case .unreachable(let cause):
                Text("Juno is unreachable · showing your local copy")
                    .help(cause)
                // Link-style accent text in the ink rung, stated rather than
                // left to a borderless style: in Chat that would be the fill
                // accent (under 4.5:1 on the dark canvas at 12pt), and above
                // Code the system's own — blue on most Macs (§0.4).
                Button(action: retry) {
                    Text("Try Again")
                        .fontWeight(.medium)
                        .foregroundStyle(Color.junoAccentInk)
                        .frame(minHeight: 28)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint(cause)
            }
        }
        .junoFont(size: 12, relativeTo: .footnote)
        .junoSecondaryInk()
        .lineLimit(1)
        .frame(height: 28)
        .frame(maxWidth: DesktopChatMeasure.reading, alignment: .leading)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, DesktopChatMeasure.gutter(forColumnWidth: columnWidth))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { columnWidth = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.desktop.offline-caption")
    }
}
