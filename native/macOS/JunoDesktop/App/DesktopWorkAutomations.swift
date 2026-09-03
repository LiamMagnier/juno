import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// The native Work automation control plane.
///
/// This is deliberately an inline two-pane surface rather than another
/// `NavigationSplitView`: Work already owns the window's split view, and a
/// nested split view makes macOS negotiate two independent column systems in
/// the same detail column. The left pane is a compact automation index; the
/// right pane is the selected automation's contract and monitoring timeline.
struct DesktopWorkAutomationsView: View {
    let model: NativeWorkAutomationModel
    let workModel: NativeWorkModel
    let modelOptions: [NativeChatModelOption]

    @State private var selectedScheduleID: String?
    @State private var editingScheduleID: String?
    @State private var editorDraft = NativeWorkScheduleDraft()
    @State private var isEditorPresented = false
    @State private var deleteCandidate: NativeWorkSchedule?
    @State private var showingDeleteConfirmation = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var selectedSchedule: NativeWorkSchedule? {
        guard let selectedScheduleID else { return nil }
        return model.schedules.first { $0.id == selectedScheduleID }
    }

    var body: some View {
        HStack(spacing: 0) {
            automationList
                .frame(minWidth: 280, idealWidth: 310, maxWidth: 350)
            Divider()
            automationDetail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color.junoCanvas)
        .task {
            await model.refresh()
            selectInitialScheduleIfNeeded()
        }
        .onChange(of: model.schedules.map(\.id), initial: true) { _, _ in
            selectInitialScheduleIfNeeded()
        }
        .sheet(isPresented: $isEditorPresented) {
            DesktopWorkAutomationEditor(
                draft: $editorDraft,
                isNew: editingScheduleID == nil,
                hosts: workModel.hosts,
                modelOptions: modelOptions,
                onCancel: { isEditorPresented = false },
                onSave: saveEditorDraft
            )
            .frame(minWidth: 620, minHeight: 680)
        }
        .confirmationDialog(
            "Delete this automation?",
            isPresented: $showingDeleteConfirmation,
            presenting: deleteCandidate
        ) { schedule in
            Button("Delete Automation", role: .destructive) {
                Task {
                    await model.delete(id: schedule.id)
                    if selectedScheduleID == schedule.id { selectedScheduleID = nil }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { schedule in
            Text("This removes \(schedule.name) and stops future fires. Runs already under way continue.")
        }
        .accessibilityIdentifier("juno.work.automations")
    }

    private var automationList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Automations")
                        .font(.title3.weight(.semibold))
                    Text("Background work that runs on your terms.")
                        .junoCaption()
                }
                Spacer(minLength: JunoSpace.tight)
                Button {
                    beginNewAutomation()
                } label: {
                    JunoIconLabel("New", icon: .plus, size: 13)
                }
                .buttonStyle(.bordered)
                .help("Create an automation")
                .accessibilityIdentifier("juno.work.automations.new")
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.region)
            .padding(.bottom, JunoSpace.cozy)

            if model.phase == .loading && model.schedules.isEmpty {
                ProgressView("Loading automations…")
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, JunoSpace.regular)
                    .padding(.vertical, JunoSpace.cozy)
            } else if model.schedules.isEmpty {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    JunoIconView(.clock, size: 22)
                        .foregroundStyle(Color.junoAccent)
                    Text("Nothing is scheduled yet")
                        .font(.headline)
                    Text("Set up a recurring or event-driven errand and Juno will keep watch for you.")
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Create an automation", action: beginNewAutomation)
                        .buttonStyle(.borderedProminent)
                        .tint(Color.junoAccent)
                        .padding(.top, JunoSpace.tight)
                }
                .padding(JunoSpace.regular)
                // A card, not glass: this box is static content sitting in the
                // index pane, and the material is reserved for chrome that
                // floats. It was also carrying a diluted accent tint, which
                // the full-alpha tint rule forbids — glass honours the alpha,
                // so what was behind the window leaked into the wash.
                .junoCard(cornerRadius: JunoRadius.card)
                .padding(.horizontal, JunoSpace.regular)
                .padding(.top, JunoSpace.tight)
            } else {
                ScrollView {
                    LazyVStack(spacing: JunoSpace.hairline) {
                        ForEach(model.schedules) { schedule in
                            automationRow(schedule)
                        }
                    }
                    .padding(.horizontal, JunoSpace.tight)
                    .padding(.bottom, JunoSpace.regular)
                }
                .scrollIndicators(.never)
            }

            Spacer(minLength: 0)
            if let error = model.lastErrorDescription, model.phase != .ready {
                HStack(alignment: .top, spacing: JunoSpace.tight) {
                    JunoIconView(.error, size: 13)
                    Text(error)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Button("Retry") { Task { await model.refresh() } }
                        .buttonStyle(.bordered)
                }
                .font(.caption)
                .junoSecondaryInk()
                .padding(JunoSpace.regular)
            }
        }
        .background(Color.junoSidebar)
    }

    private func automationRow(_ schedule: NativeWorkSchedule) -> some View {
        Button {
            // Selection rides the ladder's standard rung. The inline 0.18 it
            // replaces sat between `fast` (0.12) and `base` (0.22) — exactly
            // the near-miss the ladder exists to prevent — and never consulted
            // Reduce Motion, which the detail pane's swap is travel enough to
            // owe.
            withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                selectedScheduleID = schedule.id
            }
            Task { await model.loadRuns(for: schedule.id) }
        } label: {
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                JunoIconView(schedule.enabled ? .clock : .pause, size: 15)
                    .foregroundStyle(schedule.enabled ? Color.junoAccent : Color.junoMutedForeground)
                    .frame(width: 22)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: JunoSpace.tight) {
                        Text(schedule.name)
                            .font(.system(.body, design: .default, weight: .medium))
                            .lineLimit(1)
                        if schedule.hasUnknownTrigger {
                            JunoIconView(.error, size: 11)
                                .foregroundStyle(Color.junoCaution)
                                .help("This automation contains a trigger from a newer Juno version.")
                        }
                        Spacer(minLength: JunoSpace.hairline)
                    }
                    Text(schedule.enabled ? nextFireText(schedule) : "Paused")
                        .junoCaption()
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.snug)
        }
        .buttonStyle(.plain)
        .background(
            selectedScheduleID == schedule.id ? Color.junoRowSelected : .clear,
            in: RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
        )
        .contextMenu {
            Button("Edit Automation") { beginEdit(schedule) }
            Button(schedule.enabled ? "Pause" : "Resume") {
                Task { await model.setEnabled(id: schedule.id, enabled: !schedule.enabled) }
            }
            Button("Run Now") { Task { await model.runNow(id: schedule.id) } }
            Divider()
            Button("Delete Automation", role: .destructive) {
                deleteCandidate = schedule
                showingDeleteConfirmation = true
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(schedule.name). \(schedule.enabled ? "Active" : "Paused"). \(nextFireText(schedule))")
        .accessibilityIdentifier("juno.work.automation.\(schedule.id)")
    }

    @ViewBuilder
    private var automationDetail: some View {
        if let schedule = selectedSchedule {
            DesktopWorkAutomationDetail(
                schedule: schedule,
                model: model,
                workModel: workModel,
                onEdit: { beginEdit(schedule) },
                onDelete: {
                    deleteCandidate = schedule
                    showingDeleteConfirmation = true
                }
            )
        } else {
            VStack(spacing: JunoSpace.snug) {
                JunoIconView(.clock, size: 34)
                    .foregroundStyle(Color.junoAccent)
                Text("Choose an automation")
                    .font(.title3.weight(.semibold))
                Text("See what will start it, where it can run, and the last time it did.")
                    .junoCaption()
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .junoReadingCanvas()
        }
    }

    private func selectInitialScheduleIfNeeded() {
        guard let selectedScheduleID else {
            selectedScheduleID = model.schedules.first?.id
            if let id = model.schedules.first?.id { Task { await model.loadRuns(for: id) } }
            return
        }
        if !model.schedules.contains(where: { $0.id == selectedScheduleID }) {
            self.selectedScheduleID = model.schedules.first?.id
        }
    }

    private func beginNewAutomation() {
        editingScheduleID = nil
        editorDraft = NativeWorkScheduleDraft()
        isEditorPresented = true
    }

    private func beginEdit(_ schedule: NativeWorkSchedule) {
        editingScheduleID = schedule.id
        editorDraft = schedule.draft
        isEditorPresented = true
    }

    private func saveEditorDraft(_ draft: NativeWorkScheduleDraft) {
        let editingID = editingScheduleID
        Task {
            let saved = if let editingID {
                await model.update(id: editingID, draft: draft)
            } else {
                await model.create(draft)
            }
            if let saved {
                selectedScheduleID = saved.id
                await model.loadRuns(for: saved.id)
                isEditorPresented = false
            }
        }
    }

    private func nextFireText(_ schedule: NativeWorkSchedule) -> String {
        guard let next = schedule.nextRunAt else {
            return schedule.triggers.map { NativeWorkScheduleVocabulary.trigger($0.kind) }.joined(separator: " · ")
        }
        return "Next \(next.formatted(.relative(presentation: .named)))"
    }
}

private struct DesktopWorkAutomationDetail: View {
    let schedule: NativeWorkSchedule
    let model: NativeWorkAutomationModel
    let workModel: NativeWorkModel
    let onEdit: () -> Void
    let onDelete: () -> Void

    private var runs: [NativeWorkScheduleRun] {
        model.recentRunsScheduleID == schedule.id ? model.recentRuns : []
    }

    var body: some View {
        ScrollView {
            JunoDetailPage(maxWidth: 820) {
                VStack(alignment: .leading, spacing: JunoSpace.section) {
                    header
                    if let message = model.lastMutationExplanation {
                        HStack(alignment: .top, spacing: JunoSpace.tight) {
                            JunoIconView(.check, size: 14)
                                .foregroundStyle(Color.junoSuccess)
                            Text(message)
                                .junoCaption()
                            Spacer(minLength: 0)
                            Button {
                                model.clearMutationMessage()
                            } label: {
                                JunoIconView(.close, size: 12)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Dismiss message")
                        }
                        .padding(JunoSpace.snug)
                        // A card, not glass: an inline confirmation is content
                        // in the page's own flow, not chrome floating over it.
                        // The success colour stays on the checkmark, where it
                        // is full-alpha, rather than as the diluted tint the
                        // glass carried.
                        .junoCard(cornerRadius: JunoRadius.card)
                    }
                    triggerSection
                    contractSection
                    runHistory
                }
            }
        }
        .scrollIndicators(.never)
        .junoReadingCanvas()
        .task(id: schedule.id) { await model.loadRuns(for: schedule.id) }
        .onChange(of: schedule.id, initial: true) { _, _ in
            Task { await model.loadRuns(for: schedule.id) }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .top, spacing: JunoSpace.regular) {
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    Text("AUTOMATION")
                        .font(.caption.weight(.semibold))
                        .tracking(1.1)
                        .foregroundStyle(Color.junoAccent)
                    // The editorial serif, as every other user-named page title
                    // — a project's name, a Work task's heading — is set. SF
                    // Rounded was a third face the two-face type scale does not
                    // have, pinned at 30pt where Dynamic Type could not move it.
                    Text(schedule.name)
                        .junoPageHeading()
                    Text(schedule.instructions)
                        .junoBody()
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: JunoSpace.regular)
                Menu {
                    Button(schedule.enabled ? "Pause Automation" : "Resume Automation") {
                        Task { await model.setEnabled(id: schedule.id, enabled: !schedule.enabled) }
                    }
                    Button("Run Now") { Task { await model.runNow(id: schedule.id) } }
                    Divider()
                    Button("Edit Automation", action: onEdit)
                    Button("Delete Automation", role: .destructive, action: onDelete)
                } label: {
                    JunoIconView(.ellipsis, size: 15)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Automation actions")
            }

            HStack(spacing: JunoSpace.tight) {
                JunoIconLabel(
                    verbatim: schedule.enabled ? "Active" : "Paused",
                    icon: schedule.enabled ? .check : .pause,
                    size: 12
                )
                    .foregroundStyle(schedule.enabled ? Color.junoSuccess : Color.junoMutedForeground)
                Text("·")
                    .junoSecondaryInk()
                Text(targetText)
                    .junoCaption()
                if let next = schedule.nextRunAt {
                    Text("·")
                        .junoSecondaryInk()
                    Text("Next \(next.formatted(.relative(presentation: .named)))")
                        .junoCaption()
                }
            }
            .font(.subheadline.weight(.medium))
        }
    }

    private var triggerSection: some View {
        DesktopWorkAutomationSection(title: "Starts when", icon: .work) {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                ForEach(schedule.triggers) { trigger in
                    HStack(alignment: .top, spacing: JunoSpace.snug) {
                        JunoIconView(.circleDot, size: 11)
                            .foregroundStyle(trigger.enabled ? Color.junoAccent : Color.junoMutedForeground)
                            .padding(.top, 4)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(NativeWorkScheduleVocabulary.trigger(trigger.kind))
                                .font(.body.weight(.medium))
                            Text(triggerSummary(trigger))
                                .junoCaption()
                            if trigger.lastFiredAt != nil {
                                Text("Last fired \(trigger.lastFiredAt!.formatted(.relative(presentation: .named)))")
                                    .junoCaption()
                            }
                        }
                        Spacer(minLength: 0)
                    }
                }
                if schedule.hasUnknownTrigger {
                    JunoIconLabel(
                        "A newer Juno version added one of these triggers. It will stay intact when you edit this automation.",
                        icon: .about,
                        size: 13
                    )
                        .junoCaption()
                        .foregroundStyle(Color.junoCaution)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var contractSection: some View {
        DesktopWorkAutomationSection(title: "Run contract", icon: .shield) {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: JunoSpace.regular) {
                contractFact("Target", targetText, .device)
                contractFact("Safety", policyText(schedule.unattendedPolicy), .permission)
                contractFact("If the Mac is offline", policyText(schedule.hostOfflinePolicy), .connections)
                contractFact("Missed fires", policyText(schedule.missedRunPolicy), .clock)
                contractFact("Notifications", policyText(schedule.notifyPolicy), .bell)
                contractFact("Concurrency", "Up to \(schedule.maxConcurrentRuns)", .archive)
            }
            if let modelName = schedule.model {
                Divider()
                HStack(spacing: JunoSpace.tight) {
                    Text("Model")
                        .junoCaption()
                    Text(modelName)
                        .font(.subheadline.weight(.medium))
                }
            }
            if !schedule.requiredCapabilities.isEmpty {
                Divider()
                HStack(alignment: .top, spacing: JunoSpace.snug) {
                    Text("Capabilities")
                        .junoCaption()
                    Text(schedule.requiredCapabilities.map(NativeWorkScheduleVocabulary.sentenceCase).joined(separator: " · "))
                        .font(.subheadline.weight(.medium))
                }
            }
        }
    }

    private var runHistory: some View {
        DesktopWorkAutomationSection(title: "Recent runs", icon: .history) {
            if runs.isEmpty {
                Text("No runs yet. Run it once to confirm the contract and see its first result here.")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(spacing: 0) {
                    ForEach(runs) { run in
                        HStack(spacing: JunoSpace.snug) {
                            JunoIconView(runIcon(run.status), size: 14)
                                .foregroundStyle(runColor(run.status))
                                .frame(width: 20)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(runStatus(run.status))
                                    .font(.subheadline.weight(.medium))
                                Text(run.createdAt?.formatted(.relative(presentation: .named)) ?? "Recently")
                                    .junoCaption()
                            }
                            Spacer(minLength: 0)
                            Text(run.effectiveTarget.map(NativeWorkScheduleVocabulary.sentenceCase) ?? "Queued")
                                .junoCaption()
                        }
                        .padding(.vertical, JunoSpace.snug)
                        if run.id != runs.last?.id { Divider() }
                    }
                }
            }
        }
    }

    private func contractFact(_ title: String, _ value: String, _ icon: JunoIcon) -> some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            JunoIconView(icon, size: 14)
                .foregroundStyle(Color.junoMutedForeground)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).junoCaption()
                Text(value).font(.subheadline.weight(.medium))
            }
        }
    }

    private var targetText: String {
        switch schedule.target {
        case "local": return "Runs on \(schedule.hostID ?? "your Mac")"
        case "cloud": return "Runs in the cloud"
        default: return "Juno chooses where it runs"
        }
    }

    private func policyText(_ raw: String) -> String {
        switch raw {
        case "pause_for_approval": return "Stop and ask"
        case "skip_irreversible": return "Skip irreversible work"
        case "disallow_irreversible": return "End before irreversible work"
        case "wait": return "Wait for the Mac"
        case "cloud_subset": return "Do the cloud part"
        case "skip": return "Skip this one"
        case "run_once": return "Catch up once"
        case "run_all": return "Catch up every fire"
        case "none": return "Never"
        case "on_attention": return "When it needs you"
        case "on_finish": return "When it finishes"
        case "all": return "Everything"
        default: return NativeWorkScheduleVocabulary.sentenceCase(raw)
        }
    }

    private func triggerSummary(_ trigger: NativeWorkScheduleTrigger) -> String {
        if let expression = trigger.config["expression"]?.stringValue { return expression }
        let hour = trigger.config["hour"]?.numberValue.map { Int($0) }
        let minute = trigger.config["minute"]?.numberValue.map { Int($0) }
        if let hour, let minute {
            return String(format: "%02d:%02d · %@", hour, minute, schedule.timezone)
        }
        if !trigger.config.isEmpty { return "Configured in the automation" }
        return schedule.timezone
    }

    private func runStatus(_ raw: String) -> String {
        switch raw {
        case "queued": return "Queued"
        case "preparing": return "Preparing"
        case "running": return "Running"
        case "completed": return "Completed"
        case "failed": return "Couldn’t finish"
        case "cancelled": return "Stopped"
        default: return NativeWorkScheduleVocabulary.sentenceCase(raw)
        }
    }

    private func runIcon(_ raw: String) -> JunoIcon {
        switch raw {
        case "completed": return .check
        case "failed", "cancelled": return .error
        case "running", "preparing": return .loader
        default: return .clock
        }
    }

    private func runColor(_ raw: String) -> Color {
        switch raw {
        case "completed": return Color.junoSuccess
        case "failed", "cancelled": return Color.junoDanger
        case "running", "preparing": return Color.junoAccent
        default: return Color.junoMutedForeground
        }
    }
}

