import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// `Lead + 3 ⌄` / `Best of 3 ⌄`: on the composer only while the run is not
/// solo (TARGET §8.3). Opens the team popover (⇧⌘O).
struct CodeV2OrchestrateControl: View {
    let directory: CodeV2ProviderDirectory
    @Binding var draft: CodeV2RoleDraft
    var isEnabled = true

    @State private var isOpen = false

    var body: some View {
        Button { isOpen.toggle() } label: {
            CodeV2TextControlLabel(title: draft.label)
                .contentTransition(.numericText())
        }
        .buttonStyle(CodeV2FooterButtonStyle(isOpen: isOpen)).contentShape(.rect)
        .fixedSize()
        .disabled(!isEnabled)
        .keyboardShortcut("o", modifiers: [.command, .shift])
        .help("Who leads, who works, who reviews (⇧⌘O)")
        .accessibilityLabel("Team")
        .accessibilityValue(draft.label)
        .accessibilityIdentifier("juno.code.v2.orchestrate")
        .popover(isPresented: $isOpen, arrowEdge: .top) {
            CodeV2OrchestratePicker(directory: directory, draft: $draft)
        }
    }
}

/// The team popover (TARGET §8.3): one line per role, each pushing the model
/// picker in place; a one-line budget footer. Best of N lists its candidates
/// the same way. Role explanations live in Settings, not here.
struct CodeV2OrchestratePicker: View {
    let directory: CodeV2ProviderDirectory
    @Binding var draft: CodeV2RoleDraft

    private enum Role: Hashable {
        case lead, workers, reviewer, explorer, candidate(Int)
    }

    @State private var editing: Role?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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

