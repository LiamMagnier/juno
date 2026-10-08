import AppKit
import JunoCodeCore
import JunoCore
import JunoDesignSystem
import JunoCodeUI
import JunoSync
import SwiftUI
import UserNotifications
#if DEBUG
import JunoPreviewSupport
#endif

/// Whether this process is a unit-test host rather than the app a person
/// launched.
///
/// `JunoDesktopTests` runs inside the app (its `TEST_HOST`), so without this
/// the suite launched the real thing: a window, a Dock icon, the menu-bar
/// item, the updater's poll, the global hotkey — and, worst, the production
/// encrypted store, whose Keychain prompt no test can answer. Under a test
/// host the app composes nothing and presents nothing; the tests build the
/// views they need themselves (the offscreen snapshot harness, for one).
enum JunoTestHost {
    static let isActive = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
}

enum JunoDesktopWindow {
    static let mainID = "juno.main"
    /// The ⌘/ list of every shortcut the app answers.
    static let shortcutsID = "juno.shortcuts"
    /// Juno Code's own settings: permissions, environment, instructions, agent,
    /// Git, tools, appearance. A window of its own because a coding agent's
    /// configuration is page-sized, and it opens beside the session it tunes.
    static let codeSettingsID = "juno.code.settings"
    /// A research report in its own window, keyed by its run's id: opening
    /// the same report twice brings its window forward (register #65).
    static let researchReportID = "juno.research-report"
    /// About Juno: the app's own About window, from the application menu.
    static let aboutID = "juno.about"
    /// Software Update: every state of the in-app updater, opened from Check
    /// for Updates…, Settings › General, About and the sidebar's update line.
    static let softwareUpdateID = "juno.software-update"
    /// The File menu's item that opens another main window. Named here because
    /// ``JunoDesktopAppDelegate`` invokes it by title when a launch comes up
    /// with no window at all.
    static let newWindowMenuTitle = "New Window"

    // There is no incognito window any more. Private chat is a mode of the
    // chat route (the toolbar's Private toggle, ⇧⌘N), not a second window
    // with a second composer.

    /// Brings an existing main window to the front — deminiaturized, key, and
    /// with the app active — and says whether there was one.
    ///
    /// `openWindow(id:)` on a `WindowGroup` always opens a *new* window
    /// (errata 12), so a request that only needs the main window — a menu
    /// command with nothing focused — tries this first and opens a window
    /// only when none exists.
    @MainActor
    static func bringMainWindowForward() -> Bool {
        guard let window = NSApp.windows.first(where: {
            $0.identifier?.rawValue.hasPrefix(mainID) == true
        }) else { return false }
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        return true
    }

    /// Hands a route to the main window and brings it forward — the road a
    /// notification's click and the menu-bar extra's Needs You items share.
    /// With no window open, one is opened the way File › New Window opens it
    /// (``JunoDesktopAppDelegate``), never by `openWindow`, and it follows the
    /// route when it appears.
    @MainActor
    static func follow(_ route: JunoNotificationRoute) {
        DesktopWorkbenchRegistry.shared.requestRoute(route)
        presentMainWindow()
    }

    /// Activates the app and brings the main window forward, opening one the
    /// way File › New Window does when there is none — for requests made from
    /// outside the window (a notification, Settings' page links).
    @MainActor
    static func presentMainWindow() {
        NSApp.activate()
        if !bringMainWindowForward() {
            JunoDesktopAppDelegate.presentMainWindowIfWithheld()
        }
    }

    /// Brings the main window forward, or opens one if there is none — the
    /// path every surface outside the window takes after it has made its
    /// request through ``DesktopWorkbenchRegistry``: Quick Entry's send and the
    /// menu-bar item (§7.10).
    @MainActor
    static func showMainWindow(using openWindow: OpenWindowAction) {
        guard !bringMainWindowForward() else { return }
        openWindow(id: mainID)
        NSApp.activate()
    }
}

