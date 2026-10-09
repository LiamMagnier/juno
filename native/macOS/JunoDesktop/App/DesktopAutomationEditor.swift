import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

// MARK: - The draft

/// What the editor holds while somebody types: the web's `ScheduleDraft`
/// (`work-schedule-editor.tsx`), with the three ceilings kept as the text in
/// their fields so an empty field ("No limit") and a typo can be told apart.
struct DesktopAutomationDraft: Equatable {
    var name = ""
    var instructions = ""
    var timezone = TimeZone.current.identifier
    var target: JunoWorkTarget = .automatic
    var hostID: String?
    var enabled = true
    var triggers: [NativeWorkScheduleTriggerDraft] = [
        NativeWorkScheduleTriggerDraft(kind: "daily", config: NativeWorkScheduleCopy.defaultConfig(for: "daily"))
    ]
    var unattendedPolicy = "pause_for_approval"
    var hostOfflinePolicy = "skip"
    var missedRunPolicy = "run_once"
    var notifyPolicy = "on_attention"
    var maxConcurrentRuns = 1
    var costUSD = ""
    var tokens = ""
    var minutes = ""
    /// "" is "The task’s own model".
    var model = ""
    /// Carried through untouched: the web's editor does not show it, and an
    /// edit must not clear what another client attached.
    var requiredCapabilities: [String] = []

    init() {}

    /// Seeded from what the server stored (`draftFrom`), with every policy
    /// narrowed to a value the options know.
    init(schedule: NativeWorkSchedule) {
        typealias C = NativeWorkScheduleCopy
        name = schedule.name
        instructions = schedule.instructions
        timezone = schedule.timezone
        target = schedule.targetValue ?? .automatic
        hostID = schedule.hostID
        enabled = schedule.enabled
        triggers = schedule.triggers.map(NativeWorkScheduleTriggerDraft.init(trigger:))
        unattendedPolicy = C.known(schedule.unattendedPolicy, in: C.unattendedOptions, fallback: "pause_for_approval")
        hostOfflinePolicy = C.known(schedule.hostOfflinePolicy, in: C.hostOfflineOptions, fallback: "skip")
        missedRunPolicy = C.known(schedule.missedRunPolicy, in: C.missedRunOptions, fallback: "run_once")
        notifyPolicy = C.known(schedule.notifyPolicy, in: C.notifyOptions, fallback: "on_attention")
        maxConcurrentRuns = schedule.maxConcurrentRuns
        costUSD = C.ceilingField(Double(schedule.budget.maxCostMicroUSD) / 1_000_000)
        tokens = C.ceilingField(Double(schedule.budget.maxTokens))
        minutes = C.ceilingField(Double(schedule.budget.maxRuntimeMilliseconds) / 60_000)
        model = schedule.model ?? ""
        requiredCapabilities = schedule.requiredCapabilities
    }

    /// A pinned automation must name its Mac.
    var missingHost: Bool { target == .local && hostID == nil }

    var budgetIsValid: Bool {
        NativeWorkScheduleCopy.ceiling(costUSD) != nil
            && NativeWorkScheduleCopy.ceiling(tokens) != nil
            && NativeWorkScheduleCopy.ceiling(minutes) != nil
    }

    /// The web's `canSave`, less `saving`.
    var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !timezone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !triggers.isEmpty
            && !missingHost
            && budgetIsValid
    }

    /// The body the client sends, or nil while the form cannot be saved.
    var scheduleDraft: NativeWorkScheduleDraft? {
        guard canSave else { return nil }
        let cost = NativeWorkScheduleCopy.ceiling(costUSD) ?? 0
        let tokenCeiling = NativeWorkScheduleCopy.ceiling(tokens) ?? 0
        let minuteCeiling = NativeWorkScheduleCopy.ceiling(minutes) ?? 0
        return NativeWorkScheduleDraft(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            instructions: instructions.trimmingCharacters(in: .whitespacesAndNewlines),
            timezone: timezone.trimmingCharacters(in: .whitespacesAndNewlines),
            target: target,
            hostID: target == .cloud ? nil : hostID,
            enabled: enabled,
            triggers: triggers,
            budget: NativeWorkScheduleBudget(
                maxCostMicroUSD: Int((cost * 1_000_000).rounded()),
                maxTokens: Int(tokenCeiling.rounded()),
                maxRuntimeMilliseconds: Int((minuteCeiling * 60_000).rounded())
            ),
            unattendedPolicy: unattendedPolicy,
            hostOfflinePolicy: hostOfflinePolicy,
            missedRunPolicy: missedRunPolicy,
            notifyPolicy: notifyPolicy,
            maxConcurrentRuns: maxConcurrentRuns,
            model: model.isEmpty ? nil : model,
            requiredCapabilities: requiredCapabilities
        )
    }
}

// MARK: - The editor

