import SwiftUI
import JunoCodeCore
import JunoCodeRuntime
import JunoDesignSystem

// MARK: - The row action

/// "Rewind", beside one of the reader's messages: quiet until the row is
/// hovered, and the way back to just before that message.
struct StudioRewindButton: View {
    let controller: SessionController
    let turnID: String
    let isRowHovered: Bool

    @State private var isPresented = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var isShown: Bool { isRowHovered || isPresented }

    var body: some View {
        Button { isPresented = true } label: {
            HStack(spacing: JunoSpace.hairline) {
                // The mark for SF Symbols' `arrow.uturn.backward`.
                JunoIconView(.undo, size: 12)
                Text("Rewind")
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.tertiary))
        .contentShape(Rectangle())
        .opacity(isShown ? 1 : 0)
        .allowsHitTesting(isShown)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: isShown)
        .help("Rewind to before this message")
        .accessibilityLabel("Rewind to before this message")
        .accessibilityIdentifier("juno.code.transcript.rewind")
        .popover(isPresented: $isPresented, arrowEdge: .bottom) {
            StudioRewindFlow(controller: controller, turnID: turnID) {
                isPresented = false
            }
            .padding(JunoSpace.regular)
            .frame(width: 380)
        }
    }
}

// MARK: - The flow

/// One rewind, start to finish: what it would change, the reader's choice,
/// and — when a file changed after Juno wrote it — the second question.
struct StudioRewindFlow: View {
    let controller: SessionController
    let turnID: String
    let finish: () -> Void
    var back: (() -> Void)?

    @State private var preview: RewindPreview?
    @State private var phase: StudioRewindPanel.Phase = .choosing

    var body: some View {
        Group {
            if let preview {
                StudioRewindPanel(
                    preview: preview,
                    phase: phase,
                    isRunning: controller.isRunning,
                    choose: { run($0, force: false) },
                    restoreAnyway: { scope in run(scope, force: true) },
                    cancel: finish,
                    stop: { Task { await controller.stop() } },
                    back: back
                )
            } else {
                HStack(spacing: JunoSpace.snug) {
                    StudioSpinner().frame(width: 10, height: 10)
                    Text("Checking what would change…")
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task(id: turnID) {
            preview = await controller.rewindPreview(for: turnID)
            if preview == nil { finish() }
        }
    }

    private func run(_ scope: RewindScope, force: Bool) {
        phase = .working(scope)
        Task {
            switch await controller.rewind(to: turnID, restoring: scope, force: force) {
            case .rewound:
                finish()
            case let .diverged(paths):
                phase = .diverged(scope, paths: paths)
            case let .failed(message):
                phase = .failed(message)
                preview = await controller.rewindPreview(for: turnID) ?? preview
            }
        }
    }
}

// MARK: - The confirmation

/// The confirmation's content: the message, the three choices, the files
/// that would change, and the one limit every rewind has.
///
/// Data in, choices out, so it renders the same from a live session and from
/// a snapshot test.
struct StudioRewindPanel: View {
    enum Phase: Equatable {
        case choosing
        case working(RewindScope)
        /// The reader chose `scope`, and these files changed after Juno last
        /// wrote them. Nothing was touched.
        case diverged(RewindScope, paths: [String])
        case failed(String)
    }

    let preview: RewindPreview
    let phase: Phase
    let isRunning: Bool
    let choose: (RewindScope) -> Void
    let restoreAnyway: (RewindScope) -> Void
    let cancel: () -> Void
    let stop: () -> Void
    var back: (() -> Void)?

    @State private var highlighted: RewindScope?
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let listedFiles = 8

    private var available: [RewindScope] {
        RewindScope.allCases.filter { preview.unavailableReason($0) == nil }
    }

    private var isWorking: Bool {
        if case .working = phase { return true }
        return false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            header
            if isRunning {
                runningNotice
            } else if case let .diverged(scope, paths) = phase {
                divergence(scope: scope, paths: paths)
                    .transition(.junoInline)
            } else {
                choices
                if case let .failed(message) = phase {
                    Text(message)
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                files
            }
            Text(RewindCopy.untracked)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.tertiary)
                .fixedSize(horizontal: false, vertical: true)
            // A popover closes on esc or a click outside; a sheet needs a way
            // out it can name.
            if back != nil, !isDiverged {
                HStack {
                    Spacer()
                    Button("Cancel", action: cancel)
                        .buttonStyle(StudioSecondaryButtonStyle())
                        .contentShape(Capsule())
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("juno.code.rewind.cancel")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: phase)
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(.upArrow) { move(-1) }
        .onKeyPress(.downArrow) { move(1) }
        .onKeyPress(.return) {
            guard !isRunning, phase == .choosing || isFailed, let highlighted else { return .ignored }
            choose(highlighted)
            return .handled
        }
        .onAppear {
            highlighted = available.first
            focused = true
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.code.rewind.panel")
    }

    private var isFailed: Bool {
        if case .failed = phase { return true }
        return false
    }

    private var isDiverged: Bool {
        if case .diverged = phase { return true }
        return false
    }

    private func move(_ step: Int) -> KeyPress.Result {
        guard !available.isEmpty, !isWorking else { return .ignored }
        let current = highlighted.flatMap { available.firstIndex(of: $0) } ?? -1
        highlighted = available[(current + step + available.count) % available.count]
        return .handled
    }

    // MARK: Parts

    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            HStack(spacing: JunoSpace.tight) {
                if let back {
                    Button(action: back) {
                        JunoIconView(.chevronLeft, size: 12)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.tertiary))
                    .contentShape(Rectangle())
                    .help("Choose another message")
                    .accessibilityLabel("Back")
                    .accessibilityIdentifier("juno.code.rewind.back")
                }
                Text("Rewind to before this message")
                    .font(Studio.Font.labelEmphasis)
                    .foregroundStyle(Studio.Ink.primary)
            }
            Text(preview.turn.text)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .lineLimit(2)
                .truncationMode(.tail)
        }
    }

    private var runningNotice: some View {
        HStack(spacing: JunoSpace.snug) {
            Text(RewindCopy.running)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
            Spacer(minLength: JunoSpace.snug)
            Button("Stop", action: stop)
                .buttonStyle(StudioSecondaryButtonStyle())
                .contentShape(Capsule())
                .accessibilityIdentifier("juno.code.rewind.stop")
        }
    }

    private var choices: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline / 2) {
            ForEach(RewindScope.allCases) { scope in
                choice(scope)
            }
        }
    }

