import AppKit
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem
import SwiftUI
import WebKit

// One chrome for the dock and the pop-out window (CODE_AGENT_SPEC §4.7,
// PV-36, PV-37, PV-38): a servers menu, back, forward, a reload that keeps
// the route, an address field that follows the page, device and appearance
// menus, the log drawer and Keep sign-in. State is said in words in the
// subtitle; there is no status capsule and no badge. While Juno drives the
// page, its edge glows and one plain line offers Stop (Esc does the same).

/// Where the chrome is shown; the dock is narrow, the window is not.
enum PreviewPaneStyle {
    case dock
    case window
}

struct PreviewPaneView: View {
    @Bindable var lease: PreviewLeaseModel
    let style: PreviewPaneStyle
    var close: (() -> Void)?
    var openInWindow: (() -> Void)?

    @State private var isLogVisible = false
    @State private var isShowingSecrets = false
    @State private var addressText = ""
    @FocusState private var addressFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider().overlay(Studio.Surface.hairline)
            banners
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if isLogVisible, let key = lease.selectedKey {
                PreviewLogDrawer(key: key, close: { isLogVisible = false })
                    .frame(height: style == .dock ? 170 : 220)
            }
        }
        .background(Studio.Surface.canvas)
        .sheet(isPresented: $isShowingSecrets) {
            if let root = lease.workspaceRoot {
                PreviewSecretsSheet(workspaceRoot: root, configurationName: lease.selectedConfiguration?.name) {
                    isShowingSecrets = false
                }
            }
        }
        .onChange(of: lease.selectedName) { _, _ in lease.syncPage() }
        // A pane on screen counts as a viewer: it never stops a server, it
        // only keeps an unleased one from idling out while it is shown.
        .task(id: lease.selectedKey) {
            guard let key = lease.selectedKey else { return }
            await JunoCodeLocal.PreviewRegistry.shared.addViewer(key)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3_600))
            }
            await JunoCodeLocal.PreviewRegistry.shared.removeViewer(key)
        }
        .onChange(of: lease.page?.currentURL) { _, url in
            guard !addressFocused else { return }
            addressText = url.map(PreviewBrowserEngine.route(of:)) ?? ""
        }
        .onKeyPress(.escape) {
            guard let page = lease.page, page.agentRecentlyActive else { return .ignored }
            page.stopAgent()
            return .handled
        }
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(spacing: JunoSpace.tight) {
                serversMenu
                runButton
                Spacer(minLength: JunoSpace.tight)
                Button { lease.isAnnotating.toggle(); lease.pendingAnnotation = nil } label: { JunoIconView(.penTool, size: 15) }
                    .buttonStyle(StudioIconButtonStyle(isOn: lease.isAnnotating))
                    .disabled(!lease.canAnnotate)
                    .help(lease.isAnnotating ? "Stop annotating" : "Annotate: point at an element and send a note to the message")
                    .accessibilityLabel("Annotate")
                deviceMenu
                appearanceMenu
                Button { isLogVisible.toggle() } label: { JunoIconView(.writing, size: 15) }
                    .buttonStyle(StudioIconButtonStyle(isOn: isLogVisible))
                    .help(isLogVisible ? "Hide the server log" : "Show the server log")
                    .accessibilityLabel("Server log")
                moreMenu
                if let openInWindow {
                    Button(action: openInWindow) { JunoIconView(.appWindow, size: 15) }
                        .buttonStyle(StudioIconButtonStyle())
                        .help("Open the Preview in its own window")
                        .accessibilityLabel("Open in window")
                }
                if let close {
                    Button(action: close) { JunoIconView(.close, size: 15) }
                        .buttonStyle(StudioIconButtonStyle())
                        .help("Close the Preview pane; the server keeps running")
                        .accessibilityLabel("Close preview pane")
                        .accessibilityIdentifier("juno.code.preview.close")
                }
            }
            HStack(spacing: JunoSpace.tight) {
                Button { lease.page?.goBack() } label: { JunoIconView(.chevronLeft, size: 15) }
                    .buttonStyle(StudioIconButtonStyle())
                    .disabled(!(lease.page?.canGoBack ?? false))
                    .help("Back")
                    .accessibilityLabel("Back")
                Button { lease.page?.goForward() } label: { JunoIconView(.chevronRight, size: 15) }
                    .buttonStyle(StudioIconButtonStyle())
                    .disabled(!(lease.page?.canGoForward ?? false))
                    .help("Forward")
                    .accessibilityLabel("Forward")
                Button { lease.page?.reload() } label: { JunoIconView(.refresh, size: 15) }
                    .buttonStyle(StudioIconButtonStyle())
                    .disabled(lease.page == nil)
                    .keyboardShortcut("r", modifiers: .command)
                    .help("Reload this page (⌘R)")
                    .accessibilityLabel("Reload")
                TextField("/", text: $addressText)
                    .textFieldStyle(.roundedBorder)
                    .font(Studio.Font.mono)
                    .focused($addressFocused)
                    .onSubmit(openAddress)
                    .disabled(lease.page == nil)
                    .help("A route on this preview's server, like /settings")
                    .accessibilityLabel("Preview address")
                    .accessibilityIdentifier("juno.code.preview.address")
            }
            Text(lease.statusSentence)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .lineLimit(2)
                .truncationMode(.middle)
                .accessibilityIdentifier("juno.code.preview.status")
        }
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, JunoSpace.snug)
        .background(.bar)
    }

    private var serversMenu: some View {
        Menu {
            let configurations = lease.catalog.configurations
            if !configurations.isEmpty {
                Section("Configurations") {
                    ForEach(configurations) { configuration in
                        Button {
                            lease.selectedName = configuration.name
                        } label: {
                            Text(configuration.name)
                            Text(PreviewConfigurationDescription.commandText(configuration))
                        }
                    }
                }
            }
            let others = lease.snapshots.filter { snapshot in !configurations.contains { $0.name == snapshot.key.name } }
            if !others.isEmpty {
                Section("Attached") {
                    ForEach(others) { snapshot in
                        Button(snapshot.key.name) { lease.selectedName = snapshot.key.name }
                    }
                }
            }
            Divider()
            Button("Start") { lease.requestStart() }
                .disabled(lease.selectedConfiguration == nil || lease.selectedSnapshot?.phase.isLive == true)
            Button("Restart") { lease.restart() }
                .disabled(lease.selectedSnapshot?.phase.isLive != true)
            Button("Stop") { lease.stop() }
                .disabled(lease.selectedSnapshot?.phase.isLive != true)
            Divider()
            if lease.catalog.hasJunoFile, let url = lease.launchFileURL {
                Button("Edit .juno/launch.json") { NSWorkspace.shared.open(url) }
            } else {
                Button("Save as .juno/launch.json") { lease.saveDiscoveredConfiguration() }
                    .disabled(lease.catalog.configurations.isEmpty)
            }
        } label: {
            StudioChipLabel(title: lease.selectedName ?? "No server")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Preview servers")
        .accessibilityLabel("Preview server")
        .accessibilityIdentifier("juno.code.preview.servers")
    }

    @ViewBuilder
    private var runButton: some View {
        if lease.selectedSnapshot?.phase.isLive == true {
            Button("Stop") { lease.stop() }
                .buttonStyle(StudioQuietButtonStyle())
                .help("Stop this server")
                .accessibilityIdentifier("juno.code.preview.stop")
        } else {
            Button("Start") { lease.requestStart() }
                .buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.primary))
                .disabled(lease.selectedConfiguration == nil)
                .help(lease.selectedConfiguration.map { "Run \(PreviewConfigurationDescription.commandText($0))" } ?? "No configuration to start")
                .accessibilityIdentifier("juno.code.preview.start")
        }
    }

    private var deviceMenu: some View {
        Menu {
            ForEach([PreviewViewport.Preset.responsive, .phone, .tablet, .desktop], id: \.self) { preset in
                Button {
                    lease.page?.setViewport(.preset(preset, colorScheme: lease.page?.viewport.colorScheme ?? .system))
                } label: {
                    if lease.page?.viewport.preset == preset {
                        Label(preset.title, systemImage: "checkmark")
                    } else {
                        Text(preset.title)
                    }
                }
            }
        } label: {
            JunoIconView(deviceIcon, size: 15)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(lease.page == nil)
        .help("Device size: \(lease.page?.viewport.preset.title ?? "Responsive")")
        .accessibilityLabel("Device size")
    }

    private var deviceIcon: JunoIcon {
        switch lease.page?.viewport.preset {
        case .phone?: .smartphone
        case .tablet?: .tablet
        default: .monitor
        }
    }

    private var appearanceMenu: some View {
        Menu {
            ForEach(PreviewViewport.ColorScheme.allCases, id: \.self) { scheme in
                Button {
                    guard let page = lease.page else { return }
                    var viewport = page.viewport
                    viewport.colorScheme = scheme
                    page.setViewport(viewport)
                } label: {
                    if lease.page?.viewport.colorScheme == scheme {
                        Label(scheme.title, systemImage: "checkmark")
                    } else {
                        Text(scheme.title)
                    }
                }
            }
        } label: {
            JunoIconView(lease.page?.viewport.colorScheme == .dark ? .moon : .sun, size: 15)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(lease.page == nil)
        .help("Appearance: \(lease.page?.viewport.colorScheme.title ?? "System")")
        .accessibilityLabel("Appearance")
    }

    private var moreMenu: some View {
        Menu {
            Toggle("Keep sign-in", isOn: Binding(get: { lease.keepsSignIn }, set: { lease.setKeepSignIn($0) }))
            Button("Clear site data") { lease.clearSiteData() }
                .disabled(lease.page == nil)
            Divider()
            Button("Secrets…") { isShowingSecrets = true }
                .disabled(lease.workspaceRoot == nil)
            Toggle(
                "Allow inspection scripts",
                isOn: Binding(get: { lease.allowsInspectionScripts }, set: { lease.setAllowsInspectionScripts($0) })
            )
            Divider()
            Button("Open in browser") {
                if let url = lease.page?.currentURL { NSWorkspace.shared.open(url) }
            }
            .disabled(lease.page?.currentURL == nil)
        } label: {
            JunoIconView(.more, size: 15)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("More")
        .accessibilityLabel("More preview options")
    }

    private func openAddress() {
        guard let page = lease.page, let origin = page.origin else { return }
        let text = addressText.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: text), url.scheme != nil {
            if page.isAllowed(url) { page.load(url) }
            return
        }
        page.load(PreviewPage.url(origin: origin, path: text.isEmpty ? "/" : text))
    }

    // MARK: - Banners

    @ViewBuilder
    private var banners: some View {
        if let page = lease.page, page.agentIsDriving || page.agentStopped {
            PreviewBannerRow(
                text: page.agentStopped ? "You stopped Juno using the preview." : "Juno is using the preview.",
                actions: page.agentStopped
                    ? [("Let Juno use it", { page.allowAgent() })]
                    : [("Stop", { page.stopAgent() })]
            )
        }
        if let page = lease.page, let dialog = page.pendingDialog {
            PreviewBannerRow(
                text: "The page asks: \"\(dialog.message.prefix(160))\"",
                actions: dialog.kind == .alert
                    ? [("OK", { page.answerDialog(accept: true, text: nil) })]
                    : [("Cancel", { page.answerDialog(accept: false, text: nil) }), ("OK", { page.answerDialog(accept: true, text: dialog.defaultText) })]
            )
        }
        if let question = lease.internetQuestion {
            PreviewBannerRow(
                text: "The server tried to reach \(question.host) while offline. Let this project's server use the internet?",
                actions: [("Keep offline", { lease.answerInternet(false) }), ("Allow", { lease.answerInternet(true) })]
            )
        }
        if let question = lease.portQuestion {
            PreviewBannerRow(
                text: "Port \(question.conflict.port) is in use\(question.conflict.owner.map { " by \($0)" } ?? ""). When it is, start \(question.configuration.name) on a free port instead?",
                actions: [("Keep this port", { lease.answerPort(useFreePort: false) }), ("Use a free port", { lease.answerPort(useFreePort: true) })]
            )
        } else if let notice = lease.notice {
            PreviewBannerRow(text: notice, tint: Studio.Ink.danger, actions: [])
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if let configuration = lease.pendingApproval {
            ScrollView {
                PreviewConfigApprovalCard(
                    configuration: configuration,
                    cancel: { lease.resolveApproval(start: false, always: false) },
                    startOnce: { lease.resolveApproval(start: true, always: false) },
                    always: { lease.resolveApproval(start: true, always: true) }
                )
                .padding(JunoSpace.region)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
        } else if let page = lease.page {
            PreviewPageView(page: page)
                .overlay {
                    if lease.isAnnotating, lease.pendingAnnotation == nil {
                        PreviewAnnotateLayer(page: page) { lease.pendingAnnotation = $0 }
                    }
                }
                .overlay(alignment: .bottom) {
                    if lease.pendingAnnotation != nil {
                        PreviewAnnotateToolbar(
                            annotation: Binding(
                                get: { lease.pendingAnnotation ?? PreviewAnnotation(route: "/", selector: "", role: "", name: "", box: .zero, styles: [], sourceHint: nil, note: "", screenshot: nil) },
                                set: { lease.pendingAnnotation = $0 }
                            ),
                            send: { lease.sendAnnotation() },
                            cancel: { lease.cancelAnnotation() }
                        )
                        .padding(JunoSpace.snug)
                        .frame(maxWidth: 520)
                    }
                }
                .overlay {
                    if page.agentIsDriving {
                        RoundedRectangle(cornerRadius: 2)
                            .strokeBorder(Studio.Ink.accent.opacity(0.75), lineWidth: 2)
                            .shadow(color: Studio.Ink.accent.opacity(0.5), radius: 6)
                            .allowsHitTesting(false)
                            .transition(.opacity)
                    }
                }
                .animation(JunoMotion.fast, value: page.agentIsDriving)
        } else {
            PreviewEmptyState(lease: lease, showLog: { isLogVisible = true })
        }
    }
}

/// One plain row above the page: a sentence and its answers.
struct PreviewBannerRow: View {
    let text: String
    var tint: Color = Studio.Ink.primary
    let actions: [(String, () -> Void)]

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Text(text)
                .font(Studio.Font.meta)
                .foregroundStyle(tint)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
                Button(action.0, action: action.1)
                    .buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.primary))
            }
        }
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, JunoSpace.tight)
        .background(Studio.Surface.muted)
        .studioHairline()
    }
}