/// The automation editor on the New automation and automation pages: the
/// web's `WorkScheduleEditor`, in its order, as plain sections on the page —
/// what it runs, its name and brief, when it runs, where, what each run may
/// spend and uses, and what happens when nobody is watching — then the arming
/// card and the save row.
///
/// Every choice is a radio row with the web's label and the sentence under
/// it. The JSON editor the Work window had is gone; a trigger this build does
/// not know is kept and saved back untouched, as the web does.
struct DesktopAutomationEditor: View {
    /// Nil for a new automation.
    let schedule: NativeWorkSchedule?
    /// The account's Macs; nil when they could not be read, which leaves the
    /// Mac choice disabled on "Any of my Macs".
    let hosts: [WorkHostSummary]?
    let modelOptions: [NativeChatModelOption]
    /// The folders shared with a Mac, for a folder trigger; nil while unread.
    var grants: (String) -> [NativeWorkHostGrant]? = { _ in nil }
    var loadGrants: (String) -> Void = { _ in }
    /// The web's edit page for this automation, for a Code automation.
    var webURL: URL?
    let save: (NativeWorkScheduleDraft) async -> String?
    let cancel: () -> Void

    @State private var draft: DesktopAutomationDraft
    @State private var runsCode = false
    @State private var saving = false
    @State private var refusal: String?

    init(
        schedule: NativeWorkSchedule?,
        hosts: [WorkHostSummary]?,
        modelOptions: [NativeChatModelOption],
        grants: @escaping (String) -> [NativeWorkHostGrant]? = { _ in nil },
        loadGrants: @escaping (String) -> Void = { _ in },
        webURL: URL? = nil,
        save: @escaping (NativeWorkScheduleDraft) async -> String?,
        cancel: @escaping () -> Void
    ) {
        self.schedule = schedule
        self.hosts = hosts
        self.modelOptions = modelOptions
        self.grants = grants
        self.loadGrants = loadGrants
        self.webURL = webURL
        self.save = save
        self.cancel = cancel
        _draft = State(initialValue: schedule.map(DesktopAutomationDraft.init(schedule:)) ?? DesktopAutomationDraft())
    }

    private var isNew: Bool { schedule == nil }
    /// A Code automation opens read-only: the Mac cannot edit one yet
    /// (register #67).
    private var isReadOnly: Bool { schedule.map { !$0.isEditableHere } ?? false }
    private var locked: Bool { saving || isReadOnly }

    private var namedHost: WorkHostSummary? {
        guard let hostID = draft.hostID else { return nil }
        return hosts?.first { $0.hostID == hostID }
    }

