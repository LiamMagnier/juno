import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The composer's Orchestrate control: "Solo", "Lead + 3", "Best of 3".
/// Opens the role picker (⇧⌘O).
struct CodeV2OrchestrateControl: View {
    let directory: CodeV2ProviderDirectory
    @Binding var draft: CodeV2RoleDraft
    var isEnabled = true

    @State private var isOpen = false

    var body: some View {
        Button { isOpen.toggle() } label: {
            HStack(spacing: JunoSpace.tight + 1) {
                JunoIconView(.workflow, size: 14)
                Text(draft.label).lineLimit(1).contentTransition(.numericText())
                JunoIconView(.chevronDown, size: 11)
            }
        }
        .buttonStyle(CodeV2FooterButtonStyle(isOpen: isOpen)).contentShape(.rect)
        .disabled(!isEnabled)
        .keyboardShortcut("o", modifiers: [.command, .shift])
        .help("Orchestrate: who leads, who works, who reviews (⇧⌘O)")
        .accessibilityLabel("Orchestrate")
        .accessibilityValue(draft.label)
        .accessibilityIdentifier("juno.code.v2.orchestrate")
        .popover(isPresented: $isOpen, arrowEdge: .top) {
            CodeV2OrchestratePicker(directory: directory, draft: $draft)
        }
    }
}

/// The role picker (DESIGN §5.11): a preset, one sentence on what it means,
/// a row per role with its own model, and the run's hard budget with an
/// honest estimate.
struct CodeV2OrchestratePicker: View {
    let directory: CodeV2ProviderDirectory
    @Binding var draft: CodeV2RoleDraft
    @State private var showsUtility = false
    @State private var budgetText = ""

    private func tier(_ selection: CodeV2.ModelSelection) -> CodeV2.ContextTier? {
        directory.instance(selection.instanceId)?.models?.first { $0.id == selection.model }?.contextTiers
            .flatMap { CodeV2ContextMath.sorted($0).first }
    }

    private func billsInDollars(_ selection: CodeV2.ModelSelection) -> Bool {
        CodeV2.instanceKind(of: selection.instanceId).map(CodeV2ProviderDirectory.billsInDollars) ?? true
    }

    private var estimate: Double {
        CodeV2RunEstimate.dollars(for: draft, rate: tier, billsInDollars: billsInDollars)
    }

    private var subscriptionNote: String? {
        let vendors = draft.allSelections.filter { !billsInDollars($0) }
            .compactMap { directory.instance($0.instanceId) }
            .map(CodeV2ProviderDirectory.vendorName)
        return CodeV2RunEstimate.subscriptionNote(vendorNames: vendors)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Orchestrate").font(Studio.Font.labelEmphasis)
                Spacer()
                JunoSegmented(
                    options: [
                        JunoSegmentedOption(CodeV2.RolePreset.solo, "Solo"),
                        JunoSegmentedOption(CodeV2.RolePreset.leadWorkers, "Lead + workers"),
                        JunoSegmentedOption(CodeV2.RolePreset.bestOfN, "Best of N"),
                    ],
                    selection: $draft.preset,
                    accessibilityLabel: "Preset",
                    size: .compact
                )
                .fixedSize()
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.top, JunoSpace.cozy)

            Text(draft.explanation)
                .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.top, JunoSpace.snug)
                .padding(.bottom, JunoSpace.cozy)

            Divider().overlay(Studio.Surface.hairline)

            VStack(spacing: 0) {
                switch draft.preset {
                case .solo:
                    roleRow("Lead", duty: "Plans and does the work", selection: $draft.lead)
                case .leadWorkers:
                    roleRow("Lead", duty: "Plans, delegates and merges", selection: $draft.lead)
                    roleRow("Workers", duty: "Each takes one part of the plan", selection: $draft.worker,
                            stepper: (value: draft.workerCount, range: CodeV2RoleDraft.workerRange, set: { draft.setWorkers($0) }))
                    optionalRow("Reviewer", duty: "Reads every diff before you do", selection: $draft.reviewer)
                    optionalRow("Explorer", duty: "Maps the code before work starts", selection: $draft.explorer)
                case .bestOfN:
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Candidates").font(Studio.Font.label)
                            Text("The same model several times, or different ones side by side.")
                                .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                        }
                        Spacer()
                        CodeV2Stepper(value: draft.candidates.count, range: CodeV2RoleDraft.candidateRange) { draft.setCandidateCount($0) }
                    }
                    .padding(.horizontal, JunoSpace.cozy)
                    .frame(minHeight: 52)
                    ForEach(draft.candidates.indices, id: \.self) { index in
                        roleRow("Candidate \(index + 1)", duty: nil, selection: $draft.candidates[index])
                    }
                }
                DisclosureGroup(isExpanded: $showsUtility) {
                    optionalRow("Titles and compaction", duty: "Small jobs that keep the thread tidy", selection: $draft.utility)
                } label: {
                    Text("Titles and compaction").font(Studio.Font.label).foregroundStyle(Studio.Ink.secondary)
                }
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
            }

            Divider().overlay(Studio.Surface.hairline)

            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                HStack(spacing: JunoSpace.snug) {
                    Text("Stop at").font(Studio.Font.label)
                    TextField("$4.00", text: $budgetText)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 72)
                        .monospacedDigit()
                        .onSubmit(commitBudget)
                        .accessibilityLabel("Budget per run in dollars")
                    Text("of Alevr spend per run").font(Studio.Font.label)
                    Spacer()
                    Text(CodeV2ContextMath.estimate(estimate) + " a run · estimate")
                        .font(Studio.Font.metaDigits).foregroundStyle(Studio.Ink.secondary)
                }
                if let subscriptionNote {
                    Text(subscriptionNote).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                }
            }
            .padding(JunoSpace.cozy)
        }
        .frame(width: 600)
        .background(Studio.Surface.popover)
        .onAppear { budgetText = draft.budgetUsd.map { String(format: "$%.2f", $0) } ?? "" }
        .onDisappear(perform: commitBudget)
    }

    private func commitBudget() {
        let digits = budgetText.replacingOccurrences(of: "$", with: "").trimmingCharacters(in: .whitespaces)
        draft.budgetUsd = digits.isEmpty ? nil : Double(digits).map { max(0, $0) } ?? draft.budgetUsd
    }

    private func roleRow(
        _ name: String, duty: String?, selection: Binding<CodeV2.ModelSelection>,
        stepper: (value: Int, range: ClosedRange<Int>, set: (Int) -> Void)? = nil
    ) -> some View {
        HStack(spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(Studio.Font.label)
                if let duty { Text(duty).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary) }
            }
            Spacer()
            if let stepper {
                CodeV2Stepper(value: stepper.value, range: stepper.range, set: stepper.set)
            }
            CodeV2RoleModelButton(directory: directory, selection: selection)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(minHeight: 52)
    }

    private func optionalRow(_ name: String, duty: String, selection: Binding<CodeV2.ModelSelection?>) -> some View {
        Group {
            if selection.wrappedValue != nil {
                roleRow(name, duty: duty, selection: Binding(
                    get: { selection.wrappedValue ?? draft.lead },
                    set: { selection.wrappedValue = $0 }
                ))
            } else {
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(name).font(Studio.Font.label)
                        Text(duty).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                    }
                    Spacer()
                    Button("Add") { selection.wrappedValue = draft.lead }
                        .buttonStyle(CodeV2OutlineButtonStyle(compact: true)).contentShape(.rect)
                }
                .padding(.horizontal, JunoSpace.cozy)
                .frame(minHeight: 52)
            }
        }
    }
}