/// What the pane says when there is no page to show.
struct PreviewEmptyState: View {
    @Bindable var lease: PreviewLeaseModel
    let showLog: () -> Void

    var body: some View {
        VStack(spacing: JunoSpace.regular) {
            switch lease.selectedSnapshot?.phase {
            case .starting?:
                ProgressView().controlSize(.small)
                Text("Starting \(lease.selectedSnapshot?.displayCommand ?? "the server")")
                    .font(Studio.Font.labelEmphasis)
                Text("The page opens when the server answers. Juno checks which process owns the address, so it never opens another app's page.")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.secondary)
                    .multilineTextAlignment(.center)
            case let .failed(reason)?:
                Text("\(lease.selectedName ?? "The server") did not start")
                    .font(Studio.Font.labelEmphasis)
                    .foregroundStyle(Studio.Ink.danger)
                ScrollView {
                    Text(reason)
                        .font(Studio.Font.monoSmall)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(JunoSpace.snug)
                }
                .frame(maxHeight: 180)
                .background(Color.junoTerminal)
                .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous))
                HStack {
                    Button("Start again") { lease.requestStart() }.buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.primary))
                    Button("Show log", action: showLog).buttonStyle(StudioQuietButtonStyle())
                }
            case let .exited(code)?:
                Text("\(lease.selectedName ?? "The server") stopped on its own (exit code \(code))")
                    .font(Studio.Font.labelEmphasis)
                HStack {
                    Button("Start again") { lease.requestStart() }.buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.primary))
                    Button("Show log", action: showLog).buttonStyle(StudioQuietButtonStyle())
                }
            default:
                idle
            }
        }
        .padding(JunoSpace.region)
        .frame(maxWidth: 460)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var idle: some View {
        if let configuration = lease.selectedConfiguration {
            Text("Start \(configuration.name)")
                .font(Studio.Font.labelEmphasis)
            Text("Runs \(PreviewConfigurationDescription.commandText(configuration)) in \(configuration.workingDirectoryDisplay == "." ? "the project" : configuration.workingDirectoryDisplay) and opens the page it serves. The server belongs to this session and keeps running when you look at another one.")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .multilineTextAlignment(.center)
            HStack {
                Button("Start") { lease.requestStart() }.buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.primary))
                if configuration.source == .discovered {
                    Button("Save as .juno/launch.json") { lease.saveDiscoveredConfiguration() }
                        .buttonStyle(StudioQuietButtonStyle())
                }
            }
            if configuration.source == .discovered {
                Text("Found in the project. Saving it lets you review and change how it starts.")
                    .font(Studio.Font.caption)
                    .foregroundStyle(Studio.Ink.tertiary)
                    .multilineTextAlignment(.center)
            }
        } else {
            Text("No launch configuration")
                .font(Studio.Font.labelEmphasis)
            Text(lease.catalog.issues.first?.message
                ?? "Add .juno/launch.json to say how this project's server starts. For the iOS Simulator, use the Simulator pane.")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .multilineTextAlignment(.center)
        }
    }
}