    private var watchesFolder: Bool { draft.triggers.contains { $0.kind == "folder_change" } }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.wide) {
            whatItRuns
            nameAndBrief
            whenItRuns
            if !isReadOnly {
                whereItRuns
            }
            spendAndUse
            whenNobodyIsWatching
            DesktopAutomationArmingCard(draft: draft, hostName: namedHost?.displayName, isCode: isReadOnly)
            if let refusal {
                DesktopWorkNote(.error, refusal)
                    .transition(.opacity)
            }
            saveRow
        }
        .disabled(saving)
        .onChange(of: draft.hostID) { _, hostID in
            if watchesFolder, let hostID { loadGrants(hostID) }
        }
        .onAppear {
            if watchesFolder, let hostID = draft.hostID { loadGrants(hostID) }
        }
    }

    // MARK: What it runs

    @ViewBuilder
    private var whatItRuns: some View {
        if isNew {
            DesktopAutomationField(title: "What it runs") {
                // "Code" is offered only when the Mac can edit a Code
                // automation, and today it cannot (register #67).
                JunoSegmented(
                    options: [
                        JunoSegmented<Bool>.Option(false, "A task"),
                        JunoSegmented<Bool>.Option(true, "Code", isDisabled: true),
                    ],
                    selection: $runsCode,
                    accessibilityLabel: "What this automation runs"
                )
                .fixedSize()
            } hint: {
                "Each run adds to one task and one transcript, so what it learns carries from one run to the next."
            }
        } else if isReadOnly {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                DesktopWorkNote(.info, "A Code automation. Each run is a Code session of its own, with its own branch and pull request.") {
                    if let webURL {
                        Link("Edit this automation on the web", destination: webURL)
                            .junoType(.ui)
                            .fixedSize()
                    }
                }
                if let repository = schedule?.codeRepository {
                    DesktopAutomationReadOnlyRow(label: "Repository", value: repository)
                }
            }
        }
    }

    // MARK: Name and brief

    private var nameAndBrief: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            DesktopAutomationField(title: "Name") {
                DesktopAutomationTextField(placeholder: "Monday morning inbox sweep", text: $draft.name)
                    .disabled(locked)
            }
            DesktopAutomationField(title: "What it should do") {
                DesktopAutomationTextEditor(
                    placeholder: "Describe the errand and what “done” looks like, the way you would to a person picking it up cold.",
                    text: $draft.instructions
                )
                .disabled(locked)
            } hint: {
                "Every run starts from this text and nothing else, so it has to stand on its own — nobody is there to answer a follow-up at seven in the morning."
            }
        }
    }

    // MARK: When it runs

    private var whenItRuns: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            DesktopAutomationSectionTitle("When it runs")
            ForEach($draft.triggers) { $trigger in
                DesktopAutomationTriggerRow(
                    trigger: $trigger,
                    canRemove: draft.triggers.count > 1,
                    grants: draft.hostID.flatMap(grants),
                    locked: locked,
                    remove: { draft.triggers.removeAll { $0.id == trigger.id } }
                )
            }
            if !isReadOnly {
                DesktopAutomationAddTrigger { kind in
                    draft.triggers.append(
                        NativeWorkScheduleTriggerDraft(kind: kind, config: NativeWorkScheduleCopy.defaultConfig(for: kind))
                    )
                }
                .disabled(locked)
            }
            DesktopAutomationField(title: "Timezone") {
                DesktopAutomationTextField(placeholder: "Europe/Paris", text: $draft.timezone)
                    .frame(maxWidth: 320)
                    .disabled(locked)
            } hint: {
                "An IANA name. Every time above is read in this zone, which is what makes 09:00 stay 09:00 across a daylight-saving change."
            }
            .padding(.top, JunoSpace.tight)
        }
    }

    // MARK: Where it runs

    private var whereItRuns: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            DesktopAutomationSectionTitle("Where it runs")
            JunoSegmented(
                options: [
                    JunoSegmented<JunoWorkTarget>.Option(.automatic, "Wherever it fits"),
                    JunoSegmented<JunoWorkTarget>.Option(.cloud, "Cloud"),
                    JunoSegmented<JunoWorkTarget>.Option(.local, "One of my Macs"),
                ],
                selection: $draft.target,
                accessibilityLabel: "Where this schedule runs"
            )
            .fixedSize()
            .disabled(locked)
            if draft.target != .cloud {
                DesktopAutomationField(title: "Mac") {
                    JunoPageMenu(
                        options: hostOptions,
                        selection: Binding(
                            get: { draft.hostID ?? "" },
                            set: { draft.hostID = $0.isEmpty ? nil : $0 }
                        ),
                        accessibilityLabel: "Mac"
                    )
                    .disabled(locked || hosts == nil)
                } hint: {
                    hostHint
                }
            }
        }
    }

    private var hostOptions: [JunoPageMenuOption<String>] {
        let empty = draft.target == .local ? "Choose a Mac…" : "Any of my Macs"
        return [JunoPageMenuOption("", empty)]
            + (hosts ?? []).map { JunoPageMenuOption($0.hostID, $0.displayName) }
    }

    private var hostHint: String? {
        if draft.missingHost {
            return "A schedule pinned to a Mac has to say which one. Left open, a 07:00 fire would land on whichever machine happened to be awake."
        }
        if let namedHost, !namedHost.canServeWork {
            return "\(namedHost.displayName) is not reachable right now. The schedule can still be saved — what happens at the next fire is the offline policy below."
        }
        if let hosts, draft.target == .local, !hosts.contains(where: \.canServeWork) {
            return "None of your Macs are checking in at the moment."
        }
        return nil
    }

    // MARK: Spend and model

    private var spendAndUse: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            DesktopAutomationSectionTitle(isReadOnly ? "What each run uses" : "What each run may spend")
            if isReadOnly {
                DesktopAutomationHint("A Code run spends against your account’s usage like any other cloud session, and stops when that is spent. It carries no ceiling of its own.")
            } else {
                HStack(alignment: .top, spacing: JunoSpace.cozy) {
                    DesktopAutomationField(title: "Cost, in US dollars") {
                        DesktopAutomationTextField(placeholder: "No limit", text: $draft.costUSD)
                    }
                    DesktopAutomationField(title: "Tokens") {
                        DesktopAutomationTextField(placeholder: "No limit", text: $draft.tokens)
                    }
                    DesktopAutomationField(title: "Minutes of work") {
                        DesktopAutomationTextField(placeholder: "No limit", text: $draft.minutes)
                    }
                }
                .disabled(locked)
                DesktopAutomationHint("Empty means no ceiling of this schedule’s own: a run goes until the work is done or until your usage limit is used up. A number here is a smaller ceiling for this schedule, and whichever is smaller wins — this, or what the window has left when it fires.")
                if !draft.budgetIsValid {
                    DesktopAutomationHint("Each ceiling has to be left empty, or a number of zero or more.", warning: true)
                }
            }
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                DesktopAutomationField(title: "Model") {
                    JunoPageMenu(
                        options: modelMenuOptions,
                        selection: $draft.model,
                        accessibilityLabel: "Model"
                    )
                    .disabled(locked)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                DesktopAutomationField(title: "Runs at once") {
                    Stepper(value: $draft.maxConcurrentRuns, in: 1...5) {
                        Text("\(draft.maxConcurrentRuns)")
                            .junoType(.ui)
                            .monospacedDigit()
                            .frame(minWidth: 16, alignment: .leading)
                    }
                    .disabled(locked)
                    .accessibilityLabel("Runs at once")
                    .accessibilityValue("\(draft.maxConcurrentRuns)")
                } hint: {
                    "How many of this schedule’s runs may be under way together. One is right for anything that writes a file; a fire that lands while the last is still going waits."
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.top, JunoSpace.tight)
        }
    }

    private var modelMenuOptions: [JunoPageMenuOption<String>] {
        var options = [JunoPageMenuOption("", isReadOnly ? "Whatever the runner picks" : "The task’s own model")]
        options += modelOptions.map { JunoPageMenuOption($0.id, $0.displayName) }
        if !draft.model.isEmpty, !modelOptions.contains(where: { $0.id == draft.model }) {
            options.append(JunoPageMenuOption(draft.model, draft.model))
        }
        return options
    }

    // MARK: When nobody is watching

    private var whenNobodyIsWatching: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            DesktopAutomationSectionTitle("When nobody is watching")
            if !isReadOnly {
                DesktopAutomationPolicyGroup(
                    label: "Something it cannot undo",
                    options: NativeWorkScheduleCopy.unattendedOptions,
                    selection: $draft.unattendedPolicy
                )
                DesktopAutomationPolicyGroup(
                    label: "The Mac is not there",
                    options: NativeWorkScheduleCopy.hostOfflineOptions,
                    selection: $draft.hostOfflinePolicy
                )
            }
            DesktopAutomationPolicyGroup(
                label: "Fires that were missed",
                options: NativeWorkScheduleCopy.missedRunOptions,
                selection: $draft.missedRunPolicy
            )
            if isReadOnly {
                DesktopAutomationHint("Each run appears in the sidebar as its own Code session, with the status mark every Code session has — including the one that stopped to ask you something.")
            } else {
                DesktopAutomationPolicyGroup(
                    label: "Tell me",
                    options: NativeWorkScheduleCopy.notifyOptions,
                    selection: $draft.notifyPolicy
                )
                DesktopAutomationHint("These arrive by email, at the address on your account, once per thing worth saying — a run that finishes while a retry is still in flight does not write twice.")
            }
        }
        .disabled(locked)
    }

    // MARK: Save

    @ViewBuilder
    private var saveRow: some View {
        if !isReadOnly {
            HStack(spacing: JunoSpace.snug) {
                Button(action: submit) {
                    HStack(spacing: JunoSpace.tight) {
                        if saving {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text(isNew ? "Create schedule" : "Save changes")
                    }
                }
                .buttonStyle(.junoProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!draft.canSave || saving)
                .accessibilityIdentifier("juno.desktop.automation.save")
                // Ghost, as the web's WorkScheduleEditor has it (variant
                // "ghost"): one filled button beside Save, not two.
                Button(action: cancel) {
                    Text("Cancel")
                        .frame(minHeight: 28)
                        .contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(Color.junoSecondaryInk)
                .disabled(saving)
            }
        }
    }

    private func submit() {
        guard let body = draft.scheduleDraft, !saving else { return }
        saving = true
        refusal = nil
        Task {
            let sentence = await save(body)
            saving = false
            withAnimation(JunoMotion.base) { refusal = sentence }
        }
    }
}

// MARK: - Pieces

/// A section's name inside the editor: SF 13 semibold, a header, never the
/// web's mono label.
struct DesktopAutomationSectionTitle: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .junoType(JunoType.ui.weight(.semibold))
            .foregroundStyle(Color.junoForeground)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A caption under a field, in the secondary ink, or the warning ink when it
/// is the reason a save is refused.
struct DesktopAutomationHint: View {
    let text: String
    var warning = false

    init(_ text: String, warning: Bool = false) {
        self.text = text
        self.warning = warning
    }

    var body: some View {
        Text(text)
            .junoType(.caption)
            .foregroundStyle(warning ? Color.junoWarningInk : Color.junoSecondaryInk)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: JunoPageMetrics.ledeMeasure, alignment: .leading)
    }
}

