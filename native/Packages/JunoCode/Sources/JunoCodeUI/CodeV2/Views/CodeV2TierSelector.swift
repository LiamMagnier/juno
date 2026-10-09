import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The Traits control (DESIGN §5.9): "High · 1M" — effort and context tier in
/// one text button, plus "· Fast" when a speed variant is on. A menu of
/// effort and speed, and "Context window…" for the tier selector. ⇧⌘E
/// cycles effort without opening anything.
struct CodeV2TraitsControl: View {
    let instance: CodeV2.ProviderInstance?
    let model: CodeV2.ProviderModel?
    @Binding var selection: CodeV2.ModelSelection
    @Binding var lean: Bool
    var threadTokens: Int = 0
    var isEnabled = true

    @State private var showsTiers = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var levels: [CodeV2.EffortLevel] { model?.effortLevels ?? [] }

    var body: some View {
        Menu {
            if !levels.isEmpty {
                Picker("Effort", selection: Binding(get: { selection.effort ?? levels.first! }, set: { selection.effort = $0 })) {
                    ForEach(levels, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.inline)
            }
            if model?.supportsFast == true {
                Picker("Speed", selection: Binding(get: { selection.fast == true }, set: { selection.fast = $0 })) {
                    Text("Standard").tag(false)
                    Text("Fast  (2× price)").tag(true)
                }
                .pickerStyle(.inline)
            }
            if model?.contextTiers?.isEmpty == false {
                Divider()
                Button("Context window…") { showsTiers = true }
                    .keyboardShortcut("w", modifiers: [.command, .shift])
            }
        } label: {
            HStack(spacing: JunoSpace.tight) {
                Text(CodeV2Traits.label(effort: selection.effort, contextTokens: selection.contextTokens, fast: selection.fast == true, lean: lean))
                    .contentTransition(.numericText())
                    .lineLimit(1)
                JunoIconView(.chevronDown, size: 11)
            }
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(CodeV2FooterButtonStyle(isOpen: showsTiers)).contentShape(.rect)
        .fixedSize()
        .disabled(!isEnabled)
        .help("Effort, speed and context window (⇧⌘E cycles effort)")
        .accessibilityLabel("Traits")
        .accessibilityIdentifier("juno.code.v2.traits")
        .background {
            // ⇧⌘E cycles effort in place; the label animates instead of a toast.
            Button("") {
                withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                    selection.effort = CodeV2.EffortLevel.cycled(from: selection.effort, in: levels)
                }
            }
            .keyboardShortcut("e", modifiers: [.command, .shift])
            .hidden()
        }
        .popover(isPresented: $showsTiers, arrowEdge: .top) {
            if let instance, let model {
                CodeV2TierSelector(
                    instance: instance, model: model, selection: $selection, lean: $lean,
                    threadTokens: threadTokens, done: { showsTiers = false }
                )
            }
        }
    }
}

/// The context-window selector (DESIGN §5.10): a ruler of the model's
/// windows with this thread's size on it, then one row per tier with its
/// price, its delta against the default and what the next turn costs.
/// Subscriptions show their plan window instead of dollars.
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
            HStack(spacing: JunoSpace.snug) {
                CodeV2Mark(id: CodeV2Marks.markID(model: model.id, instanceId: instance.id), size: 16)
                Text("Context window").font(Studio.Font.labelEmphasis)
                Text("\(model.label) on \(instance.kind == .alevr ? "Alevr" : CodeV2ProviderDirectory.vendorName(instance))")
                    .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.top, JunoSpace.cozy)

