import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The one place Juno asks permission.
///
/// Sits directly above the composer while anything is waiting, and says three
/// things plainly: what it wants to do, how wide an "always" would be, and how
/// to say no with a reason. The audit counted six approval implementations
/// with a countdown, a risk chip and policy prose each; this is the whole of it.
///
/// Keys: ⏎ allows, ⌘⏎ always allows, esc declines.
struct StudioApprovalPrompt: View {
    let controller: SessionController

    @State private var redirect = ""
    @State private var showsRedirect = false
    @FocusState private var focused: Bool
    @FocusState private var redirectFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var request: ApprovalRequest? { controller.pendingApprovals.first }

    var body: some View {
        if let request {
            card(request)
                .id(request.id)
                .transition(.junoInline)
                .task(id: request.id) {
                    // Take the keyboard only from an empty composer: a reader
                    // mid-sentence who presses Return is sending their message,
                    // not approving a command that appeared under their cursor.
                    if controller.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        focused = true
                    }
                    showsRedirect = false
                    redirect = ""
                    let wait = request.expiresAt.timeIntervalSinceNow
                    if wait > 0 { try? await Task.sleep(for: .seconds(wait + 1)) }
                    guard !Task.isCancelled else { return }
                    await controller.sweepExpiredApprovals()
                }
        }
    }

    private func card(_ request: ApprovalRequest) -> some View {
        let copy = StudioApprovalCopy(request)
        return VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(alignment: .firstTextBaseline) {
                Text(copy.question)
                    .font(Studio.Font.labelEmphasis)
                    .foregroundStyle(Studio.Ink.primary)
                Spacer()
                if controller.pendingApprovals.count > 1 {
                    Text("1 of \(controller.pendingApprovals.count)")
                        .font(Studio.Font.metaDigits)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
            }

            Text(copy.subject)
                .font(Studio.Font.mono)
                .foregroundStyle(Studio.Ink.primary)
                .textSelection(.enabled)
                .lineLimit(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
                .background(
                    RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                        .fill(Studio.Surface.muted)
                )

            if request.risk == .destructive {
                Text("This reaches outside the project, so Juno always asks.")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.danger)
            }

            if showsRedirect {
                TextField("Tell Juno what to do instead", text: $redirect, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(Studio.Font.label)
                    .lineLimit(1...4)
                    .focused($redirectFocused)
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.snug)
                    .background(
                        RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                            .strokeBorder(Studio.Surface.hairline)
                    )
                    .onSubmit { declineWithRedirect(request) }
                    .transition(.opacity)
            }

            HStack(spacing: JunoSpace.snug) {
                Button {
                    if showsRedirect, !redirect.trimmingCharacters(in: .whitespaces).isEmpty {
                        declineWithRedirect(request)
                    } else {
                        Task { await controller.deny(request.id) }
                    }
                } label: {
                    Text(showsRedirect && !redirect.isEmpty ? "Decline and send" : "Decline")
                }
                .buttonStyle(StudioQuietButtonStyle())
                .accessibilityIdentifier("juno.code.approval.deny")

                if !showsRedirect {
                    Button("Say what to do instead") {
                        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                            showsRedirect = true
                        }
                        redirectFocused = true
                    }
                    .buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.tertiary))
                }

                Spacer(minLength: JunoSpace.snug)

                if let rule = request.suggestedRule {
                    Button {
                        Task { await controller.approveAlways(request.id) }
                    } label: {
                        HStack(spacing: JunoSpace.hairline + 1) {
                            Text("Always allow")
                            Text(rule.description)
                                .font(Studio.Font.monoSmall)
                                .foregroundStyle(Studio.Ink.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .frame(maxWidth: 180)
                        }
                    }
                    .buttonStyle(StudioSecondaryButtonStyle())
                    .keyboardShortcut(.return, modifiers: .command)
                    .accessibilityIdentifier("juno.code.approval.always")
                    .help("Allow now, and save \(rule.description) to this project's personal settings (⌘↩)")
                }

                Button {
                    Task { await controller.approve(request.id) }
                } label: {
                    HStack(spacing: JunoSpace.tight) {
                        Text("Allow")
                        Text("↩").foregroundStyle(Studio.Surface.canvas.opacity(0.6))
                    }
                }
                .buttonStyle(StudioPrimaryButtonStyle())
                .help("Allow once (↩)")
                .accessibilityIdentifier("juno.code.approval.approve")
            }
        }
        .padding(JunoSpace.regular)
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.composer, style: .continuous)
                .fill(Studio.Surface.raised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Studio.Radius.composer, style: .continuous)
                .strokeBorder(Studio.Ink.accent.opacity(0.45), lineWidth: 1)
        )
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .onKeyPress(.return) {
            guard !redirectFocused else { return .ignored }
            Task { await controller.approve(request.id) }
            return .handled
        }
        .onKeyPress(.escape) {
            Task { await controller.deny(request.id) }
            return .handled
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(copy.question) \(copy.subject)")
    }

    private func declineWithRedirect(_ request: ApprovalRequest) {
        let text = redirect
        redirect = ""
        showsRedirect = false
        Task { await controller.deny(request.id, redirect: text) }
    }
}

/// The words for one request: a question a person would ask, and the exact
/// thing it is about.
struct StudioApprovalCopy {
    let question: String
    let subject: String

    init(_ request: ApprovalRequest) {
        let summary = request.summary
        let object: String = {
            guard let space = summary.firstIndex(of: " ") else { return summary }
            return String(summary[summary.index(after: space)...])
        }()
        switch request.toolName {
        case "run_command":
            question = "Run this command?"
            subject = object
        case "run_tests":
            question = "Run the tests?"
            subject = object
        case "create_file":
            question = "Create this file?"
            subject = object
        case "delete_file":
            question = "Delete this file?"
            subject = object
        case "move_file":
            question = "Move this file?"
            subject = object
        case "write_file", "apply_patch", "multi_edit":
            question = "Edit this file?"
            subject = object
        case "git_commit":
            question = "Create this commit?"
            subject = object
        case "web_fetch":
            question = "Fetch this page?"
            subject = object
        case "delegate_task":
            question = "Start a sub-agent that can make changes?"
            subject = summary
        case "hook":
            question = "Run this project hook?"
            subject = summary
        default:
            if request.toolName.hasPrefix("mcp__") {
                question = "Use this connected tool?"
                subject = summary.hasPrefix("MCP ") ? String(summary.dropFirst(4)) : summary
            } else if request.toolName.hasPrefix("computer_") {
                question = "Control the screen?"
                subject = summary
            } else if request.toolName.hasPrefix("preview_") || request.toolName.contains("preview") {
                question = "Use the preview?"
                subject = summary
            } else {
                question = "Allow this?"
                subject = summary
            }
        }
    }
}
