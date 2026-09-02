import Foundation
import JunoAuth
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// One Work destination with two related control planes: live tasks and durable
/// automations. The server/native models remain authoritative; this view only
/// composes them for a phone-sized surface.
struct JunoMobileWorkHubView: View {
    private enum Section: String, CaseIterable, Identifiable {
        case tasks = "Tasks"
        case automations = "Automations"
        var id: String { rawValue }
    }

    let model: NativeWorkModel
    let accountID: AccountID?
    @State private var automationModel: NativeWorkAutomationModel?
    @State private var section: Section = .tasks

    init(
        model: NativeWorkModel,
        requestSender: (any NativeAuthenticatedRequestSending)?,
        accountID: AccountID?
    ) {
        self.model = model
        self.accountID = accountID
        _automationModel = State(
            initialValue: requestSender.map {
                NativeWorkAutomationModel(
                    client: NativeWorkAutomationClient(sender: $0)
                )
            }
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Work section", selection: $section) {
                ForEach(Section.allCases) { value in
                    Text(value.rawValue).tag(value)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 6)
            .accessibilityIdentifier("juno.mobile.work.section")

            Group {
                switch section {
                case .tasks:
                    JunoMobileWorkView(model: model)
                case .automations:
                    if let automationModel {
                        JunoMobileWorkAutomationsView(
                            model: automationModel,
                            hosts: model.hosts
                        )
                    } else {
                        ContentUnavailableView {
                            JunoIconLabel("Automations unavailable", icon: .error)
                        } description: {
                            Text("This build could not create the authenticated automation client.")
                        }
                    }
                }
            }
        }
        .background(Color.junoCanvas)
        .task(id: accountID) {
            guard let accountID, let automationModel else { return }
            await automationModel.start(for: accountID)
        }
        .onDisappear { automationModel?.stop() }
        .accessibilityIdentifier("juno.mobile.work.hub")
    }
}

private struct AutomationEditorRoute: Identifiable {
    let schedule: NativeWorkSchedule?
    let id = UUID()
}

private struct JunoMobileWorkAutomationsView: View {
    let model: NativeWorkAutomationModel
    let hosts: [WorkHostSummary]

    @State private var editor: AutomationEditorRoute?
    @State private var deleteCandidate: NativeWorkSchedule?
    @State private var openScheduleID: String?

    private var active: [NativeWorkSchedule] { model.schedules.filter(\.enabled) }
    private var paused: [NativeWorkSchedule] { model.schedules.filter { !$0.enabled } }

