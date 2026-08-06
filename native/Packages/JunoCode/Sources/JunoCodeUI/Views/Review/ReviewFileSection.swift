import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The pinned header for one changed file: what it is, how much it changed, and
/// the actions that apply to the whole file.
///
/// A separate view from the body so the review's `LazyVStack` sees a real
/// `Section` header to pin — the filename has to stay visible while its hunks
/// scroll under it, or a long diff stops saying which file it belongs to.
struct ReviewFileHeader: View {
    @Bindable var controller: SessionController
    @Bindable var review: ReviewModel
    let change: TrackedChange

    @State private var pendingRestore: Checkpoint?
    @State private var forceRestore: Checkpoint?
    @State private var confirmsFileRevert = false
    @State private var confirmsForcedFileRevert = false
    @State private var fileRevertFailure: String?
    @State private var reverting = false

    private var isEditable: Bool {
        controller.session.configuration.behavior == .code
    }

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            ReviewStateGlyph(state: change.reviewState)
            VStack(alignment: .leading, spacing: 0) {
                Text(PathDisplay.fileName(change.path))
                    .junoCode()
                    .lineLimit(1)
                if let directory = PathDisplay.directory(change.path) {
                    Text(directory)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
            DiffStat(added: change.linesAdded, removed: change.linesRemoved)
            Spacer(minLength: JunoSpace.cozy)
            fileActions
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Opaque: a pinned header with content scrolling under it has to hide
        // that content, and this is reading material either way.
        .background(alignment: .bottom) {
            VStack(spacing: 0) {
                Color.junoRaised
                Divider().overlay(Color.junoSeparator)
            }
        }
        .id(change.path)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            "\(change.path), \(change.kind.rawValue), \(change.linesAdded) added, \(change.linesRemoved) removed"
        )
        // On the header rather than beside the first dialog: one view presents
        // one thing at a time, and a refused restore has to be answerable while
        // the "restore this version" sheet is already gone.
        .confirmationDialog(
            "That file changed since this version was captured",
            isPresented: Binding(
                get: { forceRestore != nil },
                set: { if !$0 { forceRestore = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let checkpoint = forceRestore {
                Button("Restore Anyway", role: .destructive) {
                    restore(checkpoint, force: true)
                }
                Button("Cancel", role: .cancel) { forceRestore = nil }
            }
        } message: {
            Text("Restoring now discards the content written after it.")
        }
        .confirmationDialog(
            "Revert every change to this file?",
            isPresented: $confirmsFileRevert,
            titleVisibility: .visible
        ) {
            Button("Revert File", role: .destructive) {
                revertFile(force: false)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This restores \(PathDisplay.fileName(change.path)) from Juno's checkpoints.")
        }
        .confirmationDialog(
            "That file changed since Juno captured it",
            isPresented: $confirmsForcedFileRevert,
            titleVisibility: .visible
        ) {
            Button("Restore Anyway", role: .destructive) {
                revertFile(force: true)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Restoring now discards content written after Juno's latest checkpoint.")
        }
        .alert(
            "Could Not Restore File",
            isPresented: Binding(
                get: { fileRevertFailure != nil },
                set: { if !$0 { fileRevertFailure = nil } }
            )
        ) {
            Button("OK") { fileRevertFailure = nil }
        } message: {
            Text(fileRevertFailure ?? "The file could not be reverted.")
        }
    }

    @ViewBuilder
    private var fileActions: some View {
        Button("Keep File") {
            controller.acceptChange(path: change.path)
        }
        .controlSize(.small)
        .disabled(change.reviewState == .accepted)
        .help("Mark this file reviewed and keep every hunk")

        if reverting {
            ProgressView().controlSize(.small).frame(width: 46)
        } else {
            Button("Revert File", role: .destructive) {
                confirmsFileRevert = true
            }
            .controlSize(.small)
            .disabled(!isEditable)
            .help(
                isEditable
                    ? "Restore this file from its checkpoints"
                    : "Ask and Plan sessions are read-only"
            )
        }

        Menu {
            if history.isEmpty {
                Text("No earlier versions recorded")
            } else {
                ForEach(history) { checkpoint in
                    Button {
                        pendingRestore = checkpoint
                    } label: {
                        Text(
                            checkpoint.createdAt.formatted(
                                date: .omitted,
                                time: .standard
                            )
                        )
                    }
                    .disabled(!isEditable)
                }
            }
        } label: {
            Image(systemName: "clock.arrow.circlepath")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Earlier versions of this file captured before each change")
        .accessibilityLabel("File history")
        .task(id: change.checkpointIDs.count) {
            await review.loadCheckpoints(for: change.path, from: controller)
        }
        .confirmationDialog(
            "Restore this version?",
            isPresented: Binding(
                get: { pendingRestore != nil },
                set: { if !$0 { pendingRestore = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let checkpoint = pendingRestore {
                Button("Restore \(PathDisplay.fileName(change.path))") {
                    restore(checkpoint, force: false)
                }
                Button("Cancel", role: .cancel) { pendingRestore = nil }
            }
        } message: {
            if let checkpoint = pendingRestore {
                Text(
                    "\(PathDisplay.fileName(change.path)) goes back to its content at "
                        + checkpoint.createdAt.formatted(date: .abbreviated, time: .standard)
                        + ". Later changes to this file are discarded."
                )
            }
        }
    }

    private func revertFile(force: Bool) {
        reverting = true
        if force {
            confirmsForcedFileRevert = false
        }
        Task {
            let result = await review.revertFile(
                change.path,
                force: force,
                using: controller
            )
            reverting = false
            switch result {
            case .restored:
                fileRevertFailure = nil
            case .diverged where !force:
                // Divergence is the one failure an explicit overwrite can
                // answer. Operational errors never unlock this action.
                confirmsForcedFileRevert = true
            case .diverged:
                fileRevertFailure =
                    result.failureMessage ?? "The file still differs from its checkpoint."
            case let .failed(message):
                fileRevertFailure = message
            }
        }
    }

    /// This file's earlier versions, newest first.
    private var history: [Checkpoint] {
        review.checkpoints[change.path] ?? []
    }

    private func restore(_ checkpoint: Checkpoint, force: Bool) {
        pendingRestore = nil
        if force {
            forceRestore = nil
        }
        Task {
            let result = await review.restore(
                checkpointID: checkpoint.id,
                path: change.path,
                force: force,
                using: controller
            )
            switch result {
            case .restored:
                forceRestore = nil
                fileRevertFailure = nil
            case .diverged where !force:
                // A fingerprint mismatch is the only failure an explicit
                // overwrite can answer.
                forceRestore = checkpoint
            case .diverged:
                forceRestore = nil
                fileRevertFailure =
                    result.failureMessage ?? "The file still differs from that version."
            case let .failed(message):
                // Missing history, permissions, and I/O failures stay errors;
                // force would only repeat the same failed operation.
                forceRestore = nil
                fileRevertFailure = message
            }
        }
    }
}

/// One changed file's hunks, with their per-hunk actions and notes.
struct ReviewFileBody: View {
    @Bindable var controller: SessionController
    @Bindable var review: ReviewModel
    let change: TrackedChange
    let canvasWidth: CGFloat

    private var isEditable: Bool {
        controller.session.configuration.behavior == .code
    }

    private var pairedColumnWidth: CGFloat {
        // Half the canvas, but never so narrow that neither side shows a
        // statement; below that the pair scrolls as one wide document.
        max((canvasWidth - 1) / 2, DiffLinePresentation.minimumPairedColumnWidth)
    }

    var body: some View {
        content(for: review.diffs[change.path])
    }

    @ViewBuilder
    private func content(for diff: TextDiff?) -> some View {
        if review.loadingPaths.contains(change.path) {
            HStack(spacing: JunoSpace.snug) {
                ProgressView().controlSize(.small)
                Text("Loading diff…").junoCaption()
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.cozy)
        } else if review.unavailablePaths.contains(change.path) {
            ReviewNotice(
                symbol: "exclamationmark.triangle",
                text: "No checkpoint is available for this file, so its diff cannot be reconstructed."
            )
        } else if let diff, !diff.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                ForEach(Array(diff.hunks.enumerated()), id: \.offset) { index, hunk in
                    hunkView(index: index, hunk: hunk)
                }
                ForEach(controller.pendingReviewComments(for: change.path)) { comment in
                    ReviewNoteRow(comment: comment) {
                        controller.removeReviewComment(id: comment.id)
                    }
                }
            }
        } else if change.reviewState == .rejected {
            ReviewNotice(
                symbol: "arrow.uturn.backward.circle",
                text: "Reverted — this file matches the content it had before the session."
            )
        } else {
            ReviewNotice(
                symbol: "equal.circle",
                text: "This file now matches its original content."
            )
        }
    }

    @ViewBuilder
    private func hunkView(index: Int, hunk: DiffHunk) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HunkActionRow(
                hunk: hunk,
                isAccepted: controller.isHunkAccepted(path: change.path, hunk: hunk),
                isReverting: review.revertingHunkID == hunk.reviewIdentifier,
                canRevert: isEditable,
                onKeep: { controller.acceptHunk(path: change.path, hunk: hunk) },
                onRevert: {
                    Task {
                        await review.revertHunk(
                            at: index,
                            in: change.path,
                            hunk: hunk,
                            using: controller
                        )
                    }
                },
                onComment: {
                    review.commentTarget = ReviewCommentTarget(
                        path: change.path,
                        hunkIdentifier: hunk.reviewIdentifier,
                        hunkHeader: hunk.header
                    )
                }
            )

            if let failure = review.revertFailures[hunk.reviewIdentifier] {
                HStack(spacing: JunoSpace.tight) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.junoCaution)
                    Text(failure).junoCaption()
                    Spacer(minLength: JunoSpace.snug)
                    Button("Reload Diff") {
                        Task {
                            review.dismissRevertFailure(for: hunk.reviewIdentifier)
                            await review.reload(path: change.path, from: controller)
                        }
                    }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                }
                .padding(.horizontal, JunoSpace.regular)
                .padding(.vertical, JunoSpace.tight)
                .accessibilityElement(children: .combine)
            }

            switch review.layout {
            case .unified:
                UnifiedHunkLines(
                    hunk: hunk,
                    minimumWidth: canvasWidth,
                    onComment: { line in commentTarget(hunk: hunk, line: line) }
                )
            case .sideBySide:
                ScrollView(.horizontal) {
                    PairedHunkLines(
                        hunk: hunk,
                        columnWidth: pairedColumnWidth,
                        onComment: { line in commentTarget(hunk: hunk, line: line) }
                    )
                }
            }

            if let target = review.commentTarget,
               target.hunkIdentifier == hunk.reviewIdentifier
            {
                ReviewCommentEditor(
                    target: target,
                    onCancel: { review.commentTarget = nil },
                    onSubmit: { text in
                        controller.addReviewComment(
                            ReviewComment(
                                path: target.path,
                                hunkHeader: target.hunkHeader,
                                lineNumber: target.lineNumber,
                                quotedLine: target.quotedLine,
                                text: text
                            )
                        )
                        review.commentTarget = nil
                    }
                )
            }
        }
    }

    private func commentTarget(hunk: DiffHunk, line: DiffLine) {
        review.commentTarget = ReviewCommentTarget(
            path: change.path,
            hunkIdentifier: hunk.reviewIdentifier,
            hunkHeader: hunk.header,
            lineNumber: line.newLineNumber ?? line.oldLineNumber,
            quotedLine: line.text
        )
    }
}

/// Per-hunk actions. `Keep` is review bookkeeping; `Revert` is a real,
/// checkpointed write, which is why it is the only destructive control here and
/// why it is disabled outside Code sessions rather than hidden.
private struct HunkActionRow: View {
    let hunk: DiffHunk
    let isAccepted: Bool
    let isReverting: Bool
    let canRevert: Bool
    let onKeep: () -> Void
    let onRevert: () -> Void
    let onComment: () -> Void

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Text(hunk.header)
                .junoCodeSmall()
                .foregroundStyle(.tertiary)
            Spacer(minLength: JunoSpace.cozy)
            if isAccepted {
                Label("Kept", systemImage: "checkmark")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(Color.junoSuccess)
            } else {
                Button("Keep", action: onKeep)
                    .buttonStyle(.borderless)
                    .font(.caption2.weight(.medium))
                    .help("Mark this hunk reviewed")
            }
            if isReverting {
                ProgressView().controlSize(.small).frame(width: 42)
            } else {
                Button("Revert", role: .destructive, action: onRevert)
                    .buttonStyle(.borderless)
                    .font(.caption2.weight(.medium))
                    .disabled(!canRevert)
                    .help(
                        canRevert
                            ? "Restore only this hunk through a new checkpoint"
                            : "Ask and Plan sessions are read-only"
                    )
            }
            Button("Comment", action: onComment)
                .buttonStyle(.borderless)
                .font(.caption2.weight(.medium))
                .help("Add a note about this hunk to the review")
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.hairline)
        .background(Color.junoRowHover)
    }
}

/// The note editor, opened against one hunk or one line.
private struct ReviewCommentEditor: View {
    let target: ReviewCommentTarget
    let onCancel: () -> Void
    let onSubmit: (String) -> Void

    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            if let quoted = target.quotedLine {
                Text(quoted)
                    .junoCodeSmall()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            TextField(
                target.lineNumber.map { "Note on line \($0)…" } ?? "Note on this hunk…",
                text: $text,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .lineLimit(1...6)
            .focused($focused)
            .accessibilityIdentifier("juno.code.review.note-field")
            // Return adds the note, Shift-Return breaks the line — handled on the
            // *field* rather than as an accelerator on the button below.
            //
            // The button used to carry `.keyboardShortcut(.return, modifiers:
            // .command)`, which collided with the composer's Send: the composer
            // stays visible in the review by design, so two enabled controls in one
            // window claimed ⌘⏎ and which one fired was left to SwiftUI's traversal
            // order. Scoping the key to the focused editor removes the ambiguity
            // instead of renaming it.
            .onKeyPress(.return, phases: .down) { press in
                if press.modifiers.contains(.shift) { return .ignored }
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                else { return .handled }
                onSubmit(text)
                return .handled
            }
            HStack(spacing: JunoSpace.snug) {
                Spacer(minLength: 0)
                Button("Cancel", action: onCancel)
                    .controlSize(.small)
                    .keyboardShortcut(.escape, modifiers: [])
                // No accelerator: Return on the focused field above is the shortcut,
                // and a second binding here is what collided with the composer.
                Button("Add Note") { onSubmit(text) }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
                    .tint(Color.junoAccent)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(JunoSpace.cozy)
        .junoPanel(cornerRadius: JunoRadius.row)
        .padding(.horizontal, JunoSpace.regular)
        .padding(.top, JunoSpace.snug)
        .onAppear { focused = true }
    }
}

/// A note already in the batch, shown with the file it belongs to so the reader
/// can see what they have written without leaving the diff.
private struct ReviewNoteRow: View {
    let comment: ReviewComment
    let onDelete: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            Image(systemName: "text.bubble")
                .foregroundStyle(Color.junoAccent)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(location)
                    .junoCodeSmall()
                    .foregroundStyle(.tertiary)
                Text(comment.text)
                    .junoBody()
                    .textSelection(.enabled)
            }
            Spacer(minLength: JunoSpace.snug)
            Button(role: .destructive, action: onDelete) {
                Image(systemName: "trash")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .help("Delete this note")
            .accessibilityLabel("Delete note")
        }
        .padding(JunoSpace.cozy)
        .junoPanel(cornerRadius: JunoRadius.row)
        .padding(.horizontal, JunoSpace.regular)
        .accessibilityElement(children: .combine)
    }

    private var location: String {
        guard let lineNumber = comment.lineNumber else { return comment.hunkHeader }
        return "\(comment.hunkHeader) line \(lineNumber)"
    }
}

private struct ReviewNotice: View {
    let symbol: String
    let text: String

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Image(systemName: symbol)
                .foregroundStyle(.secondary)
            Text(text).junoCaption()
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
        .accessibilityElement(children: .combine)
    }
}

struct ReviewStateGlyph: View {
    let state: TrackedChange.ReviewState

    var body: some View {
        switch state {
        case .pending:
            Image(systemName: "circle.dotted")
                .foregroundStyle(.secondary)
                .help("Not reviewed")
                .accessibilityLabel("Not reviewed")
        case .accepted:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Color.junoSuccess)
                .help("Kept")
                .accessibilityLabel("Kept")
        case .rejected:
            Image(systemName: "arrow.uturn.backward.circle")
                .foregroundStyle(.secondary)
                .help("Reverted")
                .accessibilityLabel("Reverted")
        }
    }
}
