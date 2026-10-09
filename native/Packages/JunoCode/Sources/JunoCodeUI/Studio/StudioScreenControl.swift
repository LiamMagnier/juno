import AppKit
import ImageIO
import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem
import JunoScreenControl

// MARK: - Words

extension ComputerUsePermission {
    /// What the grant lets Juno do, and no more than screen control uses it
    /// for: pictures of the apps the reader grants, and input into them.
    var studioPurpose: String {
        switch self {
        case .screenRecording: "Lets Alevr see the windows of apps you grant."
        case .accessibility: "Lets Alevr read and use the apps you grant."
        }
    }

    /// The list's name in System Settings, which is not the grant's short
    /// name for Screen Recording: macOS 15 renamed it.
    var studioPaneName: String {
        switch self {
        case .screenRecording: "Screen & System Audio Recording"
        case .accessibility: "Accessibility"
        }
    }

    var studioOpenHelp: String {
        "Opens System Settings › Privacy & Security › \(studioPaneName)"
    }

    /// Opens the pane. Nothing in the app can flip the switch itself.
    func openPrivacySettings() {
        NSWorkspace.shared.open(privacySettingsURL)
    }
}

extension ComputerUsePermissionState {
    /// "Not allowed" for a refusal and a question never asked alike, because
    /// macOS reports the two identically and guessing would be wrong half the
    /// time. `notDetermined` is only what nothing has been read yet looks like.
    var studioLabel: String {
        switch self {
        case .granted: "Allowed"
        case .denied: "Not allowed"
        case .notDetermined: "Not requested"
        }
    }
}

enum StudioScreenControlText {
    /// "Screen Recording", or "Screen Recording and Accessibility". Written
    /// out rather than list-formatted: there are two grants, and the sentence
    /// must read the same in every locale the tests run under.
    static func list(_ permissions: [ComputerUsePermission]) -> String {
        let titles = permissions.map(\.title)
        guard titles.count > 1, let last = titles.last else { return titles.first ?? "" }
        return titles.dropLast().joined(separator: ", ") + " and " + last
    }
}

// MARK: - The session's notice

/// What the top of a session says about screen control, if anything.
///
/// Pure, so the mapping from coordinator state and live grants to what the
/// reader sees is testable without a window or a TCC database.
enum StudioScreenControlNotice: Equatable {
    /// Running. The stop is the point of the row.
    case active
    /// The reader took over; Juno waits for Resume.
    case paused
    /// A start the reader asked for is waiting on these grants, in the order
    /// the notice opens them.
    case needsPermission([ComputerUsePermission])
    /// macOS trusted an earlier build and not this one (CU-20).
    case trustLost
    /// It was waiting, and macOS now reports both grants. Starting is still
    /// the reader's gesture: the notice offers it and never takes it.
    case ready

    /// `isAvailable` is false once the session can no longer use screen
    /// control at all — switched to Plan, or to a model that cannot see —
    /// when a waiting notice would offer a Start that can only fail.
    init?(
        isActive: Bool,
        startBlocked: Bool,
        isAvailable: Bool = true,
        permissions: ComputerUsePermissionStatus,
        paused: Bool = false
    ) {
        if isActive {
            self = paused ? .paused : .active
            return
        }
        guard startBlocked, isAvailable else { return nil }
        let missing = permissions.missing
        if missing.contains(.accessibility), permissions.accessibilityTrustLostAfterUpdate {
            self = .trustLost
            return
        }
        self = missing.isEmpty ? .ready : .needsPermission(missing)
    }

    /// The sentence, given the app in use when running.
    func message(app: String? = nil) -> String {
        switch self {
        case .active: app.map { "Alevr is using \($0)" } ?? "Alevr can use the apps you grant"
        case .paused: "You took over. Alevr is waiting."
        case let .needsPermission(missing):
            "Screen control needs \(StudioScreenControlText.list(missing))"
        case .trustLost: ComputerUsePermissionStatus.trustLostAdvice
        case .ready: "Screen control is ready to start"
        }
    }

    var message: String { message() }

    /// The pane the one button opens: the first grant still missing, which is
    /// also the one macOS prompts for on the next start.
    var nextPermission: ComputerUsePermission? {
        switch self {
        case let .needsPermission(missing): missing.first
        case .trustLost: .accessibility
        default: nil
        }
    }
}

/// The row across the top of a session: what Juno is using, with Stop and
/// Take over, while screen control runs; the missing grant when a start could
/// not happen (CODE_AGENT_SPEC §3.7).
///
/// One plain row — a live thumbnail of the last frame, a sentence and the
/// buttons — on Liquid Glass. No dot and no pill: the words say the state
/// (CU-14), and the thumbnail refreshes after every action (CU-13).
public struct StudioScreenControlBanner: View {
    let controller: SessionController

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(controller: SessionController) {
        self.controller = controller
    }