    private func choice(_ scope: RewindScope) -> some View {
        let reason = preview.unavailableReason(scope)
        let isEnabled = reason == nil && !isWorking
        let isHighlighted = highlighted == scope && reason == nil
        return Button { choose(scope) } label: {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(scope.title)
                        .font(Studio.Font.label)
                        .foregroundStyle(reason == nil ? Studio.Ink.primary : Studio.Ink.tertiary)
                    Text(preview.detail(scope))
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: JunoSpace.snug)
                if phase == .working(scope) {
                    StudioSpinner().frame(width: 10, height: 10)
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                    .fill(isHighlighted ? Studio.Surface.selected : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous))
        }
        .buttonStyle(.plain)
        .contentShape(RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous))
        .disabled(!isEnabled)
        .onHover { hovering in
            if hovering, reason == nil { highlighted = scope }
        }
        .accessibilityHint(preview.detail(scope))
        .accessibilityIdentifier("juno.code.rewind.choice.\(scope.rawValue)")
    }

    @ViewBuilder
    private var files: some View {
        if !preview.files.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                StudioSectionHeader(
                    title: StudioFormat.plural(preview.files.count, "file") + " would change"
                )
                ForEach(preview.files.prefix(Self.listedFiles)) { file in
                    StudioRewindFileRow(file: file)
                }
                if preview.files.count > Self.listedFiles {
                    Text("and \(preview.files.count - Self.listedFiles) more")
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
            }
            .padding(.top, JunoSpace.hairline)
        }
    }

    private func divergence(scope: RewindScope, paths: [String]) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                JunoIconView(.triangleAlert, size: 12)
                    .foregroundStyle(Studio.Ink.danger)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                Text(
                    paths.count == 1
                        ? "A file changed after Juno last wrote it"
                        : "\(paths.count) files changed after Juno last wrote them"
                )
                .font(Studio.Font.labelEmphasis)
                .foregroundStyle(Studio.Ink.primary)
            }
            VStack(alignment: .leading, spacing: 2) {
                ForEach(paths.prefix(Self.listedFiles), id: \.self) { path in
                    Text(path)
                        .font(Studio.Font.mono)
                        .foregroundStyle(Studio.Ink.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Text("Restoring replaces those edits with the version from before this message.")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: JunoSpace.snug) {
                Spacer()
                Button("Cancel", action: cancel)
                    .buttonStyle(StudioSecondaryButtonStyle())
                    .contentShape(Capsule())
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("juno.code.rewind.cancel")
                Button("Restore Anyway") { restoreAnyway(scope) }
                    .buttonStyle(StudioPrimaryButtonStyle())
                    .contentShape(Capsule())
                    .keyboardShortcut(.defaultAction)
                    .accessibilityHint("Replaces the newer edits in these files.")
                    .accessibilityIdentifier("juno.code.rewind.restore-anyway")
            }
        }
    }
}

