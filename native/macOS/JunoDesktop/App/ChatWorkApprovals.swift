import AppKit
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

// MARK: - The queue

/// Every decision the task waits on, local first, and the one control that
/// answers several at once (the web's `ApprovalQueue`).
///
/// The batch bar appears only when more than one pending card may ride it
/// (``WorkApprovalWords/mayBatch(action:risk:)`` — never anything the floor
/// catches), and says whether that is all of them. Decisions go one at a time
/// and stop at the first that does not land. **Only the first answerable
/// card's verb is prominent** (register #60): one coral button per surface.
struct ChatWorkApprovalQueue: View {
    let approvals: [ChatWorkApproval]
    var isBusy = false
    var now: Date? = nil
    let decide: (ChatWorkApproval, JunoWorkApprovalDecision, String?) -> Void
    let decideAll: ([ChatWorkApproval]) -> Void

    private var clock: Date { now ?? Date() }

    /// Pending, signed and not yet expired: what can actually be answered.
    static func live(_ approvals: [ChatWorkApproval], at now: Date) -> [ChatWorkApproval] {
        approvals.filter { $0.request.isAnswerable(at: now) && !$0.request.actionDigest.isEmpty }
    }

    /// The one card whose verb is prominent: the first that can be answered.
    static func primaryID(_ approvals: [ChatWorkApproval], at now: Date) -> String? {
        live(approvals, at: now).first?.id
    }

    /// What the batch button may answer: more than one, or nothing.
    static func batchable(_ approvals: [ChatWorkApproval], at now: Date) -> [ChatWorkApproval] {
        let batchable = live(approvals, at: now).filter {
            WorkApprovalWords.mayBatch(action: $0.request.action, risk: $0.request.risk)
        }
        return batchable.count > 1 ? batchable : []
    }

    var body: some View {
        let live = Self.live(approvals, at: clock)
        let batchable = Self.batchable(approvals, at: clock)
        let primary = Self.primaryID(approvals, at: clock)
        VStack(alignment: .leading, spacing: JunoSpace.close) {
            if !batchable.isEmpty {
                batchBar(batchable, live: live.count)
                    .transition(.opacity)
            }
            ForEach(approvals) { approval in
                ChatWorkApprovalCard(
                    approval: approval.request,
                    isBusy: isBusy,
                    isPrimary: approval.id == primary,
                    now: now,
                    decide: { decision, reason in decide(approval, decision, reason) }
                )
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.work.approval-queue")
    }

    private func batchBar(_ batchable: [ChatWorkApproval], live: Int) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: JunoSpace.cozy) { batchContent(batchable, live: live) }
            VStack(alignment: .leading, spacing: JunoSpace.snug) { batchContent(batchable, live: live) }
        }
        .padding(.horizontal, JunoSpace.comfy)
        .padding(.vertical, JunoSpace.close)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.junoCard, in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoWarning.opacity(0.6), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.work.approval-batch")
    }

    @ViewBuilder
    private func batchContent(_ batchable: [ChatWorkApproval], live: Int) -> some View {
        Text(WorkApprovalWords.batchSentence(batchable: batchable.count, live: live))
            .junoFont(size: 13, relativeTo: .callout)
            .foregroundStyle(Color.junoWarningInk)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        Button {
            decideAll(batchable)
        } label: {
            Text(WorkApprovalWords.batchLabel(actions: batchable.map(\.request.action)))
                .frame(minHeight: 20)
                .contentShape(.rect)
        }
        .buttonStyle(.bordered)
        .tint(nil)
        .controlSize(.small)
        .frame(minHeight: 28)
        .fixedSize()
        .disabled(isBusy)
        .accessibilityIdentifier("juno.work.approval-batch.allow")
    }
}

// MARK: - One decision

/// One decision, asked the way a person would ask it (the web's
/// `approvals/approval-card.tsx`, register #67).
///
/// While it can be answered: a tile at radius 12 under a 1pt hairline in its
/// risk tone — no warning wash — with "Your decision", the risk, when it was
/// asked; the summary; the thing being decided about in a well ("To …" and
/// the message, file list or command); every parameter the digest covers
/// behind "Show n parameters"; what answering costs; then **Don’t · Change it
/// · {Verb} · More**. Nothing is bound to `.defaultAction` or Escape, so
/// Return never approves. Settled, it says what became of it.
///
/// **Change it** refuses the action and hands the run a correction: the
/// buttons give way to "What should it do instead?" and "Send this
/// instruction", which decides `denied` with the text as the reason.
struct ChatWorkApprovalCard: View {
    let approval: WorkApprovalRequest
    var isBusy = false
    /// Whether this card's verb is the surface's one prominent button.
    var isPrimary = true
    var now: Date? = nil
    let decide: (JunoWorkApprovalDecision, String?) -> Void

