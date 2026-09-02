import AppKit
import ApplicationServices
import JunoDesignSystem
import SwiftUI

/// The floating "Ask Juno" panel, bound to ⌥Space from anywhere.
///
/// A small non-activating panel — the app does not come to the front, the
/// panel does — with one field and a Chat / Code switch. Return sends: Chat
/// opens the main window on a new conversation carrying the text, Code opens
/// it on the New task screen with the text as the prompt. The panel is the
/// whole of the feature; it holds no state a window does not already own.
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
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 120),
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

/// The panel's contents.
struct DesktopQuickEntryView: View {
    let isAccessibilityTrusted: Bool
    let dismiss: () -> Void

    @State private var text = ""
    @State private var product = DesktopProductMode.chat
    @FocusState private var fieldFocused: Bool
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.cozy) {
                JunoMark(size: 20)
                    .foregroundStyle(Color.junoAccent)
                    .accessibilityHidden(true)
                TextField(product == .code ? "Describe a task for Juno Code…" : "Ask Juno…", text: $text)
                    .textFieldStyle(.plain)
                    .font(.title2)
                    .focused($fieldFocused)
                    .onSubmit(send)
                    .accessibilityIdentifier("juno.desktop.quick-entry.field")
                DesktopSegmented(
                    options: [
                        .init(DesktopProductMode.chat, "Chat", symbol: DesktopProductMode.chat.symbol),
                        .init(DesktopProductMode.code, "Code", symbol: DesktopProductMode.code.symbol),
                    ],
                    selection: $product,
                    accessibilityLabel: "Send to"
                )
            }
            HStack(spacing: JunoSpace.cozy) {
                Text(product == .code ? "↩ starts a task in Juno Code" : "↩ starts a new chat")
                    .junoCaption()
                Spacer(minLength: 0)
                if !isAccessibilityTrusted {
                    Button {
                        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                            NSWorkspace.shared.open(url)
                        }
                    } label: {
                        JunoIconLabel(verbatim: "⌥Space works everywhere once Juno has Accessibility access", icon: .permission, size: 12)
                            .junoCaption()
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .help("Open Privacy & Security › Accessibility")
                    .accessibilityIdentifier("juno.desktop.quick-entry.accessibility")
                }
            }
        }
        .padding(JunoSpace.regular)
        .frame(width: 620)
        .background(Color.junoRaised, in: RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 0.5)
        )
        .padding(JunoSpace.snug)
        .onAppear { fieldFocused = true }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Ask Juno")
        .accessibilityIdentifier("juno.desktop.quick-entry")
    }

    private func send() {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        switch product {
        case .code:
            DesktopWorkbenchRegistry.shared.request(.newCodeTask(prompt: prompt))
        case .chat, .work:
            DesktopWorkbenchRegistry.shared.request(.newChat(prompt: prompt))
        }
        text = ""
        dismiss()
        openWindow(id: JunoDesktopWindow.mainID)
        NSApp.activate()
    }
}
