import AppKit
import JunoCodeCore
import JunoDesignSystem
import SwiftUI

/// Machine output, in a resizable drawer at the bottom of the detail column.
///
/// It is a drawer rather than an inspector tab because of the shape of the
/// content: a test run can print two thousand lines in a second, and a column
/// 320pt wide reflows every one of them. Here the output keeps the detail
/// column's full width, scrolls sideways rather than wrapping, and can be pushed
/// out of the way without leaving the session.
///
/// It separates bounded one-shot output from a real PTY-backed terminal. The
/// distinction is visible in the segmented control: agent/tool output remains
/// capped and auditable, while reader-owned long-lived processes get stdin,
/// resize and process-group cleanup.
public struct CodeConsoleDrawer: View {
    public enum Segment: String, CaseIterable, Identifiable, Sendable {
        case output
        case terminal
        case tests

        public var id: String { rawValue }

        var label: String {
            switch self {
            case .output: return "Output"
            case .terminal: return "Terminal"
            case .tests: return "Tests"
            }
        }
    }

    /// Below this the log shows fewer than four lines and the drawer is only
    /// chrome; above it the transcript is no longer the larger surface.
    public static let minimumHeight: Double = 132
    public static let maximumHeight: Double = 520
    public static let defaultHeight: Double = 248

    private let controller: SessionController
    @Binding private var isPresented: Bool

    @SceneStorage("juno.code.console.segment") private var storedSegment = Segment.output.rawValue
    /// The reader's chosen drawer height, restored per scene: how much of the
    /// window they want spent on machine output is part of how they arranged it.
    @SceneStorage("juno.code.console.height") private var height = Self.defaultHeight
    @State private var command = ""
    @State private var terminalInput = ""
    @State private var dragBaseline: Double?
    @State private var isPushingResizeCursor = false

    /// - Parameter isPresented: the same flag the toolbar's Console toggle drives,
    ///   so the drawer's own dismiss control and the toolbar cannot disagree.
    public init(controller: SessionController, isPresented: Binding<Bool>) {
        self.controller = controller
        self._isPresented = isPresented
    }

    private var segment: Segment {
        Segment(rawValue: storedSegment) ?? .output
    }

    private var segmentBinding: Binding<Segment> {
        Binding(get: { segment }, set: { storedSegment = $0.rawValue })
    }

