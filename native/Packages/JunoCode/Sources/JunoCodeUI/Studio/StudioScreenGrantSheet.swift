import SwiftUI
import JunoCodeCore
import JunoDesignSystem
import JunoScreenControl

// What a screen tool's approval card adds under the request (CODE_AGENT_SPEC
// §3.3, §3.7): for an action, the crop of the frame with the target marked,
// the app and the element, and why it always asks when the floor applies;
// for a grant request, the grant sheet. Owned by Lane C.

/// The words for a screen tool's card.
enum StudioScreenApprovalCopy {
    static func question(toolName: String, summary _: String) -> String {
        switch toolName {
        case ComputerUseToolName.apps: "Let Juno use these apps?"
        case ComputerUseToolName.display: "Let Juno take over the screen?"
        case ComputerUseToolName.menu: "Choose this menu item?"
        case ComputerUseToolName.simulator: "Use the Simulator?"
        default: "Let Juno do this?"
        }
    }
}

/// Loads and draws the detail for one pending screen approval.
struct StudioScreenApprovalDetail: View {
    let request: ApprovalRequest
    let screen: ScreenControlModel

    @State private var detail: ScreenApprovalDetail?

    var body: some View {
        Group {
            switch detail {
            case let .action(prepared)?:
                StudioScreenActionCard(prepared: prepared)
            case let .grants(proposal)?:
                StudioScreenGrantSheet(proposal: proposal) { offers in
                    // In order, before Allow (see `settleGrantChoices`).
                    screen.updateGrantChoices(proposalID: proposal.id, offers: offers)
                }
            case let .takeover(_, display)?:
                StudioScreenTakeoverCard(display: display)
            case nil:
                // Not EmptyView: a task on an empty view never runs.
                Color.clear.frame(height: 0)
            }
        }
        .task(id: request.id) {
            guard ComputerUseToolName.isScreenTool(request.toolName) else { return }
            detail = await screen.approvalDetail(digest: request.actionDigest)
        }
    }
}

/// The picture and the target of one screen action.
struct StudioScreenActionCard: View {
    let prepared: PreparedScreenAction

    @State private var crop: CGImage?

    private var target: String {
        var parts = [prepared.target.appName]
        if let element = prepared.target.element { parts.append(element) }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            if let crop {
                Image(decorative: crop, scale: 2)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 360, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                            .strokeBorder(Studio.Surface.hairline)
                    )
                    .accessibilityLabel("The screen where Juno will act, with the spot ringed")
            }
            Text(target)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .accessibilityIdentifier("juno.code.approval.screen-target")
            if let floor = prepared.floor {
                Text(floor.explanation)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task(id: prepared.id) {
            if let data = prepared.crop {
                crop = StudioCaptureImage.decode(data, maxPixelSize: 960)
            }
        }
    }
}

/// The grant sheet: each app with what it may do, in words, and the reader's
/// choices. Allow and Decline are the card's own buttons.
struct StudioScreenGrantSheet: View {
    let proposal: GrantProposal
    let update: ([AppGrantOffer]) -> Void

    @State private var offers: [AppGrantOffer]

    init(proposal: GrantProposal, update: @escaping ([AppGrantOffer]) -> Void) {
        self.proposal = proposal
        self.update = update
        _offers = State(initialValue: proposal.offers)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            if let reason = proposal.reason, !reason.isEmpty {
                Text("Juno says: “\(reason)”")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach($offers) { $offer in
                row($offer)
            }
            Text("For this session only. Juno never controls itself, password managers or system prompts, and you can press Esc anywhere to stop.")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .onChange(of: offers) { _, next in update(next) }
    }

    @ViewBuilder
    private func row(_ offer: Binding<AppGrantOffer>) -> some View {
        let value = offer.wrappedValue
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: JunoSpace.snug) {
                if value.offeredTier != nil {
                    Toggle(isOn: offer.include) {
                        Text("\(value.displayName): \(value.offeredTier?.phrase ?? "")")
                            .font(Studio.Font.label)
                            .foregroundStyle(Studio.Ink.primary)
                    }
                    .toggleStyle(.checkbox)
                    .accessibilityIdentifier("juno.code.grant.\(value.bundleID ?? value.request)")
                } else {
                    Text(value.line)
                        .font(Studio.Font.label)
                        .foregroundStyle(Studio.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if value.offeredTier != nil {
                ForEach(value.warnings, id: \.self) { warning in
                    Text(warning)
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.tertiary)
                        .padding(.leading, 22)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if value.offeredTier == .full, value.clipboardRead || value.clipboardWrite || offer.wrappedValue.include {
                    HStack(spacing: JunoSpace.regular) {
                        if proposal.offers.first(where: { $0.id == value.id })?.clipboardRead == true {
                            Toggle("Paste from my clipboard", isOn: offer.clipboardRead).toggleStyle(.checkbox)
                        }
                        if proposal.offers.first(where: { $0.id == value.id })?.clipboardWrite == true {
                            Toggle("Copy to my clipboard", isOn: offer.clipboardWrite).toggleStyle(.checkbox)
                        }
                    }
                    .font(Studio.Font.meta)
                    .padding(.leading, 22)
                    .disabled(!value.include)
                }
            }
        }
    }
}

/// What taking over the screen means, before the reader says yes.
struct StudioScreenTakeoverCard: View {
    let display: String

    var body: some View {
        Text("Juno would use all of \(display) with the real pointer and keyboard. Every app it touches must still be granted, and its own windows stay out of the picture. Using your mouse or keyboard pauses it; Esc stops it.")
            .font(Studio.Font.meta)
            .foregroundStyle(Studio.Ink.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
