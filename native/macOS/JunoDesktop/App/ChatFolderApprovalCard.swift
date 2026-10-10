import JunoDesignSystem
import JunoWorkRuntime
import SwiftUI

/// A folder action waiting on the person, inside the turn it blocks and
/// above its answer — where the chat's other approval cards sit, drawn the
/// same way: opaque `--card`, radius 16, a hairline in the action's tone.
///
/// The question is one line ("Move march.csv to the Trash?"), what exactly
/// would happen sits in a mono well — the folder-relative path, or the
/// command and where it starts — and one sentence says what it means.
///
/// **Deny · Allow once · Always for this folder.** Refusing comes first and at
/// equal weight; Allow once is the card's one prominent button; "Always"
/// remembers the *kind* of action for this folder only. Nothing is bound to
/// Return: the person is here because they were meant to stop and read.
struct ChatFolderApprovalCard: View {
    let request: ChatFolderApprovalRequest
    let raisedAt: Date
    let decide: (ChatFolderApprovalDecision) -> Void


    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Text(request.title)
                .junoFont(size: 15, relativeTo: .body, weight: .semibold)
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, JunoSpace.snug)
            Text(request.explanation)
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, JunoSpace.hairline)
            detailWell
                .padding(.top, JunoSpace.close)
            buttons
                .padding(.top, JunoSpace.cozy)
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(edge, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(request.title)
        .accessibilityIdentifier("juno.chat.folder-approval")
    }

    private var header: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(icon, size: 15)
                .foregroundStyle(ink)
            Text("In \(Text(request.folderName).foregroundStyle(Color.junoForeground))")
                .junoFont(size: 12, relativeTo: .footnote, weight: .medium)
                .foregroundStyle(Color.junoSecondaryInk)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: JunoSpace.snug)
            HStack(spacing: JunoSpace.hairline) {
                JunoIconView(.clock, size: 12)
                Text(timerInterval: Date()...raisedAt.addingTimeInterval(DesktopChatFolderStore.approvalTimeout), countsDown: true)
                    .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                    .monospacedDigit()
            }
            .foregroundStyle(Color.junoSecondaryInk)
            .help("Unanswered, this is declined and nothing happens.")
        }
    }

    private var detailWell: some View {
        Text(request.detail)
            .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
            .foregroundStyle(Color.junoForeground)
            .textSelection(.enabled)
            .lineLimit(8)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.close)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .fill(Color.junoSecondary)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(Color.junoBorder.opacity(0.5), lineWidth: 1)
            )
    }

    private var buttons: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: JunoSpace.snug) { buttonRow }
            VStack(alignment: .leading, spacing: JunoSpace.snug) { buttonRow }
        }
    }

    @ViewBuilder
    private var buttonRow: some View {
        Button(role: .destructive) {
            decide(.deny)
        } label: {
            Text("Deny").frame(minHeight: 28)
        }
        .buttonStyle(.junoGlass)
        .tint(Color.junoDestructiveInk)
        .contentShape(.rect)
        .accessibilityIdentifier("juno.chat.folder-approval.deny")
        Button {
            decide(.allowOnce)
        } label: {
            Text("Allow Once").frame(minHeight: 28)
        }
        .buttonStyle(.junoProminent)
        .contentShape(.rect)
        .accessibilityIdentifier("juno.chat.folder-approval.allow-once")
        Button {
            decide(.allowAlways)
        } label: {
            Text("Always for This Folder").frame(minHeight: 28)
        }
        .buttonStyle(.junoGlass)
        .tint(nil)
        .contentShape(.rect)
        .help(alwaysHelp)
        .accessibilityIdentifier("juno.chat.folder-approval.always")
    }

    private var alwaysHelp: String {
        switch request.kind {
        case .replace: "Stop asking before replacing or editing files in \(request.folderName)."
        case .delete: "Stop asking before moving things in \(request.folderName) to the Trash."
        case .command: "Stop asking before running commands in \(request.folderName)."
        case .open: "Stop asking before opening files from \(request.folderName)."
        }
    }

    private var icon: JunoIcon {
        switch request.kind {
        case .replace: .pencil
        case .delete: .trash
        case .command: .terminal
        case .open: .external
        }
    }

    /// The warning tone for what cannot be put back from Alevr (a command, a
    /// replaced file); the source tone for what can (the Trash, an open).
    private var ink: Color {
        switch request.kind {
        case .command, .replace: Color.junoWarningInk
        case .delete, .open: Color.junoSource
        }
    }

    private var edge: Color {
        switch request.kind {
        case .command, .replace: Color.junoWarning.opacity(0.6)
        case .delete, .open: Color.junoSource.opacity(0.6)
        }
    }
}
