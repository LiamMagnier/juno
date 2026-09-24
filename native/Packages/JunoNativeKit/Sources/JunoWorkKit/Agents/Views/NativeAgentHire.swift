import Foundation
import JunoCore
import JunoDesignSystem
import SwiftUI

/// Hiring an agent (AGENTS.md §5.1): four questions on one page, top to
/// bottom, in the order a person decides them — what it is for, what it is
/// called and looks like, how it works, and what it starts on.
///
/// Not a wizard. Every answer stays on screen while the next one is given,
/// because they depend on each other: a Writer called Quill who is allowed to
/// "just do it" is a combination somebody should see whole before pressing
/// Hire. Picking a starting point fills the rest with that job's defaults, and
/// only the fields the person has not touched yet — changing your mind about
/// the job must not throw away a name you already typed.
struct NativeAgentHireView: View {
    let model: NativeAgentsModel
    let apps: [NativeAgentAppChoice]
    let onCancel: () -> Void
    let onHired: (NativeAgent) -> Void

    @State private var templateID: String
    @State private var draft: NativeAgentDraft
    /// The fields the person has changed by hand, which a new starting point
    /// must leave alone.
    @State private var touched: Set<String> = []
    @State private var saving = false
    @State private var failure: String?

    init(
        model: NativeAgentsModel,
        apps: [NativeAgentAppChoice],
        template: NativeAgentTemplate,
        onCancel: @escaping () -> Void,
        onHired: @escaping (NativeAgent) -> Void
    ) {
        self.model = model
        self.apps = apps
        self.onCancel = onCancel
        self.onHired = onHired
        var initial = NativeAgentDraft(template: template)
        initial.connectorIDs = Self.suggestedApps(for: template, among: apps)
        _templateID = State(initialValue: template.id)
        _draft = State(initialValue: initial)
    }

    /// A starting point's suggested apps, narrowed to the ones this account
    /// has actually connected: a suggestion is never a grant.
    static func suggestedApps(
        for template: NativeAgentTemplate,
        among apps: [NativeAgentAppChoice]
    ) -> [String] {
        apps.map(\.id).filter { template.suggestedConnectors.contains($0) }
    }