/// One file a rewind would change: its path, and what happens to it.
struct StudioRewindFileRow: View {
    let file: TurnRestoreFile

    private var effect: String {
        switch file.change {
        case .revert: "restored"
        case .recreate: "brought back"
        case .remove: "removed"
        }
    }

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Text(file.path.value)
                .font(Studio.Font.mono)
                .foregroundStyle(Studio.Ink.primary.opacity(0.85))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: JunoSpace.snug)
            if file.hasDiverged {
                Text("edited since")
                    .font(Studio.Font.metaEmphasis)
                    .foregroundStyle(Studio.Ink.secondary)
            }
            Text(effect)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.tertiary)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - The picker

/// Esc Esc from an idle, empty composer: the recent messages, newest first,
/// and then the same confirmation a row's Rewind opens.
struct StudioRewindPicker: View {
    let controller: SessionController
    let dismiss: () -> Void

    @State private var chosen: String?
    @State private var highlighted = 0
    @State private var fileCounts: [String: Int] = [:]
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let recentTurns = 20

    private var turns: [ConversationTurn] {
        Array(controller.rewindTurns.reversed().prefix(Self.recentTurns))
    }

    var body: some View {
        Group {
            if let chosen {
                StudioRewindFlow(controller: controller, turnID: chosen, finish: dismiss) {
                    self.chosen = nil
                    focused = true
                }
                .transition(.junoInline)
            } else {
                list
                    .transition(.junoInline)
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 480)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: chosen)
        .task { fileCounts = await controller.rewindFileCounts() }
        .accessibilityIdentifier("juno.code.rewind.picker")
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("Rewind")
                    .font(Studio.Font.title)
                    .foregroundStyle(Studio.Ink.primary)
                Text("Go back to just before one of your messages.")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            if turns.isEmpty {
                Text("There are no messages to rewind to yet.")
                    .font(Studio.Font.label)
                    .foregroundStyle(Studio.Ink.secondary)
            } else {
                ScrollView {
                    VStack(spacing: JunoSpace.hairline / 2) {
                        ForEach(Array(turns.enumerated()), id: \.element.id) { index, turn in
                            row(turn, index: index)
                        }
                    }
                }
                .frame(maxHeight: 360)
                .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: JunoSpace.snug) {
                StudioKeycap(keys: "↑↓ to move  ·  ↩ to choose  ·  esc to close")
                Spacer()
                Button("Cancel", action: dismiss)
                    .buttonStyle(StudioSecondaryButtonStyle())
                    .contentShape(Capsule())
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("juno.code.rewind.picker.cancel")
            }
        }
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(.upArrow) {
            guard !turns.isEmpty else { return .ignored }
            highlighted = (highlighted - 1 + turns.count) % turns.count
            return .handled
        }
        .onKeyPress(.downArrow) {
            guard !turns.isEmpty else { return .ignored }
            highlighted = (highlighted + 1) % turns.count
            return .handled
        }
        .onKeyPress(.return) {
            guard turns.indices.contains(highlighted) else { return .ignored }
            chosen = turns[highlighted].id
            return .handled
        }
        .onAppear { focused = true }
    }

    private func row(_ turn: ConversationTurn, index: Int) -> some View {
        Button { chosen = turn.id } label: {
            HStack(spacing: JunoSpace.snug) {
                Text(turn.text.isEmpty ? "Attachment" : turn.text)
                    .font(Studio.Font.label)
                    .foregroundStyle(Studio.Ink.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: JunoSpace.snug)
                if turn.kind != .prompt {
                    Text(turn.kind == .steer ? "Sent while working" : "Queued")
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
                if let count = fileCounts[turn.id], count > 0 {
                    Text("Edited " + StudioFormat.plural(count, "file"))
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
                Text(StudioFormat.age(turn.sentAt))
                    .font(Studio.Font.metaDigits)
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            .padding(.horizontal, JunoSpace.snug)
            .frame(minHeight: Studio.Metrics.rowHeight + JunoSpace.tight)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                    .fill(index == highlighted ? Studio.Surface.selected : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous))
        }
        .buttonStyle(.plain)
        .contentShape(RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous))
        .onHover { if $0 { highlighted = index } }
        .accessibilityIdentifier("juno.code.rewind.picker.row")
    }
}