private struct DesktopWorkAutomationSection<Content: View>: View {
    let title: String
    let icon: JunoIcon
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            JunoIconLabel(verbatim: title, icon: icon, size: 14)
                .junoTitle()
                .junoInk()
            content()
        }
        .padding(JunoSpace.regular)
        // A card, not glass. These sections *are* the reading content of the
        // page — the contract, the run history — and the desktop vocabulary
        // reserves the material for chrome floating over content, never under
        // it: long-form text on a translucent ground loses contrast with
        // whatever is behind the window. The diluted `junoSurface` tint the
        // glass carried was this fill trying to exist; `junoCard` is that
        // fill said properly, at full alpha, with the web's hairline and throw.
        .junoCard(cornerRadius: JunoRadius.card)
    }
}

private struct DesktopWorkAutomationEditor: View {
    @Binding var draft: NativeWorkScheduleDraft
    let isNew: Bool
    let hosts: [WorkHostSummary]
    let modelOptions: [NativeChatModelOption]
    let onCancel: () -> Void
    let onSave: (NativeWorkScheduleDraft) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var showingAdvanced = false
    @State private var validationMessage: String?

    private let triggerKinds = [
        "once", "hourly", "daily", "weekdays", "weekly", "monthly", "yearly", "cron",
        "email_filter", "calendar_window", "topic_monitor", "connector_event", "folder_change", "manual",
    ]

