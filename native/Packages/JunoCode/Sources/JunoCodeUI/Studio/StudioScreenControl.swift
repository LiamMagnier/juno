import AppKit
import ImageIO
import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem

// MARK: - Words

extension ComputerUsePermission {
    /// What the grant lets Juno do, and no more than the driver uses it for:
    /// the capture is the main display only, and input is clicks, typing, key
    /// presses and scrolls.
    var studioPurpose: String {
        switch self {
        case .screenRecording: "Lets Juno see your main display."
        case .accessibility: "Lets Juno click, type, press keys and scroll."
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
    /// Running. The stop is the point of the banner.
    case active
    /// A start the reader asked for is waiting on these grants, in the order
    /// the notice opens them.
    case needsPermission([ComputerUsePermission])
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
        permissions: ComputerUsePermissionStatus
    ) {
        if isActive {
            self = .active
            return
        }
        guard startBlocked, isAvailable else { return nil }
        let missing = permissions.missing
        self = missing.isEmpty ? .ready : .needsPermission(missing)
    }

    var message: String {
        switch self {
        case .active: "Juno is controlling the screen"
        case let .needsPermission(missing):
            "Screen control needs \(StudioScreenControlText.list(missing))"
        case .ready: "Screen control is ready to start"
        }
    }

    /// The pane the one button opens: the first grant still missing, which is
    /// also the one macOS prompts for on the next start.
    var nextPermission: ComputerUsePermission? {
        if case let .needsPermission(missing) = self { return missing.first }
        return nil
    }
}

/// The banner across the top of a session: the stop while screen control
/// runs, and the missing grant when a start could not happen.
///
/// Before this, a start that macOS refused set a red line at the foot of the
/// thread — usually scrolled out of view, with no way to reach the pane that
/// fixes it — so Start read as doing nothing. The refusal now lands where the
/// stop does, names every grant still missing, and opens the right pane.
public struct StudioScreenControlBanner: View {
    let controller: SessionController

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(controller: SessionController) {
        self.controller = controller
    }

