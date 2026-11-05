import AppKit
import Carbon.HIToolbox
import JunoCore
import JunoDesignSystem
import SwiftUI

/// The floating "Ask Juno" panel, bound to ⌥Space (or the reader's own
/// shortcut) from anywhere.
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
/// **The shortcut is a registered hot key.** It used to be a global `NSEvent`
/// monitor, which only *observes* keys: it needed Accessibility trust to see
/// anything, and even then ⌥Space still reached the frontmost app, where it
/// typed a non-breaking space. Carbon's `RegisterEventHotKey` needs no
/// permission and consumes the key in every app, this one included, so no
/// local monitor is needed either. The shortcut is the reader's to change
/// (Settings › General); ``JunoHotkeyBinder`` refuses a reserved or taken one
/// and keeps the previous shortcut working when it does.
///
/// **Prewarmed.** The panel is built two seconds after launch rather than on
/// the first press, so the first ⌥Space opens it without building a hosting
/// view under the reader's finger.
@MainActor
final class DesktopQuickEntryController {
    static let shared = DesktopQuickEntryController()

    private var panel: NSPanel?
    /// The account's Light or Dark choice, or nil to follow the system.
    ///
    /// The panel is AppKit's, not a SwiftUI scene, so the theme the main
    /// window takes through `.preferredColorScheme` never reaches it: a reader
    /// who chose Dark got a light panel over a dark window. The window's root
    /// hands the choice over here instead (errata, "Light mode and theme
    /// override").
    private var appearance: NSAppearance?

    private lazy var binder = JunoHotkeyBinder(
        registrar: DesktopCarbonHotkeyRegistrar(),
        appChords: DesktopQuickEntryHotkey.appChords
    )
    private var prewarmTask: Task<Void, Never>?
    /// While Settings records a new shortcut, a press of the current one is
    /// the recorder's answer, not a reason to open the panel.
    private var recorder: ((JunoHotkey) -> Void)?

    /// Why the saved shortcut could not be registered at launch, or nil.
    private(set) var launchProblem: JunoHotkeyProblem?

    /// The shortcut registered now, if any.
    var activeHotkey: JunoHotkey? { binder.active }

    /// Applies the account's theme to the panel, now and whenever it is next
    /// built. Nil follows the system, as the main window does.
    func setColorScheme(_ scheme: ColorScheme?) {
        appearance = scheme.flatMap { NSAppearance(named: $0 == .dark ? .darkAqua : .aqua) }
        panel?.appearance = appearance
    }

    /// Registers the reader's shortcut, falling back to ⌥Space for this run if
    /// the saved one no longer registers, then schedules the prewarm.
    /// Idempotent.
    func installHotkey() {
        guard binder.active == nil else { return }
        let saved = DesktopQuickEntryHotkey.saved
        if let problem = binder.bind(saved) {
            launchProblem = problem
            if saved != .quickEntryDefault {
                binder.bind(.quickEntryDefault)
            }
        }
        schedulePrewarm()
    }

    /// Makes `hotkey` the shortcut and saves it. Returns why not, in which
    /// case the previous shortcut is still the one registered.
    @discardableResult
    func rebind(_ hotkey: JunoHotkey) -> JunoHotkeyProblem? {
        if let problem = binder.bind(hotkey) { return problem }
        DesktopQuickEntryHotkey.save(hotkey)
        launchProblem = nil
        return nil
    }

    /// Routes presses of the current shortcut to Settings' recorder while it
    /// listens; nil hands them back to the panel.
    func setRecorder(_ recorder: ((JunoHotkey) -> Void)?) {
        self.recorder = recorder
    }

    /// The registered shortcut was pressed, in any app.
    func hotkeyPressed() {
        if let recorder, let active = binder.active {
            recorder(active)
        } else {
            toggle()
        }
    }

    /// The panel's one line about the shortcut, set only when the saved
    /// shortcut could not be registered, so the reader knows why it did not
    /// open from another app (or why ⌥Space did instead).
    var notice: String? {
        guard let launchProblem else { return nil }
        let saved = DesktopQuickEntryHotkey.saved
        var line = DesktopQuickEntryHotkey.message(for: launchProblem, hotkey: saved)
        if let active = binder.active, active != saved {
            line += " Using \(active.display) for now."
        }
        return line + " Change it in Settings › General."
    }

