import AppKit
import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// Plan & usage's three blocks the web mounts beside the plan
/// (`cancel-subscription.tsx`, `top-up-card.tsx`, `referral-card.tsx`): the
/// online cancellation, usage top-ups, and the invitation link. The Mac
/// subscribes through Stripe, so all three apply; each block hides itself
/// when its read fails or there is nothing to say, as the web's do.
struct DesktopBillingExtrasSections: View {
    let context: DesktopSettingsContext

    @State private var model: NativeBillingExtrasModel?
    @State private var showingCancel = false
    @State private var copied = false
    @State private var presenter = DesktopUpgradePresenter.shared

    var body: some View {
        Group {
            if let model {
                cancellationSection(model)
                topUpSection(model)
                referralSection(model)
            }
        }
        .task {
            guard model == nil, let billing = context.services.billing else { return }
            let created = NativeBillingExtrasModel(client: billing, accountID: context.accountID)
            model = created
            await created.load()
        }
        .sheet(isPresented: $showingCancel, onDismiss: afterCancelSheet) {
            if let model, let state = model.cancellation {
                DesktopCancelSubscriptionSheet(model: model, recap: state.recap)
            }
        }
    }

    // MARK: Cancellation

    @ViewBuilder
    private func cancellationSection(_ model: NativeBillingExtrasModel) -> some View {
        if let state = model.cancellation, !state.isHidden {
            Section {
                switch state.source {
                case .appStore:
                    DesktopSettingRow(
                        title: "Subscription",
                        description: "Bought through the App Store. To cancel, open your Apple ID subscriptions."
                    ) {
                        DesktopOutlineButton(title: "Apple ID Subscriptions", icon: .external) {
                            if let url = URL(string: "https://apps.apple.com/account/subscriptions") { NSWorkspace.shared.open(url) }
                        }
                    }
                case .stripe, .none:
                    if state.cancelAtPeriodEnd {
                        DesktopSettingRow(title: "Subscription", description: Self.cancelledSentence(state.recap.endsAtDate)) {
                            DesktopOutlineButton(title: model.sendingCancellation ? "Sending…" : "Keep My Subscription") {
                                Task {
                                    if await model.setCancellation(.resume) { await context.loadPlan() }
                                }
                            }
                            .disabled(model.sendingCancellation)
                        }
                        if let error = model.cancellationError {
                            DesktopSettingsNote(text: error, tone: .warning)
                        }
                    } else {
                        DesktopSettingRow(
                            title: "Cancel subscription",
                            description: "You keep your plan until the end of the period you’ve paid for."
                        ) {
                            DesktopOutlineButton(title: "Cancel Subscription…", destructive: true) {
                                model.prepareCancellation()
                                showingCancel = true
                            }
                            .accessibilityIdentifier("juno.desktop.settings.cancel-subscription")
                        }
                    }
                }
            }
        }
    }

    /// "Cancelled. Your plan ends on October 3, 2026."
    static func cancelledSentence(_ endsAt: Date?) -> String {
        guard let endsAt else { return "Cancelled. Your plan ends at the end of this period." }
        return "Cancelled. Your plan ends on \(endsAt.formatted(.dateTime.month(.wide).day().year()))."
    }

    private func afterCancelSheet() {
        guard let model, model.cancellationReceived else { return }
        Task {
            await model.reloadCancellation()
            await context.loadPlan()
        }
    }

    // MARK: Top-ups

    @ViewBuilder
    private func topUpSection(_ model: NativeBillingExtrasModel) -> some View {
        if let credits = model.credits, !credits.isHidden {
            Section {
                DesktopSettingRow(
                    title: "Credit",
                    description: credits.availableEur > 0
                        ? credits.nextExpiry.map { "Next expiry \($0.formatted(.dateTime.month(.abbreviated).day().year()))" }
                        : "None yet."
                ) {
                    Text(NativeBillingFormat.eur(credits.availableEur))
                        .monospacedDigit()
                }
                if credits.canBuy {
                    ForEach(credits.packs) { pack in
                        DesktopSettingRow(
                            title: "\(NativeBillingFormat.eur(NativeBillingFormat.withVat(pack.htEur))) incl. VAT",
                            description: "Adds \(NativeBillingFormat.eur(pack.creditEur)) of usage"
                        ) {
                            DesktopOutlineButton(title: model.buyingPack == pack.id ? "Opening…" : "Add") { buy(pack, model: model) }
                                .disabled(model.buyingPack != nil)
                        }
                    }
                } else if credits.plan.uppercased() == "FREE", !credits.packs.isEmpty {
                    DesktopSettingRow(title: "Top-ups extend a paid plan.") {
                        DesktopOutlineButton(title: "See Plans") { presenter.present(in: .settings) }
                    }
                }
            } header: {
                DesktopSettingsGroupHeader(
                    title: "Top-ups",
                    note: "Extra usage for a month that runs short. It’s used only once your plan’s budget is spent, and lasts twelve months."
                )
            }
        }
    }