    private var reachableHosts: [WorkHostSummary] {
        hosts.filter(\.canServeWork)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(isNew ? "New automation" : "Edit automation")
                        .font(.title2.weight(.semibold))
                    Text("Make the trigger, target, and safety contract explicit.")
                        .junoCaption()
                }
                Spacer()
                Button("Cancel", action: onCancel)
                    .buttonStyle(.bordered)
                Button("Save") { save() }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.junoAccent)
                    .disabled(!draft.isValid)
            }
            .padding(JunoSpace.region)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.section) {
                    basics
                    startsWhen
                    execution
                    safety
                    if let validationMessage {
                        JunoIconLabel(verbatim: validationMessage, icon: .error, size: 13)
                            .foregroundStyle(Color.junoDanger)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(JunoSpace.region)
            }
            .scrollIndicators(.never)
        }
        .background(Color.junoCanvas)
    }

    private var basics: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            Text("What should Juno do?")
                .font(.headline)
            TextField("Name", text: $draft.name)
                .textFieldStyle(.roundedBorder)
            TextEditor(text: $draft.instructions)
                .font(.body)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 100)
                .padding(6)
                // A solid input well, never glass: this is a text surface, and
                // glass under editable text is the exact thing the vocabulary
                // forbids. `junoPanel` is the same treatment every other sheet
                // gives its editor, and `scrollContentBackground(.hidden)` is
                // what lets the panel show through the editor's own backing.
                .junoPanel()
                .overlay(alignment: .topLeading) {
                    if draft.instructions.isEmpty {
                        Text("Describe the work in enough detail that it can run without you.")
                            .junoCaption()
                            .padding(.horizontal, 12)
                            .padding(.top, 12)
                            .allowsHitTesting(false)
                    }
                }
        }
    }

    private var startsWhen: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            HStack {
                Text("Starts when")
                    .font(.headline)
                Spacer()
                Button {
                    draft.triggers.append(
                        NativeWorkScheduleTriggerDraft(
                            kind: "daily",
                            config: ["hour": .number(9), "minute": .number(0)]
                        )
                    )
                } label: {
                    JunoIconLabel("Add trigger", icon: .plus, size: 13)
                }
                .buttonStyle(.bordered)
            }

            ForEach($draft.triggers) { $trigger in
                DesktopWorkTriggerEditor(
                    trigger: $trigger,
                    triggerKinds: triggerKinds,
                    showingAdvanced: $showingAdvanced,
                    canRemove: draft.triggers.count > 1,
                    onRemove: { draft.triggers.removeAll { $0.id == trigger.id } }
                )
            }
        }
    }

    private var execution: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            Text("Where it runs")
                .font(.headline)
            // `DesktopSegmented`, not `Picker(.segmented)`: the AppKit control
            // is for window toolbars; a switcher inside content gets the quiet
            // track with the one glass knob.
            DesktopSegmented(
                options: [
                    .init(JunoWorkTarget.automatic, "Juno chooses"),
                    .init(JunoWorkTarget.cloud, "Cloud"),
                    .init(JunoWorkTarget.local, "This Mac"),
                ],
                selection: $draft.target,
                accessibilityLabel: "Target"
            )
            if draft.target == .local {
                Picker("Mac", selection: Binding(
                    get: { draft.hostID ?? "" },
                    set: { draft.hostID = $0.isEmpty ? nil : $0 }
                )) {
                    Text("Choose a Mac").tag("")
                    ForEach(reachableHosts) { host in
                        Text(host.displayName).tag(host.hostID)
                    }
                }
                if reachableHosts.isEmpty {
                    JunoIconLabel(
                        "No reachable Mac is available. Turn on Work hosting in Settings or choose Cloud.",
                        icon: .device,
                        size: 13
                    )
                        .junoCaption()
                        .foregroundStyle(Color.junoCaution)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if !modelOptions.isEmpty {
                Picker("Model", selection: Binding(
                    get: { draft.model ?? "" },
                    set: { draft.model = $0.isEmpty ? nil : $0 }
                )) {
                    Text("Account default").tag("")
                    ForEach(modelOptions) { option in
                        Text(option.displayName).tag(option.id)
                    }
                }
            }
            TextField("Timezone (IANA)", text: $draft.timezone)
                .textFieldStyle(.roundedBorder)
            Toggle("Automation is active", isOn: $draft.enabled)
        }
    }

    private var safety: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            Text("Safety and follow-through")
                .font(.headline)
            Picker("When nobody is here", selection: $draft.unattendedPolicy) {
                Text("Stop and ask me").tag("pause_for_approval")
                Text("Skip irreversible work").tag("skip_irreversible")
                Text("End before irreversible work").tag("disallow_irreversible")
            }
            Picker("If the Mac is offline", selection: $draft.hostOfflinePolicy) {
                Text("Skip this fire").tag("skip")
                Text("Wait for the Mac").tag("wait")
                Text("Do the cloud part").tag("cloud_subset")
            }
            Picker("Missed fires", selection: $draft.missedRunPolicy) {
                Text("Catch up once").tag("run_once")
                Text("Catch up every fire").tag("run_all")
                Text("Let them go").tag("skip")
            }
            Picker("Notify me", selection: $draft.notifyPolicy) {
                Text("When it needs me").tag("on_attention")
                Text("When it finishes").tag("on_finish")
                Text("Everything").tag("all")
                Text("Never").tag("none")
            }
            Stepper("At most \(draft.maxConcurrentRuns) run\(draft.maxConcurrentRuns == 1 ? "" : "s") at once", value: $draft.maxConcurrentRuns, in: 1...5)
        }
    }

    private func save() {
        validationMessage = nil
        guard draft.isValid else {
            validationMessage = draft.target == .local && draft.hostID == nil
                ? "Choose the Mac this local automation is allowed to run on."
                : "Add a name, instructions, timezone, and at least one trigger."
            return
        }
        onSave(draft)
    }
}