    /// The legacy window's call, which takes no correction.
    init(
        approval: WorkApprovalRequest, isBusy: Bool = false, decide: @escaping (JunoWorkApprovalDecision) -> Void
    ) {
        self.approval = approval
        self.isBusy = isBusy
        self.decide = { decision, _ in decide(decision) }
    }

    /// - Parameter amendment: opens the card already changing it, with this
    ///   text — how a fixture draws that state.
    init(
        approval: WorkApprovalRequest, isBusy: Bool = false, isPrimary: Bool = true, now: Date? = nil,
        amendment: String? = nil,
        decide: @escaping (JunoWorkApprovalDecision, String?) -> Void
    ) {
        self.approval = approval
        self.isBusy = isBusy
        self.isPrimary = isPrimary
        self.now = now
        self.decide = decide
        _amending = State(initialValue: amendment != nil)
        _amendment = State(initialValue: amendment ?? "")
    }

    @State private var showsParameters = false
    @State private var amending = false
    @State private var amendment = ""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var clock: Date { now ?? Date() }
    private var expired: Bool { approval.expiresAt <= clock }
    private var answerable: Bool { approval.isPending && !expired }
    private var verb: WorkApprovalWords.Verb { WorkApprovalWords.verb(for: approval.action) }
    private var tone: Color { DesktopWorkVocabulary.riskTint(approval.risk) }