    var body: some View {
        Group {
            if (model.phase == .idle || model.phase == .loading) && model.schedules.isEmpty {
                JunoMobileQuietLoading()
            } else if (model.phase == .offline || model.phase == .failed) && model.schedules.isEmpty {
                unreachable
            } else {
                content
            }
        }
        .background(Color.junoCanvas)
        .navigationDestination(item: $openScheduleID) { id in
            if let schedule = model.schedules.first(where: { $0.id == id }) {
                JunoMobileWorkAutomationDetail(
                    schedule: schedule,
                    model: model,
                    hosts: hosts,
                    edit: { editor = AutomationEditorRoute(schedule: schedule) },
                    delete: { deleteCandidate = schedule }
                )
            } else {
                ContentUnavailableView("Automation unavailable", systemImage: "exclamationmark.triangle")
            }
        }
        .sheet(item: $editor) { route in
            JunoMobileWorkAutomationEditor(
                initialDraft: route.schedule?.draft ?? NativeWorkScheduleDraft(),
                isNew: route.schedule == nil,
                hosts: hosts,
                save: { draft in
                    let saved: NativeWorkSchedule?
                    if let id = route.schedule?.id {
                        saved = await model.update(id: id, draft: draft)
                    } else {
                        saved = await model.create(draft)
                    }
                    if let saved {
                        openScheduleID = saved.id
                        editor = nil
                    }
                    return saved != nil
                }
            )
        }
        .confirmationDialog(
            "Delete this automation?",
            isPresented: Binding(
                get: { deleteCandidate != nil },
                set: { if !$0 { deleteCandidate = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete Automation", role: .destructive) {
                guard let schedule = deleteCandidate else { return }
                deleteCandidate = nil
                Task {
                    await model.delete(id: schedule.id)
                    if openScheduleID == schedule.id { openScheduleID = nil }
                }
            }
            .contentShape(.rect)
            Button("Cancel", role: .cancel) { deleteCandidate = nil }
                .contentShape(.rect)
        } message: {
            Text("Future fires stop immediately. Runs already under way continue.")
        }
        .refreshable { await model.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { editor = AutomationEditorRoute(schedule: nil) } label: {
                    JunoIconView(.plus, size: 17)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .contentShape(.rect)
                .disabled(model.isMutating)
                .accessibilityLabel("New automation")
                .accessibilityIdentifier("juno.mobile.work.automation.new")
            }
        }
        .accessibilityIdentifier("juno.mobile.work.automations")
    }

    private var unreachable: some View {
        ContentUnavailableView {
            JunoIconLabel("Automations unavailable", icon: .error, size: 28)
        } description: {
            Text(model.lastErrorDescription ?? "Check your connection and try again.")
        } actions: {
            Button("Retry") { Task { await model.refresh() } }
                .buttonStyle(.borderedProminent)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(.rect)
        }
    }

    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                JunoPageTitle(
                    title: "Automations",
                    subtitle: "Background work that starts on a schedule or when something changes."
                )
                .padding(.top, 6)

                if let message = model.lastMutationExplanation {
                    HStack(alignment: .top, spacing: 8) {
                        JunoIconView(.check, size: 15)
                            .foregroundStyle(Color.junoSuccess)
                        Text(message).font(.caption)
                        Spacer(minLength: 0)
                        Button {
                            model.clearMutationMessage()
                        } label: {
                            JunoIconView(.close, size: 13)
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .contentShape(.rect)
                        .accessibilityLabel("Dismiss message")
                    }
                    .padding(12)
                    .junoCard(cornerRadius: JunoRadius.card)
                }

                if let error = model.lastErrorDescription {
                    JunoInlineError(message: error) { Task { await model.refresh() } }
                }

                if model.schedules.isEmpty {
                    empty
                } else {
                    if !active.isEmpty {
                        JunoGroupLabel(text: "Active")
                        ForEach(active) { row($0) }
                    }
                    if !paused.isEmpty {
                        JunoGroupLabel(text: "Paused")
                        ForEach(paused) { row($0) }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
        .scrollIndicators(.hidden)
    }

    private var empty: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: 10) {
                JunoIconView(systemImage: "clock.badge.checkmark")
                    .font(.title2)
                    .foregroundStyle(Color.junoAccent)
                Text("No automations yet").junoEmptyTitle()
                Text("Create a recurring or event-driven task. Juno can run it in the cloud or on an opted-in Mac, then keep its run history here.")
                    .font(.callout)
                    .junoSecondaryInk()
                Button("Create automation") {
                    editor = AutomationEditorRoute(schedule: nil)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.junoAccent)
                .controlSize(.large)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(.rect)
            }
        }
    }

    private func row(_ schedule: NativeWorkSchedule) -> some View {
        Button {
            openScheduleID = schedule.id
        } label: {
            JunoCard(padding: 14) {
                HStack(alignment: .top, spacing: 11) {
                    JunoIconView(
                        systemImage: schedule.enabled ? "clock.badge.checkmark" : "pause.circle"
                    )
                    .foregroundStyle(schedule.enabled ? Color.junoAccent : Color.junoMutedForeground)
                    .frame(width: 22)
                    .padding(.top, 2)

                    VStack(alignment: .leading, spacing: 5) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(schedule.name)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Color.primary)
                                .lineLimit(2)
                            if schedule.hasUnknownTrigger {
                                JunoIconView(systemImage: "sparkles")
                                    .font(.caption2)
                                    .foregroundStyle(Color.junoCaution)
                            }
                        }
                        Text(triggerSummary(schedule))
                            .font(.caption)
                            .junoSecondaryInk()
                            .lineLimit(2)
                        HStack(spacing: 6) {
                            Text(targetSummary(schedule))
                            if let next = schedule.nextRunAt, schedule.enabled {
                                Text("·")
                                Text("Next \(next.formatted(.relative(presentation: .named)))")
                            } else if !schedule.enabled {
                                Text("· Paused")
                            }
                        }
                        .font(.caption2)
                        .junoMetaInk()
                    }
                    Spacer(minLength: 4)
                    JunoIconView(.chevronRight, size: 13)
                        .junoMetaInk()
                        .padding(.top, 4)
                }
                .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .contentShape(.rect)
        .contextMenu {
            Button("Run Now") { Task { await model.runNow(id: schedule.id) } }
            Button(schedule.enabled ? "Pause" : "Resume") {
                Task { await model.setEnabled(id: schedule.id, enabled: !schedule.enabled) }
            }
            Button("Edit") { editor = AutomationEditorRoute(schedule: schedule) }
            Divider()
            Button("Delete", role: .destructive) { deleteCandidate = schedule }
        }
        .accessibilityLabel(
            "\(schedule.name). \(schedule.enabled ? "Active" : "Paused"). \(triggerSummary(schedule))."
        )
    }

