import Combine
import JunoCore
import JunoDesignSystem
import SwiftUI

/// Side-by-side model comparison — one prompt, two or three models answering at
/// once, each with its own live stream, its own clock and its real cost.
///
/// One implementation for both apps rather than a Mac screen and a phone screen,
/// because the *content* is identical and only the shelf differs: on a wide
/// window the panes sit side by side with a rule between them; on a phone they
/// become a horizontally paged strip, each pane just short of full width so the
/// next one peeks and the gesture is discoverable. Two implementations would have
/// meant two places for the receipt line to drift out of step.
///
/// Nothing here is saved, and the header says so. A fresh prompt replaces the
/// board; leaving the screen drops it.
public struct NativeCompareView: View {
    @Bindable private var model: NativeCompareModel
    private let catalog: [NativeChatModelOption]
    private let accountID: AccountID

    @State private var prompt = ""
    @FocusState private var promptFocused: Bool
    #if !os(macOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    public init(
        model: NativeCompareModel,
        catalog: [NativeChatModelOption],
        accountID: AccountID
    ) {
        self.model = model
        self.catalog = catalog
        self.accountID = accountID
    }

    /// Only models this account can actually run. A pane must never name a model
    /// the server would silently substitute — the whole screen is an argument
    /// about which model wrote which answer.
    private var selectable: [NativeChatModelOption] {
        catalog.filter { $0.isChatCapable && $0.isAvailable }
    }

    private var descriptors: [JunoModelDescriptor] {
        selectable.map(\.junoDescriptor)
    }

    private var isWide: Bool {
        #if os(macOS)
        true
        #else
        sizeClass != .compact
        #endif
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            composer
            Divider()
            board
        }
        .background(Color.junoCanvas)
        .onAppear {
            model.start(for: accountID, models: defaultModels())
        }
        .onDisappear {
            // A comparison is ephemeral by construction. Leaving the screen with
            // three private generations still streaming would keep billing for
            // answers nobody can ever see again.
            model.reset()
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 2) {
                Text("One prompt · \(model.panes.count) models")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.junoMutedForeground)
                Text("Compare")
                    .junoPageHeading()
            }
            Spacer(minLength: 12)
            Text("Comparisons aren't saved")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Color.junoMutedForeground.opacity(0.8))
                .multilineTextAlignment(.trailing)
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.top, JunoSpace.roomy)
        .padding(.bottom, JunoSpace.cozy)
    }

    // MARK: - Composer

    private var composer: some View {
        VStack(spacing: JunoSpace.snug) {
            TextField("Ask every model at once…", text: $prompt, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .font(.system(size: 15))
                .focused($promptFocused)
                .disabled(model.anyStreaming)
                .onSubmit(send)
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.top, JunoSpace.cozy)

            HStack(spacing: JunoSpace.snug) {
                Button(action: addPane) {
                    Label("Add model", systemImage: "plus")
                        .font(.system(size: 13))
                }
                .buttonStyle(.plain)
                .foregroundStyle(model.canAddPane ? Color.primary.opacity(0.8) : Color.junoMutedForeground)
                .disabled(!model.canAddPane)
                .help(
                    model.panes.count >= NativeCompareModel.maximumPanes
                        ? "Up to three models per race"
                        : "Race another model"
                )

                Text("\(model.panes.count)/\(NativeCompareModel.maximumPanes)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Color.junoMutedForeground.opacity(0.7))

                Spacer(minLength: 0)

                // One control, two jobs — the same morph the composer uses
                // everywhere else in Juno. Two separate buttons would leave a
                // dead Send sitting next to Stop for the whole run.
                //
                // The branch lives inside the action rather than in a ternary
                // between two function references: that ternary is a partially
                // applied method against an `@Observable` model, and it blows
                // the SwiftUI type checker's budget for this whole property.
                Button {
                    if model.anyStreaming {
                        model.stopAll()
                    } else {
                        send()
                    }
                } label: {
                    Image(systemName: model.anyStreaming ? "stop.fill" : "arrow.up")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(width: 30, height: 30)
                        .background(
                            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                                .fill(sendEnabled ? Color.junoAccent : Color.junoMuted)
                        )
                        .foregroundStyle(sendEnabled ? Color.junoOnAccent : Color.junoMutedForeground)
                }
                .buttonStyle(.plain)
                .disabled(!sendEnabled)
                .accessibilityLabel(model.anyStreaming ? "Stop all models" : "Send to every model")
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.bottom, JunoSpace.snug)
        }
        .background(
            RoundedRectangle(cornerRadius: JunoCornerRadius.panel, style: .continuous)
                .fill(Color.junoSurface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoCornerRadius.panel, style: .continuous)
                .strokeBorder(Color.junoHairline)
        )
        .padding(.horizontal, JunoSpace.regular)
        .padding(.bottom, JunoSpace.cozy)
    }

    private var sendEnabled: Bool {
        if model.anyStreaming { return !model.stopping }
        return !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        guard !model.anyStreaming else { return }
        model.submit(prompt)
    }

    private func addPane() {
        guard let next = contrastModel() else { return }
        model.addPane(modelID: next)
    }

    // MARK: - Board

    @ViewBuilder
    private var board: some View {
        if isWide {
            HStack(spacing: 0) {
                ForEach(Array(model.panes.enumerated()), id: \.element.id) { index, pane in
                    if index > 0 { Divider() }
                    paneView(pane)
                        .frame(maxWidth: .infinity)
                }
            }
        } else {
            // A phone cannot show three answers at once and should not pretend
            // to. Panes become a paged strip; the peek at the edge is what says
            // there is another one.
            ScrollView(.horizontal) {
                LazyHStack(spacing: 0) {
                    ForEach(model.panes) { pane in
                        paneView(pane)
                            .containerRelativeFrame(.horizontal, count: 1, spacing: 0)
                            .overlay(alignment: .trailing) { Divider() }
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollIndicators(.hidden)
        }
    }

    private func paneView(_ pane: NativeCompareModel.Pane) -> some View {
        NativeComparePane(
            pane: pane,
            run: model.runs[pane.id] ?? NativeCompareModel.Run(),
            descriptors: descriptors,
            summary: selectable.first { $0.id == pane.modelID }?.summary,
            setModel: { model.setModel($0, for: pane.id) },
            remove: model.canRemovePane ? { model.removePane(pane.id) } : nil,
            retry: { model.retry(pane.id) }
        )
    }

    // MARK: - Model defaults

    /// The opening pair: the first two available models from different labs.
    ///
    /// Contrast is the point — two models from the same provider tend to agree,
    /// which makes for a comparison that teaches nothing. The manifest is already
    /// ordered the way the picker orders it, so "first from each of two labs" is
    /// also "the two the product would recommend".
    private func defaultModels() -> [String] {
        var chosen: [String] = []
        var providers: Set<String> = []
        for option in selectable where !option.isLegacy {
            guard !providers.contains(option.providerID) else { continue }
            providers.insert(option.providerID)
            chosen.append(option.id)
            if chosen.count == NativeCompareModel.minimumPanes { return chosen }
        }
        // Fewer than two labs configured: fall back to any two runnable models
        // rather than opening with one pane, which is not a comparison.
        for option in selectable where !chosen.contains(option.id) {
            chosen.append(option.id)
            if chosen.count == NativeCompareModel.minimumPanes { break }
        }
        return chosen
    }

    /// A model from a provider not already on the board, for a third pane.
    private func contrastModel() -> String? {
        let used = Set(model.panes.compactMap { pane in
            selectable.first { $0.id == pane.modelID }?.providerID
        })
        return selectable.first { !$0.isLegacy && !used.contains($0.providerID) }?.id
            ?? selectable.first { option in !model.panes.contains { $0.modelID == option.id } }?.id
    }
}

// MARK: - One pane

/// A single column: the model picker as its own header, the answer, and a
/// receipt.
struct NativeComparePane: View {
    let pane: NativeCompareModel.Pane
    let run: NativeCompareModel.Run
    let descriptors: [JunoModelDescriptor]
    /// The model's own one-line description, shown while the pane is idle. Nil
    /// when the manifest published none — in which case the pane says what to do
    /// instead of inventing a description.
    let summary: String?
    let setModel: (String) -> Void
    let remove: (() -> Void)?
    let retry: () -> Void

    @State private var copied = false

    private var modelBinding: Binding<String> {
        // A literal closure rather than passing `setModel` itself. SwiftUI's
        // `Binding.init(get:set:)` wants an `@isolated(any) @Sendable` setter,
        // and a stored `(String) -> Void` carries no isolation — converting it
        // is a data-race diagnostic that the CI toolchain treats as an error
        // even where a local one only warns. Written out, the closure inherits
        // this view's main-actor isolation and the conversion disappears.
        Binding(get: { pane.modelID }, set: { setModel($0) })
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                answer
                    .padding(JunoSpace.cozy)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            receipt
        }
        .frame(maxHeight: .infinity)
    }

    private var header: some View {
        HStack(spacing: JunoSpace.tight) {
            // The picker IS the change control — a separate "Change" button
            // beside a label would be two controls for one decision.
            JunoModelSelectorButton(
                models: descriptors,
                selectedModelID: modelBinding,
                accessibilityID: "juno.compare.model.\(pane.id)"
            )
            .disabled(run.isStreaming)
            Spacer(minLength: 0)
            if let remove {
                Button(action: remove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.junoMutedForeground)
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(run.isStreaming)
                .accessibilityLabel("Remove this model from the comparison")
            }
        }
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, JunoSpace.tight)
    }

    @ViewBuilder
    private var answer: some View {
        switch run.status {
        case .idle:
            Text(summary ?? "Send a prompt to put this model in the race.")
                .font(.system(size: 13))
                .foregroundStyle(Color.junoMutedForeground.opacity(0.75))
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.top, JunoSpace.region)

        case .error where run.content.isEmpty:
            failure

        // Split rather than `case .submitting, .thinking, .writing where …`:
        // there the guard binds only to `.writing`, which is the behaviour
        // wanted but not what the one-line form appears to say. A pane that is
        // writing and already has text falls through to `default` and renders
        // it; one that has not emitted a token yet keeps the placeholder.
        case .submitting, .thinking:
            thinking

        case .writing where run.content.isEmpty:
            thinking

        default:
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                if run.content.isEmpty {
                    thinking
                } else {
                    JunoLessonText(run.content, streaming: run.isStreaming)
                        .textSelection(.enabled)
                }
                if let note = finishNote {
                    Text(note)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.junoMutedForeground)
                        .padding(.horizontal, JunoSpace.snug)
                        .padding(.vertical, JunoSpace.tight)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                                .fill(Color.junoMuted)
                        )
                }
            }
        }
    }

    private var thinking: some View {
        HStack(spacing: JunoSpace.cozy) {
            JunoThinkingMatrix()
                .foregroundStyle(Color.junoMutedForeground.opacity(0.65))
            JunoAIcssThinkingLabel(
                run.status == .writing ? "Writing the response" : "Thinking about your request",
                size: 14
            )
        }
        .frame(minHeight: 24)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(run.status == .writing ? "Writing the response" : "Thinking")
        .accessibilityAddTraits(.updatesFrequently)
    }

    private var failure: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text(run.errorMessage ?? "Something went wrong.")
                .font(.system(size: 13))
                .foregroundStyle(Color.junoDanger)
                .fixedSize(horizontal: false, vertical: true)
            // One recovery, the one that fits. `upgrade` has no in-app
            // destination on either platform, so the plan wall says what to do
            // rather than offering a button that goes nowhere.
            if run.errorAction == .retry {
                Button(action: retry) {
                    Label("Try again", systemImage: "arrow.clockwise")
                        .font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.junoDanger)
            }
        }
        .padding(JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                .fill(Color.junoDanger.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                .strokeBorder(Color.junoDanger.opacity(0.3))
        )
    }

    /// Why a finished run stopped, when it did not simply finish.
    private var finishNote: String? {
        if run.status == .error, !run.content.isEmpty { return run.errorMessage }
        switch run.finishReason {
        case .length: return "Stopped at its token limit."
        case .userStopped where run.status == .done: return "Stopped by user."
        default: return nil
        }
    }

    /// Time · tokens · real cost — and Copy, which is the only handoff this
    /// screen can honestly offer.
    ///
    /// The web's "Continue in chat" seeds a branch through a browser-only
    /// sessionStorage stash; there is no message-create API to seed a real
    /// conversation with, on either platform. Rather than a button that starts an
    /// empty chat and calls it continuing, the answer goes to the pasteboard.
    private var receipt: some View {
        HStack(spacing: JunoSpace.snug) {
            NativeCompareClock(
                startedAt: run.startedAt,
                elapsed: run.elapsed,
                running: run.isStreaming
            )
            if let usage = usageLine {
                Text(usage)
                    .font(.system(size: 11, design: .monospaced))
                    .monospacedDigit()
                    .foregroundStyle(Color.junoMutedForeground.opacity(0.75))
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if run.status == .done, !run.content.isEmpty {
                Button {
                    JunoPasteboard.copy(run.content)
                    copied = true
                } label: {
                    Text(copied ? "Copied" : "Copy")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color.junoMutedForeground)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(height: 32)
        .opacity(run.status == .idle ? 0 : 1)
        .onChange(of: run.content) { _, _ in copied = false }
    }

    private var usageLine: String? {
        var parts: [String] = []
        let tokens = (run.promptTokens ?? 0) + (run.completionTokens ?? 0)
        if run.promptTokens != nil || run.completionTokens != nil {
            parts.append("\(tokens.formatted(.number.notation(.compactName))) tokens")
        }
        // The tilde is load-bearing: when the server sent no figure this is
        // computed from the manifest's list prices, which is an estimate.
        if let cost = run.costUsd {
            parts.append("~" + cost.formatted(.currency(code: "USD").precision(.fractionLength(cost < 0.01 ? 4 : 2))))
        }
        return parts.isEmpty ? nil : "· " + parts.joined(separator: " · ")
    }
}

/// The race clock: ticks while the pane streams, freezes at the final time.
///
/// Its own view so the timer redraws one label rather than the whole pane —
/// re-rendering a streaming Markdown body ten times a second is the difference
/// between a smooth race and a stuttering one.
struct NativeCompareClock: View {
    let startedAt: Date?
    let elapsed: TimeInterval?
    let running: Bool

    @State private var now = Date()
    private let tick = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect()

    var body: some View {
        Group {
            if let seconds {
                Text(String(format: "%.1fs", seconds))
                    .font(.system(size: 11, design: .monospaced))
                    .monospacedDigit()
                    .foregroundStyle(Color.junoMutedForeground.opacity(0.75))
            }
        }
        .onReceive(tick) { value in
            guard running else { return }
            now = value
        }
    }

    private var seconds: Double? {
        if let elapsed { return elapsed }
        guard running, let startedAt else { return nil }
        return now.timeIntervalSince(startedAt)
    }
}
