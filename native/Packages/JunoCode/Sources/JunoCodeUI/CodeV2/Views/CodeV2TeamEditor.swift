import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The Team role editor (team lane): a preset at the top (Solo, Plan → Build
/// → Verify, Best of N), then one row per role with its own model and effort
/// on the slider-first picker Chat and the composer use, the builders'
/// count, and a budget cap at the foot. Shown in the chip's popover, which
/// macOS draws in Liquid Glass.
struct CodeV2TeamEditor: View {
    let directory: CodeV2ProviderDirectory
    @Binding var draft: CodeV2RoleDraft
    /// The composer's model: the lead, who runs the phases and writes the summary.
    let lead: CodeV2.ModelSelection

    static let width: CGFloat = 480

    private var preset: Binding<CodeV2Team.Preset> {
        Binding(get: { draft.teamPreset }, set: { choice in
            var next = draft
            next.lead = lead
            next.applyTeamPreset(choice)
            draft = next
        })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
            VStack(alignment: .leading, spacing: 2) {
                switch draft.teamPreset {
                case .solo: solo
                case .planBuildVerify: team
                case .bestOfN: candidates
                }
            }
            .padding(JunoSpace.tight + 2)
            if draft.teamPreset != .solo {
                Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
                footer
            }
        }
        .frame(width: Self.width)
        .accessibilityIdentifier("juno.code.v2.team.editor")
    }

    // MARK: Header: the preset

    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight + 2) {
            Picker("Team", selection: preset) {
                ForEach(CodeV2Team.Preset.allCases, id: \.self) { choice in
                    Text(choice.title).tag(choice)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityLabel("Team preset")
            Text(draft.teamPreset.line)
                .studioType(.small)
                .foregroundStyle(Studio.Ink.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(JunoSpace.cozy)
    }

    // MARK: Solo

    private var solo: some View {
        HStack(spacing: JunoSpace.snug) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Lead").studioType(.textMedium).foregroundStyle(Studio.Ink.primary)
                Text("Plans, builds and checks on the composer's model").studioType(.small).foregroundStyle(Studio.Ink.secondary)
            }
            Spacer(minLength: JunoSpace.snug)
            CodeV2TeamModelLabel(directory: directory, selection: lead)
        }
        .padding(.horizontal, JunoSpace.snug)
        .frame(minHeight: 44)
    }

    // MARK: Plan → Build → Verify

    @ViewBuilder private var team: some View {
        CodeV2TeamRoleRow(
            role: .architect, directory: directory,
            selection: binding(for: .architect)
        )
        CodeV2TeamRoleRow(
            role: .builder, directory: directory,
            selection: binding(for: .builder),
            count: (value: draft.workerCount, range: CodeV2RoleDraft.workerRange, set: { draft.setWorkers($0) })
        )
        CodeV2TeamRoleRow(
            role: .verifier, directory: directory,
            selection: binding(for: .verifier)
        )
        if draft.explorer != nil {
            CodeV2TeamRoleRow(
                role: .explorer, directory: directory,
                selection: binding(for: .explorer),
                remove: { draft.setSelection(nil, for: .explorer) }
            )
        } else {
            Button { draft.setSelection(lead, for: .explorer) } label: {
                CodeV2RowFace(height: 32) {
                    HStack(spacing: JunoSpace.snug) {
                        JunoIconView(.plus, size: 13)
                        Text("Add an explorer")
                        Text("maps the code first, read-only").foregroundStyle(Studio.Ink.tertiary)
                        Spacer(minLength: 0)
                    }
                    .studioType(.text)
                    .foregroundStyle(Studio.Ink.secondary)
                }
            }
            .buttonStyle(.plain)
            .contentShape(.rect)
            .accessibilityLabel("Add an explorer")
        }
    }

    private func binding(for role: CodeV2Team.Role) -> Binding<CodeV2.ModelSelection> {
        Binding(
            get: { draft.selection(for: role) ?? lead },
            set: { draft.setSelection($0, for: role) }
        )
    }

    // MARK: Best of N

    @ViewBuilder private var candidates: some View {
        ForEach(draft.candidates.indices, id: \.self) { index in
            CodeV2TeamCandidateRow(
                letter: String(UnicodeScalar(UInt8(65 + index))),
                directory: directory,
                selection: Binding(
                    get: { draft.candidates.indices.contains(index) ? draft.candidates[index] : lead },
                    set: { if draft.candidates.indices.contains(index) { draft.candidates[index] = $0 } }
                ),
                remove: draft.candidates.count > CodeV2RoleDraft.candidateRange.lowerBound
                    ? { draft.candidates.remove(at: index) } : nil
            )
        }
        if draft.candidates.count < CodeV2RoleDraft.candidateRange.upperBound {
            Button { draft.setCandidateCount(draft.candidates.count + 1) } label: {
                CodeV2RowFace(height: 32) {
                    HStack(spacing: JunoSpace.snug) {
                        JunoIconView(.plus, size: 13)
                        Text("Add a candidate")
                        Spacer(minLength: 0)
                    }
                    .studioType(.text)
                    .foregroundStyle(Studio.Ink.secondary)
                }
            }
            .buttonStyle(.plain)
            .contentShape(.rect)
        }
    }

    // MARK: Footer: the budget cap

    private func tier(_ selection: CodeV2.ModelSelection) -> CodeV2.ContextTier? {
        directory.instance(selection.instanceId)?.models?.first { $0.id == selection.model }?.contextTiers
            .flatMap { CodeV2ContextMath.sorted($0).first }
    }

    private var estimate: Double {
        CodeV2RunEstimate.dollars(for: draft, rate: tier, billsInDollars: { selection in
            CodeV2.instanceKind(of: selection.instanceId).map(CodeV2ProviderDirectory.billsInDollars) ?? true
        })
    }

    /// The run's Alevr estimate; plans and keys pay for themselves.
    private var costLine: String? {
        if estimate > 0 { return "\(CodeV2ContextMath.estimate(estimate)) a run" }
        let paid = draft.allSelections.allSatisfy { CodeV2.instanceKind(of: $0.instanceId).map(CodeV2ProviderDirectory.billsInDollars) == false }
        return paid ? "Billed to your plans" : nil
    }

    private var footer: some View {
        HStack(spacing: JunoSpace.snug) {
            Menu {
                ForEach([1.0, 2, 4, 8, 16], id: \.self) { value in
                    Button(CodeV2ContextMath.dollars(value)) { draft.budgetUsd = value }
                }
                Divider()
                Button("No Cap") { draft.budgetUsd = nil }
            } label: {
                CodeV2TextControlLabel(
                    title: draft.budgetUsd.map { "Stop at \(CodeV2ContextMath.dollars($0))" } ?? "No budget cap"
                )
            }
            .menuStyle(.button).menuIndicator(.hidden)
            .buttonStyle(CodeV2FooterButtonStyle(compact: true)).fixedSize()
            .help("The run stops once its Alevr spend reaches the cap. Subscriptions count against their own plans.")
            .accessibilityLabel("Budget cap")
            .contentShape(.rect)
            Spacer(minLength: 0)
            if let costLine {
                Text(costLine).studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary)
            }
        }
        .padding(.horizontal, JunoSpace.snug)
        .frame(height: 40)
    }
}