    private func triggerSummary(_ schedule: NativeWorkSchedule) -> String {
        let values = schedule.triggers
            .filter(\.enabled)
            .map { NativeWorkScheduleVocabulary.trigger($0.kind) }
        return values.isEmpty ? "No enabled trigger" : values.joined(separator: " · ")
    }

    private func targetSummary(_ schedule: NativeWorkSchedule) -> String {
        switch schedule.targetValue {
        case .cloud: return "Cloud"
        case .local: return hostName(schedule.hostID) ?? "Mac"
        case .automatic: return "Automatic"
        case .none: return NativeWorkScheduleVocabulary.sentenceCase(schedule.target)
        }
    }

    private func hostName(_ id: String?) -> String? {
        guard let id else { return nil }
        return hosts.first { $0.hostID == id }?.displayName
    }
}

private struct JunoMobileWorkAutomationDetail: View {
    let schedule: NativeWorkSchedule
    let model: NativeWorkAutomationModel
    let hosts: [WorkHostSummary]
    let edit: () -> Void
    let delete: () -> Void

    private var runs: [NativeWorkScheduleRun] {
        model.recentRunsScheduleID == schedule.id ? model.recentRuns : []
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                actionBar
                triggerCard
                contractCard
                historyCard
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .background(Color.junoCanvas)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: schedule.id) { await model.loadRuns(for: schedule.id) }
        .refreshable {
            await model.refresh()
            await model.loadRuns(for: schedule.id)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Edit", action: edit)
                    Button(schedule.enabled ? "Pause" : "Resume") {
                        Task { await model.setEnabled(id: schedule.id, enabled: !schedule.enabled) }
                    }
                    Button("Run Now") { Task { await model.runNow(id: schedule.id) } }
                    Divider()
                    Button("Delete", role: .destructive, action: delete)
                } label: {
                    JunoIconView(systemImage: "ellipsis", size: 17)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .contentShape(.rect)
                .accessibilityLabel("Automation actions")
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("AUTOMATION")
                .font(.caption.weight(.semibold))
                .tracking(1.0)
                .foregroundStyle(Color.junoAccent)
            Text(schedule.name).junoPageHeading()
            Text(schedule.instructions)
                .font(.body)
                .junoSecondaryInk()
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 7) {
                JunoStatusPill(
                    text: schedule.enabled ? "Active" : "Paused",
                    tint: schedule.enabled ? Color.junoSuccess : Color.junoMutedForeground,
                    filled: schedule.enabled
                )
                Text(targetText).font(.caption).junoSecondaryInk()
                if let next = schedule.nextRunAt, schedule.enabled {
                    Text("·").junoMetaInk()
                    Text("Next \(next.formatted(.relative(presentation: .named)))")
                        .font(.caption)
                        .junoSecondaryInk()
                }
            }
        }
    }

    private var actionBar: some View {
        HStack(spacing: 10) {
            Button {
                Task { await model.runNow(id: schedule.id) }
            } label: {
                Label("Run now", systemImage: "play.fill")
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.junoAccent)
            .disabled(model.isMutating)
            .contentShape(.rect)

            Button(schedule.enabled ? "Pause" : "Resume") {
                Task { await model.setEnabled(id: schedule.id, enabled: !schedule.enabled) }
            }
            .buttonStyle(.bordered)
            .disabled(model.isMutating)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
        }
    }

    private var triggerCard: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: 10) {
                Label("Starts when", systemImage: "bolt.badge.clock")
                    .font(.headline)
                ForEach(schedule.triggers) { trigger in
                    HStack(alignment: .top, spacing: 9) {
                        Circle()
                            .fill(trigger.enabled ? Color.junoAccent : Color.junoMutedForeground)
                            .frame(width: 7, height: 7)
                            .padding(.top, 6)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(NativeWorkScheduleVocabulary.trigger(trigger.kind))
                                .font(.subheadline.weight(.medium))
                            Text(triggerDetail(trigger))
                                .font(.caption)
                                .junoSecondaryInk()
                        }
                        Spacer(minLength: 0)
                    }
                }
                if schedule.hasUnknownTrigger {
                    Text("A newer Juno version added one of these triggers. It remains preserved when you edit this automation.")
                        .font(.caption)
                        .foregroundStyle(Color.junoCaution)
                }
            }
        }
    }

    private var contractCard: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: 10) {
                Label("Run contract", systemImage: "checklist.checked")
                    .font(.headline)
                fact("Target", targetText)
                fact("Safety", policy(schedule.unattendedPolicy))
                fact("Mac offline", policy(schedule.hostOfflinePolicy))
                fact("Missed fires", policy(schedule.missedRunPolicy))
                fact("Notifications", policy(schedule.notifyPolicy))
                fact("Concurrency", "Up to \(schedule.maxConcurrentRuns)")
                if let model = schedule.model { fact("Model", model) }
                if !schedule.requiredCapabilities.isEmpty {
                    fact(
                        "Capabilities",
                        schedule.requiredCapabilities
                            .map(NativeWorkScheduleVocabulary.sentenceCase)
                            .joined(separator: " · ")
                    )
                }
            }
        }
    }

    private var historyCard: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("Recent runs", systemImage: "arrow.triangle.2.circlepath")
                    .font(.headline)
                if runs.isEmpty {
                    Text("No runs yet. Run it once to verify the contract.")
                        .font(.caption)
                        .junoSecondaryInk()
                } else {
                    ForEach(runs) { run in
                        HStack(spacing: 9) {
                            JunoIconView(systemImage: runSymbol(run.status))
                                .foregroundStyle(runColor(run.status))
                                .frame(width: 20)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(NativeWorkScheduleVocabulary.sentenceCase(run.status))
                                    .font(.subheadline.weight(.medium))
                                Text(run.createdAt?.formatted(.relative(presentation: .named)) ?? "Recently")
                                    .font(.caption)
                                    .junoSecondaryInk()
                            }
                            Spacer(minLength: 0)
                            Text(run.effectiveTarget.map(NativeWorkScheduleVocabulary.sentenceCase) ?? "Queued")
                                .font(.caption)
                                .junoMetaInk()
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
        }
    }

    private func fact(_ name: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(name)
                .font(.caption)
                .junoSecondaryInk()
                .frame(width: 92, alignment: .leading)
            Text(value)
                .font(.subheadline.weight(.medium))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var targetText: String {
        switch schedule.targetValue {
        case .cloud: return "Cloud"
        case .automatic: return "Juno chooses"
        case .local:
            return hosts.first { $0.hostID == schedule.hostID }?.displayName ?? "Selected Mac"
        case .none: return NativeWorkScheduleVocabulary.sentenceCase(schedule.target)
        }
    }

    private func triggerDetail(_ trigger: NativeWorkScheduleTrigger) -> String {
        if let expression = trigger.config["expression"]?.stringValue { return expression }
        let hour = trigger.config["hour"]?.numberValue.map { Int($0) }
        let minute = trigger.config["minute"]?.numberValue.map { Int($0) }
        if let hour, let minute {
            return String(format: "%02d:%02d · %@", hour, minute, schedule.timezone)
        }
        if !trigger.config.isEmpty { return "Configured event filters" }
        return schedule.timezone
    }

    private func policy(_ raw: String) -> String {
        switch raw {
        case "pause_for_approval": return "Stop and ask"
        case "skip_irreversible": return "Skip irreversible work"
        case "disallow_irreversible": return "End before irreversible work"
        case "wait": return "Wait for the Mac"
        case "cloud_subset": return "Do the cloud subset"
        case "skip": return "Skip this fire"
        case "run_once": return "Catch up once"
        case "run_all": return "Catch up every fire"
        case "none": return "Never"
        case "on_attention": return "When it needs you"
        case "on_finish": return "When it finishes"
        case "all": return "Everything"
        default: return NativeWorkScheduleVocabulary.sentenceCase(raw)
        }
    }

    private func runSymbol(_ status: String) -> String {
        switch status {
        case "completed": return "checkmark.circle.fill"
        case "failed", "cancelled", "interrupted": return "exclamationmark.circle.fill"
        case "running", "preparing": return "arrow.triangle.2.circlepath"
        default: return "clock"
        }
    }

    private func runColor(_ status: String) -> Color {
        switch status {
        case "completed": return .junoSuccess
        case "failed", "cancelled", "interrupted": return .junoDanger
        case "running", "preparing": return .junoAccent
        default: return .junoMutedForeground
        }
    }
}

