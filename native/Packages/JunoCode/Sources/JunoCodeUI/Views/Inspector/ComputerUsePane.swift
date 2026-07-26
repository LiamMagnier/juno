import AppKit
import Combine
import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem

/// Computer Use: what Juno is allowed to do to this Mac, what it has already
/// done, and the control that ends it.
///
/// This is a safety surface before it is an information surface, so three rules
/// shape it and none of them are negotiable:
///
/// 1. **Nothing here reports a state it did not read.** Every value comes from
///    `ComputerUseCoordinator.snapshot()` by way of the controller — the two TCC
///    grants from `CGPreflightScreenCaptureAccess`/`AXIsProcessTrusted`, the
///    bounds from `CGDisplayBounds`, the journal from the coordinator's own
///    record. A permission reads "Granted" only when macOS says it is.
/// 2. **Allowing is not starting.** The switch writes the session's capability;
///    starting is a separate, visible gesture, because that gesture is the
///    consent the coordinator demands and the moment macOS is asked for the
///    grants. Reopening a session never resumes capture: the coordinator's
///    active state lives in memory and `detach()` drops it.
/// 3. **The stop is never more than one click away.** ``ComputerUseStopBar``
///    pins it above the list here, and the canvas carries the floating glass
///    indicator; both are driven by the same `computerUseActive` fact.
///
/// It renders as sections of the Activity list rather than as a fourth
/// inspector pane on purpose. Activity's question is "what is the run doing, and
/// what has it been allowed to do to this machine" — screen control is the
/// sharpest answer that question has. A fourth segment would also have to fit
/// beside Changes, Activity and Repository in a 260pt column, where the existing
/// three already spend their width.
struct ComputerUseSections: View {
    let controller: SessionController

    /// The thumbnail's ceiling.
    ///
    /// Bounded rather than left to `scaledToFit`, because an unbounded ideal
    /// height propagates out of a scroll view and up into the split view, which
    /// resizes the *window* instead of clipping the image. A 16:10 display at
    /// inspector width is about this tall anyway.
    private static let captureHeight: CGFloat = 180

    var body: some View {
        Group {
            consentSection
            permissionsSection
            displaySection
            captureSection
            journalSection
        }
    }

    // MARK: - Consent

    private var consentSection: some View {
        Section {
            Toggle("Allow screen control", isOn: enabledBinding)
                .disabled(unavailableReason != nil)
                .help(
                    "Lets this session capture the display and drive the pointer and keyboard. Turning it off stops capture immediately."
                )
                .accessibilityIdentifier("juno.code.inspector.computer-use.enabled")

            LabeledContent("State") { stateChip }

            // Both controls are always present and disabled rather than swapped
            // in and out, so the stop never moves to a position the pointer has
            // to re-find at the moment it is needed.
            HStack(spacing: JunoSpace.snug) {
                Spacer(minLength: 0)
                Button("Start") {
                    Task { await controller.activateComputerUse() }
                }
                .controlSize(.small)
                .disabled(!canStart)
                .help(startHelp)
                .accessibilityIdentifier("juno.code.inspector.computer-use.start")

                Button("Stop", role: .destructive) {
                    Task { await controller.stopComputerUse() }
                }
                .controlSize(.small)
                .disabled(!controller.computerUseActive)
                .help("Immediately end screen capture and input control")
                .accessibilityIdentifier("juno.code.inspector.computer-use.stop")
            }

            if let unavailableReason {
                Text(unavailableReason).junoCaption()
            }
        } header: {
            Text("Screen control")
        } footer: {
            Text(
                "Starting is the consent: macOS asks for Screen Recording and Accessibility the first time, and Juno never starts on its own — reopening this session leaves screen control off."
            )
            .junoCaption()
        }
    }

    @ViewBuilder
    private var stateChip: some View {
        if controller.computerUseActive {
            StatusChip("Active", systemImage: "record.circle", tint: .junoDanger)
        } else if controller.session.configuration.computerUseEnabled {
            StatusChip("Not running", systemImage: "pause.circle", tint: .secondary)
        } else {
            StatusChip("Off", systemImage: "stop.circle", tint: .secondary)
        }
    }

    // MARK: - Permissions