    /// Builds the panel ahead of the first press, once launch has settled.
    private func schedulePrewarm() {
        prewarmTask?.cancel()
        prewarmTask = Task { [weak self] in
            // An explicit clock, as elsewhere in the app: Swift 6.2's
            // cross-module `Task.sleep(for:)` specialization can crash.
            let clock = ContinuousClock()
            try? await clock.sleep(until: clock.now.advanced(by: .seconds(2)))
            guard !Task.isCancelled else { return }
            self?.prewarm()
        }
    }

    /// Builds and lays out the panel without showing it. Idempotent.
    func prewarm() {
        guard panel == nil else { return }
        let built = makePanel()
        built.contentView?.layoutSubtreeIfNeeded()
        panel = built
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
        // A titled panel keeps its traffic lights unless they are hidden, and
        // they would draw over the composer's top-left corner.
        [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].forEach {
            panel.standardWindowButton($0)?.isHidden = true
        }
        panel.contentView = NSHostingView(
            rootView: DesktopQuickEntryView(
                readNotice: { DesktopQuickEntryController.shared.notice },
                dismiss: { [weak self] in self?.hide() }
            )
            .desktopTextScale()
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
    /// Reads the controller's line about the shortcut, if it could not be
    /// registered. Read on every appearance, because the panel is built once
    /// (prewarmed) and the reader may fix the shortcut in Settings meanwhile.
    let readNotice: () -> String?
    let dismiss: () -> Void

    @State private var notice: String?
    @State private var text = ""
    @State private var product: DesktopProductMode

    init(
        readNotice: @escaping () -> String?,
        dismiss: @escaping () -> Void,
        startingProduct: DesktopProductMode = .chat
    ) {
        self.readNotice = readNotice
        self.dismiss = dismiss
        _product = State(initialValue: startingProduct)
    }
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
        product == .code ? "Describe a task for Alevr Code…" : ChatComposerPlaceholder.text()
    }

    private var startLabel: String {
        product == .code ? "Start a task in Alevr Code" : "Start a new chat"
    }

    private var hint: String {
        product == .code ? "↩ starts a task in Alevr Code" : "↩ starts a new chat"
    }

    var body: some View {
        JunoComposerShell(
            captionAbove: { EmptyView() },
            above: { EmptyView() },
            field: { field },
            controls: { controls },
            edge: { EmptyView() },
            captionBelow: { noticeLine }
        )
        .frame(width: Self.width)
        .padding(JunoSpace.snug)
        .onAppear {
            fieldFocused = true
            notice = readNotice()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
            notice = readNotice()
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Ask Alevr")
        .accessibilityIdentifier("juno.desktop.quick-entry")
    }

    /// Why the shortcut did not open the panel from another app, when it
    /// could not be registered. Nothing otherwise.
    @ViewBuilder
    private var noticeLine: some View {
        if let notice {
            JunoIconLabel(verbatim: notice, icon: .keyboard, size: 12)
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .lineLimit(2)
                .accessibilityIdentifier("juno.desktop.quick-entry.shortcut-notice")
        }
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
        // ↩ sends and ⇧↩ / ⌥↩ break the line, as in every composer
        // (`JunoComposerReturn`); an input method's ↩ stays its own.
        .onKeyPress(.return, phases: .down) { press in
            switch JunoComposerReturn.resolve(press) {
            case .inputMethod: return .ignored
            case .newline: return JunoTextEditing.insertLineBreak() ? .handled : .ignored
            case .send: break
            }
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
            // The product list is the window's (`DesktopProductMode.switchable`),
            // drawn with Juno's own switch at its compact size: outside a
            // toolbar the system picker put the chosen glyph white on a
            // white thumb, and when active would spend the system accent on
            // it (§0.4). The thumb here is neutral, the words spelled out.
            JunoSegmented(
                options: DesktopProductMode.switchable.map { mode in
                    JunoSegmentedOption(mode, mode.label, icon: mode.icon)
                },
                selection: $product,
                accessibilityLabel: "Product",
                size: .compact
            )
            Text(hint)
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .lineLimit(1)
                .padding(.leading, JunoSpace.snug)
            Spacer(minLength: JunoSpace.snug)
            // The send face, but not the send words: Return puts the text in
            // a new chat's (or task's) field, and the reader sends it there.
            ComposerPrimaryDisc(
                face: canSend ? .send : .disabled(startLabel),
                label: startLabel,
                help: "\(startLabel)  ↩",
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

// MARK: - The shortcut

/// Quick Entry's shortcut as the app stores, shows and checks it.
enum DesktopQuickEntryHotkey {
    /// `UserDefaults` key: the shortcut's ``JunoHotkey/storageValue``. This
    /// Mac's choice, like text size, not the account's.
    static let storageKey = "quickEntry.hotkey"

    /// The saved shortcut, or ⌥Space when none is saved or it does not read.
    static var saved: JunoHotkey {
        hotkey(storage: UserDefaults.standard.string(forKey: storageKey) ?? "")
    }

    static func hotkey(storage: String) -> JunoHotkey {
        JunoHotkey(storageValue: storage) ?? .quickEntryDefault
    }

    static func save(_ hotkey: JunoHotkey) {
        UserDefaults.standard.set(hotkey.storageValue, forKey: storageKey)
    }

    /// The chords Alevr's own menus answer, by command name, so a global
    /// shortcut cannot take one of them away from the app itself.
    static var appChords: [JunoHotkey: String] {
        var chords: [JunoHotkey: String] = [:]
        for entry in JunoShortcutRegistry.entries where entry.id != .askJuno {
            if case .field = entry.binding { continue }
            guard let key = entry.key, let hotkey = hotkey(key: key, modifiers: entry.modifiers) else { continue }
            chords[hotkey] = entry.menuTitle ?? entry.listLabel ?? entry.id.rawValue
        }
        return chords
    }

    static func modifiers(_ eventModifiers: SwiftUI.EventModifiers) -> JunoHotkey.Modifiers {
        var result: JunoHotkey.Modifiers = []
        if eventModifiers.contains(.control) { result.insert(.control) }
        if eventModifiers.contains(.option) { result.insert(.option) }
        if eventModifiers.contains(.shift) { result.insert(.shift) }
        if eventModifiers.contains(.command) { result.insert(.command) }
        return result
    }

    /// A SwiftUI chord as a key position, or nil for a key with no fixed one.
    static func hotkey(key: KeyEquivalent, modifiers eventModifiers: SwiftUI.EventModifiers) -> JunoHotkey? {
        let code: UInt16?
        switch key {
        case .space: code = JunoHotkey.KeyCode.space
        case .return: code = JunoHotkey.KeyCode.returnKey
        case .tab: code = JunoHotkey.KeyCode.tab
        case .delete: code = JunoHotkey.KeyCode.delete
        case .escape: code = JunoHotkey.KeyCode.escape
        case .upArrow: code = JunoHotkey.KeyCode.upArrow
        case .downArrow: code = JunoHotkey.KeyCode.downArrow
        case .leftArrow: code = JunoHotkey.KeyCode.leftArrow
        case .rightArrow: code = JunoHotkey.KeyCode.rightArrow
        default: code = JunoHotkey.keyCode(forCharacter: key.character)
        }
        return code.map { JunoHotkey(keyCode: $0, modifiers: Self.modifiers(eventModifiers)) }
    }

    /// The shortcut as a menu chord, so File › Ask Alevr… shows the reader's
    /// choice. Nil for a key a menu cannot show.
    static func keyboardShortcut(_ hotkey: JunoHotkey) -> KeyboardShortcut? {
        let key: KeyEquivalent
        switch hotkey.keyCode {
        case JunoHotkey.KeyCode.space: key = .space
        case JunoHotkey.KeyCode.returnKey: key = .return
        case JunoHotkey.KeyCode.tab: key = .tab
        case JunoHotkey.KeyCode.delete: key = .delete
        case JunoHotkey.KeyCode.escape: key = .escape
        case JunoHotkey.KeyCode.upArrow: key = .upArrow
        case JunoHotkey.KeyCode.downArrow: key = .downArrow
        case JunoHotkey.KeyCode.leftArrow: key = .leftArrow
        case JunoHotkey.KeyCode.rightArrow: key = .rightArrow
        default:
            guard hotkey.isCharacterKey, let character = hotkey.keyName.lowercased().first else { return nil }
            key = KeyEquivalent(character)
        }
        var eventModifiers: SwiftUI.EventModifiers = []
        if hotkey.modifiers.contains(.control) { eventModifiers.insert(.control) }
        if hotkey.modifiers.contains(.option) { eventModifiers.insert(.option) }
        if hotkey.modifiers.contains(.shift) { eventModifiers.insert(.shift) }
        if hotkey.modifiers.contains(.command) { eventModifiers.insert(.command) }
        return KeyboardShortcut(key, modifiers: eventModifiers)
    }

    /// The key a recorder just saw, as a shortcut.
    static func hotkey(from event: NSEvent) -> JunoHotkey {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        var result: JunoHotkey.Modifiers = []
        if flags.contains(.control) { result.insert(.control) }
        if flags.contains(.option) { result.insert(.option) }
        if flags.contains(.shift) { result.insert(.shift) }
        if flags.contains(.command) { result.insert(.command) }
        return JunoHotkey(keyCode: event.keyCode, modifiers: result)
    }

    /// Why a shortcut was refused, in one sentence that names it.
    static func message(for problem: JunoHotkeyProblem, hotkey: JunoHotkey) -> String {
        let chord = hotkey.display
        switch problem {
        case .unknownKey: return "Alevr can’t use that key in a shortcut."
        case .needsControlOrOption: return "\(chord) needs ⌃ or ⌥, or it would take the key from every app."
        case .typesCharacter: return "\(chord) types a character. Add ⌃ or ⌘."
        case .reservedBySystem(let use): return "macOS uses \(chord) for \(use)."
        case .usedByApp(let command): return "\(chord) is already \(command) in Alevr."
        case .unavailable: return "\(chord) is already taken by another app."
        }
    }
}

/// Registers global shortcuts with Carbon's hot key API, which needs no
/// Accessibility permission and consumes the key before any app sees it.
///
/// One application-level handler serves every registration; a press is
/// handed to the Quick Entry controller on the main actor. Each registration
/// carries Alevr's signature, so a press from anything else is passed on.
final class DesktopCarbonHotkeyRegistrar: JunoHotkeyRegistrar {
    /// "Alvr".
    static let signature: OSType = 0x416C_7672

    private var handler: EventHandlerRef?
    private var nextID: UInt32 = 0

    func register(_ hotkey: JunoHotkey) -> EventHotKeyRef? {
        installHandlerIfNeeded()
        nextID &+= 1
        var reference: EventHotKeyRef?
        let status = RegisterEventHotKey(
            UInt32(hotkey.keyCode),
            Self.carbonModifiers(hotkey.modifiers),
            EventHotKeyID(signature: Self.signature, id: nextID),
            GetApplicationEventTarget(),
            0,
            &reference
        )
        guard status == noErr, let reference else { return nil }
        return reference
    }

    func unregister(_ registration: EventHotKeyRef) {
        UnregisterEventHotKey(registration)
    }

    static func carbonModifiers(_ modifiers: JunoHotkey.Modifiers) -> UInt32 {
        var flags: UInt32 = 0
        if modifiers.contains(.command) { flags |= UInt32(cmdKey) }
        if modifiers.contains(.option) { flags |= UInt32(optionKey) }
        if modifiers.contains(.control) { flags |= UInt32(controlKey) }
        if modifiers.contains(.shift) { flags |= UInt32(shiftKey) }
        return flags
    }

    private func installHandlerIfNeeded() {
        guard handler == nil else { return }
        var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(
            GetApplicationEventTarget(),
            { _, event, _ in
                var identifier = EventHotKeyID()
                let status = GetEventParameter(
                    event,
                    EventParamName(kEventParamDirectObject),
                    EventParamType(typeEventHotKeyID),
                    nil,
                    MemoryLayout<EventHotKeyID>.size,
                    nil,
                    &identifier
                )
                guard status == noErr, identifier.signature == DesktopCarbonHotkeyRegistrar.signature else {
                    return OSStatus(eventNotHandledErr)
                }
                Task { @MainActor in DesktopQuickEntryController.shared.hotkeyPressed() }
                return noErr
            },
            1,
            &pressed,
            nil,
            &handler
        )
    }
}

// MARK: - Settings › General: the shortcut recorder

/// Listens for the next chord while Settings records Quick Entry's shortcut.
///
/// A local monitor, which needs no permission: it only sees keys sent to this
/// app, and Settings is frontmost while it records. A press of the current
/// shortcut never reaches it (the hot key consumes it first), so the
/// controller forwards that one here instead.
@MainActor
@Observable
final class DesktopShortcutRecorder {
    private(set) var isRecording = false
    @ObservationIgnored private var monitor: Any?
    @ObservationIgnored private var onChord: ((JunoHotkey) -> Void)?

    func start(_ onChord: @escaping (JunoHotkey) -> Void) {
        guard !isRecording else { return }
        isRecording = true
        self.onChord = onChord
        DesktopQuickEntryController.shared.setRecorder { [weak self] hotkey in self?.finish(hotkey) }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let hotkey = DesktopQuickEntryHotkey.hotkey(from: event)
            // Local monitors run on the main thread, inside the event loop.
            MainActor.assumeIsolated {
                if hotkey == JunoHotkey(keyCode: JunoHotkey.KeyCode.escape, modifiers: []) {
                    self?.stop()
                } else {
                    self?.finish(hotkey)
                }
            }
            return nil
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        onChord = nil
        isRecording = false
        DesktopQuickEntryController.shared.setRecorder(nil)
    }

    private func finish(_ hotkey: JunoHotkey) {
        let deliver = onChord
        stop()
        deliver?(hotkey)
    }
}

/// The "Ask Alevr" row: the shortcut as keycaps, a click to record a new one,
/// and Reset when it is not ⌥Space. A refused shortcut says why in the row
/// and leaves the previous one working.
struct DesktopQuickEntryShortcutRow: View {
    @AppStorage(DesktopQuickEntryHotkey.storageKey) private var stored = ""
    @State private var recorder = DesktopShortcutRecorder()
    @State private var problem: String?

    private var current: JunoHotkey {
        DesktopQuickEntryController.shared.activeHotkey ?? DesktopQuickEntryHotkey.hotkey(storage: stored)
    }

    var body: some View {
        DesktopSettingRow(
            title: "Ask Alevr",
            description: problem ?? "Opens Quick Entry from any app. Click the shortcut, then press a new one.",
            tone: problem == nil ? .normal : .destructive
        ) {
            HStack(spacing: JunoSpace.snug) {
                if current != .quickEntryDefault, !recorder.isRecording {
                    DesktopOutlineButton(title: "Reset") { apply(.quickEntryDefault) }
                        .accessibilityIdentifier("juno.desktop.settings.quick-entry-shortcut.reset")
                }
                Button {
                    if recorder.isRecording {
                        recorder.stop()
                    } else {
                        problem = nil
                        recorder.start { apply($0) }
                    }
                } label: {
                    Group {
                        if recorder.isRecording {
                            Text("Press a shortcut")
                                .junoType(.ui)
                                .foregroundStyle(Color.junoSecondaryInk)
                        } else {
                            DesktopKeycapChord(keys: current.keys)
                        }
                    }
                    .frame(minWidth: 112, minHeight: 28)
                    .contentShape(.rect)
                }
                .buttonStyle(.bordered)
                .help(recorder.isRecording ? "Press a shortcut, or esc to cancel" : "Change the shortcut")
                .accessibilityLabel(
                    recorder.isRecording
                        ? "Recording a shortcut. Press Escape to cancel."
                        : "Shortcut, \(JunoShortcutKeys.spoken(current.keys)). Change"
                )
                .accessibilityIdentifier("juno.desktop.settings.quick-entry-shortcut")
            }
        }
        .onDisappear { recorder.stop() }
    }

    private func apply(_ hotkey: JunoHotkey) {
        let previous = current
        if let refusal = DesktopQuickEntryController.shared.rebind(hotkey) {
            problem = DesktopQuickEntryHotkey.message(for: refusal, hotkey: hotkey)
                + " \(previous.display) still works."
        } else {
            problem = nil
            stored = hotkey.storageValue
        }
    }
}