/// "− 3 +": a plain stepper for counts.
struct CodeV2Stepper: View {
    let value: Int
    let range: ClosedRange<Int>
    let set: (Int) -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button { set(value - 1) } label: { JunoIconView(.minus, size: 12).frame(width: 28, height: 28).contentShape(.rect) }
                .buttonStyle(.plain).disabled(value <= range.lowerBound).accessibilityLabel("Fewer")
            Text("\(value)").font(Studio.Font.labelDigits).frame(minWidth: 18)
            Button { set(value + 1) } label: { JunoIconView(.plus, size: 12).frame(width: 28, height: 28).contentShape(.rect) }
                .buttonStyle(.plain).disabled(value >= range.upperBound).accessibilityLabel("More")
        }
        .foregroundStyle(Studio.Ink.secondary)
        .overlay(RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous).strokeBorder(Studio.Surface.hairline))
    }
}

/// A role's model (196 wide): mark, "Claude Opus 5.5 · High" over where it
/// runs and what it costs. Opens the same model picker.
struct CodeV2RoleModelButton: View {
    let directory: CodeV2ProviderDirectory
    @Binding var selection: CodeV2.ModelSelection
    @State private var isOpen = false

    private var instance: CodeV2.ProviderInstance? { directory.instance(selection.instanceId) }
    private var model: CodeV2.ProviderModel? { instance?.models?.first { $0.id == selection.model } }

    private var subline: String {
        guard let instance else { return "" }
        switch instance.kind {
        case .alevr, .byok:
            let where_ = instance.kind == .alevr ? "Alevr" : instance.label
            if let tier = model?.contextTiers.flatMap({ CodeV2ContextMath.sorted($0).first }), tier.inputPerMTok > 0 {
                return "\(where_) · \(CodeV2ContextMath.dollars(tier.inputPerMTok)) / \(CodeV2ContextMath.dollars(tier.outputPerMTok))"
            }
            return where_
        case .claudeAgent: return "Your subscription"
        default: return instance.label
        }
    }

    var body: some View {
        Button { isOpen.toggle() } label: {
            HStack(spacing: JunoSpace.snug) {
                CodeV2Mark(id: CodeV2Marks.markID(model: selection.model, instanceId: selection.instanceId), size: 16)
                VStack(alignment: .leading, spacing: 0) {
                    Text([model?.label ?? CodeV2Formatting.modelName(selection.model), selection.effort?.title]
                        .compactMap { $0 }.joined(separator: " · "))
                        .font(Studio.Font.label).foregroundStyle(Studio.Ink.primary).lineLimit(1)
                    Text(subline).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                JunoIconView(.chevronsUpDown, size: 11).foregroundStyle(Studio.Ink.tertiary)
            }
            .padding(.horizontal, JunoSpace.snug)
            .frame(width: 236, height: 42)
            .background(RoundedRectangle(cornerRadius: Studio.Radius.field, style: .continuous).fill(Studio.Surface.raised))
            .overlay(RoundedRectangle(cornerRadius: Studio.Radius.field, style: .continuous).strokeBorder(Studio.Surface.hairline))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .popover(isPresented: $isOpen, arrowEdge: .trailing) {
            CodeV2ModelPicker(directory: directory, selection: $selection, choose: { id, model in
                let effort = selection.effort.flatMap { (model.effortLevels ?? []).contains($0) ? $0 : nil } ?? model.defaultEffort
                selection = CodeV2.ModelSelection(
                    instanceId: id, model: model.id, effort: effort,
                    contextTokens: model.contextTiers.flatMap { CodeV2ContextMath.sorted($0).first?.tokens }
                )
                isOpen = false
            })
        }
    }
}
