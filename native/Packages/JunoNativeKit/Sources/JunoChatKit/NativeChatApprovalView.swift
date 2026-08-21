import JunoDesignSystem
import SwiftUI

/// The native chat approval card.
///
/// This is deliberately shared by macOS and iOS. An approval is a safety
/// boundary, not a platform-specific decoration: both clients show the stored
/// preview, expose the exact redacted detail, and offer the same digest-bound
/// decisions with the safe choice carrying the strongest visual emphasis.
public struct NativeChatApprovalCard: View {
    private let approval: NativeChatApproval
    private let isBusy: Bool
    private let errorMessage: String?
    private let canAllowScope: Bool
    private let decide: (NativeChatApprovalDecision) -> Void

    public init(
        approval: NativeChatApproval,
        isBusy: Bool = false,
        errorMessage: String? = nil,
        canAllowScope: Bool? = nil,
        decide: @escaping (NativeChatApprovalDecision) -> Void
    ) {
        self.approval = approval
        self.isBusy = isBusy
        self.errorMessage = errorMessage
        self.canAllowScope = canAllowScope ?? approval.canAllowScope
        self.decide = decide
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 7) {
                Image(systemName: riskIcon)
                    .junoFont(size: 13, relativeTo: .body, weight: .semibold)
                    .foregroundStyle(riskColor)
                Text(riskLabel)
                    .junoFont(size: 13, relativeTo: .subheadline, weight: .semibold)
                    .foregroundStyle(riskColor)
                Text(approval.connectorLabel)
                    .junoSecondaryInk()
                    .lineLimit(1)
                Spacer(minLength: 4)
            }

            Text(approval.preview)
                .junoFont(size: 16, relativeTo: .body, weight: .medium)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            if !approval.detail.isEmpty {
                DisclosureGroup("Show exact details") {
                    ScrollView(.horizontal, showsIndicators: true) {
                        Text(approval.prettyDetail)
                            .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                    }
                    .frame(maxHeight: 180)
                    .background(Color.junoMuted, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .junoFont(size: 13, relativeTo: .subheadline)
            }

            Text(statusCopy)
                .junoFont(size: 13, relativeTo: .subheadline)
                .junoSecondaryInk()

            if approval.isPending {
                Text("Expires \(approval.expiresAt.formatted(.relative(presentation: .named)))")
                    .junoFont(size: 12, relativeTo: .caption)
                    .junoMetaInk()
            }

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .junoFont(size: 13, relativeTo: .subheadline)
                    .foregroundStyle(Color.junoDanger)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if approval.isPending {
                VStack(spacing: 8) {
                    Button {
                        decide(.allowOnce)
                    } label: {
                        Text("Allow once")
                            .frame(maxWidth: .infinity)
                    }
                    .junoProminentAction()
                    .controlSize(.large)
                    .accessibilityIdentifier("juno.chat.approval.allow-once")

                    HStack(spacing: 8) {
                        if canAllowScope {
                            Button {
                                decide(.allowScope)
                            } label: {
                                Text("Allow for this action")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.large)
                            .accessibilityIdentifier("juno.chat.approval.allow-scope")
                        }

                        Button {
                            decide(.deny)
                        } label: {
                            Text("Deny")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                        .accessibilityIdentifier("juno.chat.approval.deny")
                    }
                }
                .disabled(isBusy)
            }
        }
        .padding(16)
        .background(Color.junoSurface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(riskColor.opacity(0.45), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.chat.approval")
    }

    private var riskLabel: String {
        switch approval.riskClass {
        case .readOnly: "Reads only"
        case .reversibleWrite: "Reversible change"
        case .externalWrite: "Leaves Juno"
        case .destructiveOrSensitive: "Cannot be undone"
        case .unknown: "Unverified action"
        }
    }

    private var riskIcon: String {
        switch approval.riskClass {
        case .destructiveOrSensitive, .unknown: "exclamationmark.shield.fill"
        default: "shield.lefthalf.filled"
        }
    }

    private var riskColor: Color {
        switch approval.riskClass {
        case .destructiveOrSensitive, .unknown: .junoDanger
        case .externalWrite: .junoCaution
        case .reversibleWrite: .junoAccent
        case .readOnly: .junoSource
        }
    }

    private var statusCopy: String {
        switch approval.status {
        case .pending: "Juno is waiting for your answer."
        case .allowed: "Allowed. Juno is carrying out the action."
        case .denied: "Denied. Juno did not carry out the action."
        case .executing: "Juno is carrying out the action now."
        case .executed: "Juno carried out the action."
        case .failed: "Juno tried this and it failed."
        case .expired: "This expired before it was answered. Nothing was sent."
        case .superseded: "The action or permissions changed, so Juno cancelled this request."
        case .blocked: "Your permissions blocked this. Nothing was sent."
        }
    }
}