    private var notice: StudioScreenControlNotice? {
        StudioScreenControlNotice(
            isActive: controller.computerUseActive || controller.screen.isThisSessionActive,
            startBlocked: controller.computerUseStartBlocked,
            isAvailable: controller.computerUseUnavailableReason == nil,
            // A refused start re-reads the grants with the trust memory, so a
            // grant voided by an update says how to fix it (CU-20).
            permissions: controller.computerUseStartBlocked
                ? ComputerUsePermissionProbe.system.read()
                : controller.computerUsePermissions,
            paused: controller.screen.presence.paused
        )
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let notice {
                StudioScreenControlRow(
                    notice: notice,
                    app: controller.screen.presence.holder?.appName,
                    thumbnail: controller.screen.latestStep?.thumbnail ?? controller.computerUseLatestCapture?.imageData,
                    markedPoint: controller.screen.latestStep?.markedPoint,
                    takeover: controller.screen.presence.mode == .takeover,
                    stop: { Task { await controller.stopComputerUse() } },
                    takeOver: { Task { await controller.screen.takeOver() } },
                    resume: { Task { await controller.screen.resume() } },
                    start: { Task { await controller.startComputerUse() } },
                    dismiss: { controller.dismissComputerUsePermissionNotice() }
                )
                .transition(reduceMotion ? .junoInline : .junoOverlay)
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        // Grants change in System Settings, outside the app, and nothing
        // tells Juno. Coming back is the moment they may have changed, so the
        // notice re-reads them then and turns into Start without the reader
        // hunting for a refresh.
        .onReceive(
            NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
        ) { _ in
            guard controller.computerUseStartBlocked || controller.computerUseActive else { return }
            Task { await controller.refreshComputerUse() }
        }
    }
}

/// The row itself, from plain values, so snapshots can draw every state.
struct StudioScreenControlRow: View {
    let notice: StudioScreenControlNotice
    var app: String?
    var thumbnail: Data?
    var markedPoint: [Double]?
    var takeover = false
    let stop: () -> Void
    var takeOver: () -> Void = {}
    var resume: () -> Void = {}
    let start: () -> Void
    let dismiss: () -> Void

    @Environment(\.junoSnapshotOpaqueGlass) private var snapshotOpaqueGlass

    private var sentence: String {
        let base = notice.message(app: app)
        return notice == .active && takeover ? base + " and has the whole screen" : base
    }

    private var detail: String? {
        switch notice {
        case .active: "Press Esc anywhere to stop."
        case .paused: "Resume when you are done; Alevr takes a fresh look first."
        case .trustLost: "macOS ties the permission to each build, and this one was not added."
        default: nil
        }
    }

    var body: some View {
        // With the side panel open the thread column is narrow; the buttons
        // give up their long names first, then the sentence wraps. It never
        // truncates.
        ViewThatFits(in: .horizontal) {
            row(compact: false)
            row(compact: true)
        }
        .padding(.leading, thumbnail != nil && isRunning ? JunoSpace.snug : JunoSpace.cozy)
        .padding(.trailing, JunoSpace.snug)
        .padding(.vertical, JunoSpace.snug)
        .background { surface }
        .padding(.top, JunoSpace.snug)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(sentence)
    }

    private var isRunning: Bool { notice == .active || notice == .paused }

    @ViewBuilder
    private var surface: some View {
        let shape = RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
        if snapshotOpaqueGlass {
            shape.fill(Studio.Surface.raised).overlay(shape.strokeBorder(Studio.Surface.hairline))
        } else {
            Color.clear.junoGlass(in: shape)
        }
    }

