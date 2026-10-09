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
/// Keys, while the card has focus: ⏎ allows, ⌘⏎ always allows, esc declines.
/// None of them is a window-wide shortcut. ⌘⏎ is also the composer's send
/// key, and as a key equivalent on the button it fired from anywhere in the
/// window: a reader typing a steer who pressed it to send granted a standing
/// rule instead, and their message went nowhere.
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
                .transition(.opacity)
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
        return VStack(alignment: .leading, spacing: JunoSpace.snug + 2) {
            // The composer takeover (code-v4 TARGET §7.4): the question in
            // the signal ink, the count, the exact thing in a mono well.
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text(copy.question)
                    .studioType(.textMedium)
                    .foregroundStyle(Studio.Signal.ink)
                    .lineLimit(2)
                Spacer()
                if controller.pendingApprovals.count > 1 {
                    Text("1 of \(controller.pendingApprovals.count)")
                        .studioType(.small).monospacedDigit()
                        .foregroundStyle(Studio.Ink.secondary)
                }
            }

            Text(copy.subject)
                .studioType(.code)
                .foregroundStyle(Studio.Ink.primary)
                .textSelection(.enabled)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
                .background(
                    RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                        .fill(Studio.Surface.muted)
                )

            // A screen tool's card shows what it will hit: the marked crop,
            // the app and element, or the grant sheet (Lane C).
            if ComputerUseToolName.isScreenTool(request.toolName) {
                StudioScreenApprovalDetail(request: request, screen: controller.screen)
            }

            if request.risk == .destructive, !ComputerUseToolName.isScreenTool(request.toolName) {
                Text(Self.isFileTool(request.toolName)
                    ? "This changes what Alevr itself may do in this project, so Alevr always asks."
                    : "This reaches outside the project, so Alevr always asks.")
                    .studioType(.small)
                    .foregroundStyle(Studio.Ink.secondary)
            }

            if showsRedirect {
                TextField("Tell Alevr what to do instead", text: $redirect, axis: .vertical)
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
                .buttonStyle(.borderless)
                .accessibilityIdentifier("juno.code.approval.deny")

                if !showsRedirect {
                    Button("Redirect") {
                        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                            showsRedirect = true
                        }
                        redirectFocused = true
                    }
                    .buttonStyle(.borderless)
                    .help("Decline and say what to do instead")
                }

                Spacer(minLength: JunoSpace.snug)

                if let rule = request.suggestedRule {
                    Button {
                        Task { await controller.approveAlways(request.id) }
                    } label: {
                        Text("Always Allow")
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("juno.code.approval.always")
                    // Said where it goes, because for screen input that is
                    // every project, not this one: no project file may allow it.
                    .help(
                        rule.coversScreenInput
                            ? "Allow now, and save \(rule.description) to your settings for all projects (⌘↩ while this card is selected)"
                            : "Allow now, and save \(rule.description) to this project's personal settings (⌘↩ while this card is selected)"
                    )
                }

                Button {
                    Task { await controller.approve(request.id) }
                } label: {
                    Text("Allow Once")
                }
                .buttonStyle(CodeV2InkButtonStyle())
                .help("Allow once (↩)")
                .accessibilityIdentifier("juno.code.approval.approve")
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.top, JunoSpace.cozy + 2)
        .padding(.bottom, JunoSpace.cozy)
        // Drawn inside the composer's shell, which holds the 1pt signal edge.
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .onKeyPress(.return, phases: .down) { press in
            guard !redirectFocused else { return .ignored }
            if press.modifiers.contains(.command), request.suggestedRule != nil {
                Task { await controller.approveAlways(request.id) }
            } else {
                Task { await controller.approve(request.id) }
            }
            return .handled
        }
        .onKeyPress(.escape) {
            Task { await controller.deny(request.id) }
            return .handled
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(copy.question) \(copy.subject)")
    }

    /// The file tools stay inside the project, so a destructive one is a
    /// write to the project's policy files rather than a way out of it.
    private static func isFileTool(_ name: String) -> Bool {
        ["create_file", "write_file", "apply_patch", "multi_edit", "delete_file", "move_file"].contains(name)
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
    /// The mark in the card's tile: what kind of thing is asking.
    var icon: JunoIcon = .shield
    /// Whether the subject is a shell command, drawn after a `$`.
    var isCommand = false

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
            icon = .terminal
            isCommand = true
        case "shell_start":
            question = "Run this in the background?"
            subject = summary.hasPrefix("Start in background: ")
                ? String(summary.dropFirst("Start in background: ".count))
                : summary
            icon = .terminal
            isCommand = true
        case "shell_write":
            question = "Send this to the background process?"
            subject = summary
            icon = .terminal
        case "shell_kill":
            question = "Stop this background process?"
            subject = summary
            icon = .terminal
        case "run_tests":
            question = "Run the tests?"
            subject = object
            icon = .listChecks
            isCommand = true
        case "create_file":
            question = "Create this file?"
            subject = object
            icon = .filePlus
        case "delete_file":
            question = "Delete this file?"
            subject = object
            icon = .trash
        case "move_file":
            question = "Move this file?"
            subject = object
            icon = .fileCode
        case "apply_patch" where summary.hasPrefix("Patch "):
            question = "Apply this patch?"
            subject = object
            icon = .pencil
        case "write_file", "apply_patch", "multi_edit":
            question = "Edit this file?"
            subject = object
            icon = .pencil
        case "git_commit":
            question = "Create this commit?"
            subject = object
            icon = .gitCommit
        case "web_fetch":
            question = "Fetch this page?"
            subject = object
            icon = .web
        case "delegate_task":
            question = "Start a sub-agent that can make changes?"
            subject = summary
            icon = .agents
        case "hook":
            question = "Run this project hook?"
            subject = summary
        default:
            if request.toolName.hasPrefix("mcp__") {
                question = "Use this connected tool?"
                subject = summary.hasPrefix("MCP ") ? String(summary.dropFirst(4)) : summary
            } else if ComputerUseToolName.isScreenTool(request.toolName) {
                question = StudioScreenApprovalCopy.question(toolName: request.toolName, summary: summary)
                subject = summary
                icon = .monitor
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