/// One role on one row: its name and duty on the left, its model and effort
/// on the right as the slider-first picker (effort panel first, the
/// catalogue of labs and Subscriptions behind the model's name).
struct CodeV2TeamRoleRow: View {
    let role: CodeV2Team.Role
    let directory: CodeV2ProviderDirectory
    @Binding var selection: CodeV2.ModelSelection
    var count: (value: Int, range: ClosedRange<Int>, set: (Int) -> Void)?
    var remove: (() -> Void)?

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: JunoSpace.tight) {
                    Text(role.name).studioType(.textMedium).foregroundStyle(Studio.Ink.primary)
                    if let phase = role.phase {
                        Text(CodeV2Team.phaseTitle(phase)).studioType(.small).foregroundStyle(Studio.Ink.tertiary)
                    }
                }
                Text(role.duty).studioType(.small).foregroundStyle(Studio.Ink.secondary).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .layoutPriority(1)
            Spacer(minLength: JunoSpace.tight)
            if let count {
                CodeV2Stepper(value: count.value, range: count.range, set: count.set)
                    .accessibilityLabel("Builders")
                    .accessibilityValue("\(count.value)")
            }
            CodeV2TeamModelPicker(directory: directory, selection: $selection, role: role.name)
            if let remove {
                Button(action: remove) { JunoIconView(.close, size: 11) }
                    .buttonStyle(StudioIconButtonStyle())
                    .contentShape(.rect)
                    .help("Remove the \(role.name.lowercased())")
                    .accessibilityLabel("Remove the \(role.name.lowercased())")
            }
        }
        .padding(.horizontal, JunoSpace.snug)
        .frame(minHeight: 44)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(role.name)
    }
}

