import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The context window menu (TARGET §8.2): one row per tier, its size, what
/// the next turn costs and its rates on a second line; the thread's size and
/// the cached rate underneath. Subscriptions read "Included in your plan".
struct CodeV2TierSelector: View {
    let instance: CodeV2.ProviderInstance
    let model: CodeV2.ProviderModel
    @Binding var selection: CodeV2.ModelSelection
    @Binding var lean: Bool
    var threadTokens: Int = 0
    var done: () -> Void = {}

    @State private var pendingCompact: CodeV2TierChoice?

    private var billsInDollars: Bool { CodeV2ProviderDirectory.billsInDollars(instance.kind) }
    private var tiers: [CodeV2.ContextTier] { CodeV2ContextMath.sorted(model.contextTiers ?? []) }
    private var choices: [CodeV2TierChoice] {
        CodeV2TierChoice.choices(tiers: tiers, threadTokens: threadTokens, billsInDollars: billsInDollars)
    }

    private func isChosen(_ choice: CodeV2TierChoice) -> Bool {
        if choice.kind == .lean { return lean }
        return !lean && (selection.contextTokens ?? tiers.first?.tokens) == choice.windowTokens
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(spacing: 0) {
                ForEach(choices) { choice in
                    CodeV2TierRow(
                        choice: choice, isChosen: isChosen(choice), billsInDollars: billsInDollars,
                        planLine: billsInDollars ? nil : "Included in your \(CodeV2ProviderDirectory.vendorName(instance)) plan",
                        action: { pick(choice) }
                    )
                }
            }
            .padding(JunoSpace.tight + 2)
            Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
            footer
                .padding(.horizontal, JunoSpace.cozy)
                .frame(minHeight: 36)
        }
        .frame(width: 360)
    }

    @ViewBuilder
    private var footer: some View {
        if let pendingCompact {
            HStack(spacing: JunoSpace.snug) {
                Text("Switching compacts this thread first.")
                    .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                Spacer(minLength: 0)
                Button("Compact and Switch") { apply(pendingCompact) }
                    .buttonStyle(.bordered).controlSize(.small)
            }
            .padding(.vertical, JunoSpace.snug)
        } else {
            HStack(spacing: JunoSpace.snug) {
                Text("This thread uses \(CodeV2ContextMath.compactCount(threadTokens)).")
                    .studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary)
                Spacer(minLength: 0)
                if billsInDollars, let base = tiers.first {
                    Text("Cached input \(CodeV2ContextMath.dollars(base.cachedInputPerMTok ?? base.inputPerMTok)) per million")
                        .studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary)
                }
            }
        }
    }

    private func pick(_ choice: CodeV2TierChoice) {
        if choice.compactsNow, threadTokens > 0, !isChosen(choice) {
            pendingCompact = choice
            return
        }
        apply(choice)
    }

    private func apply(_ choice: CodeV2TierChoice) {
        lean = choice.kind == .lean
        selection.contextTokens = choice.kind == .lean ? choice.tier.tokens : choice.windowTokens
        pendingCompact = nil
        done()
    }
}

/// One tier: "Standard  272K" and "≈ $0.39 next turn" over its rates. A
/// tier that would compact says so on hover, in place of the rates.
struct CodeV2TierRow: View {
    let choice: CodeV2TierChoice
    let isChosen: Bool
    let billsInDollars: Bool
    var planLine: String?
    let action: () -> Void

    @State private var hovering = false

    private var secondLine: String {
        if hovering, choice.compactsNow, !isChosen {
            return "Compacts now to about \(CodeV2ContextMath.compactCount(choice.compactsAt / 2))"
        }
        return planLine ?? choice.priceLine
    }

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: JunoSpace.tight + 2) {
                        Text(choice.name).foregroundStyle(Studio.Ink.primary)
                        Text(CodeV2ContextMath.label(tokens: choice.windowTokens)).foregroundStyle(Studio.Ink.secondary)
                    }
                    .studioType(.text)
                    .monospacedDigit()
                    Text(secondLine)
                        .studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                }
                Spacer(minLength: JunoSpace.snug)
                if billsInDollars, let estimate = choice.nextTurnEstimate {
                    Text("\(CodeV2ContextMath.estimate(estimate)) next turn")
                        .studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary)
                }
                JunoIconView(.check, size: 13)
                    .foregroundStyle(Studio.Ink.primary)
                    .opacity(isChosen ? 1 : 0)
            }
            .padding(.horizontal, JunoSpace.snug)
            .frame(height: 44)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                    .fill(hovering ? Studio.Surface.hover : Color.clear)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityAddTraits(isChosen ? .isSelected : [])
    }
}