    private func row(compact: Bool) -> some View {
        HStack(spacing: JunoSpace.snug) {
            if isRunning, let thumbnail {
                StudioScreenThumbnail(imageData: thumbnail, markedPoint: markedPoint)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(sentence)
                    .font(Studio.Font.labelEmphasis)
                    .foregroundStyle(Studio.Ink.primary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail, !compact {
                    Text(detail)
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: JunoSpace.snug)
            actions(compact: compact)
                .fixedSize()
        }
    }

    @ViewBuilder
    private func actions(compact: Bool) -> some View {
        switch notice {
        case .active:
            Button("Take over", action: takeOver)
                .buttonStyle(StudioQuietButtonStyle())
                .help("Pause Alevr and use the Mac yourself")
                .accessibilityIdentifier("juno.code.computer-use.take-over").contentShape(.rect)
            Button("Stop", action: stop)
                .buttonStyle(StudioSecondaryButtonStyle())
                .contentShape(Capsule())
                .help("End screen control now, in every session (Esc)")
                .accessibilityIdentifier("juno.code.computer-use.stop")
        case .paused:
            Button("Stop", action: stop)
                .buttonStyle(StudioQuietButtonStyle())
                .accessibilityIdentifier("juno.code.computer-use.stop").contentShape(.rect)
            Button("Resume", action: resume)
                .buttonStyle(StudioSecondaryButtonStyle())
                .help("Let Alevr carry on from a fresh look at the screen")
                .accessibilityIdentifier("juno.code.computer-use.resume").contentShape(.rect)
        case .needsPermission, .trustLost:
            if let permission = notice.nextPermission {
                Button(compact ? "Open Settings" : "Open \(permission.title)") {
                    permission.openPrivacySettings()
                }
                .buttonStyle(StudioSecondaryButtonStyle())
                .contentShape(Capsule())
                .help(
                    permission == .screenRecording
                        ? permission.studioOpenHelp + ". macOS may ask you to reopen Alevr after you allow it."
                        : permission.studioOpenHelp
                )
                .accessibilityLabel("Open \(permission.title) settings")
                .accessibilityIdentifier("juno.code.computer-use.open-settings")
            }
            dismissButton
        case .ready:
            Button("Start", action: start)
                .buttonStyle(StudioSecondaryButtonStyle())
                .contentShape(Capsule())
                .help("Start screen control for this session")
                .accessibilityIdentifier("juno.code.computer-use.start")
            dismissButton
        }
    }

    private var dismissButton: some View {
        Button(action: dismiss) {
            JunoIconView(.close, size: 12)
        }
        .buttonStyle(StudioIconButtonStyle())
        .contentShape(RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous))
        .help("Dismiss")
        .accessibilityLabel("Dismiss")
        .accessibilityIdentifier("juno.code.computer-use.dismiss")
    }
}

// MARK: - What the agent saw

/// The agent's latest frame at the height of a control, with the point it
/// acted on marked, opening to a readable size on click.
struct StudioScreenThumbnail: View {
    let imageData: Data
    var markedPoint: [Double]?
    var height: CGFloat = Studio.Metrics.control + 8

    @State private var thumbnail: CGImage?
    @State private var presented = false

    var body: some View {
        Button { presented = true } label: {
            ZStack {
                if let thumbnail {
                    Image(decorative: thumbnail, scale: 2)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                } else {
                    Studio.Surface.muted.aspectRatio(16 / 10, contentMode: .fit)
                }
            }
            .overlay { StudioPointMarker(point: markedPoint) }
            .frame(height: height)
            .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous))
            // A screenshot is content, so it sits on a real edge: a white
            // window in light mode and a dark desktop in dark mode both vanish
            // into the row without one.
            .overlay(
                RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous)
                    .strokeBorder(Studio.Surface.hairline)
            )
            .contentShape(RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous))
        }
        .buttonStyle(.plain)
        .help("What Alevr saw last")
        .accessibilityLabel("What Alevr saw last")
        .accessibilityHint("Shows the screen capture larger")
        .accessibilityIdentifier("juno.code.computer-use.capture")
        .popover(isPresented: $presented, arrowEdge: .bottom) {
            StudioCaptureDetail(imageData: imageData, markedPoint: markedPoint)
        }
        // Decoded once per frame, small: the row redraws with every streamed
        // token, and a full frame decoded on each of those would be most of it.
        .task(id: imageData) {
            thumbnail = StudioCaptureImage.decode(imageData, maxPixelSize: 220)
        }
    }
}

/// A ring at a fractional point of whatever it overlays.
struct StudioPointMarker: View {
    let point: [Double]?

