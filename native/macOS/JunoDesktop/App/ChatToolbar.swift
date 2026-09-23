import JunoDesignSystem
import Observation
import SwiftUI

/// The Chat window's detail toolbar (§3 of the Liquid Glass redesign): New
/// chat at the leading edge while the sidebar is hidden, and one shared glass
/// capsule holding Share and the Private toggle.
///
/// **Declared once, on ``ChatDetail``, and never per destination** (crash rule
/// 3). Every item exists in every state; what changes is a hidden flag set
/// with `ToolbarContent.hidden(_:)`, which flips visibility on an item whose
/// identity never changes. Adding and removing items is what rebuilt the
/// `NSToolbar` underneath a live window and drove the split-view constraint
/// loop this shell has crashed in. By state:
///
/// - Draft: only Private.
/// - A saved chat with messages: Share and Private.
/// - A page: nothing — the traffic lights and the sidebar toggle only.
///
/// **What is not here, on purpose.** No search field (search is the sidebar's
/// button, and later ⌘K), no model picker (that is the composer's), no New
/// chat while the sidebar shows its own, no `ToolbarSpacer`, no
/// `.controlSize` or `junoToolbarMetrics()` — the window's toolbar style sets
/// the metric — and no tint: ``ChatDetail`` applies the accent *below* the
/// view that owns this toolbar, so every glyph here stays monochrome (§0.4).
///
/// **Outputs is not built yet.** §3 puts an Outputs count first in the
/// capsule, driven by a per-chat record of what the session produced and
/// used; the Mac has no such model, and a count drawn from nothing would be a
/// claim. It lands with the transcript rework.
struct ChatToolbar: ToolbarContent {
    /// The chat route — a conversation, a draft or a private chat — as opposed
    /// to a page.
    let isChatRoute: Bool
    let isSidebarCollapsed: Bool
    /// A saved chat with messages, not private, on an account with a share
    /// service.
    let canShare: Bool
    let isPrivate: Bool
    /// False only when this account has no private-chat transport.
    let canGoPrivate: Bool
    let share: DesktopShareState
    let newChat: () -> Void
    let startShare: () -> Void
    let togglePrivate: () -> Void

    var body: some ToolbarContent {
        // The web rail's New chat, for when the sidebar — and its own New chat
        // row — is hidden. Never both at once.
        ToolbarItem(placement: .navigation) {
            Button(action: newChat) {
                Label { Text("New chat") } icon: { JunoSymbol(.new) }
            }
            .help("New chat  ⌘N")
            .accessibilityIdentifier("New chat")
        }
        .hidden(!isSidebarCollapsed || !isChatRoute)

        // Two items at one placement, which the system draws in one shared
        // capsule. Separate items rather than one group because each hides on
        // its own condition, and `ToolbarContent.hidden(_:)` is the item-level
        // switch — `toolbarItemHidden(_:)` on a view inside a group was
        // measured to hide nothing on macOS 27.
        ToolbarItem(placement: .primaryAction) {
            DesktopShareToolbarButton(share: share, action: startShare)
        }
        .hidden(!isChatRoute || !canShare)

        ToolbarItem(placement: .primaryAction) {
            DesktopPrivateChatButton(isPrivate: isPrivate, action: togglePrivate)
                .disabled(!canGoPrivate)
        }
        .hidden(!isChatRoute)
    }
}

// MARK: - Share

/// Where a Share stands. Held by the window, so the toolbar button, the title
/// menu's Share… and a row menu's Share… all present the one popover.
@MainActor
@Observable
final class DesktopShareState {
    enum Phase: Equatable {
        case idle
        case working
        case copied(URL)
        case failed(String)
    }

    var isPresented = false
    var phase: Phase = .idle
    /// The conversation the popover is about — set by every share as it starts.
    ///
    /// A row's Share… opens its chat and shares it in the same gesture, and
    /// the window closes the popover when the selection moves. Whether that
    /// close or the share runs first is up to the run loop; the window closes
    /// the popover only when the newly selected chat is *not* this one, which
    /// is what keeps the close from landing on the popover that was just
    /// opened for the chat being selected — that would leave the link copied
    /// with nothing said, the silent Share this popover replaced. A share that
    /// finishes after another has started for a different chat checks this
    /// too, and leaves the popover and the pasteboard to the newer one.
    var conversationID: String?