private struct JunoMobileWorkAutomationEditor: View {
    let isNew: Bool
    let hosts: [WorkHostSummary]
    let save: (NativeWorkScheduleDraft) async -> Bool

    @State private var draft: NativeWorkScheduleDraft
    @State private var isSaving = false
    @State private var validationMessage: String?
    @Environment(\.dismiss) private var dismiss

    init(
        initialDraft: NativeWorkScheduleDraft,
        isNew: Bool,
        hosts: [WorkHostSummary],
        save: @escaping (NativeWorkScheduleDraft) async -> Bool
    ) {
        self.isNew = isNew
        self.hosts = hosts
        self.save = save
        _draft = State(initialValue: initialDraft)
    }

    var body: some View {
        NavigationStack {
            Form {
                basics
                triggers
                execution
                safety
                limits
                if let validationMessage {
                    Section {
                        Text(validationMessage).foregroundStyle(Color.junoDanger)
                    }
                }
            }
            .navigationTitle(isNew ? "New automation" : "Edit automation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { submit() }
                        .disabled(!draft.isValid || isSaving)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                }
            }
            .overlay {
                if isSaving {
                    ProgressView()
                        .padding(18)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
            }
        }
        .junoSheetSurface(.page)
    }

    private var basics: some View {
        Section("What should Juno do?") {
            TextField("Name", text: $draft.name)
            TextField("Instructions", text: $draft.instructions, axis: .vertical)
                .lineLimit(4...10)
        }
    }