/// A label above its control, and an optional hint below it (the web's
/// `Label` + input + caption).
struct DesktopAutomationField<Control: View>: View {
    let title: String
    let hint: String?
    @ViewBuilder let control: () -> Control

    init(title: String, @ViewBuilder control: @escaping () -> Control, hint: () -> String? = { nil }) {
        self.title = title
        self.control = control
        self.hint = hint()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(title)
                .junoType(JunoType.ui.weight(.medium))
                .foregroundStyle(Color.junoForeground)
            control()
            if let hint {
                DesktopAutomationHint(hint)
            }
        }
    }
}

/// A single-line field: the web's `Input` — 32pt, field radius, the `--input`
/// hairline, the neutral ring while focused.
struct DesktopAutomationTextField: View {
    let placeholder: String
    @Binding var text: String

    @FocusState private var focused: Bool
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        // The prompt in the secondary ink: lighter than a value, so it never
        // reads as one, and still at AA on the field.
        TextField(placeholder, text: $text, prompt: Text(placeholder).foregroundColor(Color.junoSecondaryInk))
            .textFieldStyle(.plain)
            .junoType(.ui)
            .focused($focused)
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: JunoPageMetrics.controlHeight)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .fill(Color.junoRaised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(focused ? Color.junoRing : Color.junoInput, lineWidth: 1)
            )
            .opacity(isEnabled ? 1 : 0.6)
            .accessibilityLabel(placeholder)
    }
}

