import AppKit
import ApplicationServices
import JunoDesignSystem
import SwiftUI

/// The floating "Ask Juno" panel, bound to ⌥Space from anywhere.
///
/// A small non-activating panel — the app does not come to the front, the
/// panel does — holding the composer's shell and the Chat/Code switch. Return
/// sends: Chat brings the main window forward on a new conversation carrying
/// the text, Code brings it forward on the New task screen with the text as the
/// prompt. The panel is the whole of the feature; it holds no state a window
/// does not already own. (Work left the switch in Phase 1 of the Liquid Glass
/// redesign; what used to be an errand for it is an ordinary chat now. Nothing
/// is armed: the model decides whether the sentence is a task and starts one
/// itself, as it does on the web.)
///
/// **The hotkey needs Accessibility.** A global key monitor only receives
/// events when the app is trusted for accessibility, so the panel says so in
/// one line when it is not, and offers the System Settings pane. It never asks
/// for the permission on the reader's behalf: prompting for a standing grant
/// from a background hotkey is exactly the surprise the permission exists to
/// prevent. Inside the app the shortcut works regardless, through a local
/// monitor.
@MainActor
final class DesktopQuickEntryController {
    static let shared = DesktopQuickEntryController()

    private var panel: NSPanel?
    private var globalMonitor: Any?
    private var localMonitor: Any?
    /// The account's Light or Dark choice, or nil to follow the system.
    ///
    /// The panel is AppKit's, not a SwiftUI scene, so the theme the main
    /// window takes through `.preferredColorScheme` never reaches it: a reader
    /// who chose Dark got a light panel over a dark window. The window's root
    /// hands the choice over here instead (errata, "Light mode and theme
    /// override").
    private var appearance: NSAppearance?

    /// Applies the account's theme to the panel, now and whenever it is next
    /// built. Nil follows the system, as the main window does.
    func setColorScheme(_ scheme: ColorScheme?) {
        appearance = scheme.flatMap { NSAppearance(named: $0 == .dark ? .darkAqua : .aqua) }
        panel?.appearance = appearance
    }

    /// Whether the global monitor can receive keys. Read live: the reader may
    /// grant the permission while the app is running.
    var isAccessibilityTrusted: Bool {
        AXIsProcessTrusted()
    }

    /// Installs the ⌥Space monitors. Idempotent.
    func installHotkey() {
        guard globalMonitor == nil, localMonitor == nil else { return }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
            guard Self.isHotkey(event) else { return }
            Task { @MainActor in DesktopQuickEntryController.shared.toggle() }
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard Self.isHotkey(event) else { return event }
            Task { @MainActor in DesktopQuickEntryController.shared.toggle() }
            return nil
        }
    }

    /// ⌥Space, and nothing else: no ⌘, no ⌃, no ⇧, so it cannot collide with
    /// Spotlight's ⌘Space or a terminal's ⌃Space.
    nonisolated static func isHotkey(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        return event.keyCode == 49 && flags == [.option]
    }

    func toggle() {
        if let panel, panel.isVisible {
            panel.orderOut(nil)
        } else {
            show()
        }
    }

    func show() {
        let panel = self.panel ?? makePanel()
        self.panel = panel
        panel.center()
        // A little above centre, where Spotlight sits, so the eye finds it.
        if let screen = NSScreen.main {
            var frame = panel.frame
            frame.origin.y = screen.visibleFrame.midY + screen.visibleFrame.height * 0.12
            panel.setFrameOrigin(frame.origin)
        }
        panel.makeKeyAndOrderFront(nil)
    }

    func hide() {
        panel?.orderOut(nil)
    }

    private func makePanel() -> NSPanel {
        let panel = DesktopQuickEntryPanel(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 132),
            styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.becomesKeyOnlyIfNeeded = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.appearance = appearance
        panel.contentView = NSHostingView(
            rootView: DesktopQuickEntryView(
                isAccessibilityTrusted: isAccessibilityTrusted,
                dismiss: { [weak self] in self?.hide() }
            )
        )
        return panel
    }
}

/// A panel that can take the keyboard without activating the app, and that
/// goes away on Escape.
private final class DesktopQuickEntryPanel: NSPanel {
    override var canBecomeKey: Bool { true }

    override func cancelOperation(_ sender: Any?) {
        orderOut(nil)
    }
}

