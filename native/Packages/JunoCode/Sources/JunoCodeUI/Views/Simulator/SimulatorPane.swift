import JunoDesignSystem
import JunoSimulator
import SwiftUI

#if canImport(AppKit)
import AppKit
#endif

/// The Simulator pane: the device, its controls, and honest status.
///
/// Everything visible here is backed by a real fact from
/// ``SimulatorSessionService``. There are no decorative controls: Rotate and
/// Record are absent in this build because Juno cannot yet perform them through
/// a supported interface, and a greyed-out Rotate would still be a claim that
/// rotation is coming from Juno.
///
/// The one thing this pane is emphatic about is what it *cannot* do. Apple ships
/// no supported API for injecting touches into a booted simulator, so the pane
/// says so, in words, next to a button that opens the real Simulator app for the
/// user to interact with. That is the disclosed fallback — not silent
/// Accessibility automation, which Juno never uses.
@MainActor
public struct SimulatorPane: View {
    @Bindable private var model: SimulatorPaneModel
    private let close: () -> Void

    public init(model: SimulatorPaneModel, close: @escaping () -> Void) {
        self.model = model
        self.close = close
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            pickers
            Divider()
            deviceArea
            Divider()
            transcript
        }
        .task { await model.startIfNeeded() }
        .accessibilityIdentifier("juno.code.simulator-pane")
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: JunoSpace.tight) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Simulator")
                    .font(.callout.weight(.semibold))
                Text(model.statusLine)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(model.state.isFailed ? Color.junoDanger : Color.junoMutedForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if model.isSharingFrameWithModel {
                // Raised before the capture leaves the Mac, not after.
                Label("Juno is looking", systemImage: "eye.fill")
                    .font(.caption2)
                    .foregroundStyle(Color.junoAccent)
                    .accessibilityIdentifier("juno.code.simulator-ai-viewing")
            }

            controlOwnerBadge

            Button(action: close) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .medium))
                    .junoSecondaryInk()
                    .frame(width: 24, height: 24)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help("Close the Simulator pane. The task keeps running.")
            .accessibilityLabel("Close Simulator pane")
        }
        .padding(.leading, JunoSpace.regular)
        .padding(.trailing, JunoSpace.snug)
        .padding(.vertical, JunoSpace.snug)
        .background(Color.junoSurface.opacity(0.5))
    }

    /// Who owns input right now. Only ever one of them.
    @ViewBuilder
    private var controlOwnerBadge: some View {
        switch model.lease.owner {
        case .juno:
            Label("Juno is controlling", systemImage: "sparkles")
                .font(.caption2)
                .foregroundStyle(Color.junoAccent)
        case .user:
            Label("You are controlling", systemImage: "hand.point.up.left")
                .font(.caption2)
                .junoSecondaryInk()
        case .none:
            EmptyView()
        }
    }

    // MARK: Pickers and run controls

    private var pickers: some View {
        HStack(spacing: JunoSpace.snug) {
            Picker("Scheme", selection: $model.selectedScheme) {
                ForEach(model.schemes, id: \.self) { Text($0).tag($0) }
            }
            .labelsHidden()
            .frame(maxWidth: 170)
            .disabled(model.schemes.isEmpty || model.state.isBusy)

            Picker("Device", selection: $model.selectedDeviceUDID) {
                ForEach(model.devices) { device in
                    Text(device.name).tag(device.udid)
                }
            }
            .labelsHidden()
            .frame(maxWidth: 190)
            .disabled(model.devices.isEmpty || model.state.isBusy)

            Spacer(minLength: JunoSpace.tight)

            if model.state.isBusy {
                Button("Stop") { model.cancel() }
                    .help("Stop the current build or launch")
            } else if model.state.isRunning {
                Button("Relaunch") { model.run() }
                Button("Stop") { model.stop() }
            } else {
                Button("Run") { model.run() }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                    .disabled(!model.canRun)
            }

            Menu {
                Button("Rebuild") { model.run() }
                    .disabled(!model.canRun)
                // Destructive and slow, so it is behind an explicit action and
                // never part of an ordinary run.
                Button("Clean Build…") { model.confirmingClean = true }
                    .disabled(!model.canRun)
                Divider()
                Button("Open in Simulator") { model.openSimulatorApp() }
                    .disabled(!model.state.isRunning)
                Button("Take Screenshot") { model.captureNow() }
                    .disabled(!model.state.isRunning)
                Divider()
                Button("Rediscover Projects") { model.rediscover() }
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .accessibilityLabel("Simulator actions")
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.tight)
        .confirmationDialog(
            "Clean the build folder?",
            isPresented: $model.confirmingClean,
            titleVisibility: .visible
        ) {
            Button("Clean and Build", role: .destructive) { model.run(clean: true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This deletes Juno's build products for this project and rebuilds from scratch. Xcode's own derived data is not touched.")
        }
    }

    // MARK: The device

    @ViewBuilder
    private var deviceArea: some View {
        ZStack {
            Color.junoMuted.opacity(0.35)

            switch model.state {
            case .unavailable(let reason):
                JunoEmptyState(
                    title: "Simulator unavailable",
                    message: reason,
                    symbol: "iphone.slash",
                    actionLabel: "Check Again",
                    action: { model.rediscover() }
                )
                .padding(JunoSpace.regular)

            case .failed(let failure):
                VStack(spacing: JunoSpace.snug) {
                    JunoEmptyState(
                        title: failure.stage == .build ? "Build failed" : "Simulator error",
                        message: failure.message,
                        icon: .error,
                        actionLabel: "Try Again",
                        action: { model.run() }
                    )
                    if !model.diagnostics.isEmpty {
                        diagnosticsList
                    }
                }
                .padding(JunoSpace.regular)

            default:
                if let frame = model.latestFrame {
                    Image(nsImage: frame)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .padding(JunoSpace.snug)
                        .accessibilityLabel("Simulator screen")
                        .accessibilityIdentifier("juno.code.simulator-screen")
                } else {
                    VStack(spacing: JunoSpace.snug) {
                        if model.state.isBusy { ProgressView() }
                        Text(model.state.isRunning ? "Waiting for the first frame…" : model.state.label)
                            .junoCaption()
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .bottom) { interactionNotice }
    }

    /// The honest disclosure. Present whenever Juno cannot inject input — which
    /// in this build is always — so nobody discovers the limitation by tapping
    /// the screen and having nothing happen.
    @ViewBuilder
    private var interactionNotice: some View {
        if model.state.isRunning, let reason = model.inputCapability.unavailableReason {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Image(systemName: "hand.tap")
                    .junoSecondaryInk()
                Text(reason)
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
                Button("Open in Simulator") { model.openSimulatorApp() }
                    .buttonStyle(.borderless)
            }
            .padding(JunoSpace.snug)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous))
            .padding(JunoSpace.snug)
            .accessibilityIdentifier("juno.code.simulator-input-disclosure")
        }
    }

    private var diagnosticsList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(model.diagnostics.prefix(30)) { diagnostic in
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                        Image(systemName: diagnostic.severity == .error ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
                            .foregroundStyle(diagnostic.severity == .error ? Color.junoDanger : Color.junoCaution)
                            .font(.caption2)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(diagnostic.message).junoBody()
                            if let file = diagnostic.file {
                                Text("\((file as NSString).lastPathComponent)\(diagnostic.line.map { ":\($0)" } ?? "")")
                                    .junoMono()
                                    .junoSecondaryInk()
                            }
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 160)
    }

    // MARK: Build output and logs

    private var transcript: some View {
        VStack(spacing: 0) {
            Picker("", selection: $model.transcriptTab) {
                Text("Build").tag(SimulatorPaneModel.TranscriptTab.build)
                Text("Logs").tag(SimulatorPaneModel.TranscriptTab.logs)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.tight)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(model.visibleLines) { line in
                            Text(line.text)
                                .junoMono()
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(line.id)
                        }
                    }
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.bottom, JunoSpace.snug)
                }
                .onChange(of: model.visibleLines.last?.id) { _, id in
                    guard let id else { return }
                    // Long builds must not freeze the window: lines are appended
                    // to a bounded buffer and the scroll is the only work done
                    // per line.
                    withAnimation(.none) { proxy.scrollTo(id, anchor: .bottom) }
                }
            }
            .frame(height: 160)
        }
    }
}

private extension SimulatorState {
    var isFailed: Bool {
        if case .failed = self { return true }
        if case .unavailable = self { return true }
        return false
    }
}