    public var body: some View {
        VStack(spacing: 0) {
            resizeHandle
            header
            Divider().overlay(Color.junoSeparator)
            Group {
                switch segment {
                case .output: outputSegment
                case .terminal: terminalSegment
                case .tests: testsSegment
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(height: max(Self.minimumHeight, min(Self.maximumHeight, height)))
        // Opaque, like every other reading surface. Long machine output over a
        // translucent material loses contrast the moment the window moves.
        .background(Color.junoRaised)
        .overlay(alignment: .top) {
            Rectangle().fill(Color.junoSeparator).frame(height: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Console")
    }

    // MARK: - Chrome

    private var resizeHandle: some View {
        Rectangle()
            .fill(Color.clear)
            .frame(height: 5)
            .contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        let baseline = dragBaseline ?? height
                        dragBaseline = baseline
                        height = max(
                            Self.minimumHeight,
                            min(Self.maximumHeight, baseline - Double(value.translation.height))
                        )
                    }
                    .onEnded { _ in dragBaseline = nil }
            )
            .onContinuousHover { phase in
                switch phase {
                case .active:
                    guard !isPushingResizeCursor else { return }
                    isPushingResizeCursor = true
                    NSCursor.resizeUpDown.push()
                case .ended:
                    guard isPushingResizeCursor else { return }
                    isPushingResizeCursor = false
                    NSCursor.pop()
                }
            }
            // A pushed cursor outlives the view that pushed it.
            //
            // The push/pop pair above is balanced for the ordinary hover in/out, but
            // `.ended` cannot arrive if the handle goes away while the pointer is
            // still over it — closing the drawer with ⌥⌘C, switching to Chat, or
            // closing the window. The resize cursor then stayed as the app's cursor
            // everywhere, with no handle left to pop it.
            .onDisappear {
                guard isPushingResizeCursor else { return }
                isPushingResizeCursor = false
                NSCursor.pop()
            }
            .accessibilityHidden(true)
    }

    private var header: some View {
        HStack(spacing: JunoSpace.snug) {
            HStack(spacing: 2) {
                ForEach(Segment.allCases) { candidate in
                    Button {
                        withAnimation(JunoMotion.fast) {
                            segmentBinding.wrappedValue = candidate
                        }
                    } label: {
                        Text(candidate.label)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(
                                segment == candidate
                                    ? Color.junoForeground : Color.junoMutedForeground
                            )
                            .padding(.horizontal, JunoSpace.snug)
                            .frame(height: 24)
                            .background(
                                segment == candidate ? Color.junoRaised : .clear,
                                in: RoundedRectangle(
                                    cornerRadius: JunoRadius.chip,
                                    style: .continuous
                                )
                            )
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .focusEffectDisabled()
                    .accessibilityAddTraits(segment == candidate ? .isSelected : [])
                }
            }
            .padding(2)
            .background(
                Color.junoMuted.opacity(0.5),
                in: RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
            )
            .accessibilityIdentifier("juno.code.console.segment")

            Spacer(minLength: JunoSpace.snug)

            if segment == .terminal {
                interactiveRunState
            } else {
                runState
            }

            Button {
                copyVisibleOutput()
            } label: {
                Image(systemName: "doc.on.doc")
            }
            .buttonStyle(.borderless)
            .disabled(visibleLines.isEmpty)
            .help("Copy this output to the clipboard")
            .accessibilityLabel("Copy output")

            Button {
                isPresented = false
            } label: {
                Image(systemName: "chevron.down")
            }
            .buttonStyle(.borderless)
            .help("Hide the console")
            .accessibilityLabel("Hide the console")
            .accessibilityIdentifier("juno.code.console.hide")
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.bottom, JunoSpace.tight)
    }

    /// Running, or the runtime's own exit line. Never a state this view decided.
    @ViewBuilder
    private var runState: some View {
        if let run = controller.consoleRun, run.isRunning {
            HStack(spacing: JunoSpace.tight) {
                ProgressView().controlSize(.small)
                Text(run.command)
                    .junoCodeSmall()
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 220, alignment: .leading)
                // A command with a two-minute timeout needs to say how long it
                // has been going, or a silent build looks like a hang.
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    Text(elapsed(since: run.startedAt))
                        .junoCaption()
                        .monospacedDigit()
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Running \(run.command)")
        } else if let run = controller.consoleRun,
                  case let .finished(detail, failed) = run.outcome
        {
            Label(detail, systemImage: failed ? "xmark.circle" : "checkmark.circle")
                .junoCodeSmall()
                .foregroundStyle(failed ? Color.junoDanger : Color.junoSuccess)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: 260, alignment: .trailing)
                .help("\(run.command) — \(detail)")
                .accessibilityLabel("\(run.command) \(detail)")
        } else if controller.isRunningTest {
            HStack(spacing: JunoSpace.tight) {
                ProgressView().controlSize(.small)
                Text("Running tests").junoCaption()
            }
            .accessibilityLabel("Running tests")
        }
    }

    @ViewBuilder
    private var interactiveRunState: some View {
        switch controller.interactiveTerminalState {
        case .starting:
            HStack(spacing: JunoSpace.tight) {
                ProgressView().controlSize(.small)
                Text("Starting terminal").junoCaption()
            }
        case let .running(processID):
            HStack(spacing: JunoSpace.tight) {
                Circle().fill(Color.junoSuccess).frame(width: 7, height: 7)
                Text("Terminal · " + String(processID)).junoCaption().monospacedDigit()
                Button("Stop") { Task { await controller.stopInteractiveTerminal() } }
                    .controlSize(.small)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Interactive terminal running, process " + String(processID))
        case let .exited(code):
            Label(
                "Exited " + String(code),
                systemImage: code == 0 ? "checkmark.circle" : "xmark.circle"
            )
            .junoCaption()
            .foregroundStyle(code == 0 ? Color.junoSuccess : Color.junoDanger)
        case let .failed(reason):
            Label(reason, systemImage: "exclamationmark.triangle")
                .junoCaption()
                .foregroundStyle(Color.junoDanger)
                .lineLimit(1)
                .truncationMode(.middle)
        case .idle:
            EmptyView()
        }
    }

    // MARK: - Output

    private var visibleLines: [TerminalLine] {
        switch segment {
        case .output: return controller.terminal
        case .terminal: return controller.interactiveTerminal
        case .tests: return controller.lastTestRunOutput
        }
    }

    @ViewBuilder
    private var outputSegment: some View {
        if controller.session.configuration.location != .local {
            // A cloud or remote run has no local process to stream. Saying so is
            // the honest state; an empty terminal implies it might yet fill.
            unavailable(
                controller.consoleUnavailableReason
                    ?? "This session produces no local output on this Mac."
            )
        } else {
            VStack(spacing: 0) {
                outputLog
                Divider().overlay(Color.junoSeparator)
                commandField
            }
        }
    }

    private var outputLog: some View {
        ScrollViewReader { proxy in
            ScrollView([.vertical, .horizontal]) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(controller.terminal) { line in
                        outputRow(line).id(line.id)
                    }
                }
                .padding(.vertical, JunoSpace.tight)
                .padding(.horizontal, JunoSpace.snug)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.junoTerminal)
            .overlay {
                if controller.terminal.isEmpty {
                    Text(
                        "Command and test output appears here while it is produced."
                    )
                    .junoCaption()
                    .multilineTextAlignment(.center)
                    .padding(JunoSpace.regular)
                }
            }
            .onChange(of: controller.terminal.last?.id) { _, newValue in
                guard let newValue else { return }
                proxy.scrollTo(newValue, anchor: .bottom)
            }
        }
    }

    /// One line: fixed width, never wrapped, selectable. `stderr` is tinted
    /// rather than prefixed — a prefix would shift the columns the fixed-width
    /// output is aligned on.
    private func outputRow(_ line: TerminalLine) -> some View {
        Text(line.text.isEmpty ? " " : line.text)
            .junoCodeSmall()
            .foregroundStyle(channelStyle(line.channel))
            .textSelection(.enabled)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel(
                line.channel == .stderr ? "Error output: \(line.text)" : line.text
            )
    }

    /// The ink each channel draws in, on the ``Color/junoTerminal`` well.
    ///
    /// stdout and log were `.primary` and `.secondary` — platform-neutral ink,
    /// so pure white and pure grey in dark mode. The well was recently corrected
    /// from a cool value to a warm one, which left the terminal's own output as
    /// the coldest text in the app sitting on one of its warmest surfaces. The
    /// warm ramp keeps the same three-way hierarchy (output · error · chatter)
    /// while belonging to the palette.
    private func channelStyle(_ channel: ToolOutputChannel) -> AnyShapeStyle {
        switch channel {
        case .stdout: return AnyShapeStyle(Color.junoForeground)
        case .stderr: return AnyShapeStyle(Color.junoDanger)
        case .log: return AnyShapeStyle(Color.junoMutedForeground)
        }
    }

    private var commandField: some View {
        HStack(spacing: JunoSpace.snug) {
            Text("$")
                .junoCodeSmall()
                .junoMetaInk()
                .accessibilityHidden(true)

            TextField(
                controller.consoleUnavailableReason ?? "Run a command in the workspace root",
                text: $command
            )
            .textFieldStyle(.plain)
            .junoCode()
            .onSubmit(submitCommand)
            .disabled(controller.consoleUnavailableReason != nil || isCommandRunning)
            .accessibilityLabel("Command")
            .accessibilityIdentifier("juno.code.console.command")

            if isCommandRunning {
                ProgressView().controlSize(.small)
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .background(Color.junoRaised)
        .help(
            controller.consoleUnavailableReason
                ?? "One command at a time, in the workspace root. Risky commands ask for approval first."
        )
    }

    @ViewBuilder
    private var terminalSegment: some View {
        if let reason = controller.interactiveTerminalUnavailableReason {
            unavailable(reason)
        } else {
            VStack(spacing: 0) {
                interactiveOutputLog
                Divider().overlay(Color.junoSeparator)
                interactiveCommandField
            }
        }
    }

    private var interactiveOutputLog: some View {
        ScrollViewReader { proxy in
            ScrollView([.vertical, .horizontal]) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(controller.interactiveTerminal) { line in
                        outputRow(line).id(line.id)
                    }
                }
                .padding(.vertical, JunoSpace.tight)
                .padding(.horizontal, JunoSpace.snug)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.junoTerminal)
            .overlay {
                if controller.interactiveTerminal.isEmpty {
                    Text("Start a persistent shell, watcher, REPL or dev server here.")
                        .junoCaption()
                        .multilineTextAlignment(.center)
                        .padding(JunoSpace.regular)
                }
            }
            .onChange(of: controller.interactiveTerminal.last?.id) { _, newValue in
                guard let newValue else { return }
                proxy.scrollTo(newValue, anchor: .bottom)
            }
        }
    }

    private var interactiveCommandField: some View {
        HStack(spacing: JunoSpace.snug) {
            Text(controller.interactiveTerminalState.isRunning ? ">" : "$")
                .junoCodeSmall()
                .junoMetaInk()
                .accessibilityHidden(true)
            TextField(
                controller.interactiveTerminalState.isRunning
                    ? "Type input and press Return"
                    : "Start a persistent command, e.g. npm run dev",
                text: $terminalInput
            )
            .textFieldStyle(.plain)
            .junoCode()
            .onSubmit(submitInteractiveInput)
            .accessibilityLabel(
                controller.interactiveTerminalState.isRunning
                    ? "Terminal input"
                    : "Start terminal command"
            )
            .accessibilityIdentifier("juno.code.console.terminal")
            if controller.interactiveTerminalState.isRunning {
                Button {
                    Task { await controller.stopInteractiveTerminal() }
                } label: {
                    Image(systemName: "stop.fill")
                }
                .buttonStyle(.borderless)
                .help("Stop the terminal process group")
                .accessibilityLabel("Stop terminal")
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .background(Color.junoRaised)
    }

    private var isCommandRunning: Bool {
        controller.consoleRun?.isRunning ?? false
    }

    private func submitCommand() {
        let pending = command
        guard !pending.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        command = ""
        Task { await controller.runConsoleCommand(pending) }
    }

    private func submitInteractiveInput() {
        let pending = terminalInput
        guard !pending.isEmpty else { return }
        terminalInput = ""
        if controller.interactiveTerminalState.isRunning {
            Task { await controller.writeInteractiveTerminal(pending) }
        } else {
            Task { await controller.startInteractiveTerminal(pending) }
        }
    }

    // MARK: - Tests

    @ViewBuilder
    private var testsSegment: some View {
        if controller.session.configuration.location != .local {
            unavailable(
                "\(controller.session.configuration.location == .cloud ? "Cloud" : "Remote") "
                    + "runs report no structured test results to this Mac."
            )
        } else {
            List {
                lastRunSection
                suggestionsSection
            }
            .listStyle(.inset)
        }
    }

    @ViewBuilder
    private var lastRunSection: some View {
        Section("Last run") {
            if let run = controller.lastTestRun {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    HStack(spacing: JunoSpace.snug) {
                        Image(
                            systemName: run.passed ? "checkmark.seal.fill" : "xmark.seal.fill"
                        )
                        .foregroundStyle(run.passed ? Color.junoSuccess : Color.junoDanger)
                        Text(run.passed ? "Passed" : "Failed")
                            .font(.system(.callout, weight: .medium))
                        Text(outcomeDetail(run))
                            .junoCaption()
                        Spacer(minLength: JunoSpace.snug)
                        Button("Re-run") { runTests(run.command) }
                            .controlSize(.small)
                            .disabled(isTestRunBlocked)
                            .help(testRunHelp)
                    }
                    Text(run.command)
                        .junoCode()
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .textSelection(.enabled)

                    if !controller.lastTestRunOutput.isEmpty {
                        OutputWell(
                            lines: controller.lastTestRunOutput.map {
                                (text: $0.text, channel: $0.channel)
                            },
                            maxHeight: 180
                        )
                    } else if !run.passed {
                        Text(
                            "The output for this run is no longer in the console buffer."
                        )
                        .junoCaption()
                    }
                }
                .padding(.vertical, JunoSpace.hairline)
            } else {
                Text("No test run has completed in this session yet.")
                    .junoCaption()
            }
        }
    }

    @ViewBuilder
    private var suggestionsSection: some View {
        Section {
            if controller.testSuggestions.isEmpty {
                Text("No test toolchain was detected in this workspace.")
                    .junoCaption()
            } else {
                ForEach(controller.testSuggestions) { suggestion in
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        HStack(spacing: JunoSpace.snug) {
                            Text(suggestion.toolchain)
                                .font(.system(.callout, weight: .medium))
                            Spacer(minLength: JunoSpace.snug)
                            Button("Run") { runTests(suggestion.command) }
                                .controlSize(.small)
                                .disabled(isTestRunBlocked)
                                .help(testRunHelp)
                        }
                        Text(suggestion.command)
                            .junoCode()
                            .junoSecondaryInk()
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, JunoSpace.hairline)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(suggestion.toolchain): \(suggestion.command)")
                }
            }
        } header: {
            Text("Detected test commands")
        } footer: {
            // There is no lint or diagnostics service in the packages at all, so
            // failures are exactly what the test runner and stderr reported.
            Text(
                "Juno has no separate diagnostics or lint service: what a run reports here is the test runner's own result and its output."
            )
            .junoCaption()
        }
    }

    private var isTestRunBlocked: Bool {
        controller.isRunningTest
            || controller.isRunning
            || controller.consoleUnavailableReason != nil
    }

    private var testRunHelp: String {
        if let reason = controller.consoleUnavailableReason { return reason }
        if controller.isRunningTest { return "A test run is already in flight." }
        if controller.isRunning { return "The agent is running; stop it first." }
        return "Run this command through the same approval policy the agent uses"
    }

    private func runTests(_ command: String) {
        Task { await controller.runTest(command: command) }
    }

    private func outcomeDetail(_ run: TestRunCompletedEvent) -> String {
        var parts: [String] = []
        if let tests = run.testsRun { parts.append("\(tests) tests") }
        if let failures = run.failures { parts.append("\(failures) failed") }
        parts.append(String(format: "%.1fs", run.durationSeconds))
        return parts.joined(separator: " · ")
    }

    // MARK: - Helpers

    private func unavailable(_ message: String) -> some View {
        Text(message)
            .junoCaption()
            .multilineTextAlignment(.center)
            .padding(JunoSpace.regular)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.junoTerminal)
    }

    private func elapsed(since date: Date) -> String {
        let seconds = Int(Date().timeIntervalSince(date))
        return seconds < 60
            ? "\(seconds)s"
            : String(format: "%dm %02ds", seconds / 60, seconds % 60)
    }

    private func copyVisibleOutput() {
        let text = visibleLines.map(\.text).joined(separator: "\n")
        guard !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