            CodeV2TierRuler(tiers: tiers, threadTokens: threadTokens)
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.cozy)

            Divider().overlay(Studio.Surface.hairline)

            VStack(spacing: 0) {
                ForEach(choices) { choice in
                    CodeV2TierRow(
                        choice: choice, isChosen: isChosen(choice), billsInDollars: billsInDollars,
                        planLine: billsInDollars ? nil : planLine,
                        action: { pick(choice) }
                    )
                }
            }
            .padding(.vertical, JunoSpace.tight)

            Divider().overlay(Studio.Surface.hairline)
            footer
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
        }
        .frame(width: 440)
        .background(Studio.Surface.popover)
    }

    private var planLine: String {
        let plan = instance.account?.plan.map { CodeV2ProviderDirectory.planName($0) + " plan" } ?? "Your plan"
        if let summary = CodeV2ProviderDirectory.windowSummary(instance) {
            return "Uses your plan · \(plan) · \(summary)"
        }
        return "Uses your plan · \(plan)"
    }

    @ViewBuilder
    private var footer: some View {
        if let pendingCompact {
            HStack {
                Text("This thread is \(CodeV2ContextMath.compactCount(threadTokens)). Switching compacts it first.")
                    .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                Spacer()
                Button("Compact and switch") { apply(pendingCompact) }
                    .buttonStyle(CodeV2OutlineButtonStyle(compact: true)).contentShape(.rect)
            }
        } else if billsInDollars, let base = tiers.first {
            let cachedRate = base.cachedInputPerMTok ?? base.inputPerMTok
            let cached = CodeV2ContextMath.estimateCost(threadTokens: min(threadTokens, base.tokens), tier: base, cachedInputTokens: threadTokens)
            Text("Cached input \(CodeV2ContextMath.dollars(cachedRate)) per million"
                 + (cached.map { ". A cached turn now: \(CodeV2ContextMath.estimate($0))." } ?? "."))
                .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
        } else {
            Text("Counts against your \(CodeV2ProviderDirectory.vendorName(instance)) plan, not Alevr.")
                .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
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

/// The selector's signature: a hairline track to the largest window, a tick
/// at every tier, and a 3pt ink bar at this thread's size.
struct CodeV2TierRuler: View {
    let tiers: [CodeV2.ContextTier]
    let threadTokens: Int

    var body: some View {
        let maxTokens = max(1, tiers.last?.tokens ?? 1)
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text("This thread · \(CodeV2ContextMath.compactCount(threadTokens))")
                .font(Studio.Font.metaDigits).foregroundStyle(Studio.Ink.secondary)
            GeometryReader { proxy in
                let width = proxy.size.width
                ZStack(alignment: .topLeading) {
                    Rectangle().fill(Studio.Surface.hairline).frame(height: 1).offset(y: 6)
                    Capsule().fill(Studio.Ink.primary)
                        .frame(width: max(3, width * min(1, Double(threadTokens) / Double(maxTokens))), height: 3)
                        .offset(y: 5)
                    ForEach(tiers, id: \.tokens) { tier in
                        let x = width * Double(tier.tokens) / Double(maxTokens)
                        Rectangle().fill(Studio.Ink.tertiary).frame(width: 1, height: 9)
                            .offset(x: min(width - 1, x), y: 2)
                        Text(CodeV2ContextMath.label(tokens: tier.tokens))
                            .junoFont(size: 11, relativeTo: .caption2)
                            .monospacedDigit()
                            .foregroundStyle(Studio.Ink.secondary)
                            .fixedSize()
                            .offset(x: min(width - 28, max(0, x - 14)), y: 14)
                    }
                }
            }
            .frame(height: 30)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("This thread uses \(CodeV2ContextMath.compactCount(threadTokens)) tokens")
    }
}

struct CodeV2TierRow: View {
    let choice: CodeV2TierChoice
    let isChosen: Bool
    let billsInDollars: Bool
    var planLine: String?
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                Group {
                    if isChosen { JunoIconView(.check, size: 14).foregroundStyle(Studio.Ink.primary) } else { Color.clear }
                }
                .frame(width: 16, height: 20)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: JunoSpace.tight) {
                        Text(choice.name).font(isChosen ? Studio.Font.labelEmphasis : Studio.Font.label)
                        Text(CodeV2ContextMath.label(tokens: choice.windowTokens))
                            .font(Studio.Font.labelDigits).foregroundStyle(Studio.Ink.secondary)
                    }
                    Text(planLine ?? choice.priceLine)
                        .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                    if let delta = choice.compactsNow && !isChosen
                        ? "Compacts now to about \(CodeV2ContextMath.compactCount(choice.compactsAt / 2))."
                        : choice.deltaLine
                    {
                        Text(delta).font(Studio.Font.meta).foregroundStyle(Studio.Ink.tertiary)
                    }
                }
                Spacer(minLength: JunoSpace.snug)
                if billsInDollars, let estimate = choice.nextTurnEstimate {
                    Text("\(CodeV2ContextMath.estimate(estimate)) next turn")
                        .font(Studio.Font.metaDigits).foregroundStyle(Studio.Ink.secondary)
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.snug)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                    .fill(hovering ? Studio.Surface.hover : Color.clear)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, JunoSpace.tight)
        .onHover { hovering = $0 }
        .accessibilityAddTraits(isChosen ? .isSelected : [])
    }
}
