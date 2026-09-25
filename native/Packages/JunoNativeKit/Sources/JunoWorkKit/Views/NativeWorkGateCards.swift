import Foundation
import JunoCore
import JunoDesignSystem
import SwiftUI

// The two cards a run stops on — an approval and a question — for surfaces
// that answer them outside the task's own thread: today an agent's Now tab,
// tomorrow either app's Work screen, which still draws private copies.
//
// Both hand the answer back through a closure rather than holding a model, so
// the same card answers a relay approval, a question, or an approval raised by
// a run executing on this Mac, whose answer goes to the in-process
// coordinator instead of the server.
//
// Opaque surface and a hairline, never glass: these are content, read and
// decided on (FLAT_UI.md §2). The words are literals because the Mac has no
// string catalog, and a key shown as text on the card that authorises an
// action is the worst place for one.

// MARK: - Approval

/// One action a run has stopped to ask permission for.
///
/// The whole request is handed back with the decision, never an id: the
/// digest of the exact action on screen and its expiry both have to travel
/// with the answer, which is what stops a card shown for one action from
/// authorising another.
///
/// **Refuse comes first**, at the same weight as Always allow (AGENTS.md
/// §5.2, and the web's card): the answer that can never cost anything is never
/// the hard one to reach. Allow once carries the accent but is not the default
/// action, so a stray Return cannot allow anything; Refuse answers Escape.
public struct NativeWorkApprovalCard: View {
    private let approval: WorkApprovalRequest
    private let busy: Bool
    private let decide: @MainActor (JunoWorkApprovalDecision) -> Void

    /// - Parameters:
    ///   - busy: an answer is on its way; the buttons stand still until it lands.
    ///   - decide: answers it. Called with `.denied`, `.allowed` or
    ///     `.allowedAlways`, the last only where a standing yes is possible.
    public init(
        approval: WorkApprovalRequest,
        busy: Bool = false,
        decide: @escaping @MainActor (JunoWorkApprovalDecision) -> Void
    ) {
        self.approval = approval
        self.busy = busy
        self.decide = decide
    }

    /// Irreversible actions are the only ones drawn in danger; everything else
    /// that reaches a person is caution.
    private var tint: Color {
        JunoWorkVocabulary.riskTint(approval.risk)
    }

    private var alwaysAsks: Bool {
        JunoWorkRiskLevel(rawValue: approval.risk)?.alwaysRequiresApproval == true
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            header
            // The stored sentence, verbatim. It is what an audit can prove was
            // on screen.
            Text(approval.summary)
                .junoBody()
                .junoInk()
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            // Stated rather than counted down: a live countdown needs a timer
            // behind every card, and pressing Allow after the window closed is
            // already answered with a sentence saying it expired.
            Text("Expires \(approval.expiresAt.formatted(.relative(presentation: .named)))")
                .junoCaption()
            actions
                .disabled(busy)
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(Color.junoSurface)
        }
        .overlay {
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(tint.opacity(0.45), lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.work.gate.approval")
    }

    private var header: some View {
        HStack(alignment: .center, spacing: JunoSpace.snug) {
            JunoIconView(alwaysAsks ? .error : .permission, size: 12)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(JunoWorkVocabulary.risk(approval.risk))
                .junoFont(size: 12, relativeTo: .caption, weight: .semibold)
                .foregroundStyle(tint)
            Text(JunoWorkVocabulary.action(approval.action))
                .junoCaption()
                .lineLimit(1)
        }
    }

    // One row on the Mac, where the card is wide. Two on the phone, so no
    // label is cut: Refuse and Allow once side by side, the standing yes
    // under them.
    @ViewBuilder
    private var actions: some View {
        #if os(macOS)
        HStack(spacing: JunoSpace.snug) {
            refuseButton
            allowOnceButton
            if approval.allowsStandingGrant {
                allowAlwaysButton
            }
            Spacer(minLength: 0)
        }
        #else
        VStack(spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.snug) {
                refuseButton
                allowOnceButton
            }
            if approval.allowsStandingGrant {
                allowAlwaysButton
            }
        }
        .controlSize(.large)
        #endif
    }

    private var refuseButton: some View {
        Button {
            decide(.denied)
        } label: {
            Text("Refuse")
                .junoInk()
                .frame(maxWidth: buttonWidth)
        }
        .buttonStyle(.bordered)
        .keyboardShortcut(.cancelAction)
        .frame(minHeight: 44)
        .contentShape(.rect)
        .accessibilityIdentifier("juno.work.gate.refuse")
    }