    private var permissionsSection: some View {
        Section {
            permissionRow(
                "Screen Recording",
                state: controller.computerUseScreenPermission,
                anchor: "Privacy_ScreenCapture"
            )
            permissionRow(
                "Accessibility",
                state: controller.computerUseAccessibilityPermission,
                anchor: "Privacy_Accessibility"
            )
            HStack(spacing: JunoSpace.snug) {
                Spacer(minLength: 0)
                Button("Re-check") {
                    Task { await controller.refreshComputerUse() }
                }
                .controlSize(.small)
                .help("Ask macOS for both grants again")
                .accessibilityIdentifier("juno.code.inspector.computer-use.recheck")
            }
        } header: {
            Text("Permissions")
        } footer: {
            // macOS answers "does this process hold the grant", and nothing more:
            // never-asked and refused are the same `false`. So the pane says "Not
            // granted" rather than picking one of the two and being wrong half
            // the time.
            Text(
                "macOS reports only whether Juno holds each grant, not whether it was refused or never asked for. Screen Recording in particular often needs Juno relaunched before a grant made in System Settings is reported here."
            )
            .junoCaption()
        }
    }

    private func permissionRow(
        _ name: String,
        state: ComputerUsePermissionState,
        anchor: String
    ) -> some View {
        LabeledContent(name) {
            HStack(spacing: JunoSpace.tight) {
                Text(permissionLabel(state))
                    .junoCaption()
                    .foregroundStyle(permissionTint(state))
                if state != .granted {
                    Button("Open Settings…") { openPrivacySettings(anchor: anchor) }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .help("Open System Settings › Privacy & Security › \(name)")
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name): \(permissionLabel(state))")
    }

    // MARK: - Display

    private var displaySection: some View {
        Section {
            if let bounds = controller.computerUseDisplayBounds {
                LabeledContent("Captured display", value: "Main display")
                LabeledContent("Size") {
                    Text("\(Int(bounds.width)) × \(Int(bounds.height)) pt").junoCodeSmall()
                }
                LabeledContent("Origin") {
                    Text("\(Int(bounds.minX)), \(Int(bounds.minY))").junoCodeSmall()
                }
            } else {
                Text("macOS did not report bounds for the main display.").junoCaption()
            }
        } header: {
            Text("Display")
        } footer: {
            // Stated plainly because the driver really is single-display:
            // `displayBounds()` is `CGDisplayBounds(CGMainDisplayID())` and the
            // capture filter picks the same display. Implying a picker exists
            // would be the lie here.
            Text(
                "Main display only. Juno does not enumerate displays, so there is no display or window picker beneath this — a second monitor is neither captured nor clickable. Coordinates outside these bounds are refused before they reach the system."
            )
            .junoCaption()
        }
    }

    // MARK: - Capture

    private var captureSection: some View {
        Section {
            HStack(spacing: JunoSpace.snug) {
                Button("Capture now") {
                    Task { await controller.captureComputerUseScreenshot() }
                }
                .controlSize(.small)
                .disabled(!controller.computerUseActive)
                .help(
                    controller.computerUseActive
                        ? "Take one screenshot through the same rate-limited, journaled path the agent uses"
                        : "Screen control is not running"
                )
                .accessibilityIdentifier("juno.code.inspector.computer-use.capture")
                Spacer(minLength: 0)
            }

            if let data = controller.computerUseScreenshot, let image = NSImage(data: data) {
                capture(image)
            } else {
                Text("No capture has been taken from this pane.").junoCaption()
            }
        } header: {
            Text("Latest capture")
        } footer: {
            Text(
                "Held in memory for this session and dropped the moment screen control stops. It is never written to the transcript, to sync, or to analytics. Captures the agent takes for itself are listed below, not shown here."
            )
            .junoCaption()
        }
    }

    private func capture(_ image: NSImage) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Image(nsImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: Self.captureHeight)
                .clipShape(
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                )
                // A screenshot is content, so it sits on a real edge rather than
                // bleeding into the pane — a white window in light mode and a
                // dark desktop in dark mode both need one.
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .strokeBorder(Color.junoBorder, lineWidth: 1)
                )
                .accessibilityLabel("Most recent screen capture")
            if let pixels = pixelSize(of: image) {
                Text(pixels).junoCodeSmall().foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, JunoSpace.hairline)
    }

