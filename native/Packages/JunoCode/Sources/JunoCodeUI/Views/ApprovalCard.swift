import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// A pending approval: a blocking, expiring decision about what runs on the
/// reader's machine.
///
/// This is the highest-stakes surface in Juno Code, and it had three different
/// treatments — a card in the transcript, a `.bar` strip, an inline row — none of
/// which showed the expiry the model has always carried and the coordinator has
/// always failed closed on. There is one card now, pinned above the composer in
/// both the transcript and the review canvas, so the reader can be looking at the
/// diff the approval is about while they answer.
///
/// It is deliberately opaque and deliberately not a sheet. It is reading material
/// with a decision in it, and a modal would cover the transcript needed to make
/// that decision.
public struct ApprovalCard: View {
    let request: ApprovalRequest
    let controller: SessionController
    /// Set by the expiry timer below rather than by a periodic clock, so the
    /// buttons are not rebuilt once a second underneath the reader's pointer.
    @State private var expired = false

    public init(request: ApprovalRequest, controller: SessionController) {
        self.request = request
        self.controller = controller
    }

    /// Only `critical` — destructive, escaping, networked or privilege-elevating
    /// — gets the danger colour. Tinting every approval red trains the reader to
    /// dismiss the colour, which is exactly the wrong reflex on this surface.
    private var tint: Color {
        request.risk == .critical ? .junoDanger : .junoCaution
    }

    /// The one case where "and stop asking" is a fair offer: the reader is being
    /// asked about a workspace edit, under the mode whose whole content is that
    /// question.
    private var offersStandingEditPermission: Bool {
        request.risk == .write
            && controller.session.configuration.behavior == .code
            && controller.session.configuration.permissionMode == .askBeforeChanges
    }

    private var riskExplanation: String {
        switch request.risk {
        case .read: "Reads inside this folder."
        case .write: "Changes a file in this folder. The previous version is checkpointed."
        case .execute: "Runs a command in this folder."
        case .critical:
            "Destructive, networked, or reaches outside this folder. This always asks, in every mode."
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            header

            Text(request.summary)
                .font(.callout)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)

            Text(riskExplanation)
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)

            Text(request.toolName)
                .junoMono()
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)

            actions
        }
        .padding(JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoPanel()
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(tint.opacity(0.55), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            "Approval required, \(request.risk.rawValue) risk: \(request.summary)"
        )
        // Nothing else in the app ticks, so the card that shows the countdown is
        // what closes the loop on it: an expired request would otherwise leave the
        // suspended tool waiting for an answer the policy has already given.
        .task(id: request.id) {
            let delay = request.expiresAt.timeIntervalSinceNow
            if delay > 0 {
                try? await Task.sleep(for: .seconds(delay))
            }
            guard !Task.isCancelled else { return }
            expired = true
            await controller.sweepExpiredApprovals()
        }
    }

    private var header: some View {
        HStack(spacing: JunoSpace.snug) {
            Image(systemName: "hand.raised.fill")
                .imageScale(.small)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text("Approval required")
                .font(.system(.callout, weight: .semibold))
            Spacer(minLength: JunoSpace.snug)
            ApprovalCountdown(expiresAt: request.expiresAt)
            StatusChip(
                "\(request.risk.rawValue.capitalized) risk",
                systemImage: "exclamationmark.triangle.fill",
                tint: tint
            )
        }
    }

    private var actions: some View {
        HStack(spacing: JunoSpace.snug) {
            if expired {
                Text("This request expired and was refused.")
                    .font(.caption)
                    .foregroundStyle(Color.junoDanger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)

            Button(expired ? "Dismiss" : "Deny") {
                Task { await controller.deny(request.id) }
            }
            .keyboardShortcut(.escape, modifiers: .shift)
            .help(expired ? "Clear this request" : "Deny this action (⇧⎋)")
            .accessibilityIdentifier("juno.code.approval.deny")

            if offersStandingEditPermission, !expired {
                Button("Always allow edits here") {
                    Task { await controller.approveAllowingFurtherEdits(request.id) }
                }
                .help(
                    "Approve this edit and let Juno edit files in this folder for the rest of the session. Commands still ask."
                )
                .accessibilityIdentifier("juno.code.approval.always-allow")
            }

            Button("Approve") {
                Task { await controller.approve(request.id) }
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.junoAccent)
            .keyboardShortcut(.return, modifiers: .shift)
            .disabled(expired)
            .help("Approve this action (⇧⏎)")
            .accessibilityIdentifier("juno.code.approval.approve")
        }
    }
}

/// How long the reader has left. The expiry has always been part of the model
/// and the coordinator has always enforced it; showing it is what makes the
/// enforcement fair.
struct ApprovalCountdown: View {
    let expiresAt: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
            let remaining = Int(expiresAt.timeIntervalSince(timeline.date).rounded())
            Group {
                if remaining > 0 {
                    Text("Expires in \(remaining / 60):\(String(format: "%02d", remaining % 60))")
                        .foregroundStyle(remaining <= 60 ? Color.junoCaution : Color.secondary)
                } else {
                    Text("Expired")
                        .foregroundStyle(Color.junoDanger)
                }
            }
            .font(.caption)
            .monospacedDigit()
            .accessibilityLabel(
                remaining > 0
                    ? "Expires in \(remaining / 60) minutes \(remaining % 60) seconds"
                    : "Expired"
            )
        }
    }
}