    /// Whether moving the selection to `selected` should close a popover
    /// opened for `sharing`: always, unless the chat now selected is the one
    /// being shared. A rule of its own so the row-share race can be asserted
    /// without a window.
    nonisolated static func selectionClosesPopover(sharing: String?, selected: String?) -> Bool {
        sharing != selected
    }
}

/// Share, and the popover that reports what it did.
///
/// **Never silent.** Share used to publish the chat and copy the link with no
/// acknowledgement at all — a notice was written to state nothing read. The
/// full Share popover (Copy Link, Revoke, the snapshot caption, More…) is
/// Phase 3 (§7.3); until then this popover says the one thing that happened:
/// a link was made and is on the pasteboard, or why it was not.
private struct DesktopShareToolbarButton: View {
    @Bindable var share: DesktopShareState
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label { Text("Share") } icon: { JunoSymbol(.share) }
                .contentShape(.rect)
        }
        .help("Share this chat")
        .accessibilityIdentifier("Share")
        // Dismissed with its anchor, as the footer's and the model chip's
        // popovers are: a popover whose anchor leaves the hierarchy while it
        // is up is the crash rule 2 guards against, and the window's own
        // closes cover the routes it knows about, not every one.
        .onDisappear { share.isPresented = false }
        .popover(isPresented: $share.isPresented, arrowEdge: .bottom) {
            DesktopShareResultPopover(phase: share.phase, retry: action)
        }
    }
}

/// The interim Share popover's content, on the system's popover glass with an
/// explicit frame (crash rule 2).
private struct DesktopShareResultPopover: View {
    let phase: DesktopShareState.Phase
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text("Share this chat")
                .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                .junoInk()
                .accessibilityAddTraits(.isHeader)

            switch phase {
            case .idle, .working:
                HStack(spacing: JunoSpace.snug) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Creating a link…")
                        .junoFont(size: 12, relativeTo: .footnote)
                        .junoSecondaryInk()
                }
            case .copied(let url):
                Text(url.absoluteString)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .junoInk()
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                    .padding(.horizontal, JunoSpace.snug)
                    .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                            .fill(Color.junoGlassFill)
                    )
                Text("Link copied. Anyone with it can read this chat as it is now.")
                    .junoFont(size: 12, relativeTo: .footnote)
                    .junoSecondaryInk()
                    .fixedSize(horizontal: false, vertical: true)
            case .failed(let message):
                Text(message)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoDestructiveInk)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Try Again", action: retry)
                    .contentShape(.rect)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(width: 360, height: 132, alignment: .topLeading)
        .accessibilityIdentifier("juno.desktop.share-popover")
    }
}

// MARK: - Private chat

/// The Private toggle, as a plain button and not `Toggle(.button)`.
///
/// A button-style toggle in the toolbar draws its on state in the *system*
/// accent — blue on a stock Mac — which is both an accent Juno does not spend
/// on toolbar glyphs (§0.4) and the one colour the Phase 1 gate forbids. So
/// the state is carried by the glyph alone: the ghost outline off, the solid
/// ghost on — the web's "fill means on" rule — with the toggle's semantics
/// restated for VoiceOver.
private struct DesktopPrivateChatButton: View {
    let isPrivate: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label {
                Text("Private chat")
            } icon: {
                JunoSymbol(.privateChat, weight: isPrivate ? .fill : .regular)
            }
            .contentShape(.rect)
        }
        // The web's copy (`private-chat-toggle.tsx`).
        .help(isPrivate ? "Private chat is on. Nothing is saved." : "Start private chat")
        .accessibilityValue(isPrivate ? "On" : "Off")
        .accessibilityAddTraits(.isToggle)
        .accessibilityIdentifier("juno.desktop.private-chat")
    }
}