/// A Best of N candidate: its letter, then its model.
struct CodeV2TeamCandidateRow: View {
    let letter: String
    let directory: CodeV2ProviderDirectory
    @Binding var selection: CodeV2.ModelSelection
    var remove: (() -> Void)?

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Text("Candidate \(letter)").studioType(.textMedium).foregroundStyle(Studio.Ink.primary)
            Spacer(minLength: JunoSpace.snug)
            CodeV2TeamModelPicker(directory: directory, selection: $selection, role: "Candidate \(letter)")
            if let remove {
                Button(action: remove) { JunoIconView(.close, size: 11) }
                    .buttonStyle(StudioIconButtonStyle())
                    .contentShape(.rect)
                    .accessibilityLabel("Remove candidate \(letter)")
            }
        }
        .padding(.horizontal, JunoSpace.snug)
        .frame(minHeight: 36)
    }
}

/// A role's model and effort: the composer's slider-first control without
/// its window-wide shortcuts (one per role would collide).
struct CodeV2TeamModelPicker: View {
    let directory: CodeV2ProviderDirectory
    @Binding var selection: CodeV2.ModelSelection
    let role: String

    @State private var stage: JunoModelPickerStage?

    private var model: CodeV2.ProviderModel? {
        directory.instance(selection.instanceId).flatMap {
            CodeV2ModelCatalogue.models(of: $0, in: directory).first { $0.id == selection.model }
        }
    }

    private var name: String { model?.label ?? CodeV2Formatting.modelName(selection.model) }

    private var stopID: Binding<String?> {
        Binding(
            get: { (selection.effort ?? model?.defaultEffort)?.rawValue },
            set: { id in
                guard let id, let level = CodeV2.EffortLevel(rawValue: id) else { return }
                selection.effort = level
            }
        )
    }

    var body: some View {
        JunoModelPickerControl(
            stage: $stage,
            ladder: CodeV2ModelControl.ladder(for: model, name: name),
            stopID: stopID,
            fastMode: nil,
            modelName: name,
            catalogSize: CodeV2ModelControl.catalogSize,
            arrowEdge: .trailing,
            isEnabled: true,
            accessibilityValue: [name, selection.effort?.title].compactMap { $0 }.joined(separator: ", "),
            accessibilityID: "juno.code.v2.team.\(role.lowercased().replacingOccurrences(of: " ", with: "-"))",
            help: "\(role)'s model and effort"
        ) { open in
            CodeV2TeamModelLabel(directory: directory, selection: selection, isOpen: open)
        } catalog: { close in
            CodeV2ModelPicker(
                directory: directory,
                selection: $selection,
                choose: { instance, choice in
                    let levels = choice.effortLevels ?? []
                    let effort = selection.effort.flatMap { levels.contains($0) ? $0 : nil } ?? choice.defaultEffort
                    selection = CodeV2.ModelSelection(
                        instanceId: instance, model: choice.id, effort: effort,
                        contextTokens: choice.contextTiers.flatMap { CodeV2ContextMath.sorted($0).first?.tokens }
                    )
                    close()
                },
                showsFooter: false
            )
        }
    }
}

/// The lab's mark, the model's short name and its effort.
struct CodeV2TeamModelLabel: View {
    let directory: CodeV2ProviderDirectory
    let selection: CodeV2.ModelSelection
    var isOpen = false

    private var name: String {
        directory.instance(selection.instanceId)
            .flatMap { CodeV2ModelCatalogue.models(of: $0, in: directory).first { $0.id == selection.model }?.label }
            ?? CodeV2Formatting.modelName(selection.model)
    }

    var body: some View {
        CodeV2ModelControlLabel(isOpen: isOpen) {
            CodeV2Mark(id: CodeV2Marks.markID(model: selection.model, instanceId: selection.instanceId), size: 14)
            Text(CodeV2ModelNames.short(name)).foregroundStyle(Studio.Ink.primary).lineLimit(1)
            if let effort = selection.effort {
                Text(effort.title).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
            }
        }
    }
}