    /// The capture's real pixel dimensions, which are not the display's point
    /// size on a Retina Mac.
    private func pixelSize(of image: NSImage) -> String? {
        guard let representation = image.representations.first else { return nil }
        return "\(representation.pixelsWide) × \(representation.pixelsHigh) px"
    }

    // MARK: - Journal

    private var journalSection: some View {
        Section {
            if controller.computerUseJournal.isEmpty {
                Text(emptyJournalMessage).junoCaption()
            } else {
                ForEach(controller.computerUseJournal.reversed()) { entry in
                    journalRow(entry)
                }
            }
        } header: {
            HStack(spacing: JunoSpace.snug) {
                Text("Actions")
                Spacer(minLength: 0)
                if let journalSummary {
                    Text(journalSummary).junoCaption()
                }
            }
        } footer: {
            // Deliberately not "every action is recorded". The coordinator
            // refuses an out-of-bounds coordinate and a too-fast action *before*
            // it journals anything, so those never appear as failed rows. Saying
            // otherwise would let a reader treat an empty list as proof that
            // nothing was attempted.
            Text(
                "Every action that reaches the system is recorded here as it happens, with its result. Actions refused before that — a coordinate outside the display, or one arriving sooner than \(rateLimitLabel) after the last — are turned away without a row. The record lives in this session only; it is not written to the transcript or synced."
            )
            .junoCaption()
        }
    }

    private func journalRow(_ entry: ComputerUseJournalEntry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: JunoSpace.tight) {
                Image(
                    systemName: entry.succeeded
                        ? "checkmark.circle.fill"
                        : "xmark.circle.fill"
                )
                .imageScale(.small)
                .foregroundStyle(entry.succeeded ? Color.junoSuccess : Color.junoDanger)
                .accessibilityHidden(true)
                Text(actionLabel(entry.action)).junoCodeSmall()
                Spacer(minLength: JunoSpace.tight)
                Text(entry.timestamp, style: .time)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if let note = entry.note {
                // The coordinator's own reason the action failed once it had
                // already reached the driver — a capture that could not encode,
                // an unsupported key, an event the window server refused.
                // Rendered verbatim: the exact failure is what makes the record
                // worth keeping, and rewriting it into something friendlier
                // would cost the reader the only detail they can act on.
                Text(note)
                    .junoCaption()
                    .lineLimit(3)
                    .textSelection(.enabled)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(actionLabel(entry.action)), \(entry.succeeded ? "succeeded" : "failed")"
        )
    }

    // MARK: - Derived text

    private var unavailableReason: String? { controller.computerUseUnavailableReason }

    private var canStart: Bool {
        unavailableReason == nil
            && controller.session.configuration.computerUseEnabled
            && !controller.computerUseActive
    }

    private var startHelp: String {
        if let unavailableReason { return unavailableReason }
        if !controller.session.configuration.computerUseEnabled {
            return "Allow screen control for this session first"
        }
        if controller.computerUseActive { return "Screen control is already running" }
        return "Start screen capture and input control for this session"
    }

    private var enabledBinding: Binding<Bool> {
        Binding(
            get: { controller.session.configuration.computerUseEnabled },
            set: { enabled in
                Task { await controller.setComputerUseEnabled(enabled) }
            }
        )
    }

    private var emptyJournalMessage: String {
        if let unavailableReason { return unavailableReason }
        if !controller.session.configuration.computerUseEnabled {
            return "Screen control is off for this session."
        }
        return "Nothing has been captured, clicked or typed in this session."
    }

    /// "14 actions · 2 failed" — counted off the record, never estimated.
    private var journalSummary: String? {
        let entries = controller.computerUseJournal
        guard !entries.isEmpty else { return nil }
        let failed = entries.filter { !$0.succeeded }.count
        let total = entries.count == 1 ? "1 action" : "\(entries.count) actions"
        return failed == 0 ? total : "\(total) · \(failed) failed"
    }

    /// Read from the coordinator's own constant rather than restated, so the
    /// sentence cannot drift away from the limit it describes.
    private var rateLimitLabel: String {
        let seconds = ComputerUseCoordinator.minimumActionIntervalSeconds
        return String(format: "%.1fs", seconds)
    }

    private func permissionLabel(_ state: ComputerUsePermissionState) -> String {
        switch state {
        case .notDetermined: "Not requested"
        case .denied: "Not granted"
        case .granted: "Granted"
        }
    }