/// The things only AppKit can tell us: the app finished launching, the app is
/// about to quit, the APNs token, and a click on one of Juno's notifications.
///
/// Launch and termination are the updater's. Launch starts the ten-minute
/// poll; termination is the moment a staged update can be swapped in without
/// interrupting anyone, which is the whole reason the updater does not restart
/// the app on its own.
///
/// The notification center has one delegate, and this is it: a click on an
/// agent's or a task's notification becomes a route the main window follows,
/// and anything else — Juno Code's own local notifications — is handed to
/// ``StudioRunMonitor`` exactly as if it were still the delegate.
@MainActor
private final class JunoDesktopAppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        // A test host is an accessory: no Dock icon, no menu bar of its own,
        // and nothing that steals focus from the person running the suite.
        guard JunoTestHost.isActive else { return }
        _ = NSApp.setActivationPolicy(.accessory)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Nothing a test host should start: no window, no updater, no hotkey.
        guard !JunoTestHost.isActive else { return }
        MainActor.assumeIsolated {
            DispatchQueue.main.async { Self.presentMainWindowIfWithheld() }
            // Settings' rows that open a page in the main window (seam 10).
            DesktopPageLinks.install()
            #if DEBUG
            if JunoPreviewEnvironment.isActive {
                // The harness never polls, downloads or stages anything. It only
                // seeds the phase the footer card draws, so that card can be
                // looked at in both appearances instead of reasoned about — the
                // flag and the seeding method both already existed and had
                // nothing joining them, which meant the one state this view has
                // was unreachable in visual QA.
                if JunoPreviewEnvironment.updateReady {
                    DesktopUpdateModel.shared.setPreviewReady(version: "0.1.12")
                }
                return
            }
            #endif
            DesktopUpdateModel.shared.start()
            // ⌥Space from anywhere. Installed at launch rather than on first
            // use so the shortcut exists before any window does.
            DesktopQuickEntryController.shared.installHotkey()
            // Juno Code's notifications, answered for the life of the app
            // rather than while a Code window happens to be on screen. A click
            // is one request the registry hands to exactly one window, which
            // switches it to Code; with no window open, one is opened.
            StudioRunMonitor.shared.install(responder: DesktopLifecycle.codeNotificationResponder {
                Self.presentMainWindowIfWithheld()
            })
            // A restart or shutdown is not a quit to ask about.
            DesktopLifecycle.observePowerOff()
            // While Juno uses other apps: the caption, the takeover glow and
            // the start and stop notifications (CODE_AGENT_SPEC §3.7).
            DesktopScreenPresence.shared.install()
            // Computer use for every model (Code v2 SPEC §3.12): the action
            // overlay, and the bridge connected agents reach the Mac through.
            ComputerUseDesktopHost.shared.install()
            // After the monitor, which claims the same slot when it installs.
            UNUserNotificationCenter.current().delegate = self
            // Every launch, as Apple asks: the token can change, and asking
            // never prompts. A build signed without the push entitlement —
            // every Developer ID build today — is refused, and the refusal
            // lands in `didFailToRegister` below and nowhere else.
            NSApplication.shared.registerForRemoteNotifications()
        }
    }

    func application(
        _ application: NSApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        NativePushRegistrar.shared.didRegister(deviceToken: deviceToken)
    }

    func application(
        _ application: NSApplication,
        didFailToRegisterForRemoteNotificationsWithError error: any Error
    ) {
        NativePushRegistrar.shared.didFailToRegister(error)
    }

    /// A click on a notification.
    ///
    /// The async form, because forwarding needs the run monitor, and the
    /// monitor lives on the main actor: awaiting it is how a nonisolated
    /// callback reaches it. `userInfo` is narrowed to its strings here, where
    /// it was delivered — every key a route reads is one, and the dictionary
    /// itself cannot cross to the main actor.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = Self.stringValues(of: response.notification.request.content.userInfo)
        guard let route = JunoNotificationRoute(userInfo: info) else {
            let codeNotifications = await MainActor.run { StudioRunMonitor.shared }
            codeNotifications.userNotificationCenter(
                center,
                didReceive: response,
                withCompletionHandler: {}
            )
            return
        }
        await Self.openRoute(route, notificationID: info["notificationId"])
    }

    /// Banners and sound while Juno is in front: the answer Code's monitor
    /// gave when it was the delegate, so nothing Code raises looks different.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    nonisolated private static func stringValues(of userInfo: [AnyHashable: Any]) -> [String: String] {
        var values: [String: String] = [:]
        for (key, value) in userInfo {
            guard let key = key as? String, let value = value as? String else { continue }
            values[key] = value
        }
        return values
    }

    /// Hands a route to the main window and brings it forward. Opening only
    /// navigates: nothing a notification carries answers anything.
    private static func openRoute(_ route: JunoNotificationRoute, notificationID: String?) {
        if let notificationID {
            NativePushRegistrar.shared.markOpened(notificationID: notificationID)
        }
        JunoDesktopWindow.follow(route)
    }

    /// Opens the main window when SwiftUI declined to.
    ///
    /// AppKit hands every bare command-line token it cannot read as a `-key
    /// value` default to the app as a document to open — `code` in
    /// `--juno-ui-preview --juno-preview-tab code`, or any file dropped on the
    /// icon. Juno has no document type, and on macOS 27 an open request at
    /// launch is enough for SwiftUI to withhold the default `WindowGroup`: the
    /// app came up with a menu bar, a status item and no window. Neither
    /// answering the request from the delegate, claiming it with
    /// `handlesExternalEvents`, nor `defaultLaunchBehavior(.presented)` changed
    /// that; the one thing that does is the same action the reader has — File ›
    /// New Window, which `JunoDesktopCommands` offers exactly while no window
    /// is focused. Invoked once, a turn after launch, and only when no main
    /// window exists, so an ordinary launch is untouched.
    @MainActor
    fileprivate static func presentMainWindowIfWithheld() {
        let hasMainWindow = NSApp.windows.contains {
            $0.identifier?.rawValue.hasPrefix(JunoDesktopWindow.mainID) == true
        }
        guard !hasMainWindow,
            let item = NSApp.mainMenu?.items
                .compactMap(\.submenu)
                .flatMap(\.items)
                .first(where: { $0.title == JunoDesktopWindow.newWindowMenuTitle }),
            let action = item.action
        else { return }
        NSApp.sendAction(action, to: item.target, from: item)
    }

    /// Quitting with runs working asks first, Keep working the default
    /// (CODE_AGENT_SPEC §1.12). A stopped run comes back as interrupted, with
    /// Resume.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !JunoTestHost.isActive else { return .terminateNow }
        return MainActor.assumeIsolated {
            DesktopLifecycle.terminateReply(
                activeRuns: DesktopWorkbenchRegistry.shared.activeRunCount,
                systemIsPoweringOff: DesktopLifecycle.systemIsPoweringOff,
                confirm: DesktopLifecycle.confirmQuit
            )
        }
    }

    /// Runs, notifications and the menu bar item outlive the last window.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        DesktopLifecycle.terminatesAfterLastWindowClosed
    }

    func applicationWillTerminate(_ notification: Notification) {
        ComputerUseDesktopHost.shared.uninstall()
        MainActor.assumeIsolated {
            // Never swapped in under a run the reader chose to stop: it is
            // interrupted, and Resume needs the build that was running it.
            guard DesktopLifecycle.installsStagedUpdate(
                activeRuns: DesktopWorkbenchRegistry.shared.activeRunCount
            ) else { return }
            DesktopUpdateModel.shared.installOnQuitIfStaged()
        }
    }
}