    private var trimmedName: String {
        draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var hireTitle: String {
        trimmedName.isEmpty ? "Hire agent" : "Hire \(trimmedName)"
    }

    private var template: NativeAgentTemplate {
        NativeAgentTemplate.named(templateID) ?? NativeAgentTemplate.all[0]
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.region) {
                    intro
                    step(1, "What should it take on?") { templates }
                    step(2, "Name and face") { nameAndFace }
                    step(3, "How it works") { howItWorks }
                    step(4, "A first goal", optional: true) { firstGoal }
                }
                .padding(JunoSpace.roomy)
                .frame(maxWidth: JunoReadingMeasure.reading, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            Divider()
            footer
        }
        #if os(macOS)
        .frame(minWidth: 640, idealWidth: 720, minHeight: 640, idealHeight: 780)
        #endif
        .junoSheetSurface(.page)
        .accessibilityIdentifier("juno.agents.hire")
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text("New agent")
                .junoEmptyTitle()
                .junoInk()
                .accessibilityAddTraits(.isHeader)
            Text("A teammate with its own brief, goals and memory. It works in the cloud and asks before anything it cannot take back.")
                .font(.callout)
                .junoSecondaryInk()
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func step<Content: View>(
        _ number: Int,
        _ title: String,
        optional: Bool = false,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text(verbatim: String(number))
                    .junoCodeSmall()
                    .junoSecondaryInk()
                Text(title)
                    .junoFont(size: 17, relativeTo: .title3, weight: .semibold)
                    .junoInk()
                if optional {
                    Text("Optional")
                        .font(.callout)
                        .junoSecondaryInk()
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    // MARK: 1 · Starting point

    private var templates: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 240), spacing: JunoSpace.snug, alignment: .top)],
            alignment: .leading,
            spacing: JunoSpace.snug
        ) {
            ForEach(NativeAgentTemplate.all) { option in
                Button {
                    pick(option)
                } label: {
                    NativeAgentTemplateTile(template: option, selected: option.id == templateID)
                        .contentShape(.rect)
                }
                .buttonStyle(.junoPress)
            }
        }
    }

    // MARK: 2 · Name and face

    @ViewBuilder
    private var nameAndFace: some View {
        VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            #if os(macOS)
            HStack(alignment: .top, spacing: JunoSpace.roomy) {
                nameFields
                NativeAgentFacePreview(avatar: draft.avatar, name: trimmedName)
            }
            #else
            NativeAgentFacePreview(avatar: draft.avatar, name: trimmedName)
                .frame(maxWidth: .infinity)
            nameFields
            #endif
            NativeAgentFaceBuilder(avatar: avatarBinding)
        }
    }

    private var nameFields: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                NativeAgentFieldLabel(title: "Name")
                TextField("Name", text: nameBinding)
                    .textFieldStyle(.roundedBorder)
            }
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                NativeAgentFieldLabel(title: "What it is for")
                TextField("Inbox and calendar", text: roleBinding)
                    .textFieldStyle(.roundedBorder)
            }
            let suggestions = template.names.filter { $0 != trimmedName }
            if !suggestions.isEmpty {
                HStack(spacing: JunoSpace.tight) {
                    Text("Or call it")
                        .font(.callout)
                        .junoSecondaryInk()
                    ForEach(suggestions, id: \.self) { suggestion in
                        Button(suggestion) {
                            touched.insert("name")
                            draft.name = suggestion
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .frame(minHeight: 44)
                        .contentShape(.rect)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: 3 · How it works

    private var howItWorks: some View {
        VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                NativeAgentFieldLabel(title: "How it talks")
                NativeAgentStylePicker(style: styleBinding)
            }
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                NativeAgentFieldLabel(title: "Its brief")
                Text("Who it is, what it looks after, and how you like things done.")
                    .font(.callout)
                    .junoSecondaryInk()
                TextEditor(text: instructionsBinding)
                    .font(.body)
                    .nativeAgentWell(minHeight: 140)
                    .accessibilityLabel("Its brief")
            }
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                NativeAgentFieldLabel(title: "Autonomy")
                NativeAgentAutonomyPicker(mode: approvalBinding)
            }
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                NativeAgentFieldLabel(title: "Connected apps it may use")
                NativeAgentAppPicker(apps: apps, selection: appsBinding)
            }
        }
    }

    // MARK: 4 · First goal

    private var firstGoal: some View {
        TextField("Something it works towards over time", text: firstGoalBinding)
            .textFieldStyle(.roundedBorder)
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: JunoSpace.snug) {
            if let failure {
                Text(failure)
                    .junoCaption()
                    .lineLimit(2)
            }
            Spacer(minLength: JunoSpace.snug)
            Button("Cancel", action: onCancel)
                .keyboardShortcut(.cancelAction)
                .frame(minHeight: 44)
                .contentShape(.rect)
            Button(action: hire) {
                if saving {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Text(hireTitle)
                }
            }
            .keyboardShortcut(.defaultAction)
            // Opaque, in the Juno accent: glass is chrome, never content or a
            // sheet's body (MACOS_LIQUID_GLASS_REDESIGN.md §0.1).
            .buttonStyle(.junoProminent)
            .disabled(!draft.isValid || saving)
            .frame(minHeight: 44)
            .contentShape(.rect)
            .accessibilityIdentifier("juno.agents.hire.submit")
        }
        .padding(.horizontal, JunoSpace.roomy)
        .padding(.vertical, JunoSpace.cozy)
    }

    // MARK: Bindings that remember a hand edit

    private var nameBinding: Binding<String> {
        Binding(get: { draft.name }, set: { value in
            touched.insert("name")
            draft.name = String(value.prefix(NativeAgentLimits.name))
        })
    }

    private var roleBinding: Binding<String> {
        Binding(get: { draft.role }, set: { value in
            touched.insert("role")
            draft.role = String(value.prefix(NativeAgentLimits.role))
        })
    }

    private var avatarBinding: Binding<JunoAgentAvatar> {
        Binding(get: { draft.avatar }, set: { value in
            touched.insert("avatar")
            draft.avatar = value
        })
    }

    private var styleBinding: Binding<NativeAgentStyle> {
        Binding(get: { draft.style }, set: { value in
            touched.insert("style")
            draft.style = value
        })
    }

    private var instructionsBinding: Binding<String> {
        Binding(get: { draft.instructions }, set: { value in
            touched.insert("instructions")
            draft.instructions = value
        })
    }

    private var approvalBinding: Binding<JunoWorkPermissionPolicy> {
        Binding(get: { draft.approvalMode }, set: { value in
            touched.insert("approvalMode")
            draft.approvalMode = value
        })
    }

    private var appsBinding: Binding<[String]> {
        Binding(get: { draft.connectorIDs }, set: { value in
            touched.insert("apps")
            draft.connectorIDs = value
        })
    }

    private var firstGoalBinding: Binding<String> {
        Binding(get: { draft.firstGoal }, set: { value in
            touched.insert("firstGoal")
            draft.firstGoal = String(value.prefix(NativeAgentLimits.goalTitle))
        })
    }

    // MARK: Actions

    private func pick(_ option: NativeAgentTemplate) {
        templateID = option.id
        draft.template = option.id
        if !touched.contains("name") { draft.name = option.names.first ?? "" }
        if !touched.contains("role") { draft.role = option.role }
        if !touched.contains("avatar") { draft.avatar = option.avatar }
        if !touched.contains("style") { draft.style = option.style }
        if !touched.contains("instructions") { draft.instructions = option.instructions }
        if !touched.contains("approvalMode") { draft.approvalMode = option.approvalMode }
        if !touched.contains("firstGoal") { draft.firstGoal = option.firstGoal }
        if !touched.contains("apps") { draft.connectorIDs = Self.suggestedApps(for: option, among: apps) }
    }

    private func hire() {
        guard draft.isValid, !saving else { return }
        saving = true
        failure = nil
        let submitted = draft
        Task {
            let agent = await model.hire(submitted)
            saving = false
            if let agent {
                onHired(agent)
            } else {
                failure = model.lastErrorDescription ?? "Couldn’t hire this agent. Try again."
            }
        }
    }
}