    var body: some View {
        Group {
            if let editing {
                rolePicker(editing)
            } else {
                overview
            }
        }
        .frame(width: 380)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: editing)
    }

    // MARK: Overview

    private var overview: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(spacing: 0) {
                switch draft.preset {
                case .solo, .leadWorkers, .planBuildVerify:
                    roleRow("Lead", selection: draft.lead) { editing = .lead }
                    roleRow("Workers", selection: draft.worker, count: draft.workerCount) { editing = .workers }
                    roleRow("Reviewer", selection: draft.reviewer) { editing = .reviewer }
                    roleRow("Explorer", selection: draft.explorer) { editing = .explorer }
                case .bestOfN:
                    ForEach(draft.candidates.indices, id: \.self) { index in
                        roleRow(String(UnicodeScalar(UInt8(65 + index))), selection: draft.candidates[index]) {
                            editing = .candidate(index)
                        }
                    }
                    if draft.candidates.count < CodeV2RoleDraft.candidateRange.upperBound {
                        Button { draft.setCandidateCount(draft.candidates.count + 1) } label: {
                            CodeV2RowFace(height: 32) {
                                HStack(spacing: JunoSpace.snug) {
                                    JunoIconView(.plus, size: 13)
                                    Text("Add candidate")
                                    Spacer(minLength: 0)
                                }
                                .studioType(.text)
                                .foregroundStyle(Studio.Ink.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(JunoSpace.tight + 2)
            Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
            footer
        }
    }

    private func roleRow(_ role: String, selection: CodeV2.ModelSelection?, count: Int? = nil, open: @escaping () -> Void) -> some View {
        CodeV2RoleRow(
            role: role,
            model: selection.map { modelLine($0, count: count) },
            source: selection.map(sourceLine),
            stepper: count.map { value in
                (value: value, range: CodeV2RoleDraft.workerRange, set: { draft.setWorkers($0) })
            },
            open: open
        )
    }

    private func modelLine(_ selection: CodeV2.ModelSelection, count: Int?) -> String {
        let model = directory.instance(selection.instanceId)?.models?.first { $0.id == selection.model }
        let name = model?.label ?? CodeV2Formatting.modelName(selection.model)
        let effort = selection.effort.map { " · " + $0.title } ?? ""
        return (count.map { "\($0) × " } ?? "") + name + effort
    }

    private func sourceLine(_ selection: CodeV2.ModelSelection) -> String {
        guard let instance = directory.instance(selection.instanceId) else { return "" }
        switch instance.kind {
        case .alevr:
            if let tier = tier(selection), tier.inputPerMTok > 0 {
                return CodeV2ContextMath.dollars(tier.inputPerMTok).replacingOccurrences(of: ".00", with: "")
                    + " / " + CodeV2ContextMath.dollars(tier.outputPerMTok).replacingOccurrences(of: ".00", with: "")
            }
            return "Alevr"
        case .byok: return "Your key"
        case .claudeAgent: return "Your plan"
        default: return CodeV2ProviderDirectory.vendorName(instance)
        }
    }

    private var footer: some View {
        HStack(spacing: JunoSpace.snug) {
            Menu {
                ForEach([1.0, 2, 4, 8, 16], id: \.self) { value in
                    Button(CodeV2ContextMath.dollars(value)) { draft.budgetUsd = value }
                }
                Divider()
                Button("No Limit") { draft.budgetUsd = nil }
            } label: {
                CodeV2TextControlLabel(
                    title: draft.budgetUsd.map { "Stop at \(CodeV2ContextMath.dollars($0)) of Alevr spend" } ?? "No spend limit"
                )
            }
            .menuStyle(.button).menuIndicator(.hidden)
            .buttonStyle(CodeV2FooterButtonStyle(compact: true)).fixedSize()
            .help("A hard stop for the run's Alevr spend. Subscriptions count against their own plans.")
                .contentShape(.rect)
            Spacer(minLength: 0)
            Text("\(CodeV2ContextMath.estimate(estimate)) a run")
                .studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary)
        }
        .padding(.horizontal, JunoSpace.snug)
        .frame(height: 40)
    }

    // MARK: A role's model

    private func rolePicker(_ role: Role) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                Button { editing = nil } label: {
                    CodeV2RowFace(height: 28, horizontal: 0) {
                        HStack(spacing: JunoSpace.tight) {
                            JunoIconView(.chevronLeft, size: 12)
                            Text(title(role))
                        }
                        .studioType(.textMedium)
                        .foregroundStyle(Studio.Ink.primary)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back to the team")
                Spacer(minLength: 0)
                if removable(role) {
                    Button("Remove") { set(role, nil); editing = nil }
                        .buttonStyle(StudioQuietButtonStyle())
                        .contentShape(.rect)
                }
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 40)
            Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
            CodeV2ModelPicker(
                directory: directory,
                selection: Binding(get: { current(role) ?? draft.lead }, set: { set(role, $0) }),
                choose: { id, model in
                    let previous = current(role)
                    let effort = previous?.effort.flatMap { (model.effortLevels ?? []).contains($0) ? $0 : nil } ?? model.defaultEffort
                    set(role, CodeV2.ModelSelection(
                        instanceId: id, model: model.id, effort: effort,
                        contextTokens: model.contextTiers.flatMap { CodeV2ContextMath.sorted($0).first?.tokens }
                    ))
                    editing = nil
                },
                showsFooter: false
            )
        }
    }

    private func title(_ role: Role) -> String {
        switch role {
        case .lead: "Lead"
        case .workers: "Workers"
        case .reviewer: "Reviewer"
        case .explorer: "Explorer"
        case .candidate(let index): "Candidate \(String(UnicodeScalar(UInt8(65 + index))))"
        }
    }

    private func removable(_ role: Role) -> Bool {
        switch role {
        case .reviewer: draft.reviewer != nil
        case .explorer: draft.explorer != nil
        case .candidate: draft.candidates.count > CodeV2RoleDraft.candidateRange.lowerBound
        default: false
        }
    }

    private func current(_ role: Role) -> CodeV2.ModelSelection? {
        switch role {
        case .lead: draft.lead
        case .workers: draft.worker
        case .reviewer: draft.reviewer
        case .explorer: draft.explorer
        case .candidate(let index): draft.candidates.indices.contains(index) ? draft.candidates[index] : nil
        }
    }

    private func set(_ role: Role, _ selection: CodeV2.ModelSelection?) {
        switch role {
        case .lead: if let selection { draft.setLead(selection) }
        case .workers: if let selection { draft.worker = selection }
        case .reviewer: draft.reviewer = selection
        case .explorer: draft.explorer = selection
        case .candidate(let index):
            if let selection { draft.candidates[index] = selection } else { draft.candidates.remove(at: index) }
        }
    }
}

/// One role on one line: the role in muted ink, its model in ink, where it
/// runs or what it costs, and a chevron. Workers show a stepper on hover.
struct CodeV2RoleRow: View {
    let role: String
    let model: String?
    let source: String?
    var stepper: (value: Int, range: ClosedRange<Int>, set: (Int) -> Void)?
    let open: () -> Void

    @State private var hovering = false

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Button(action: open) {
                HStack(spacing: JunoSpace.snug) {
                    Text(role).foregroundStyle(Studio.Ink.secondary).frame(width: 72, alignment: .leading)
                    Text(model ?? "Add").foregroundStyle(model == nil ? Studio.Ink.secondary : Studio.Ink.primary).lineLimit(1)
                    Spacer(minLength: JunoSpace.tight)
                }
                .studioType(.text)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if let stepper, hovering {
                CodeV2Stepper(value: stepper.value, range: stepper.range, set: stepper.set)
            } else if let source {
                Text(source).studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary).lineLimit(1)
            }
            JunoIconView(.chevronRight, size: 11).foregroundStyle(Studio.Ink.tertiary)
        }
        .padding(.horizontal, JunoSpace.snug)
        .frame(height: 32)
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                .fill(hovering ? Studio.Surface.hover : Color.clear)
        )
        .onHover { hovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(role), \(model ?? "none")")
    }
}

/// "− 3 +": a plain stepper for counts.
struct CodeV2Stepper: View {
    let value: Int
    let range: ClosedRange<Int>
    let set: (Int) -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button { set(value - 1) } label: { JunoIconView(.minus, size: 11) }
                .buttonStyle(StudioIconButtonStyle()).contentShape(.rect).disabled(value <= range.lowerBound).accessibilityLabel("Fewer")
            Text("\(value)").studioType(.small).monospacedDigit().frame(minWidth: 14)
            Button { set(value + 1) } label: { JunoIconView(.plus, size: 11) }
                .buttonStyle(StudioIconButtonStyle()).contentShape(.rect).disabled(value >= range.upperBound).accessibilityLabel("More")
        }
        .foregroundStyle(Studio.Ink.secondary)
    }
}