/// The app's lifecycle rules for Juno Code, apart from the delegate so tests
/// can read them (CODE_AGENT_SPEC §1.11, §1.12).
enum DesktopLifecycle {
    /// Juno keeps running with its last window closed.
    static let terminatesAfterLastWindowClosed = QuitGuard.terminatesAfterLastWindowClosed

    /// Set once macOS says it is logging out, restarting or shutting down:
    /// the quit guard then lets the app go without asking, rather than
    /// cancelling the restart with a question nobody is there to answer.
    @MainActor static var systemIsPoweringOff = false

    /// Listens for the Mac powering off, for the quit guard.
    @MainActor
    static func observePowerOff() {
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.willPowerOffNotification,
            object: nil,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated { systemIsPoweringOff = true }
        }
    }

    /// Whether to quit now, given the runs working and the reader's answer to
    /// the question when there are any. `confirm` returns true to quit.
    @MainActor
    static func terminateReply(
        activeRuns: Int,
        systemIsPoweringOff: Bool = false,
        confirm: @MainActor (_ message: String, _ detail: String) -> Bool
    ) -> NSApplication.TerminateReply {
        switch QuitGuard.decision(activeRuns: activeRuns, systemIsPoweringOff: systemIsPoweringOff) {
        case .quit:
            return .terminateNow
        case let .ask(message, detail):
            return confirm(message, detail) ? .terminateNow : .terminateCancel
        }
    }

    static func installsStagedUpdate(activeRuns: Int) -> Bool {
        QuitGuard.installsStagedUpdate(activeRuns: activeRuns)
    }

    /// The question, with Keep Working as the default button.
    @MainActor
    static func confirmQuit(message: String, detail: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = detail
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Keep Working")
        alert.addButton(withTitle: "Quit")
        return alert.runModal() == .alertSecondButtonReturn
    }

    /// What answering a Juno Code notification does: the same paths as the
    /// Runs list, with the same digest check. `present` brings the window
    /// forward when an answer needs it.
    @MainActor
    static func codeNotificationResponder(present: @escaping @MainActor () -> Void) -> CodeNotificationResponder {
        let registry = DesktopWorkbenchRegistry.shared
        func open(_ id: CodeSessionID) {
            registry.request(.openSession(id))
            present()
        }
        return CodeNotificationResponder(
            open: open,
            reviewChanges: open,
            allowOnce: { id, approvalID, digest in
                _ = await registry.workbench?.allowOnce(sessionID: id, approvalID: approvalID, digest: digest)
            },
            decline: { id, approvalID, digest in
                _ = await registry.workbench?.decline(sessionID: id, approvalID: approvalID, digest: digest)
            },
            reply: { id, questionID, text in
                _ = await registry.workbench?.reply(sessionID: id, questionID: questionID, text: text)
            },
            keepGoing: { id in _ = await registry.workbench?.keepGoing(sessionID: id) },
            retry: { id in _ = await registry.workbench?.retry(sessionID: id) },
            fixIt: { id in
                guard let controller = await registry.workbench?.controller(for: id) else { return }
                await controller.reviewQueue.pullRequest.fixIt()
            }
        )
    }
}