    private var notice: StudioScreenControlNotice? {
        StudioScreenControlNotice(
            isActive: controller.computerUseActive,
            startBlocked: controller.computerUseStartBlocked,
            isAvailable: controller.computerUseUnavailableReason == nil,
            permissions: controller.computerUsePermissions
        )
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let notice {
                StudioScreenControlCapsule(
                    notice: notice,
                    capture: controller.computerUseLatestCapture,
                    stop: { Task { await controller.stopComputerUse() } },
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

/// The capsule itself, from plain values, so snapshots can draw every state.
struct StudioScreenControlCapsule: View {
    let notice: StudioScreenControlNotice
    var capture: ComputerUseCapture?
    let stop: () -> Void
    let start: () -> Void
    let dismiss: () -> Void

    var body: some View {
        // With the side panel open the thread column is narrow, and the names
        // of the missing grants are the one part of the sentence the reader
        // cannot do without. So the button gives up its pane name first, and
        // then the sentence wraps; it never truncates.
        ViewThatFits(in: .horizontal) {
            row(compact: false)
            row(compact: true)
        }
        .padding(.leading, notice == .active && capture != nil ? JunoSpace.snug : JunoSpace.cozy)
        .padding(.trailing, JunoSpace.snug)
        .padding(.vertical, JunoSpace.snug)
        .background(Capsule().fill(Studio.Surface.raised))
        .overlay(Capsule().strokeBorder(Studio.Surface.hairline))
        .padding(.top, JunoSpace.snug)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(notice.message)
    }

    private func row(compact: Bool) -> some View {
        HStack(spacing: JunoSpace.snug) {
            if notice == .active, let capture {
                StudioCaptureThumbnail(capture: capture)
            }
            mark
            Text(notice.message)
                .font(Studio.Font.label)
                .foregroundStyle(Studio.Ink.primary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            actions(compact: compact)
                .fixedSize()
        }
    }

    /// Red while Juno holds the mouse and keyboard, as it always has: a live
    /// control is not the "working" coral. Coral while a start waits on the
    /// reader, because that is exactly "needs you".
    @ViewBuilder
    private var mark: some View {
        switch notice {
        case .active:
            Circle().fill(Studio.Ink.danger).frame(width: 7, height: 7)
        case .needsPermission, .ready:
            Circle().fill(Studio.Ink.accent).frame(width: 7, height: 7)
        }
    }

    @ViewBuilder
    private func actions(compact: Bool) -> some View {
        switch notice {
        case .active:
            Button("Stop", action: stop)
                .buttonStyle(StudioSecondaryButtonStyle())
                .contentShape(Capsule())
                .help("Immediately end screen capture and input control")
                .accessibilityIdentifier("juno.code.computer-use.stop")
        case .needsPermission:
            if let permission = notice.nextPermission {
                Button(compact ? "Open Settings" : "Open \(permission.title)") {
                    permission.openPrivacySettings()
                }
                .buttonStyle(StudioSecondaryButtonStyle())
                .contentShape(Capsule())
                .help(
                    permission == .screenRecording
                        ? permission.studioOpenHelp
                            + ". macOS may ask you to reopen Juno after you allow it."
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

/// The agent's latest screenshot at the height of a control, opening to a
/// readable size on click.
///
/// A screen at 45 points wide is a sign of life, not something to read: it
/// says the agent is looking, and roughly at what. The popover is where it can
/// actually be read.
struct StudioCaptureThumbnail: View {
    let capture: ComputerUseCapture

    @State private var thumbnail: CGImage?
    @State private var presented = false

    var body: some View {
        Button { presented = true } label: {
            Group {
                if let thumbnail {
                    Image(decorative: thumbnail, scale: 2)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                } else {
                    Studio.Surface.muted
                        .aspectRatio(16 / 10, contentMode: .fit)
                }
            }
            .frame(height: Studio.Metrics.control)
            .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous))
            // A screenshot is content, so it sits on a real edge: a white
            // window in light mode and a dark desktop in dark mode both vanish
            // into the capsule without one.
            .overlay(
                RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous)
                    .strokeBorder(Studio.Surface.hairline)
            )
            .contentShape(RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous))
        }
        .buttonStyle(.plain)
        .help("What Juno saw last")
        .accessibilityLabel("What Juno saw last")
        .accessibilityHint("Shows the screen capture larger")
        .accessibilityIdentifier("juno.code.computer-use.capture")
        .popover(isPresented: $presented, arrowEdge: .bottom) {
            StudioCaptureDetail(capture: capture)
        }
        // Decoded once per capture, small: the banner redraws with every
        // streamed token, and a full-display JPEG decoded on each of those
        // would be most of the frame.
        .task(id: capture.capturedAt) {
            thumbnail = StudioCaptureImage.decode(capture.imageData, maxPixelSize: 160)
        }
    }
}

struct StudioCaptureDetail: View {
    let capture: ComputerUseCapture

    @State private var image: CGImage?

    private static let width: CGFloat = 560

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Group {
                if let image {
                    Image(decorative: image, scale: 2)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                } else {
                    Studio.Surface.muted.aspectRatio(16 / 10, contentMode: .fit)
                }
            }
            .frame(width: Self.width)
            .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                    .strokeBorder(Studio.Surface.hairline)
            )
            .accessibilityLabel("Screen capture")
            Text("What Juno saw at \(capture.capturedAt.formatted(date: .omitted, time: .standard)). Kept in memory only, and gone when screen control stops.")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .frame(width: Self.width, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(JunoSpace.cozy)
        .task(id: capture.capturedAt) {
            image = StudioCaptureImage.decode(capture.imageData, maxPixelSize: 1_400)
        }
    }
}

enum StudioCaptureImage {
    /// A downsampled decode straight from the JPEG, so a thumbnail never
    /// holds a full display's pixels.
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

/// Screen control's page section: the two grants, live, each a click from its
/// System Settings pane, and a plain account of what turning it on means.
///
/// Every claim in the copy is one the code keeps. Screenshots are `read`
/// actions and never ask; clicks, typing, key presses and scrolls are
/// `critical`, which asks in every mode but Full access, and an Always allow
/// rule silences them like any other tool. The copy says so rather than
/// promising "always asks", which would be false in exactly the mode where a
/// reader most needs it to be true.
struct StudioScreenControlSettings: View {
    let probe: ComputerUsePermissionProbe

    @State private var permissions: ComputerUsePermissionStatus

    init(probe: ComputerUsePermissionProbe) {
        self.probe = probe
        // Read in init as well as on appear: preflight is cheap and never
        // prompts, and it spares the first frame a state it did not read.
        _permissions = State(initialValue: probe.read())
    }

    var body: some View {
        Section {
            Text("Lets Juno see your main display and use the mouse and keyboard, in a session where you choose Start Screen Control from the More menu. Screenshots never ask. Each click, keystroke and scroll asks first, unless the session has Full access or you chose Always allow for it.")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(ComputerUsePermission.allCases, id: \.self) { permission in
                row(permission)
            }
        } header: {
            Text("Screen control")
        } footer: {
            Text("Available in sessions on this Mac, in a mode that can make changes, with a model that can see images. It stops when you press Stop, switch sessions or switch to Plan. macOS reports only whether Juno has each permission, and may ask you to reopen Juno after you allow Screen Recording.")
        }
        // The window appearing and the app coming back to the front are the
        // two moments a grant can have changed: the reader was in System
        // Settings, which tells no one.
        .onAppear(perform: refresh)
        .onReceive(
            NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
        ) { _ in refresh() }
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
    }
}