// MARK: - The face builder

/// The face at size, with the states it will show once it is working, so the
/// person sees the character move before they hire it. Grok's avatar studio
/// lets you check every state before committing; this is that at the size of
/// one control.
struct NativeAgentFacePreview: View {
    let avatar: JunoAgentAvatar
    let name: String

    @State private var state: JunoAgentState = .idle

    private static let states: [JunoAgentState] = [.idle, .working, .waiting, .done]

    var body: some View {
        VStack(spacing: JunoSpace.cozy) {
            JunoAgentFace(
                avatar: avatar,
                state: state,
                size: JunoAgentFaceSize.lg,
                name: name.isEmpty ? "New agent" : name
            )
            .frame(width: 160, height: 160)
            .background {
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(Color.junoSurface)
            }
            .overlay {
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 0.5)
            }
            Picker("Preview a state", selection: $state) {
                ForEach(Self.states) { option in
                    Text(option.label).tag(option)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 300)
        }
    }
}

/// Shape, colour, eyes and mark as four rows of swatches. Each swatch is the
/// face itself with that one choice changed, so the choice is made by looking.
struct NativeAgentFaceBuilder: View {
    @Binding var avatar: JunoAgentAvatar

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            NativeAgentSwatchRow(
                title: "Shape",
                options: JunoAgentShape.allCases,
                selected: avatar.shape,
                name: { $0.label },
                select: { avatar.shape = $0 }
            ) { option in
                JunoAgentFace(
                    avatar: JunoAgentAvatar(
                        shape: option, tone: avatar.tone, eyes: avatar.eyes, mark: JunoAgentMark.none
                    ),
                    size: JunoAgentFaceSize.sm
                )
            }
            NativeAgentSwatchRow(
                title: "Colour",
                options: JunoAgentTone.allCases,
                selected: avatar.tone,
                name: { $0.label },
                select: { avatar.tone = $0 }
            ) { option in
                Circle()
                    .fill(option.color)
                    .frame(width: 20, height: 20)
            }
            NativeAgentSwatchRow(
                title: "Eyes",
                options: JunoAgentEyes.allCases,
                selected: avatar.eyes,
                name: { $0.label },
                select: { avatar.eyes = $0 }
            ) { option in
                JunoAgentFace(
                    avatar: JunoAgentAvatar(
                        shape: avatar.shape, tone: avatar.tone, eyes: option, mark: JunoAgentMark.none
                    ),
                    size: JunoAgentFaceSize.sm
                )
            }
            NativeAgentSwatchRow(
                title: "Mark",
                options: JunoAgentMark.allCases,
                selected: avatar.mark,
                name: { $0.label },
                select: { avatar.mark = $0 }
            ) { option in
                JunoAgentFace(
                    avatar: JunoAgentAvatar(
                        shape: avatar.shape, tone: avatar.tone, eyes: avatar.eyes, mark: option
                    ),
                    size: JunoAgentFaceSize.sm
                )
            }
        }
    }
}

