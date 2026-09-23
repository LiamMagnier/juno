import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI

/// A connector action waiting on the reader, inside the turn it blocks and
/// **above** its answer (spec §6.9, brief §6.10): the model's tool loop is
/// holding, so the question sits where the eye already is.
///
/// Opaque — `--card`, radius 16, a hairline in the action's risk tone while it
/// can be answered — with the web's copy (`approval-card.tsx`, verbatim). The
/// buttons refuse first and at equal weight: **Don't allow · Allow once ·
/// Allow this action for this connector**. A row that led with a primary Allow
/// would have answered for the reader, who is here because they were meant to
/// stop and think — so **nothing is bound to `.defaultAction`**, and Return
/// never approves.
///
/// The Mac's own card rather than the shared `NativeChatApprovalCard`, which
/// keeps the phone's 44pt layout and its glass action.
struct DesktopApprovalCard: View {
    let approval: NativeChatApproval
    let isBusy: Bool
    let errorMessage: String?
    let canAllowScope: Bool
    let decide: (NativeChatApprovalDecision) -> Void

    @State private var detailOpen = false
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var isTask: Bool {
        approval.connectorID == "juno_work" && approval.toolName == "start_task"
    }

    private var answerable: Bool { approval.isPending && approval.expiresAt > Date() }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Text(approval.preview)
                .junoFont(size: 15, relativeTo: .body, weight: answerable ? .semibold : .regular)
                .foregroundStyle(Color.junoForeground)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, JunoSpace.snug)
            if !isTask {
                // Identifiers, so mono.
                Text("\(approval.connectorLabel) · \(approval.toolName)")
                    .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.top, JunoSpace.hairline)
            }
            if !isTask || answerable {
                Text(isTask ? Self.taskDescription : riskDetail)
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, JunoSpace.snug)
            }
            if approval.derivedFromUntrusted {
                untrustedNote.padding(.top, JunoSpace.close)
            }
            detailWell.padding(.top, JunoSpace.close)
            if answerable {
                decisionButtons.padding(.top, JunoSpace.cozy)
            }
            if let status = statusLine {
                Text(status)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, JunoSpace.close)
            }
            if let errorMessage {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                    JunoIconView(.warning, size: 13)
                    Text(errorMessage)
                        .junoFont(size: 12, relativeTo: .footnote)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .foregroundStyle(Color.junoWarningInk)
                .padding(.top, JunoSpace.close)
            }
            if answerable, !isBusy {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(.clock, size: 12)
                    Text(isTask ? "Unanswered, this expires and the task does not start." : "Unanswered, this expires and Juno stops rather than acting on it.")
                        .junoFont(size: 11, relativeTo: .caption)
                }
                .foregroundStyle(Color.junoSecondaryInk)
                .padding(.top, JunoSpace.snug)
            }
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
        .accessibilityLabel(isTask ? "Start a background task?" : "Juno needs your approval")
        .accessibilityIdentifier("juno.chat.approval")
    }

    // MARK: Pieces

    private var header: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(isTask ? .work : .security, size: 16)
                .foregroundStyle(answerable ? Color.junoWarningInk : Color.junoSecondaryInk)
            Text(title)
                .junoFont(size: 12, relativeTo: .footnote, weight: .semibold)
                .foregroundStyle(answerable ? Color.junoWarningInk : Color.junoSecondaryInk)
            if !isTask {
                Text(riskLabel)
                    .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                    .foregroundStyle(riskInk)
                    .padding(.horizontal, JunoSpace.snug)
                    .frame(height: 20)
                    .overlay(Capsule().strokeBorder(riskInk.opacity(0.45), lineWidth: 1))
            }
            Spacer(minLength: JunoSpace.snug)
            if answerable {
                HStack(spacing: JunoSpace.hairline) {
                    JunoIconView(.clock, size: 12)
                    // The words in SF, the ticking count in mono.
                    Text("Expires in")
                        .junoFont(size: 12, relativeTo: .footnote)
                    Text(timerInterval: Date()...approval.expiresAt, countsDown: true)
                        .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                        .monospacedDigit()
                }
                .foregroundStyle(Color.junoSecondaryInk)
                .accessibilityLabel("Answer before \(approval.expiresAt.formatted(date: .omitted, time: .shortened))")
            }
        }
    }

    private var title: String {
        if isTask { return answerable ? "Start a background task?" : "Background task" }
        return answerable ? "Juno needs your approval" : "Approval request"
    }

    /// The exact arguments the digest covers, folded until asked for — never
    /// summarised, and already redacted server-side.
    private var detailWell: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion)) {
                    detailOpen.toggle()
                }
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(.chevronRight, size: 12, weight: .bold)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .rotationEffect(.degrees(detailOpen ? 90 : 0))
                    Text(isTask ? "What the task will be told" : "Exactly what will be sent")
                        .junoFont(size: 12, relativeTo: .footnote, weight: .medium)
                        .foregroundStyle(Color.junoForeground)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, JunoSpace.cozy)
                .frame(minHeight: 32)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .contentShape(.rect)
            .accessibilityValue(detailOpen ? "Expanded" : "Collapsed")
            if detailOpen {
                Rectangle()
                    .fill(Color.junoBorder.opacity(0.5))
                    .frame(height: 1)
                detailRows
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.close)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoSecondary)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(0.5), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
    }

    @ViewBuilder
    private var detailRows: some View {
        let rows = approval.detail.sorted { $0.key < $1.key }
        if rows.isEmpty {
            Text("This call sends no arguments.")
                .junoFont(size: 12, relativeTo: .footnote)
                .foregroundStyle(Color.junoSecondaryInk)
        } else {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                ForEach(rows, id: \.key) { entry in
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                        Text(entry.key)
                            .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .frame(width: 112, alignment: .leading)
                        Text(Self.format(entry.value))
                            .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                            .foregroundStyle(Color.junoForeground)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    private var untrustedNote: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            JunoIconView(.security, size: 14)
                .foregroundStyle(Color.junoWarningInk)
            Text(isTask ? Self.taskUntrusted : Self.untrusted)
                .junoFont(size: 12, relativeTo: .footnote)
                .foregroundStyle(Color.junoWarningInk)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.close)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoWarning.opacity(0.1))
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoWarning.opacity(0.4), lineWidth: 1)
        )
    }

    /// Refuse first, at equal weight. Allow once is the surface's one
    /// prominent button; nothing is the default action.
    private var decisionButtons: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: JunoSpace.snug) { buttons }
            VStack(alignment: .leading, spacing: JunoSpace.snug) { buttons }
        }
        .disabled(isBusy)
    }

    @ViewBuilder
    private var buttons: some View {
        Button(role: .destructive) {
            decide(.deny)
        } label: {
            Text(isTask ? "Don’t start" : "Don’t allow").frame(minHeight: 28)
        }
        .buttonStyle(.bordered)
        // The web's destructive outline: refusing, in the refusal's own ink.
        .tint(Color.junoDestructiveInk)
        .contentShape(.rect)
        .accessibilityIdentifier("juno.chat.approval.deny")
        Button {
            decide(.allowOnce)
        } label: {
            Text(isTask ? "Start task" : "Allow once").frame(minHeight: 28)
        }
        .buttonStyle(.borderedProminent)
        .contentShape(.rect)
        .accessibilityIdentifier("juno.chat.approval.allow-once")
        if canAllowScope, !isTask {
            Button {
                decide(.allowScope)
            } label: {
                Text("Allow this action for this connector").frame(minHeight: 28)
            }
            .buttonStyle(.bordered)
            .contentShape(.rect)
            .accessibilityIdentifier("juno.chat.approval.allow-scope")
        }
    }

    // MARK: Words (the web's, verbatim)

    private var riskLabel: String {
        switch approval.riskClass {
        case .readOnly: "Reads only"
        case .reversibleWrite: "Reversible change"
        case .externalWrite: "Leaves Juno"
        case .destructiveOrSensitive: "Cannot be undone"
        case .unknown: "Unverified"
        }
    }

    private var riskDetail: String {
        switch approval.riskClass {
        case .readOnly: "This reads. Nothing outside Juno changes."
        case .reversibleWrite: "This changes something that can be put back, like a label, a folder or a draft."
        case .externalWrite: "This sends something to another service. Once it lands there, Juno cannot take it back."
        case .destructiveOrSensitive: "This deletes, pays for, or touches something private. Nothing here can undo it afterwards."
        case .unknown:
            "Juno could not verify that this only reads, so it is treated as a change that leaves Juno. Read the arguments below before you answer."
        }
    }

    /// The risk's own tone: quiet for a read, the source tone for something
    /// that can be put back, the warning tone for everything that cannot.
    private var riskInk: Color {
        switch approval.riskClass {
        case .readOnly: Color.junoSecondaryInk
        case .reversibleWrite: Color.junoSource
        case .externalWrite, .destructiveOrSensitive, .unknown: Color.junoWarningInk
        }
    }

    private var edge: Color {
        guard answerable else {
            return Color.junoBorder.opacity(JunoHairline.opacity(increaseContrast: contrast == .increased))
        }
        switch approval.riskClass {
        case .readOnly: return Color.junoBorder.opacity(JunoHairline.opacity(increaseContrast: contrast == .increased))
        case .reversibleWrite: return Color.junoSource.opacity(0.6)
        case .externalWrite, .destructiveOrSensitive, .unknown: return Color.junoWarning.opacity(0.6)
        }
    }

    private var statusLine: String? {
        if approval.isPending {
            return approval.expiresAt <= Date()
                ? "This expired before it was answered. Nothing was sent." : nil
        }
        if isTask {
            switch approval.status {
            case .allowed, .executing: return "Allowed. Starting the task."
            case .executed: return "Started. The task reports back in this chat."
            case .denied: return "Not started."
            case .failed: return "The task could not be started."
            case .expired: return "This expired before it was answered, so the task did not start."
            case .superseded, .blocked, .pending: break
            }
        }
        switch approval.status {
        case .pending: return nil
        case .allowed: return "Allowed. Juno is carrying this out."
        case .denied: return "Denied. Juno did not carry this out."
        case .executing: return "Juno is carrying this out now."
        case .executed: return "Juno carried this out."
        case .failed: return "Juno tried this and it failed."
        case .expired: return "This expired before it was answered. Nothing was sent."
        case .superseded:
            return "The arguments or your permissions changed after this was raised, so Juno cancelled it and will ask again."
        case .blocked: return "Your permissions blocked this, so Juno never sent it."
        }
    }

    static let untrusted = "The model wrote these arguments from content it read: a web page, a file, or output from another connector. That content can contain text written to steer what gets sent. Check the values below are what you meant before you allow it."
    static let taskUntrusted = "This chat includes content Juno read from outside it, such as a web page, a file or a connected app. Check that the brief below is what you asked for before you start it."
    static let taskDescription = "Juno works on this on its own and reports back in this chat. It asks before risky steps, and you can stop it at any time."

    static func format(_ value: JunoJSONValue) -> String {
        switch value {
        case .string(let text): text
        case .number(let number): number.rounded() == number ? String(Int(number)) : String(number)
        case .bool(let flag): flag ? "true" : "false"
        case .null: "null"
        case .array, .object:
            (try? JSONEncoder().encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        }
    }
}