    var body: some View {
        GeometryReader { proxy in
            if let point, point.count == 2 {
                Circle()
                    .strokeBorder(Studio.Ink.accent, lineWidth: 1.5)
                    .background(Circle().strokeBorder(Color.white.opacity(0.9), lineWidth: 3))
                    .frame(width: 9, height: 9)
                    .position(x: proxy.size.width * point[0], y: proxy.size.height * point[1])
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct StudioCaptureDetail: View {
    let imageData: Data
    var markedPoint: [Double]?
    var capturedAt: Date?

    @State private var image: CGImage?

    private static let width: CGFloat = 560

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            ZStack {
                if let image {
                    Image(decorative: image, scale: 2)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                } else {
                    Studio.Surface.muted.aspectRatio(16 / 10, contentMode: .fit)
                }
            }
            .overlay { StudioPointMarker(point: markedPoint) }
            .frame(width: Self.width)
            .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                    .strokeBorder(Studio.Surface.hairline)
            )
            .accessibilityLabel("Screen capture")
            Text("What Alevr saw. Kept in memory only, and gone when screen control stops.")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .frame(width: Self.width, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(JunoSpace.cozy)
        .task(id: imageData) {
            image = StudioCaptureImage.decode(imageData, maxPixelSize: 1_400)
        }
    }
}

enum StudioCaptureImage {
    /// A downsampled decode straight from the encoded frame, so a thumbnail
    /// never holds a full display's pixels.
    static func decode(_ data: Data, maxPixelSize: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(
            source,
            0,
            [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            ] as CFDictionary
        )
    }
}

// MARK: - Settings

/// Screen control's page section: what it does, the two macOS grants live,
/// and the apps the reader narrowed (Settings → Screen control).
///
/// Every claim in the copy is one the code keeps: grants are per app and per
/// session (D-021); terminals and IDEs are click-only, browsers view-only,
/// Juno and password or system prompts never; clicks, typing and keys ask
/// unless the session has Full access; sending, buying, deleting and signing
/// in always ask; a project's files cannot change any of it.
struct StudioScreenControlSettings: View {
    let probe: ComputerUsePermissionProbe
    var preferencesStore: ScreenControlPreferencesStore = .standard

    @State private var permissions: ComputerUsePermissionStatus
    @State private var preferences: ScreenControlPreferences = .default
    @State private var newApp = ""

    init(probe: ComputerUsePermissionProbe, preferencesStore: ScreenControlPreferencesStore = .standard) {
        self.probe = probe
        self.preferencesStore = preferencesStore
        // Read in init as well as on appear: preflight is cheap and never
        // prompts, and it spares the first frame a state it did not read.
        _permissions = State(initialValue: probe.read())
        _preferences = State(initialValue: preferencesStore.load())
    }

    var body: some View {
        Section {
            Text("Lets Alevr use the Mac apps you grant, one session at a time, when you choose Let Alevr Use Apps from the More menu. Each app is granted for the session only: terminals and editors for clicks, browsers for looking, and never Alevr itself, password managers or system prompts. Clicks, typing and keys ask first unless the session has Full access; sending, buying, deleting, signing in and changes in System Settings always ask. Press Esc anywhere to stop.")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if permissions.accessibilityTrustLostAfterUpdate, permissions.accessibility != .granted {
                Text(ComputerUsePermissionStatus.trustLostAdvice)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("juno.code.settings.screen-control.trust-lost")
            }
            ForEach(ComputerUsePermission.allCases, id: \.self) { permission in
                row(permission)
            }
        } header: {
            Text("Screen control")
        } footer: {
            Text("Available in sessions on this Mac, in a mode that can make changes, with a model that can see images. It stops when you press Stop or Esc, switch sessions or switch to Plan. macOS reports only whether Alevr has each permission, and may ask you to reopen Alevr after you allow Screen Recording.")
        }
        // The window appearing and the app coming back to the front are the
        // two moments a grant can have changed: the reader was in System
        // Settings, which tells no one.
        .onAppear(perform: refresh)
        .onReceive(
            NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
        ) { _ in refresh() }

        Section {
            if narrowed.isEmpty {
                Text("No app is narrowed. Each app gets the most its kind allows, and only when you grant it in a session.")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            ForEach(narrowed, id: \.self) { bundleID in
                appRow(bundleID)
            }
            HStack(spacing: JunoSpace.cozy) {
                TextField("Bundle id, like com.apple.TextEdit", text: $newApp)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(addApp)
                Button("Deny", action: addApp)
                    .disabled(newApp.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("juno.code.settings.screen-control.deny")
            }
        } header: {
            Text("Apps")
        } footer: {
            Text("You can lower what an app may be granted or deny it. Nothing here can raise an app above its kind's limit, and nothing here grants an app: that is a question in each session.")
        }

        StudioConnectedAgentsSettings()
    }

    /// Bundle ids the reader denied or lowered, sorted.
    private var narrowed: [String] {
        (Array(preferences.denied) + Array(preferences.loweredTiers.keys)).sorted()
    }

    private func appRow(_ bundleID: String) -> some View {
        let cap = AppCategories.category(bundleID: bundleID).cap
        let current: AppTier? = preferences.denied.contains(bundleID) ? nil : preferences.loweredTiers[bundleID]
        return HStack {
            Text(bundleID)
                .font(Studio.Font.mono)
            Spacer()
            Menu(current.map { $0.phrase.capitalized(with: nil) } ?? "Never") {
                ForEach(AppTier.allCases.filter { candidate in cap.map { candidate <= $0 } ?? false }, id: \.self) { tier in
                    Button(tier.phrase.capitalized(with: nil)) { preferences = preferencesStore.set(bundleID, tier: tier); push() }.contentShape(.rect)
                }
                Button("Never") { preferences = preferencesStore.set(bundleID, tier: nil); push() }.contentShape(.rect)
                Divider()
                Button("Remove from this list") { preferences = preferencesStore.remove(bundleID); push() }.contentShape(.rect)
            }
            .fixedSize().contentShape(.rect)
        }
    }

    private func addApp() {
        let id = newApp.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { return }
        preferences = preferencesStore.set(id, tier: nil)
        newApp = ""
        push()
    }

    private func push() {
        let preferences = self.preferences
        Task { await ScreenControlService.shared.setPreferences(preferences) }
    }

    private func row(_ permission: ComputerUsePermission) -> some View {
        let state = permissions.state(of: permission)
        return HStack(spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: 2) {
                Text(permission.title)
                Text(permission.studioPurpose)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            Spacer()
            HStack(spacing: JunoSpace.hairline) {
                if state == .granted {
                    JunoIconView(.check, size: 12)
                        .foregroundStyle(Studio.Ink.secondary)
                        .accessibilityHidden(true)
                }
                Text(state.studioLabel)
                    .font(Studio.Font.meta)
                    .foregroundStyle(state == .granted ? Studio.Ink.secondary : Studio.Ink.primary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("juno.code.settings.screen-control.\(permission.rawValue).state")
            // Present whatever the state: the same pane is where an allowed
            // grant is taken back.
            Button("Open Settings") { permission.openPrivacySettings() }
                .contentShape(Rectangle())
                .help(permission.studioOpenHelp)
                .accessibilityLabel("Open \(permission.title) settings")
                .accessibilityIdentifier("juno.code.settings.screen-control.\(permission.rawValue).open")
        }
    }

    private func refresh() {
        permissions = probe.read()
        preferences = preferencesStore.load()
    }
}

/// Computer use for connected agents (Code v2 SPEC §3.12): Claude through
/// your own `claude`, Codex, Gemini CLI and the other agents Alevr runs reach
/// this Mac through Alevr's `computer_use` tool. Off until you turn it on;
/// each agent asks once per session, each app is granted in the session, and
/// the allowlist only spares cards in Auto-edit and Auto — never the floor.
struct StudioConnectedAgentsSettings: View {
    var url: URL = ComputerUseBridgeSettings.defaultURL

    @State private var settings = ComputerUseBridgeSettings()
    @State private var newApp = ""
    @State private var saveFailed = false

    var body: some View {
        Section {
            Toggle("Let connected agents use apps", isOn: Binding(
                get: { settings.connectedAgentsEnabled },
                set: { settings.connectedAgentsEnabled = $0; save() }
            ))
            .accessibilityIdentifier("alevr.code.settings.connected-agents.toggle")
            if settings.connectedAgentsEnabled {
                ForEach(settings.allowlist.sorted(), id: \.self) { bundleID in
                    HStack {
                        Text(bundleID).font(Studio.Font.mono)
                        Spacer()
                        Button("Remove") {
                            settings.allowlist.remove(bundleID)
                            save()
                        }
                        .contentShape(.rect)
                    }
                }
                HStack(spacing: JunoSpace.cozy) {
                    TextField("Bundle id, like com.apple.TextEdit", text: $newApp)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(add)
                    Button("Allow without asking", action: add)
                        .disabled(newApp.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier("alevr.code.settings.connected-agents.allow")
                }
            }
            if saveFailed {
                Text("Alevr could not save this setting.")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.primary)
            }
        } header: {
            Text("Connected agents")
        } footer: {
            Text("Agents you connect to Alevr Code, like Claude (your subscription) or Codex, can use Mac apps through Alevr: each asks you once per session, each app is granted in that session, and every step shows on screen with Esc to stop. Apps listed here run clicks and typing without a card in Auto-edit and Auto; sending, buying, deleting and signing in always ask.")
        }
        .onAppear { settings = ComputerUseBridgeSettings.load(from: url) }
    }

    private func add() {
        let id = newApp.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !id.isEmpty else { return }
        settings.allowlist.insert(id)
        newApp = ""
        save()
    }

    private func save() {
        do {
            try settings.save(to: url)
            saveFailed = false
        } catch {
            saveFailed = true
        }
    }
}