private struct DesktopWorkTriggerEditor: View {
    @Binding var trigger: NativeWorkScheduleTriggerDraft
    let triggerKinds: [String]
    @Binding var showingAdvanced: Bool
    let canRemove: Bool
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.snug) {
                Picker("Trigger", selection: $trigger.kind) {
                    ForEach((triggerKinds + (triggerKinds.contains(trigger.kind) ? [] : [trigger.kind])), id: \.self) { kind in
                        Text(NativeWorkScheduleVocabulary.trigger(kind)).tag(kind)
                    }
                }
                .labelsHidden()
                .onChange(of: trigger.kind) { _, kind in
                    trigger.config = defaultConfig(for: kind, existing: trigger.config)
                }
                Toggle("Enabled", isOn: $trigger.enabled)
                    .toggleStyle(.checkbox)
                Spacer()
                if canRemove {
                    Button(role: .destructive, action: onRemove) {
                        JunoIconView(.minus, size: 13)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove trigger")
                }
            }
            triggerConfiguration
            DisclosureGroup("Advanced configuration", isExpanded: $showingAdvanced) {
                TextEditor(text: jsonBinding)
                    // The scanned-monospace rung, spelled by name.
                    .junoCodeSmall()
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 70)
                    .padding(6)
                    // A solid input well, never glass — same contract as the
                    // instructions editor above: no material under editable
                    // text, and a nested fill inside an already-raised card
                    // is exactly what `junoPanel` exists for.
                    .junoPanel()
                Text("Use a JSON object. Juno preserves trigger fields it does not interpret on this screen.")
                    .junoCaption()
            }
        }
        .padding(JunoSpace.regular)
        // A card, not glass: a trigger's editor is content on the sheet's
        // canvas, and the material belongs only to chrome that floats over
        // content — see the section container above for the full reasoning.
        .junoCard(cornerRadius: JunoRadius.card)
    }

    @ViewBuilder
    private var triggerConfiguration: some View {
        switch trigger.kind {
        case "hourly":
            Stepper("At minute \(number("minute", fallback: 0))", value: numberBinding("minute", fallback: 0), in: 0...59)
        case "once":
            HStack {
                TextField("Date (YYYY-MM-DD)", text: dateBinding)
                    .textFieldStyle(.roundedBorder)
                timeControls
            }
        case "weekly":
            HStack {
                Picker("Weekday", selection: numberBinding("weekday", fallback: 1)) {
                    ForEach(0..<7, id: \.self) { day in
                        Text(weekdayName(day)).tag(day)
                    }
                }
                timeControls
            }
        case "monthly":
            HStack {
                Stepper("Day \(number("monthday", fallback: 1))", value: numberBinding("monthday", fallback: 1), in: 1...31)
                timeControls
            }
        case "yearly":
            HStack {
                Stepper("Month \(number("month", fallback: 1))", value: numberBinding("month", fallback: 1), in: 1...12)
                Stepper("Day \(number("monthday", fallback: 1))", value: numberBinding("monthday", fallback: 1), in: 1...31)
                timeControls
            }
        case "daily", "weekdays":
            timeControls
        case "cron":
            TextField("Minute hour day-of-month month day-of-week", text: stringBinding("expression"))
                .textFieldStyle(.roundedBorder)
                .font(.system(.body, design: .monospaced))
        case "manual":
            Text("This automation runs only when you press Run Now.")
                .junoCaption()
        default:
            JunoIconLabel(
                "This trigger listens for an event from a connected source. Use Advanced configuration to edit its filters.",
                icon: .work,
                size: 13
            )
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var timeControls: some View {
        HStack(spacing: JunoSpace.tight) {
            Stepper("\(number("hour", fallback: 9))h", value: numberBinding("hour", fallback: 9), in: 0...23)
            Stepper("\(number("minute", fallback: 0))m", value: numberBinding("minute", fallback: 0), in: 0...59)
        }
    }

    private var jsonBinding: Binding<String> {
        Binding(
            get: {
                guard let data = try? JSONEncoder.pretty.encode(JunoJSONValue.object(trigger.config)) else { return "{}" }
                return String(data: data, encoding: .utf8) ?? "{}"
            },
            set: { value in
                guard let data = value.data(using: .utf8),
                    let decoded = try? JSONDecoder().decode(JunoJSONValue.self, from: data),
                    case .object(let object) = decoded
                else { return }
                trigger.config = object
            }
        )
    }

    private var dateBinding: Binding<String> {
        Binding(
            get: {
                String(
                    format: "%04d-%02d-%02d",
                    number("year", fallback: Calendar.current.component(.year, from: Date())),
                    number("month", fallback: Calendar.current.component(.month, from: Date())),
                    number("day", fallback: Calendar.current.component(.day, from: Date()))
                )
            },
            set: { value in
                let parts = value.split(separator: "-").compactMap { Int($0) }
                guard parts.count == 3 else { return }
                setNumber("year", parts[0])
                setNumber("month", parts[1])
                setNumber("day", parts[2])
            }
        )
    }

    private func number(_ key: String, fallback: Int) -> Int {
        guard let value = trigger.config[key]?.numberValue, value.isFinite else { return fallback }
        return Int(value)
    }

    private func numberBinding(_ key: String, fallback: Int) -> Binding<Int> {
        Binding(get: { number(key, fallback: fallback) }, set: { setNumber(key, $0) })
    }

    private func stringBinding(_ key: String) -> Binding<String> {
        Binding(get: { trigger.config[key]?.stringValue ?? "" }, set: { trigger.config[key] = .string($0) })
    }

    private func setNumber(_ key: String, _ value: Int) {
        trigger.config[key] = .number(Double(value))
    }

    private func weekdayName(_ value: Int) -> String {
        let symbols = Calendar(identifier: .gregorian).weekdaySymbols
        return symbols.indices.contains(value) ? symbols[value] : "Day \(value)"
    }

    private func defaultConfig(
        for kind: String,
        existing: [String: JunoJSONValue]
    ) -> [String: JunoJSONValue] {
        switch kind {
        case "hourly": return ["minute": .number(existing["minute"]?.numberValue ?? 0)]
        case "daily", "weekdays", "weekly", "monthly", "yearly":
            return [
                "hour": .number(existing["hour"]?.numberValue ?? 9),
                "minute": .number(existing["minute"]?.numberValue ?? 0),
            ]
        case "once":
            let now = Calendar.current.dateComponents([.year, .month, .day], from: Date())
            return [
                "year": .number(Double(now.year ?? 2026)),
                "month": .number(Double(now.month ?? 1)),
                "day": .number(Double(now.day ?? 1)),
                "hour": .number(9),
                "minute": .number(0),
            ]
        case "cron": return ["expression": .string("0 9 * * 1-5")]
        default: return existing
        }
    }
}

private extension JSONEncoder {
    static var pretty: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}