    private var allowOnceButton: some View {
        Button {
            decide(.allowed)
        } label: {
            Text("Allow once")
                .fontWeight(.semibold)
                .foregroundStyle(Color.junoOnAccent)
                .frame(maxWidth: buttonWidth)
        }
        .buttonStyle(.junoProminent)
        .frame(minHeight: 44)
        .contentShape(.rect)
        .accessibilityIdentifier("juno.work.gate.allow")
    }

    /// Offered only where a standing yes is actually possible — the server
    /// refuses one for anything that always asks.
    private var allowAlwaysButton: some View {
        Button {
            decide(.allowedAlways)
        } label: {
            Text("Always allow this")
                .junoInk()
                .frame(maxWidth: buttonWidth)
        }
        .buttonStyle(.bordered)
        .frame(minHeight: 44)
        .contentShape(.rect)
        .accessibilityIdentifier("juno.work.gate.allow-always")
    }

    /// On the phone every button fills its share of the row; on the Mac each
    /// is as wide as its words.
    private var buttonWidth: CGFloat? {
        #if os(macOS)
        return nil
        #else
        return CGFloat.infinity
        #endif
    }
}

// MARK: - Question

/// A question a run has stopped to ask, answered where it is shown.
///
/// The reply is typed in the card itself on both platforms — one shape, so a
/// question reads the same wherever an agent's page is open. What the person
/// writes stays in the card until the reply has landed: `send` answers
/// whether it did, and a reply that failed is still there to send again.
public struct NativeWorkQuestionCard: View {
    private let question: WorkQuestionPrompt
    private let busy: Bool
    private let send: @MainActor (String) async -> Bool

    @State private var draft = ""
    @State private var sending = false

    /// - Parameters:
    ///   - busy: a reply is on its way from elsewhere on the page.
    ///   - send: delivers the reply, trimmed, and answers whether it landed.
    public init(
        question: WorkQuestionPrompt,
        busy: Bool = false,
        send: @escaping @MainActor (String) async -> Bool
    ) {
        self.question = question
        self.busy = busy
        self.send = send
    }

    private var reply: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isWorking: Bool {
        busy || sending
    }

    /// A question this build could not read is still a question: the run is
    /// stopped on it, and its thread shows it in full.
    private var prompt: String {
        question.text.isEmpty
            ? "It asked something this app can’t show. Its thread has the question in full."
            : question.text
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(alignment: .center, spacing: JunoSpace.snug) {
                JunoIconView(.conversation, size: 12)
                    .foregroundStyle(Color.junoAccent)
                    .accessibilityHidden(true)
                Text("It asked")
                    .junoFont(size: 12, relativeTo: .caption, weight: .semibold)
                    .junoInk()
            }
            Text(prompt)
                .junoBody()
                .junoInk()
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            field
            HStack(spacing: JunoSpace.snug) {
                Spacer(minLength: 0)
                if isWorking {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Sending your answer")
                }
                sendButton
            }
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(Color.junoSurface)
        }
        .overlay {
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 0.5)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.work.gate.question")
    }

    private var field: some View {
        TextField("Your answer", text: $draft, axis: .vertical)
            .textFieldStyle(.plain)
            .lineLimit(2...8)
            .junoBody()
            .padding(JunoSpace.snug)
            .background {
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .fill(Color.junoMuted)
            }
            .overlay {
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 0.5)
            }
            .disabled(isWorking)
            .accessibilityLabel("Your answer")
            .accessibilityIdentifier("juno.work.gate.answer-field")
    }

    private var sendButton: some View {
        Button(action: submit) {
            Text("Send")
                .fontWeight(.semibold)
                .foregroundStyle(Color.junoOnAccent)
        }
        .buttonStyle(.junoProminent)
        .disabled(reply.isEmpty || isWorking)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(.rect)
        .accessibilityIdentifier("juno.work.gate.answer-send")
    }

    private func submit() {
        let text = reply
        guard !text.isEmpty, !isWorking else { return }
        // Held here as well as by the caller, so a second press before the
        // caller's own busy flag arrives cannot send the reply twice.
        sending = true
        Task {
            let landed = await send(text)
            sending = false
            if landed { draft = "" }
        }
    }
}