/// "Start this preview server?" with exactly what will run (PV-33): the argv,
/// the folder, env keys (never values), the port, the network and where the
/// configuration came from.
struct PreviewConfigApprovalCard: View {
    let configuration: ResolvedPreviewConfiguration
    let cancel: () -> Void
    let startOnce: () -> Void
    let always: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            Text("Start this preview server?")
                .font(Studio.Font.title)
            Text("\(configuration.name) is new or changed since you last allowed it. Juno runs it only as shown.")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                row("Command", PreviewConfigurationDescription.commandText(configuration), mono: true)
                row("Folder", configuration.workingDirectoryDisplay == "." ? "the workspace root" : configuration.workingDirectoryDisplay, mono: true)
                row("Environment", configuration.environmentKeys.isEmpty ? "no variables from the file" : configuration.environmentKeys.joined(separator: ", "), mono: !configuration.environmentKeys.isEmpty)
                row("Port", portText)
                row("Network", configuration.network == .internet ? "May use the internet" : "Loopback only (kernel sandbox)")
                row("From", configuration.source.displayName, mono: configuration.source != .discovered)
            }
            .padding(JunoSpace.cozy)
            .background(Studio.Surface.raised, in: RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous).strokeBorder(Studio.Surface.hairline))
            ForEach(configuration.warnings, id: \.self) { warning in
                Text(warning)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.danger)
            }
            HStack(spacing: JunoSpace.snug) {
                Spacer()
                Button("Cancel", action: cancel)
                    .buttonStyle(StudioQuietButtonStyle())
                    .keyboardShortcut(.cancelAction)
                Button("Start once", action: startOnce)
                    .buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.primary))
                Button("Always for this configuration", action: always)
                    .buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.primary))
                    .help("Remembered on this Mac for these exact bytes; any change asks again")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.code.preview.config-approval")
    }

    private var portText: String {
        switch (configuration.port, configuration.autoPort) {
        case let (port?, true?): "\(port), or the next free port"
        case let (port?, _): "\(port), which must be free"
        case (nil, true?): "A free port Juno picks"
        default: "Whatever the server prints"
        }
    }

    private func row(_ label: String, _ value: String, mono: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            Text(label)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .frame(width: 92, alignment: .leading)
            Text(value)
                .font(mono ? Studio.Font.mono : Studio.Font.label)
                .foregroundStyle(Studio.Ink.primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The server log, read from the registry's ring buffer (PV-12), lazy.
struct PreviewLogDrawer: View {
    let key: PreviewKey
    let close: () -> Void
    @State private var entries: [PreviewLogBuffer.Entry] = []
    @State private var dropped = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Server log")
                    .font(Studio.Font.labelEmphasis)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(entries.map(\.text).joined(separator: "\n"), forType: .string)
                } label: { JunoIconView(.copy, size: 14) }
                    .buttonStyle(StudioIconButtonStyle())
                    .disabled(entries.isEmpty)
                    .help("Copy the log")
                Button(action: close) { JunoIconView(.chevronDown, size: 14) }
                    .buttonStyle(StudioIconButtonStyle())
                    .help("Hide the log")
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.hairline)
            ScrollViewReader { proxy in
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if dropped > 0 {
                            Text("\(dropped) earlier lines are no longer held")
                                .font(Studio.Font.monoSmall)
                                .foregroundStyle(Studio.Ink.tertiary)
                        }
                        ForEach(entries) { entry in
                            Text(entry.text.isEmpty ? " " : entry.text)
                                .font(Studio.Font.monoSmall)
                                .foregroundStyle(entry.channel == .stderr ? Studio.Ink.danger : entry.channel == .log ? Studio.Ink.secondary : Studio.Ink.primary)
                                .textSelection(.enabled)
                                .lineLimit(1)
                                .fixedSize(horizontal: true, vertical: false)
                                .id(entry.id)
                        }
                    }
                    .padding(JunoSpace.snug)
                }
                .background(Color.junoTerminal)
                .onChange(of: entries.last?.id) { _, id in
                    if let id { proxy.scrollTo(id, anchor: .bottom) }
                }
            }
        }
        .studioHairline(.top)
        .task(id: key) {
            while !Task.isCancelled {
                if let page = await JunoCodeLocal.PreviewRegistry.shared.logs(key, limit: 500) {
                    if page.entries.last?.id != entries.last?.id { entries = page.entries }
                    dropped = page.droppedBefore
                }
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
        .accessibilityLabel("Server log")
    }
}