@main
struct JunoDesktopApp: App {
    @NSApplicationDelegateAdaptor(JunoDesktopAppDelegate.self) private var appDelegate

    /// `nil` only under the DEBUG preview harness, which supplies its own
    /// throwaway world and must never touch the account's real data.
    ///
    /// This used to be non-optional and built in `init()` unconditionally, so a
    /// `--juno-ui-preview` launch opened the production encrypted store — and
    /// therefore prompted for the account's Keychain encryption key — before
    /// discarding the whole configuration in favour of `PreviewWorld`. On a build
    /// whose signature differs from the one that created the Keychain item, that
    /// prompt is modal and unanswerable by automation, which is what made visual
    /// QA and the UI suite intermittently impossible to run. A QA harness has no
    /// business holding production credentials it does not use.
    @State private var configuration: JunoDesktopConfiguration?

    init() {
        // The Mermaid engine the transcript's diagram figure draws with, from
        // the app's own bundle (`Resources/ArtifactRuntime`), so a ```mermaid
        // fence becomes a diagram without the figure fetching anything.
        JunoMermaidEngine.register(script: Self.bundledMermaid())
        // Split by `#if` rather than by a ternary on a compile-time-constant
        // flag: in Stable and Next the flag is `false`, so the preview branch is
        // statically dead and the compiler rejects it under warnings-as-errors.
        // A test host composes nothing: opening the encrypted store is what
        // raises the Keychain prompt no test can answer.
        #if DEBUG
        _configuration = State(
            initialValue: JunoPreviewEnvironment.isActive || JunoTestHost.isActive
                ? nil
                : JunoDesktopConfiguration.live()
        )
        #else
        _configuration = State(
            initialValue: JunoTestHost.isActive ? nil : JunoDesktopConfiguration.live()
        )
        #endif
    }