    private func permissionTint(_ state: ComputerUsePermissionState) -> Color {
        switch state {
        // Caution, not danger: a grant that has never been asked for is a step
        // still to take, not a failure, and macOS cannot tell the two apart.
        case .notDetermined: .secondary
        case .denied: .junoCaution
        case .granted: .junoSuccess
        }
    }

    private func actionLabel(_ action: ComputerUseActionKind) -> String {
        switch action {
        case .screenshot: "Screen capture"
        case let .click(x, y): "Click \(Int(x)), \(Int(y))"
        case let .doubleClick(x, y): "Double-click \(Int(x)), \(Int(y))"
        case let .typeText(text): "Type \(text.count) characters"
        case let .pressKey(key): "Press \(key)"
        case let .scroll(x, y, delta): "Scroll \(Int(delta)) at \(Int(x)), \(Int(y))"
        }
    }

    private func openPrivacySettings(anchor: String) {
        guard let url = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)"
        ) else { return }
        NSWorkspace.shared.open(url)
    }
}

// MARK: - The hard stop

/// The always-reachable stop, pinned above the pane's list.
///
/// Above the list rather than inside it, because a kill switch that scrolls out
/// of view is not a kill switch. It paints no background of its own — an
/// inspector is a vibrant region and filling it turns a native pane into a grey
/// slab — and it is not glass: the one floating glass status control this
/// feature is allowed belongs over the canvas, where it can be seen from every
/// pane at once.
///
/// It follows `computerUseActive`, which is the coordinator's own state, not the
/// session's capability switch. A standing grant and a live camera are different
/// facts and the reader has to be able to tell them apart.
struct ComputerUseStopBar: View {
    let controller: SessionController

    var body: some View {
        if controller.computerUseActive {
            VStack(spacing: 0) {
                HStack(spacing: JunoSpace.snug) {
                    Image(systemName: "record.circle")
                        .imageScale(.small)
                        .foregroundStyle(Color.junoDanger)
                        .symbolEffect(.pulse)
                        .accessibilityHidden(true)
                    Text("Screen control is active")
                        .junoRowLabel()
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Spacer(minLength: JunoSpace.tight)
                    Button("Stop") {
                        Task { await controller.stopComputerUse() }
                    }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
                    .tint(Color.junoDanger)
                    .help("Immediately end screen capture and input control")
                    .accessibilityIdentifier("juno.code.inspector.computer-use.stop-bar")
                }
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)

                Divider().overlay(Color.junoSeparator)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Screen control is active")
        }
    }
}

// MARK: - Keeping the pane honest

/// Re-reads the coordinator while a Computer Use surface is on screen.
///
/// Nothing pushes Computer Use state into the view: the coordinator is an actor
/// the agent's own tools write to, and the two TCC grants are process-wide
/// facts that change in System Settings, outside the app entirely. Read once at
/// appearance, the journal would therefore stand still while the agent was
/// clicking — a safety record that lags the machine it is recording is worse
/// than none.
///
/// So it polls once a second *while capture is live*, and otherwise reads once
/// and stops. The key includes `computerUseActive`, which is what restarts the
/// fast loop the moment capture begins and ends it the moment capture stops.
/// Coming back from System Settings re-reads as well, which is how a grant just
/// made shows up without the reader hunting for a refresh.
struct ComputerUseWatch: ViewModifier {
    let controller: SessionController

    private var key: String {
        "\(controller.sessionID.value)|\(controller.computerUseActive)"
    }

    func body(content: Content) -> some View {
        content
            .task(id: key) {
                while !Task.isCancelled {
                    await controller.refreshComputerUse()
                    guard controller.computerUseActive else { return }
                    try? await Task.sleep(for: .seconds(1))
                }
            }
            .onReceive(
                NotificationCenter.default.publisher(
                    for: NSApplication.didBecomeActiveNotification
                )
            ) { _ in
                Task { await controller.refreshComputerUse() }
            }
    }
}

extension View {
    /// Keeps ``ComputerUseSections`` in step with the coordinator and with TCC.
    func computerUseWatch(_ controller: SessionController) -> some View {
        modifier(ComputerUseWatch(controller: controller))
    }
}