/// Shows a preview's page by re-parenting its one web view (PV-4): appearing
/// adopts it, disappearing hands it back, and the page never reloads for it.
struct PreviewPageView: NSViewRepresentable {
    let page: PreviewPage

    func makeNSView(context: Context) -> PreviewPageContainerView {
        let container = PreviewPageContainerView(frame: .zero)
        container.onWindowChange = { [weak page] view in
            guard let page else { return }
            if view.window != nil {
                page.adopt(into: view)
            } else {
                page.release(from: view)
            }
        }
        return container
    }

    func updateNSView(_ container: PreviewPageContainerView, context: Context) {
        if container.window != nil, container.hosted !== page.webView {
            page.adopt(into: container)
        }
    }

    static func dismantleNSView(_ container: PreviewPageContainerView, coordinator: ()) {
        container.onWindowChange = nil
        if let webView = container.hosted, let page = PreviewPageRegistry.shared.all.first(where: { $0.webView === webView }) {
            page.release(from: container)
        }
    }
}

/// The Preview's secrets for this checkout, by name only (§4.2, §4.3):
/// sign-in secrets the agent types by name, and server secrets the selected
/// configuration's process receives. Values go to the Keychain and are never
/// shown again.
struct PreviewSecretsSheet: View {
    let workspaceRoot: URL
    let configurationName: String?
    let done: () -> Void