/// The multi-line brief: the web's `Textarea`, four lines tall to start.
struct DesktopAutomationTextEditor: View {
    let placeholder: String
    @Binding var text: String

    @FocusState private var focused: Bool
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        TextEditor(text: $text)
            .junoType(.ui)
            .scrollContentBackground(.hidden)
            .focused($focused)
            .frame(minHeight: 96)
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.snug)
            .overlay(alignment: .topLeading) {
                if text.isEmpty {
                    Text(placeholder)
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .padding(.horizontal, JunoSpace.cozy)
                        .padding(.vertical, JunoSpace.snug)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .fill(Color.junoRaised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(focused ? Color.junoRing : Color.junoInput, lineWidth: 1)
            )
            .opacity(isEnabled ? 1 : 0.6)
            .accessibilityLabel("What it should do")
    }
}

/// A read-only fact of a Code automation.
struct DesktopAutomationReadOnlyRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
            Text(label)
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 112, alignment: .leading)
            Text(value)
                .junoType(.ui)
                .foregroundStyle(Color.junoForeground)
                .textSelection(.enabled)
        }
    }
}

/// One policy as radio rows (`PolicyGroup`): the label, then each option's
/// words and the sentence under them. The selected row takes the secondary
/// fill and a darker edge; its mark is the foreground ink, never the accent.
struct DesktopAutomationPolicyGroup: View {
    let label: String
    let options: [NativeWorkScheduleCopy.PolicyOption]
    @Binding var selection: String
    /// Off where the group already sits under a heading of its own.
    var showsLabel = true

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            if showsLabel {
                Text(label)
                    .junoType(JunoType.ui.weight(.medium))
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
            }
            VStack(spacing: JunoSpace.tight) {
                ForEach(options) { option in
                    DesktopAutomationRadioRow(
                        option: option,
                        isSelected: option.value == selection,
                        select: { selection = option.value }
                    )
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }
}

private struct DesktopAutomationRadioRow: View {
    let option: NativeWorkScheduleCopy.PolicyOption
    let isSelected: Bool
    let select: () -> Void

    @State private var isHovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: select) {
            HStack(alignment: .top, spacing: JunoSpace.close) {
                JunoRadioMark(isOn: isSelected)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    Text(option.label)
                        .junoType(JunoType.ui.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                    Text(option.hint)
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .fill(isSelected ? Color.junoSecondary : (isHovering && isEnabled ? Color.junoHover : Color.clear))
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(
                        isSelected ? Color.junoForeground.opacity(0.25) : Color.junoBorder.opacity(0.5),
                        lineWidth: 1
                    )
            )
            .contentShape(.rect(cornerRadius: JunoRadius.field))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

// MARK: - Triggers

/// "Add a trigger": the clock kinds, then the event kinds, each with its
/// hint as the item's subtitle. Title Case in the menu, the web's words.
struct DesktopAutomationAddTrigger: View {
    let add: (String) -> Void

    /// The web's labels in Title Case, for the native menu (§0.7).
    static func menuTitle(_ kind: String) -> String {
        switch kind {
        case "email_filter": "An Email Arrives"
        case "calendar_window": "A Meeting Is Coming Up"
        case "topic_monitor": "A Topic Is Mentioned"
        case "connector_event": "A Connected App Sends an Event"
        case "folder_change": "A Folder Changes"
        case "manual": "Only When You Press Run"
        case "api": "Something Calls It"
        default: NativeWorkScheduleCopy.triggerLabel(kind)
        }
    }

    var body: some View {
        Menu {
            Section("On a Clock") {
                ForEach(NativeWorkScheduleCopy.clockKinds) { kind in
                    item(kind)
                }
            }
            Section("On Something Happening") {
                ForEach(NativeWorkScheduleCopy.eventKinds) { kind in
                    item(kind)
                }
            }
        } label: {
            Label("Add a trigger", icon: .plus)
        }
        .menuStyle(.button)
        .buttonStyle(.junoGlass)
        .tint(nil)
        .fixedSize()
        .accessibilityIdentifier("juno.desktop.automation.add-trigger")
    }

    private func item(_ kind: NativeWorkScheduleCopy.TriggerKind) -> some View {
        Button {
            add(kind.kind)
        } label: {
            Text(Self.menuTitle(kind.kind))
            Text(kind.hint)
        }
    }
}

/// One trigger: its mark and name, an On/Off switch, Remove, the sentence it
/// adds up to, and its fields.
struct DesktopAutomationTriggerRow: View {
    @Binding var trigger: NativeWorkScheduleTriggerDraft
    let canRemove: Bool
    let grants: [NativeWorkHostGrant]?
    let locked: Bool
    let remove: () -> Void

    private var isKnown: Bool {
        NativeWorkScheduleCopy.allKinds.contains { $0.kind == trigger.kind }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(NativeWorkScheduleCopy.isClockKind(trigger.kind) ? .clock : .circleDot, size: 16)
                    .foregroundStyle(Color.junoMutedForeground)
                    .accessibilityHidden(true)
                Text(NativeWorkScheduleCopy.triggerLabel(trigger.kind))
                    .junoType(JunoType.ui.weight(.medium))
                    .foregroundStyle(Color.junoForeground)
                Spacer(minLength: JunoSpace.snug)
                Text(trigger.enabled ? "On" : "Off")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                Toggle(isOn: $trigger.enabled) { EmptyView() }
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .tint(Color.junoAccent)
                    .labelsHidden()
                    .accessibilityLabel("\(NativeWorkScheduleCopy.triggerLabel(trigger.kind)) trigger enabled")
                    .disabled(locked)
                Button(action: remove) {
                    JunoIconView(.trash, size: 15)
                        .foregroundStyle(Color.junoMutedForeground)
                        .frame(width: 28, height: 28)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .disabled(locked || !canRemove)
                .help(canRemove ? "Remove this trigger" : "A schedule needs at least one trigger. Change this one instead.")
                .accessibilityLabel("Remove this trigger")
            }
            Text(NativeWorkScheduleCopy.describe(trigger))
                .junoType(.caption)
                .monospacedDigit()
                .foregroundStyle(Color.junoSecondaryInk)
            DesktopAutomationTriggerFields(trigger: $trigger, grants: grants, isKnown: isKnown)
                .disabled(locked)
                .padding(.top, JunoSpace.tight)
        }
        .padding(.horizontal, JunoSpace.comfy)
        .padding(.vertical, JunoSpace.cozy)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoRaised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(0.6), lineWidth: 1)
        )
    }
}