/// The panel's contents: the composer's own shell, and the product switch
/// (§7.10).
///
/// **The one composer.** Quick Entry used to draw a composer of its own — a
/// Juno mark beside the field, floating glass chrome at the composer radius, a
/// custom segmented control and a coral circle — which was a fifth
/// implementation of the same object, drifting from the other four. It is now
/// ``JunoComposerShell``, the shape every composer in the product is: the
/// field row, then the controls row with the Chat/Code switch where `+` sits in
/// a chat and the same primary disc at the end. No mark: the panel is summoned
/// by a key the reader just pressed, and it needs no logo to say whose it is.
///
/// This is the one custom glass site outside the main window (§0.1): a panel
/// that pops up over other apps is the place the material genuinely has
/// something to refract.
///
/// **Sending brings the existing window forward** (errata 12). `openWindow(id:)`
/// on a `WindowGroup` always opens a *new* window, so every ⌥Space used to
/// leave another main window behind it. The request goes through
/// ``DesktopWorkbenchRegistry`` to whichever window is open, and that window is
/// brought forward; a window is opened only when there is none.
struct DesktopQuickEntryView: View {
    let isAccessibilityTrusted: Bool
    let dismiss: () -> Void

    @State private var text = ""
    @State private var product = DesktopProductMode.chat
    @FocusState private var fieldFocused: Bool
    @Environment(\.openWindow) private var openWindow

    /// Narrower than a chat's 768: the panel floats over other work, and a
    /// Spotlight-sized entry is what the eye expects from a global key.
    private static let width: CGFloat = 640

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Chat's placeholder is the composer's own; Code's names what Code does
    /// with a sentence.
    private var placeholder: String {
        product == .code ? "Describe a task for Juno Code…" : ChatComposerPlaceholder.text()
    }

    private var hint: String {
        product == .code ? "↩ starts a task in Juno Code" : "↩ starts a new chat"
    }

    var body: some View {
        JunoComposerShell(
            captionAbove: { EmptyView() },
            above: { EmptyView() },
            field: { field },
            controls: { controls },
            edge: { EmptyView() },
            captionBelow: { EmptyView() }
        )
        .frame(width: Self.width)
        .padding(JunoSpace.snug)
        .onAppear { fieldFocused = true }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Ask Juno")
        .accessibilityIdentifier("juno.desktop.quick-entry")
    }

    private var field: some View {
        TextField(
            text: $text,
            prompt: Text(placeholder).foregroundStyle(Color.junoSecondaryInk),
            axis: .vertical
        ) {
            Text(placeholder)
        }
        .textFieldStyle(.plain)
        .junoType(.body)
        .foregroundStyle(Color.junoForeground)
        .lineLimit(1...6)
        .focused($fieldFocused)
        // ↩ sends and ⇧↩ breaks the line, as in every composer.
        .onKeyPress(.return, phases: .down) { press in
            if press.modifiers.contains(.shift) { return .ignored }
            send()
            return .handled
        }
        // The panel is its own window, outside every view that states the
        // accent, so the field states it for its caret. Only the field: the
        // switch beside it must not take a tint (§0.4).
        .junoAccentTint()
        .accessibilityIdentifier("juno.desktop.quick-entry.field")
    }

    private var controls: some View {
        HStack(spacing: JunoComposerMetrics.controlSpacing) {
            // The window's own switch, so Quick Entry and the toolbar can
            // never offer different products or draw them differently. Icons
            // only, as in the toolbar: outside a toolbar a segmented picker
            // would spell its labels out.
            DesktopProductSwitch(product: $product)
                .labelStyle(.iconOnly)
                .fixedSize()
            Text(hint)
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .lineLimit(1)
                .padding(.leading, JunoSpace.snug)
            Spacer(minLength: JunoSpace.snug)
            if !isAccessibilityTrusted {
                Button {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                        NSWorkspace.shared.open(url)
                    }
                } label: {
                    JunoIconLabel(verbatim: "Allow ⌥Space everywhere", icon: .permission, size: 12)
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .padding(.horizontal, JunoSpace.tight)
                        .frame(height: JunoComposerMetrics.controlHeight)
                        .contentShape(.rect)
                }
                .buttonStyle(ComposerControlStyle())
                .help("Open Privacy & Security › Accessibility — the global shortcut needs it")
                .accessibilityIdentifier("juno.desktop.quick-entry.accessibility")
            }
            ComposerPrimaryDisc(
                face: canSend ? .send : .disabled("Send"),
                identifier: "juno.desktop.quick-entry.send",
                action: send
            )
        }
    }

    private func send() {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        if product == .code {
            DesktopWorkbenchRegistry.shared.request(.newCodeTask(prompt: prompt))
        } else {
            DesktopWorkbenchRegistry.shared.request(.newChat(prompt: prompt))
        }
        text = ""
        dismiss()
        JunoDesktopWindow.showMainWindow(using: openWindow)
    }
}