    @State private var signInNames: [String] = []
    @State private var serverNames: [String] = []
    @State private var newName = ""
    @State private var newValue = ""
    @State private var newKind: PreviewSecrets.Kind = .signIn

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            Text("Preview secrets")
                .font(Studio.Font.title)
            Text("Kept in the Keychain for this project. Juno never shows a value to the model or writes it to a file.")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
            section(
                "Sign-in secrets",
                caption: "The agent types these into password fields by name.",
                names: signInNames,
                kind: .signIn,
                scope: nil
            )
            if let configurationName {
                section(
                    "Server secrets for \(configurationName)",
                    caption: "Environment variables only this server's process receives.",
                    names: serverNames,
                    kind: .server,
                    scope: configurationName
                )
            }
            Divider()
            HStack(spacing: JunoSpace.snug) {
                Picker("", selection: $newKind) {
                    Text("Sign-in").tag(PreviewSecrets.Kind.signIn)
                    if configurationName != nil { Text("Server").tag(PreviewSecrets.Kind.server) }
                }
                .labelsHidden()
                .fixedSize()
                TextField(newKind == .server ? "NAME" : "name", text: $newName)
                    .textFieldStyle(.roundedBorder)
                    .font(Studio.Font.mono)
                SecureField("value", text: $newValue)
                    .textFieldStyle(.roundedBorder)
                Button("Add") { add() }
                    .buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.primary))
                    .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty || newValue.isEmpty)
            }
            HStack {
                Spacer()
                Button("Done", action: done)
                    .buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.primary))
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(JunoSpace.region)
        .frame(width: 520)
        .onAppear(perform: reload)
    }

    private func section(_ title: String, caption: String, names: [String], kind: PreviewSecrets.Kind, scope: String?) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(title).font(Studio.Font.labelEmphasis)
            Text(caption).font(Studio.Font.caption).foregroundStyle(Studio.Ink.tertiary)
            if names.isEmpty {
                Text("None yet").font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
            }
            ForEach(names, id: \.self) { name in
                HStack {
                    Text(name).font(Studio.Font.mono)
                    Text("••••").font(Studio.Font.meta).foregroundStyle(Studio.Ink.tertiary)
                    Spacer()
                    Button("Remove") {
                        PreviewSecrets.delete(kind, checkoutRoot: workspaceRoot, scope: scope, name: name)
                        reload()
                    }
                    .buttonStyle(StudioQuietButtonStyle())
                }
            }
        }
    }

    private func add() {
        let name = newName.trimmingCharacters(in: .whitespaces)
        PreviewSecrets.save(newValue, newKind, checkoutRoot: workspaceRoot, scope: newKind == .server ? configurationName : nil, name: name)
        newName = ""
        newValue = ""
        reload()
    }

    private func reload() {
        signInNames = PreviewSecrets.names(.signIn, checkoutRoot: workspaceRoot)
        serverNames = configurationName.map { PreviewSecrets.names(.server, checkoutRoot: workspaceRoot, scope: $0) } ?? []
    }
}
