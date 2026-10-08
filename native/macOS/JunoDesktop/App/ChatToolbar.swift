import JunoDesignSystem
import Observation
import SwiftUI

/// The Chat window's detail toolbar (§3 of the Liquid Glass redesign): New
/// chat at the leading edge while the sidebar is hidden, and one shared glass
/// capsule holding Outputs, Share and the Private toggle.
///
/// **Declared once, on ``ChatDetail``, and never per destination** (crash rule
/// 3). Every item exists in every state; what changes is a hidden flag set
/// with `ToolbarContent.hidden(_:)`, which flips visibility on an item whose
/// identity never changes. Adding and removing items is what rebuilt the
/// `NSToolbar` underneath a live window and drove the split-view constraint
/// loop this shell has crashed in. By state:
///
/// - Draft: only Private.
/// - A saved chat with messages: Outputs (when the chat made or used
///   something), Share and Private.
/// - A page: nothing — the traffic lights and the sidebar toggle only.
///
/// **What is not here, on purpose.** No search field (search is the sidebar's
/// button and the ⌘K panel), no model picker (that is the composer's), no New
/// chat while the sidebar shows its own, no `ToolbarSpacer`, no
/// `.controlSize` or `junoToolbarMetrics()` — the window's toolbar style sets
/// the metric — and no tint: ``ChatDetail`` applies the accent *below* the
/// view that owns this toolbar, so every glyph here stays monochrome (§0.4).
struct ChatToolbar: ToolbarContent {
    /// Chat | Code, the bar's centre.
    @Binding var product: DesktopProductMode
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
    /// What this chat made and used (B3). Its item hides while there is
    /// nothing to show.
    let outputs: DesktopOutputsContext
    @Binding var isOutputsPresented: Bool
    let newChat: () -> Void
    let startShare: () -> Void
    let togglePrivate: () -> Void

    var body: some ToolbarContent {
        // The ChatGPT for Mac bar: the product switch centred as one Liquid
        // Glass segmented capsule, the window's own sidebar toggle at the
        // leading edge, and the private-chat toggle trailing. Declared
        // unconditionally (crash rule 3); only its selection changes.
        ToolbarItem(placement: .principal) {
            DesktopProductSwitch(product: $product)
        }

        // The web rail's New chat, for when the sidebar — and its own New chat
        // row — is hidden. Never both at once, as on the web.
        ToolbarItem(placement: .navigation) {
            Button(action: newChat) {
                Label { Text("New chat") } icon: { JunoSymbol(.new) }
            }
            .help(JunoShortcutRegistry.help("New chat", .newChat))
            .accessibilityIdentifier("New chat")
        }
        .hidden(!isSidebarCollapsed || !isChatRoute)

        // Three items at one placement, which the system draws in one shared
        // capsule. Separate items rather than one group because each hides on
        // its own condition, and `ToolbarContent.hidden(_:)` is the item-level
        // switch — `toolbarItemHidden(_:)` on a view inside a group was
        // measured to hide nothing on macOS 27. Outputs is first, as on the
        // web, and declared unconditionally like the others.
        ToolbarItem(placement: .primaryAction) {
            DesktopOutputsToolbarButton(context: outputs, isPresented: $isOutputsPresented)
        }
        .hidden(!isChatRoute || outputs.outputs.isEmpty)

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

/// Share, and the popover it opens (B2): the web's five states and words,
/// anchored here whichever surface started it.
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
        .onDisappear { share.close() }
        .popover(isPresented: $share.isPresented, arrowEdge: .bottom) {
            DesktopSharePopover(state: share)
        }
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
            // The iPhone's mark: a dashed circle that fills with a check
            // when the chat is private — one control changing state.
            Label {
                Text("Private chat")
            } icon: {
                // The web's incognito glyph, filled while the chat is private
                // ("fill means on").
                JunoSymbol(.privateChat, weight: isPrivate ? .fill : .regular)
            }
            .contentShape(.rect)
        }
        // The web's copy (`private-chat-toggle.tsx`): "Incognito" wherever the
        // mode is named, so the toggle and the window title agree.
        .help(isPrivate ? "Incognito is on. Nothing is saved." : "Turn on incognito")
        .accessibilityLabel(isPrivate ? "Leave incognito" : "Turn on incognito")
        .accessibilityValue(isPrivate ? "On" : "Off")
        .accessibilityAddTraits(.isToggle)
        .accessibilityIdentifier("juno.desktop.private-chat")
    }
}