    private func buy(_ pack: NativeTopUpCredits.Pack, model: NativeBillingExtrasModel) {
        Task {
            do {
                NSWorkspace.shared.open(try await model.checkout(pack: pack.id))
            } catch {
                context.toasts.post(.error("Couldn’t start the top-up.", detail: (error as? NativeWebRouteError)?.message))
            }
        }
    }

    // MARK: Invite a friend

    @ViewBuilder
    private func referralSection(_ model: NativeBillingExtrasModel) -> some View {
        if let referrals = model.referrals {
            Section {
                DesktopSettingRow(title: "Your link") {
                    HStack(spacing: JunoSpace.snug) {
                        Text(referrals.link)
                            .font(.callout.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                        DesktopOutlineButton(title: copied ? "Copied" : "Copy") { copy(referrals.link) }
                    }
                }
                DesktopSettingRow(title: "Rewards", description: referrals.rewardsSentence) {
                    Text("\(Text("\(referrals.rewarded) "))\(Text("of \(referrals.maxRewards)").foregroundStyle(.secondary))")
                        .monospacedDigit()
                }
            } header: {
                DesktopSettingsGroupHeader(
                    title: "Invite a friend",
                    note: "When someone you invite starts a paid plan, you each get \(NativeBillingFormat.eur(referrals.rewardEur)) of usage."
                )
            }
        }
    }

    private func copy(_ link: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(link, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }
}

/// "Cancel your subscription" (Code de la consommation L215-1-1, D215-1 to
/// D215-3): the recap to check, what happens next, then ONE button that
/// notifies the cancellation. The confirmation goes out by email.
struct DesktopCancelSubscriptionSheet: View {
    let model: NativeBillingExtrasModel
    let recap: NativeCancellationState.Recap
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Cancel your subscription")
                    .font(.title3.weight(.semibold))
                Text("Check the details below, then notify the cancellation.")
                    .foregroundStyle(.secondary)
            }
            if model.cancellationReceived {
                Text(recap.email.map { "Cancellation received. A confirmation is on its way to \($0)." } ?? "Cancellation received.")
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.updatesFrequently)
                HStack {
                    Spacer()
                    Button("Done") { dismiss() }
                        .contentShape(.rect)
                        .keyboardShortcut(.defaultAction)
                }
            } else {
                Grid(alignment: .leading, horizontalSpacing: JunoSpace.regular, verticalSpacing: JunoSpace.tight) {
                    recapRow("Name", recap.name ?? "—")
                    recapRow("Email", recap.email ?? "—")
                    recapRow("Plan", recap.planName)
                    recapRow("Reference", recap.reference, monospaced: true)
                    recapRow("Ends on", recap.endsAtDate?.formatted(.dateTime.month(.wide).day().year()) ?? "The end of the current period")
                }
                Text("You keep your plan until then and won’t be charged again. After that your account moves to Free, and your conversations and files stay. You can undo this until it takes effect.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Want it to end sooner, with a refund for the days you won’t use? Write to support instead.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let error = model.cancellationError {
                    Label(error, image: JunoIcon.warning.assetName)
                        .foregroundStyle(Color.junoDestructiveInk)
                }
                HStack(spacing: JunoSpace.snug) {
                    Spacer()
                    Button("Keep Subscription") { dismiss() }
                        .contentShape(.rect)
                        .keyboardShortcut(.cancelAction)
                        .disabled(model.sendingCancellation)
                    Button(role: .destructive) {
                        Task { await model.setCancellation(.cancel) }
                    } label: {
                        if model.sendingCancellation {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Notify Cancellation")
                        }
                    }
                    .contentShape(.rect)
                    .disabled(model.sendingCancellation)
                    .accessibilityIdentifier("juno.desktop.settings.notify-cancellation")
                }
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 440)
        .interactiveDismissDisabled(model.sendingCancellation)
    }

    private func recapRow(_ label: String, _ value: String, monospaced: Bool = false) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value)
                .font(monospaced ? .callout.monospaced() : .body)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
    }
}