    var body: some View {
        Group {
            if answerable { pending } else { settled }
        }
        .padding(JunoSpace.comfy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.junoCard, in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(answerable ? tone.opacity(0.7) : Color.junoBorder.opacity(0.6), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(answerable ? "Your decision: \(approval.summary)" : approval.summary)
        .accessibilityIdentifier("juno.work.approval")
    }

    // MARK: Pending

    private var pending: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Text(approval.summary)
                .junoFont(size: 15, relativeTo: .body, weight: .medium)
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .padding(.top, JunoSpace.snug)
            preview
            parameters
            Text(WorkApprovalWords.riskConsequence(approval.risk))
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoWarningInk)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, JunoSpace.close)
            if approval.actionDigest.isEmpty {
                Text(WorkApprovalWords.noDigest)
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoWarningInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, JunoSpace.close)
            } else if amending {
                amendForm
                    .padding(.top, JunoSpace.cozy)
                    .transition(.opacity)
            } else {
                buttons
                    .padding(.top, JunoSpace.cozy)
                    .transition(.opacity)
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(.clock, size: 11)
                    Text(WorkApprovalWords.expiryFootnote)
                        .junoFont(size: 11, relativeTo: .caption)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .foregroundStyle(Color.junoSecondaryInk)
                .padding(.top, JunoSpace.snug)
            }
        }
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: amending)
    }

    private var header: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(.shieldCheck, size: 14)
                .foregroundStyle(Color.junoWarningInk)
                .accessibilityHidden(true)
            Text(WorkApprovalWords.decisionHeader)
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                .foregroundStyle(Color.junoWarningInk)
            ChatWorkRiskPill(risk: approval.risk)
            Spacer(minLength: JunoSpace.snug)
            asked
        }
    }

    @ViewBuilder
    private var asked: some View {
        if let createdAt = approval.createdAt {
            Text(ChatWorkFormat.ago(createdAt, now: clock))
                .junoFont(size: 11, relativeTo: .caption)
                .monospacedDigit()
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize()
        }
    }

    /// The thing being decided about, drawn as the kind of thing it is: a
    /// message as prose, a file list one per line, a command as code.
    @ViewBuilder
    private var preview: some View {
        let body = WorkApprovalWords.previewBody(approval.detail, verb: verb)
        let target = WorkApprovalWords.previewTarget(approval.detail, verb: verb)
        if let body {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                if let target { targetLine(target) }
                previewBody(body)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.close)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.junoSecondary, in: RoundedRectangle(cornerRadius: JunoRadius.md, style: .continuous))
            .padding(.top, JunoSpace.close)
        } else if let target {
            targetLine(target).padding(.top, JunoSpace.snug)
        }
    }

    private func targetLine(_ target: String) -> some View {
        (Text("To ") + Text(target).foregroundStyle(Color.junoForeground))
            .junoFont(size: 12, relativeTo: .footnote)
            .foregroundStyle(Color.junoSecondaryInk)
            .lineLimit(2)
            .textSelection(.enabled)
    }

    @ViewBuilder
    private func previewBody(_ body: String) -> some View {
        switch verb.bodyStyle {
        case .prose:
            Text(body)
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .lineLimit(14)
                .textSelection(.enabled)
        case .paths, .command:
            // A file list and a command are the file system's and the shell's
            // own characters, so mono.
            Text(body)
                .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .lineLimit(14)
                .textSelection(.enabled)
        }
    }

    /// Everything the digest covers, on request — folded, never hidden.
    @ViewBuilder
    private var parameters: some View {
        let rows = WorkApprovalWords.parameters(approval.detail)
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Button {
                    withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion)) {
                        showsParameters.toggle()
                    }
                } label: {
                    HStack(spacing: JunoSpace.tight) {
                        JunoIconView(.chevronRight, size: 10, weight: .bold)
                            .rotationEffect(.degrees(showsParameters ? 90 : 0))
                        Text(WorkApprovalWords.parametersToggle(count: rows.count, open: showsParameters))
                            .monospacedDigit()
                    }
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(minHeight: 28)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityValue(showsParameters ? "Expanded" : "Collapsed")
                if showsParameters {
                    Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: JunoSpace.snug, verticalSpacing: JunoSpace.micro) {
                        ForEach(rows, id: \.key) { row in
                            GridRow {
                                Text(row.key)
                                    .foregroundStyle(Color.junoSecondaryInk)
                                    .gridColumnAlignment(.leading)
                                Text(row.value)
                                    .foregroundStyle(Color.junoForeground)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.snug)
                    .background(Color.junoSecondary, in: RoundedRectangle(cornerRadius: JunoRadius.md, style: .continuous))
                    .transition(.opacity)
                }
            }
            .padding(.top, JunoSpace.hairline)
        }
    }

    // MARK: Buttons

    private var buttons: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: JunoSpace.snug) { buttonRow }
            VStack(alignment: .leading, spacing: JunoSpace.snug) { buttonRow }
        }
        .disabled(isBusy)
    }

    /// Refuse first, at equal weight; the verb is the one coloured control.
    @ViewBuilder
    private var buttonRow: some View {
        Button(role: .destructive) {
            decide(.denied, nil)
        } label: {
            Text("Don\u{2019}t").frame(minHeight: 20).contentShape(.rect)
        }
        .buttonStyle(.bordered)
        .tint(Color.junoDestructiveInk)
        .controlSize(.small)
        .frame(minHeight: 28)
        .accessibilityIdentifier("juno.work.approval.deny")

        Button {
            amending = true
        } label: {
            HStack(spacing: JunoSpace.tight) {
                JunoIconView(.pencil, size: 12)
                Text("Change it")
            }
            .frame(minHeight: 20)
            .contentShape(.rect)
        }
        .buttonStyle(.bordered)
        .tint(nil)
        .controlSize(.small)
        .frame(minHeight: 28)
        .accessibilityIdentifier("juno.work.approval.amend")

        verbButton

        if WorkApprovalWords.mayStopAsking(action: approval.action, risk: approval.risk) {
            Menu {
                Button {
                    decide(.allowedAlways, nil)
                } label: {
                    Text("\(Self.menuTitle(verb.verb)), and Stop Asking")
                    Text(WorkApprovalWords.standingScope(action: approval.action))
                }
            } label: {
                Text("More")
                    .junoFont(size: 12, relativeTo: .footnote)
                    .frame(minHeight: 28)
                    .contentShape(.rect)
            }
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .menuIndicator(.visible)
            // Neutral: the verb is the card's one coloured control.
            .tint(Color.junoSecondaryInk)
            .foregroundStyle(Color.junoSecondaryInk)
            .frame(minHeight: 28)
            .fixedSize()
            .help("More answers")
            .accessibilityIdentifier("juno.work.approval.more")
        }
    }

    @ViewBuilder
    private var verbButton: some View {
        let button = Button {
            decide(.allowed, nil)
        } label: {
            Text(verb.verb).frame(minHeight: 20).contentShape(.rect)
        }
        .controlSize(.small)
        .frame(minHeight: 28)
        // "Send" alone, read out of context, is not enough to decide on.
        .accessibilityLabel("\(verb.verb): \(approval.summary)")
        .accessibilityIdentifier("juno.work.approval.allow")
        if isPrimary {
            button.buttonStyle(.junoProminent)
        } else {
            button.buttonStyle(.bordered).tint(nil)
        }
    }

    // MARK: Change it

    private var amendForm: some View {
        let trimmed = amendment.trimmingCharacters(in: .whitespacesAndNewlines)
        return VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text(WorkApprovalWords.amendPrompt)
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                .foregroundStyle(Color.junoWarningInk)
            TextEditor(text: $amendment)
                .junoFont(size: 13, relativeTo: .callout)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, JunoSpace.snug)
                .padding(.vertical, JunoSpace.tight)
                .frame(minHeight: 60, maxHeight: 112)
                .background(alignment: .topLeading) {
                    if amendment.isEmpty {
                        Text(WorkApprovalWords.amendPlaceholder)
                            .junoFont(size: 13, relativeTo: .callout)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .padding(.horizontal, JunoSpace.snug + 5)
                            .padding(.vertical, JunoSpace.tight)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .background(Color.junoSecondary, in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 1)
                )
                .accessibilityLabel(WorkApprovalWords.amendPrompt)
            Text(WorkApprovalWords.amendNote)
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: JunoSpace.snug) {
                Button {
                    amending = false
                    amendment = ""
                } label: {
                    Text("Back").frame(minWidth: 28, minHeight: 28).contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(Color.junoSecondaryInk)
                let send = Button {
                    decide(.denied, trimmed)
                } label: {
                    Text("Send this instruction").frame(minHeight: 20).contentShape(.rect)
                }
                .controlSize(.small)
                .frame(minHeight: 28)
                .disabled(trimmed.isEmpty)
                .accessibilityIdentifier("juno.work.approval.amend.send")
                if isPrimary {
                    send.buttonStyle(.junoProminent)
                } else {
                    send.buttonStyle(.bordered).tint(nil)
                }
            }
            .disabled(isBusy)
        }
    }

    // MARK: Settled

    private var settled: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.shieldCheck, size: 14)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .accessibilityHidden(true)
                ChatWorkRiskPill(risk: approval.risk)
                Spacer(minLength: JunoSpace.snug)
                asked
            }
            Text(approval.summary)
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Text(WorkApprovalWords.actionLabel(approval.action))
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoSecondaryInk)
            HStack(spacing: JunoSpace.tight) {
                JunoIconView(.clock, size: 11)
                Text(WorkApprovalWords.settledLine(approval, expired: expired) { ChatWorkFormat.ago($0, now: clock) })
                    .junoFont(size: 11, relativeTo: .caption)
                    .monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(Color.junoSecondaryInk)
            .padding(.top, JunoSpace.micro)
        }
    }

    /// A verb in a native menu is in Title Case: "Make the Changes".
    static func menuTitle(_ verb: String) -> String {
        let small: Set<String> = ["a", "an", "the", "and", "but", "or", "for", "nor", "on", "at", "to", "by", "of", "in"]
        return verb.split(separator: " ").enumerated().map { index, word in
            let lower = word.lowercased()
            if index > 0, small.contains(lower) { return lower }
            return word.prefix(1).uppercased() + word.dropFirst()
        }
        .joined(separator: " ")
    }
}

/// The web's `RiskPill`: the bad tone, with a shield, for what is sensitive or
/// cannot be undone; neutral for everything else.
struct ChatWorkRiskPill: View {
    let risk: String

    var body: some View {
        let severe = WorkApprovalWords.riskIsSevere(risk)
        let ink = severe ? Color.junoDestructiveInk : Color.junoSecondaryInk
        HStack(spacing: JunoSpace.micro) {
            if severe {
                JunoIconView(.security, size: 10)
            }
            Text(WorkApprovalWords.riskLabel(risk))
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
        }
        .foregroundStyle(ink)
        .padding(.horizontal, JunoSpace.snug)
        .frame(height: 20)
        .background(Capsule(style: .continuous).fill((severe ? Color.junoDestructive : Color.junoMutedForeground).opacity(0.12)))
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}