/// A trigger's fields (`TriggerConfigFields`), per kind, with the web's
/// labels, placeholders and hints.
struct DesktopAutomationTriggerFields: View {
    @Binding var trigger: NativeWorkScheduleTriggerDraft
    let grants: [NativeWorkHostGrant]?
    let isKnown: Bool

    var body: some View {
        switch trigger.kind {
        case "manual":
            DesktopAutomationHint("Nothing to configure. This schedule sits still until you press Run now.")
        case "api":
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                DesktopAutomationHint("A fire starts this automation and carries nothing with it. Its task is what you wrote, and every run is validated against that — so there is nowhere a caller’s words could go that the run would read.")
                DesktopAutomationHint("The fire URL and its token live under “Firing this from elsewhere”, below.")
            }
        case "once":
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                number("Year", "year", fallback: Calendar.current.component(.year, from: Date()), range: 1970...9999)
                choice("Month", "month", options: monthOptions, fallback: 1)
                number("Day", "day", fallback: 1, range: 1...31, hint: "A day that does not exist in the month is refused when you save.")
                number("Hour", "hour", fallback: 9, range: 0...23)
                number("Minute", "minute", fallback: 0, range: 0...59)
            }
        case "hourly":
            number("Minutes past the hour", "minute", fallback: 0, range: 0...59)
                .frame(maxWidth: 200, alignment: .leading)
        case "daily", "weekdays":
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                number("Hour", "hour", fallback: 9, range: 0...23)
                number("Minute", "minute", fallback: 0, range: 0...59)
            }
            .frame(maxWidth: 320, alignment: .leading)
        case "weekly":
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                choice("Day", "weekday", options: weekdayOptions, fallback: 1)
                number("Hour", "hour", fallback: 9, range: 0...23)
                number("Minute", "minute", fallback: 0, range: 0...59)
            }
        case "monthly":
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                number("Day of the month", "monthday", fallback: 1, range: 1...31, hint: "31 means the last day of a shorter month, not a month that is skipped.")
                number("Hour", "hour", fallback: 9, range: 0...23)
                number("Minute", "minute", fallback: 0, range: 0...59)
            }
        case "yearly":
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                choice("Month", "month", options: monthOptions, fallback: 1)
                number("Day", "monthday", fallback: 1, range: 1...31)
                number("Hour", "hour", fallback: 9, range: 0...23)
                number("Minute", "minute", fallback: 0, range: 0...59)
            }
        case "cron":
            text("Expression", "expression", placeholder: "0 9 * * 1-5", hint: "Five fields: minute hour day-of-month month day-of-week. Numbers only — 0 or 7 for Sunday.")
        case "email_filter":
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                list("From", "from", placeholder: "@stripe.com, invoices@", hint: "Any one of these matching the sender is enough. Substrings, so a bare domain works. Empty means any sender.")
                list("Never from", "excludeFrom", hint: "Checked before anything else. A match here vetoes the trigger.")
                list("Subject contains", "subjectContains", hint: "Every phrase listed must appear.")
                list("Subject must not contain", "excludeSubjectContains", hint: "Any one of these appearing vetoes the trigger.")
                unservable("Labels", field: "labels", asked: !listText("labels").isEmpty) { trigger.config["labels"] = .array([]) }
                unservable("Attachments", field: "requireAttachment", asked: bool("requireAttachment")) { trigger.config["requireAttachment"] = .bool(false) }
            }
        case "calendar_window":
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                HStack(alignment: .top, spacing: JunoSpace.cozy) {
                    number("Minutes before it starts", "leadMinutes", fallback: 10, range: 0...1440)
                    number("Shortest meeting (minutes)", "minDurationMinutes", fallback: 0, range: 0...1440)
                }
                list("Title contains", "titleContains", hint: "Any one of these is enough. Empty means any title.")
                list("Calendars", "calendarIds", hint: "Empty means every calendar the connector exposes.")
                unservable("Attendees", field: "requireAttendees", asked: bool("requireAttendees")) { trigger.config["requireAttendees"] = .bool(false) }
            }
        case "topic_monitor":
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                list("Terms", "terms", placeholder: "acquisition, funding round")
                HStack(alignment: .bottom, spacing: JunoSpace.cozy) {
                    number("Sources needed", "minSources", fallback: 1, range: 1...50, hint: "How many independent sources must have mentioned it.")
                    switchRow("Every term, not just one", "requireAll")
                }
            }
        case "connector_event":
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                text("Connector", "connector", placeholder: "github", hint: "Required. A connector-event trigger with no connector is refused when you save.")
                list("Events", "events", placeholder: "issue.opened, pull_request.merged", hint: "Empty means every event that connector sends.")
            }
        case "folder_change":
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                folderField
                HStack(alignment: .top, spacing: JunoSpace.cozy) {
                    list("File types", "suffixes", placeholder: ".csv, .xlsx", hint: "Empty means any file.")
                    number("Files changed", "minChangedFiles", fallback: 1, range: 1...1000, hint: "Fewer than this and the change is ignored.")
                }
            }
        default:
            DesktopAutomationHint("This trigger was set up by a newer version of Alevr. It is left untouched, and saving does not change it.")
        }
    }

    // MARK: Fields

    private var folderField: some View {
        DesktopAutomationField(title: "Folder") {
            if let grants {
                if grants.isEmpty {
                    DesktopAutomationHint("That Mac has not given Alevr access to any folder yet, so there is nothing for this trigger to watch. Grant one in the Alevr app on that Mac.", warning: true)
                } else {
                    JunoPageMenu(
                        options: [JunoPageMenuOption("", "Choose a folder…")]
                            + grants.map { JunoPageMenuOption($0.id, $0.displayName) },
                        selection: stringBinding("grantId"),
                        accessibilityLabel: "Folder"
                    )
                }
            } else {
                DesktopAutomationHint("Pick the Mac this schedule runs on, above, and its granted folders appear here.")
            }
        } hint: {
            "Folders are granted on the Mac itself, in the Alevr app. This list is what that Mac has given Alevr access to."
        }
    }

    private var weekdayOptions: [JunoPageMenuOption<Int>] {
        NativeWorkScheduleCopy.weekdayNames.enumerated().map { JunoPageMenuOption($0.offset, $0.element) }
    }

    private var monthOptions: [JunoPageMenuOption<Int>] {
        NativeWorkScheduleCopy.monthNames.enumerated().map { JunoPageMenuOption($0.offset + 1, $0.element) }
    }

    private func number(
        _ label: String, _ key: String, fallback: Int, range: ClosedRange<Int>, hint: String? = nil
    ) -> some View {
        DesktopAutomationField(title: label) {
            DesktopAutomationNumberField(
                label: label,
                value: Binding(
                    get: { intValue(key, fallback) },
                    set: { trigger.config[key] = .number(Double(min(range.upperBound, max(range.lowerBound, $0)))) }
                )
            )
        } hint: {
            hint
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func choice(
        _ label: String, _ key: String, options: [JunoPageMenuOption<Int>], fallback: Int
    ) -> some View {
        DesktopAutomationField(title: label) {
            JunoPageMenu(
                options: options,
                selection: Binding(
                    get: { intValue(key, fallback) },
                    set: { trigger.config[key] = .number(Double($0)) }
                ),
                accessibilityLabel: label
            )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func text(_ label: String, _ key: String, placeholder: String, hint: String? = nil) -> some View {
        DesktopAutomationField(title: label) {
            DesktopAutomationTextField(placeholder: placeholder, text: stringBinding(key))
        } hint: {
            hint
        }
    }

    private func list(_ label: String, _ key: String, placeholder: String = "", hint: String? = nil) -> some View {
        DesktopAutomationField(title: label) {
            DesktopAutomationTextField(
                placeholder: placeholder.isEmpty ? label : placeholder,
                text: Binding(
                    get: { listText(key) },
                    set: { raw in
                        let values = raw.split(separator: ",")
                            .map { $0.trimmingCharacters(in: .whitespaces) }
                            .filter { !$0.isEmpty }
                        trigger.config[key] = .array(values.map { .string($0) })
                    }
                )
            )
        } hint: {
            hint
        }
    }

    private func switchRow(_ label: String, _ key: String) -> some View {
        Toggle(isOn: Binding(get: { bool(key) }, set: { trigger.config[key] = .bool($0) })) {
            Text(label)
                .junoType(.ui)
                .foregroundStyle(Color.junoForeground)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .toggleStyle(.switch)
        .controlSize(.small)
        .tint(Color.junoAccent)
        .padding(.horizontal, JunoSpace.cozy)
        .frame(height: JunoPageMetrics.controlHeight)
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(0.5), lineWidth: 1)
        )
    }

    /// An option the source cannot answer (`UnservableOption`): named, with
    /// why, and a way to drop it when this trigger still asks for it.
    private func unservable(_ label: String, field: String, asked: Bool, clear: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(label)
                .junoType(JunoType.ui.weight(.medium))
                .foregroundStyle(Color.junoForeground)
            DesktopAutomationHint(NativeWorkScheduleCopy.optionLimit(kind: trigger.kind, field: field) ?? "")
            if asked {
                DesktopAutomationHint("This trigger still asks for it, so it will not start a run until the condition is removed.", warning: true)
                Button("Remove this condition", action: clear)
                    .buttonStyle(.junoGlass)
                    .tint(nil)
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoSecondary)
        )
    }

    // MARK: Config access

    private func intValue(_ key: String, _ fallback: Int) -> Int {
        guard let value = trigger.config[key]?.numberValue, value.isFinite else { return fallback }
        return Int(value)
    }

    private func bool(_ key: String) -> Bool { trigger.config[key]?.boolValue == true }

    private func listText(_ key: String) -> String {
        guard case .array(let values)? = trigger.config[key] else { return "" }
        return values.compactMap(\.stringValue).joined(separator: ", ")
    }

    private func stringBinding(_ key: String) -> Binding<String> {
        Binding(
            get: { trigger.config[key]?.stringValue ?? "" },
            set: { trigger.config[key] = .string($0) }
        )
    }
}

/// A whole number in a field, clamped by the caller on every edit.
struct DesktopAutomationNumberField: View {
    let label: String
    @Binding var value: Int

    @FocusState private var focused: Bool
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        TextField(label, value: $value, format: .number.grouping(.never))
            .textFieldStyle(.plain)
            .junoType(.ui)
            .monospacedDigit()
            .focused($focused)
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: JunoPageMetrics.controlHeight)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .fill(Color.junoRaised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(focused ? Color.junoRing : Color.junoInput, lineWidth: 1)
            )
            .opacity(isEnabled ? 1 : 0.6)
            .accessibilityLabel(label)
    }
}