    /// `ArtifactRuntime/mermaid.min.js`, or nil in a build that did not ship
    /// it — in which case a diagram shows its labelled source.
    static func bundledMermaid() -> String? {
        guard let url = Bundle.main.url(
            forResource: "mermaid.min",
            withExtension: "js",
            subdirectory: "ArtifactRuntime"
        ) else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    var body: some Scene {
        WindowGroup(id: JunoDesktopWindow.mainID) {
            Group {
                #if DEBUG
                if JunoPreviewEnvironment.isActive {
                    JunoDesktopPreviewRoot()
                        .frame(minWidth: 820, minHeight: 560)
                        .junoPreviewAppearance()
                } else {
                    liveRoot
                }
                #else
                liveRoot
                #endif
            }
            // The window paints the warm canvas once, behind everything —
            // sign-in, both products, every page. It is the only placement
            // macOS has for a window ground, and painting it here rather than
            // on each detail column is what lets content scroll *under* the
            // toolbar and the sidebar's glass sample warm paper instead of
            // the system's grey.
            .containerBackground(Color.junoCanvas, for: .window)
        }
        .defaultSize(width: 1240, height: 800)
        .windowResizability(.contentMinSize)
        // Under a test host the main window never opens on its own.
        .defaultLaunchBehavior(JunoTestHost.isActive ? .suppressed : .automatic)
        // No `.hiddenTitleBar`. The window has a real title — the chat's, "New
        // chat" on a draft, or the page's — so the Window menu, Mission
        // Control and ⌘` name it, and the toolbar shows it (§1.3).
        // `.unified`, not `.unifiedCompact`.
        //
        // `.unifiedCompact` is AppKit's *compact* titlebar mode: it shortens the
        // titlebar and draws every toolbar control at the small metric. That is
        // the whole reason the toolbar actions read as undersized — the compose
        // and overflow buttons came out around 22pt in a 1512pt-wide window,
        // against the ~30pt that Mail, Notes and Xcode land on.
        //
        // It is worth recording what does NOT fix this, because both look like
        // they should and neither moves a pixel. `.controlSize(.large)` on the
        // view carrying `.toolbar { … }` does nothing: toolbar item content is
        // hosted by `NSToolbar` in a hierarchy that is a sibling of the content
        // view, so the content view's environment never reaches it. Putting
        // `.controlSize` / `.imageScale` on the `Button` inside the
        // `ToolbarItem` does nothing either — under Liquid Glass the system owns
        // the toolbar control metric, and the window's toolbar style is the only
        // thing that sets it. Both were built, run and screenshotted before
        // landing here.
        //
        // Compact is the right choice for a utility window with one or two
        // actions. This window is the product's primary surface, so it takes
        // the standard metric.
        .windowToolbarStyle(.unified)
        .windowBackgroundDragBehavior(.enabled)
        .commands {
            JunoDesktopCommands()
        }

        // A real, independently resizable development preview. The scene lives
        // in `JunoCodeUI`; registering it here is what makes the session
        // toolbar's Preview action open a window rather than a decorative
        // control. Each window owns the dev-server process it starts and tears
        // that process down when it closes.
        CodePreviewScene()

        // A `Settings` scene is what puts Juno's settings behind ⌘, and under the
        // application menu, where a Mac user looks for them. Reaching settings
        // only by clicking an account row in the sidebar meant ⌘, did nothing —
        // and left the settings pane unreachable from a window showing Code.
        // The Settings window: General, Code, Usage, Connections. The account's
        // pages live here rather than in a product's navigation column, so
        // opening Usage never replaces the surface the reader was working in.
        // The only settings surface (§7.2): the in-window sheet and the Chat
        // column's Settings destination are gone, and every entry point — ⌘,,
        // the footer's gear, the account popover — opens this scene.
        Settings {
            DesktopSettingsWindow(configuration: configuration)
                .junoAccountAppearance(configuration)
                // Settings › Memory's embedded page reads its model from
                // here, so `DesktopMemoryScreen(model:back:)` keeps its two
                // arguments (Phase 4 B1).
                .environment(\.desktopMemoryContext, configuration.flatMap(DesktopMemoryContext.init(configuration:)))
                // This scene declares no toolbar items of its own, so the
                // accent can sit at its root: toggles, sliders and the one
                // prominent button take it, and nothing in the chrome does.
                .junoAccentTint()
        }

        Window("Juno Code Settings", id: JunoDesktopWindow.codeSettingsID) {
            DesktopCodeSettingsWindow(configuration: configuration)
                .junoAccountAppearance(configuration)
        }
        .defaultSize(width: 880, height: 640)
        .windowResizability(.contentMinSize)

        Window("Keyboard Shortcuts", id: JunoDesktopWindow.shortcutsID) {
            DesktopShortcutsWindow()
        }
        .defaultSize(width: 640, height: 720)
        .windowResizability(.contentSize)

        // A research report, read in a window of its own (Phase 5 B6,
        // register #65): opened from the research row, the recap and the
        // Research panel's Report view.
        WindowGroup("Research Report", id: JunoDesktopWindow.researchReportID, for: String.self) { $runID in
            if let runID {
                ResearchReportWindow(runID: runID, configuration: configuration)
                    .junoAccountAppearance(configuration)
            }
        }
        .defaultSize(width: 880, height: 720)
        .windowResizability(.contentMinSize)
        .defaultLaunchBehavior(.suppressed)

        // About Juno and Software Update (premium pass): fixed-size utility
        // windows, never restored at launch and kept out of the Window menu's
        // generated list — each has its own item in the application menu.
        Window("About Juno", id: JunoDesktopWindow.aboutID) {
            DesktopAboutWindow()
                .junoAccountAppearance(configuration)
                .junoAccentTint()
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
        .windowBackgroundDragBehavior(.enabled)
        .restorationBehavior(.disabled)
        .defaultLaunchBehavior(.suppressed)
        .commandsRemoved()

        Window("Software Update", id: JunoDesktopWindow.softwareUpdateID) {
            DesktopSoftwareUpdateWindow()
                .junoAccountAppearance(configuration)
                .junoAccentTint()
        }
        .windowResizability(.contentSize)
        .restorationBehavior(.disabled)
        .defaultLaunchBehavior(.suppressed)
        .commandsRemoved()

        // The menu bar item: New Chat, the chats that need you, live Code sessions, Open Juno (§7.10).
        // Read off the shared registry, so it is right with no window open.
        MenuBarExtra(isInserted: .constant(!JunoTestHost.isActive)) {
            DesktopMenuBarExtraContent()
                .junoAccentTint()
        } label: {
            DesktopMenuBarExtraLabel()
        }
    }

    @ViewBuilder
    private var liveRoot: some View {
        if let configuration {
            // 820×560 fits the sidebar at its narrowest beside a chat column
            // at its narrowest; the window opens at 1240×800.
            JunoDesktopRootView(configuration: configuration)
                .frame(minWidth: 820, minHeight: 560)
        } else {
            // Unreachable outside the preview harness: `configuration` is only
            // nil when the preview branch above is taken.
            JunoEmptyState(
                title: "Juno could not start",
                message: "The application runtime was not composed.",
                icon: .error
            )
        }
    }
}

// `JunoDesktopCommands` and the focused-value plumbing it reads live in
// DesktopCommands.swift.

private extension View {
    /// The account's stored theme and accent, applied to a window that is not
    /// the workspace.
    ///
    /// These modifiers lived only on `JunoDesktopRootView`, so choosing Dark or
    /// switching accent in the ⌘, window restyled every window *except the one
    /// the choice was made in* — the single most confusing possible outcome for a
    /// control whose entire job is to change how things look.
    func junoAccountAppearance(_ configuration: JunoDesktopConfiguration?) -> some View {
        let settings = configuration?.memorySettingsModel?.settings
        let scheme: ColorScheme? =
            switch settings?.theme {
            case .light: .light
            case .dark: .dark
            case .system, .none: nil
            }
        return preferredColorScheme(scheme)
            .onChange(of: settings?.accent) { _, accent in
                JunoAccentSelection.shared.apply(setting: accent)
            }
    }
}