    private var triggers: some View {
        Section("Starts when") {
            ForEach($draft.triggers) { $trigger in
                MobileAutomationTriggerEditor(
                    trigger: $trigger,
                    canRemove: draft.triggers.count > 1,
                    remove: { draft.triggers.removeAll { $0.id == trigger.id } }
                )
            }
            Button {
                draft.triggers.append(
                    NativeWorkScheduleTriggerDraft(
                        kind: "daily",
                        config: ["hour": .number(9), "minute": .number(0)]
                    )
                )
            } label: {
                Label("Add trigger", systemImage: "plus.circle")
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .contentShape(.rect)
        }
    }

    private var execution: some View {
        Section("Where it runs") {
            Picker("Target", selection: $draft.target) {
                Text("Automatic").tag(JunoWorkTarget.automatic)
                Text("Cloud").tag(JunoWorkTarget.cloud)
                Text("Mac").tag(JunoWorkTarget.local)
            }
            if draft.target == .local {
                Picker("Mac", selection: hostBinding) {
                    Text("Choose a Mac").tag("")
                    ForEach(hosts.filter(\.canServeWork)) { host in
                        Text(host.displayName).tag(host.hostID)
                    }
                }
                if hosts.filter(\.canServeWork).isEmpty {
                    Text("No opted-in Mac is currently able to serve Work.")
                        .font(.caption)
                        .foregroundStyle(Color.junoCaution)
                }
            }
            TextField("Model override (optional)", text: modelBinding)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
    }

    private var safety: some View {
        Section("Safety and delivery") {
            Picker("If approval is needed", selection: $draft.unattendedPolicy) {
                Text("Stop and ask").tag("pause_for_approval")
                Text("Skip irreversible work").tag("skip_irreversible")
                Text("End before irreversible work").tag("disallow_irreversible")
            }
            Picker("If Mac is offline", selection: $draft.hostOfflinePolicy) {
                Text("Skip this fire").tag("skip")
                Text("Wait for Mac").tag("wait")
                Text("Do cloud subset").tag("cloud_subset")
            }
            Picker("If a fire was missed", selection: $draft.missedRunPolicy) {
                Text("Catch up once").tag("run_once")
                Text("Catch up every fire").tag("run_all")
                Text("Skip").tag("skip")
            }
            Picker("Notify", selection: $draft.notifyPolicy) {
                Text("When it needs you").tag("on_attention")
                Text("When it finishes").tag("on_finish")
                Text("Everything").tag("all")
                Text("Never").tag("none")
            }
            Stepper(
                "Maximum concurrent runs: \(draft.maxConcurrentRuns)",
                value: $draft.maxConcurrentRuns,
                in: 1...5
            )
            Toggle("Enabled", isOn: $draft.enabled)
        }
    }

    private var limits: some View {
        Section("Limits") {
            TextField("Token ceiling (0 = default)", value: $draft.budget.maxTokens, format: .number)
                .keyboardType(.numberPad)
            TextField("Runtime ms (0 = default)", value: $draft.budget.maxRuntimeMilliseconds, format: .number)
                .keyboardType(.numberPad)
            TextField("Cost micro-USD (0 = default)", value: $draft.budget.maxCostMicroUSD, format: .number)
                .keyboardType(.numberPad)
        }
    }

    private var hostBinding: Binding<String> {
        Binding(
            get: { draft.hostID ?? "" },
            set: { draft.hostID = $0.isEmpty ? nil : $0 }
        )
    }

    private var modelBinding: Binding<String> {
        Binding(
            get: { draft.model ?? "" },
            set: {
                let value = $0.trimmingCharacters(in: .whitespacesAndNewlines)
                draft.model = value.isEmpty ? nil : value
            }
        )
    }

    private func submit() {
        guard draft.isValid else {
            validationMessage = "Add a name, instructions and at least one trigger. Local automations also need a Mac."
            return
        }
        isSaving = true
        validationMessage = nil
        Task {
            let didSave = await save(draft)
            await MainActor.run {
                isSaving = false
                if didSave { dismiss() }
                else { validationMessage = "Juno could not save this automation. Review the fields or try again." }
            }
        }
    }
}

private struct MobileAutomationTriggerEditor: View {
    @Binding var trigger: NativeWorkScheduleTriggerDraft
    let canRemove: Bool
    let remove: () -> Void

    private let kinds = [
        "once", "hourly", "daily", "weekdays", "weekly", "monthly", "yearly", "cron",
        "email_filter", "calendar_window", "topic_monitor", "connector_event", "folder_change", "manual",
    ]

    @State private var showAdvanced = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Picker("Trigger", selection: kindBinding) {
                    ForEach(kinds, id: \.self) { kind in
                        Text(NativeWorkScheduleVocabulary.trigger(kind)).tag(kind)
                    }
                }
                Toggle("", isOn: $trigger.enabled).labelsHidden()
                if canRemove {
                    Button(role: .destructive, action: remove) {
                        JunoIconView(systemImage: "minus.circle")
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .contentShape(.rect)
                    .accessibilityLabel("Remove trigger")
                }
            }

            configuration

            DisclosureGroup("Advanced configuration", isExpanded: $showAdvanced) {
                TextField("JSON configuration", text: jsonBinding, axis: .vertical)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(3...8)
                Text("Event triggers keep fields this screen does not interpret. Invalid JSON is ignored until it becomes valid again.")
                    .font(.caption2)
                    .junoSecondaryInk()
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var configuration: some View {
        switch trigger.kind {
        case "hourly":
            Stepper("At minute \(number("minute", fallback: 0))", value: numberBinding("minute", fallback: 0), in: 0...59)
        case "once":
            TextField("Date (YYYY-MM-DD)", text: dateBinding)
            timeControls
        case "weekly":
            Picker("Weekday", selection: numberBinding("weekday", fallback: 1)) {
                ForEach(0..<7, id: \.self) { day in
                    Text(weekdayName(day)).tag(day)
                }
            }
            timeControls
        case "monthly":
            Stepper("Day \(number("monthday", fallback: 1))", value: numberBinding("monthday", fallback: 1), in: 1...31)
            timeControls
        case "yearly":
            Stepper("Month \(number("month", fallback: 1))", value: numberBinding("month", fallback: 1), in: 1...12)
            Stepper("Day \(number("monthday", fallback: 1))", value: numberBinding("monthday", fallback: 1), in: 1...31)
            timeControls
        case "daily", "weekdays":
            timeControls
        case "cron":
            TextField("Minute hour day-of-month month day-of-week", text: stringBinding("expression"))
                .font(.system(.body, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        case "manual":
            Text("Runs only when you press Run now.")
                .font(.caption)
                .junoSecondaryInk()
        default:
            Text("This trigger listens for an event. Configure its source/filter fields below or leave existing fields intact.")
                .font(.caption)
                .junoSecondaryInk()
        }
    }

    private var timeControls: some View {
        HStack {
            Stepper("\(number("hour", fallback: 9))h", value: numberBinding("hour", fallback: 9), in: 0...23)
            Stepper("\(number("minute", fallback: 0))m", value: numberBinding("minute", fallback: 0), in: 0...59)
        }
    }

    private var kindBinding: Binding<String> {
        Binding(
            get: { trigger.kind },
            set: { kind in
                trigger.kind = kind
                trigger.config = defaultConfig(for: kind, existing: trigger.config)
            }
        )
    }

    private var jsonBinding: Binding<String> {
        Binding(
            get: {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                guard let data = try? encoder.encode(JunoJSONValue.object(trigger.config)) else { return "{}" }
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
        Binding(
            get: { trigger.config[key]?.stringValue ?? "" },
            set: { trigger.config[key] = .string($0) }
        )
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
        case "hourly":
            return ["minute": .number(existing["minute"]?.numberValue ?? 0)]
        case "daily", "weekdays":
            return [
                "hour": .number(existing["hour"]?.numberValue ?? 9),
                "minute": .number(existing["minute"]?.numberValue ?? 0),
            ]
        case "weekly":
            return [
                "weekday": .number(existing["weekday"]?.numberValue ?? 1),
                "hour": .number(existing["hour"]?.numberValue ?? 9),
                "minute": .number(existing["minute"]?.numberValue ?? 0),
            ]
        case "monthly":
            return [
                "monthday": .number(existing["monthday"]?.numberValue ?? 1),
                "hour": .number(existing["hour"]?.numberValue ?? 9),
                "minute": .number(existing["minute"]?.numberValue ?? 0),
            ]
        case "yearly":
            return [
                "month": .number(existing["month"]?.numberValue ?? 1),
                "monthday": .number(existing["monthday"]?.numberValue ?? 1),
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
        case "manual": return [:]
        default: return existing
        }
    }
}