// MARK: - The arming card

/// "What you are switching on" (`ScheduleArmingCard`): the automation in
/// plain sentences — when, where, what, and what happens unattended — between
/// the form and its Save, so what is about to be armed is read whole first.
struct DesktopAutomationArmingCard: View {
    let draft: DesktopAutomationDraft
    let hostName: String?
    var isCode = false

    private var when: String {
        let active = draft.triggers.filter(\.enabled)
        guard !active.isEmpty else { return "Nothing will start it — every trigger is switched off." }
        let sentence = active.map(NativeWorkScheduleCopy.describe).joined(separator: " · ")
        let zone = draft.timezone.trimmingCharacters(in: .whitespacesAndNewlines)
        return zone.isEmpty ? sentence : "\(sentence) · times are \(zone)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text(draft.enabled ? "What you are switching on" : "What you are saving")
                .junoType(JunoType.ui.weight(.semibold))
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            if !draft.enabled {
                Text("This is saved paused. Nothing runs until you switch it on.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                row("When", when)
                if !isCode {
                    row("Runs on", NativeWorkScheduleCopy.armingTarget(target: draft.target, hostName: hostName))
                }
                row(
                    "What it does",
                    draft.instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? "Not written yet." : draft.instructions.trimmingCharacters(in: .whitespacesAndNewlines),
                    muted: draft.instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
                if !isCode {
                    let offline = NativeWorkScheduleCopy.armingOffline(draft.hostOfflinePolicy, target: draft.target)
                    row(
                        "Unattended",
                        NativeWorkScheduleCopy.armingUnattended(draft.unattendedPolicy)
                            + (offline.isEmpty ? "" : " \(offline)")
                    )
                }
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.comfy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoCard(cornerRadius: JunoRadius.card)
        .accessibilityElement(children: .contain)
    }

    private func row(_ label: String, _ value: String, muted: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
            Text(label)
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 112, alignment: .leading)
            Text(value)
                .junoType(.ui)
                .foregroundStyle(muted ? Color.junoSecondaryInk : Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }
}