/// One row of swatches: a radio group drawn as flat tiles, the chosen one in
/// the selected fill with a darker edge.
struct NativeAgentSwatchRow<Option: Identifiable & Equatable, Swatch: View>: View {
    let title: String
    let options: [Option]
    let selected: Option
    let name: (Option) -> String
    let select: (Option) -> Void
    @ViewBuilder let swatch: (Option) -> Swatch

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            NativeAgentFieldLabel(title: title)
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 44, maximum: 48), spacing: JunoSpace.tight)],
                alignment: .leading,
                spacing: JunoSpace.tight
            ) {
                ForEach(options) { option in
                    let isSelected = option == selected
                    Button {
                        select(option)
                    } label: {
                        swatch(option)
                            .frame(width: 44, height: 44)
                            .background {
                                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                                    .fill(isSelected ? Color.junoMuted : Color.junoSurface)
                            }
                            .overlay {
                                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                                    .strokeBorder(
                                        isSelected ? Color.junoForeground.opacity(0.35) : Color.junoBorder,
                                        lineWidth: isSelected ? 1 : 0.5
                                    )
                            }
                            .contentShape(.rect)
                    }
                    .buttonStyle(.junoPress)
                    .help(name(option))
                    .accessibilityLabel(Text(verbatim: "\(title): \(name(option))"))
                    .accessibilityAddTraits(isSelected ? [.isSelected] : [])
                }
            }
        }
    }
}

// MARK: - How it works

/// How it talks: four tiles, each with its one-line summary.
struct NativeAgentStylePicker: View {
    @Binding var style: NativeAgentStyle

    var body: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 220), spacing: JunoSpace.snug, alignment: .top)],
            alignment: .leading,
            spacing: JunoSpace.snug
        ) {
            ForEach(NativeAgentStyle.allCases) { option in
                Button {
                    style = option
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(option.label)
                            .font(.callout.weight(.medium))
                            .junoInk()
                        Text(option.summary)
                            .font(.callout)
                            .junoSecondaryInk()
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .nativeAgentTile(selected: option == style)
                    .contentShape(.rect)
                }
                .buttonStyle(.junoPress)
                .accessibilityAddTraits(option == style ? [.isSelected] : [])
            }
        }
    }
}

/// The three Work modes by their promise labels, with the floor spelled out
/// beneath — under every mode, not as a caveat on the last one.
struct NativeAgentAutonomyPicker: View {
    @Binding var mode: JunoWorkPermissionPolicy

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            ForEach(JunoWorkPermissionPolicy.allCases, id: \.self) { option in
                Button {
                    mode = option
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(option.agentAutonomyLabel)
                            .font(.callout.weight(.medium))
                            .junoInk()
                        Text(option.agentAutonomySummary)
                            .font(.callout)
                            .junoSecondaryInk()
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .nativeAgentTile(selected: option == mode)
                    .contentShape(.rect)
                }
                .buttonStyle(.junoPress)
                .accessibilityAddTraits(option == mode ? [.isSelected] : [])
            }
            Text(JunoWorkPermissionPolicy.agentAutonomyFloor)
                .font(.callout)
                .junoSecondaryInk()
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The apps the account has connected, each a switch. Only connected apps are
/// offered; an app the agent was given that is no longer connected stays in
/// its list, said plainly, rather than silently dropping out.
struct NativeAgentAppPicker: View {
    let apps: [NativeAgentAppChoice]
    @Binding var selection: [String]

    private var orphaned: [String] {
        let known = Set(apps.map(\.id))
        return selection.filter { !known.contains($0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if apps.isEmpty {
                Text("No apps are connected yet. Connect one in Connections and give it to this agent later.")
                    .font(.callout)
                    .junoSecondaryInk()
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(apps) { app in
                Toggle(isOn: binding(for: app.id)) {
                    Text(app.label)
                        .font(.callout)
                        .junoInk()
                }
                .frame(minHeight: 44)
            }
            ForEach(orphaned, id: \.self) { id in
                Toggle(isOn: binding(for: id)) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(JunoWorkVocabulary.sentenceCased(id))
                            .font(.callout)
                            .junoInk()
                        Text("Not connected any more")
                            .junoCaption()
                    }
                }
                .frame(minHeight: 44)
            }
        }
    }

    private func binding(for id: String) -> Binding<Bool> {
        Binding(
            get: { selection.contains(id) },
            set: { isOn in
                if isOn {
                    if !selection.contains(id) { selection.append(id) }
                } else {
                    selection.removeAll { $0 == id }
                }
            }
        )
    }
}
