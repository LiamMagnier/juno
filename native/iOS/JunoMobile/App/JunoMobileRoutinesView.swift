import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// Routines (the web's `/automations`): tasks that start themselves — at a
/// time you choose or when something changes — with every run attached to the
/// same task. Active first, then paused, so a paused row's next fire never
/// reads as about to happen.
struct JunoMobileRoutinesView: View {
  @Environment(\.junoFeatureHub) private var hub
  @State private var creating = false
  @State private var busyIDs: Set<String> = []
  @State private var message: JunoMobileRoutineMessage?
  @State private var deleting: NativeWorkSchedule?

  private var model: NativeWorkAutomationModel? { hub?.routines }

  var body: some View {
    Group {
      if let model {
        content(model)
      } else {
        ContentUnavailableView {
          Label("Routines are unavailable", icon: .automations, size: 44)
        }
      }
    }
    .navigationTitle("Routines")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          creating = true
        } label: {
          JunoIconView(.plus, size: 18)
            .accessibilityLabel("New Routine")
        }
        .disabled(model == nil)
        .accessibilityIdentifier("juno.mobile.routines.new")
      }
    }
    .sheet(isPresented: $creating) {
      if let model {
        NavigationStack {
          JunoMobileRoutineEditor(model: model, schedule: nil)
        }
        .tint(Color.junoAccent)
      }
    }
    .routineMessage($message)
    .confirmationDialog(
      "Delete “\(deleting?.name ?? "")”?",
      isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
      titleVisibility: .visible,
      presenting: deleting
    ) { schedule in
      Button("Delete Routine", role: .destructive) { delete(schedule) }
      .contentShape(.rect)
    } message: { _ in
      Text(JunoMobileRoutineCopy.deleteMessage)
    }
    .task { await model?.refresh() }
  }

  @ViewBuilder
  private func content(_ model: NativeWorkAutomationModel) -> some View {
    let active = model.schedules.filter(\.enabled)
    let paused = model.schedules.filter { !$0.enabled }
    if model.schedules.isEmpty, model.phase == .idle || model.phase == .loading {
      ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
    } else if model.schedules.isEmpty, model.phase == .failed || model.phase == .offline {
      ContentUnavailableView {
        Label("Couldn’t load your routines", icon: .wifiOff, size: 44)
      } description: {
        Text("Existing routines keep running on the server; this list is empty because the read failed.")
      } actions: {
        Button("Try Again") { Task { await model.refresh() } }
      .contentShape(.rect)
      }
    } else if model.schedules.isEmpty {
      ContentUnavailableView {
        Label("No routines yet", icon: .automations, size: 44)
      } description: {
        Text("Run a task every weekday at eight, every Monday, or once a month. Alevr works while you are elsewhere and stops for approvals when it needs you.")
      } actions: {
        Button("New Routine") { creating = true }
      .contentShape(.rect)
      }
    } else {
      List {
        if !active.isEmpty {
          Section(paused.isEmpty ? "" : "Active") {
            ForEach(active) { row($0, model: model) }
          }
        }
        if !paused.isEmpty {
          Section(active.isEmpty ? "" : "Paused") {
            ForEach(paused) { row($0, model: model) }
          }
        }
      }
      .listStyle(.insetGrouped)
      .refreshable { await model.refresh() }
    }
  }

  private func row(_ schedule: NativeWorkSchedule, model: NativeWorkAutomationModel) -> some View {
    NavigationLink {
      JunoMobileRoutineDetailView(model: model, scheduleID: schedule.id)
    } label: {
      JunoMobileRoutineRow(schedule: schedule, isBusy: busyIDs.contains(schedule.id))
    }
    .contextMenu { actions(schedule, model: model) }
    .swipeActions(edge: .trailing) {
      Button("Delete", role: .destructive) { deleting = schedule }
      Button(schedule.enabled ? "Pause" : "Resume") { toggle(schedule, model: model) }
        .tint(.gray)
    }
    .accessibilityIdentifier("juno.mobile.routine.\(schedule.id)")
  }

  @ViewBuilder
  private func actions(_ schedule: NativeWorkSchedule, model: NativeWorkAutomationModel) -> some View {
    Button { runNow(schedule, model: model) } label: { Label("Run Now", icon: .play) }
      .disabled(busyIDs.contains(schedule.id))
      .contentShape(.rect)
    Button {
      toggle(schedule, model: model)
    } label: {
      Label(schedule.enabled ? "Pause" : "Resume", icon: schedule.enabled ? .pause : .play)
    }
    .disabled(busyIDs.contains(schedule.id))
      .contentShape(.rect)
    Divider()
    Button(role: .destructive) { deleting = schedule } label: { Label("Delete…", icon: .trash) }
      .contentShape(.rect)
  }

  private func runNow(_ schedule: NativeWorkSchedule, model: NativeWorkAutomationModel) {
    busyIDs.insert(schedule.id)
    Task {
      let result = await model.runNowReporting(id: schedule.id)
      busyIDs.remove(schedule.id)
      message = JunoMobileRoutineCopy.ranNow(result)
      if case .done = result { await model.refresh() }
    }
  }

  private func toggle(_ schedule: NativeWorkSchedule, model: NativeWorkAutomationModel) {
    busyIDs.insert(schedule.id)
    let pausing = schedule.enabled
    Task {
      let result = await model.setEnabledReporting(id: schedule.id, enabled: !pausing)
      busyIDs.remove(schedule.id)
      message = JunoMobileRoutineCopy.toggled(result, pausing: pausing)
    }
  }

  private func delete(_ schedule: NativeWorkSchedule) {
    guard let model else { return }
    Task {
      let result = await model.deleteReporting(id: schedule.id)
      message = JunoMobileRoutineCopy.deleted(result)
    }
  }
}

/// One routine: its name, its schedule in words, then when it runs next and
/// when it last ran. Paused is said in words, in the secondary ink.
struct JunoMobileRoutineRow: View {
  let schedule: NativeWorkSchedule
  var isBusy = false

  private var triggers: String {
    schedule.triggers.map(NativeWorkScheduleCopy.describe).joined(separator: " · ")
  }

  private var meta: String {
    var parts = [NativeWorkScheduleCopy.nextFireSentence(schedule)]
    if let lastRun = schedule.lastRunAt {
      parts.append("last ran \(NativeWorkScheduleCopy.timeAgo(lastRun))")
    }
    return parts.joined(separator: " · ")
  }

  var body: some View {
    HStack(spacing: JunoSpace.cozy) {
      VStack(alignment: .leading, spacing: JunoSpace.micro) {
        Text(schedule.name)
          .foregroundStyle(schedule.enabled ? Color.primary : Color.junoSecondaryInk)
          .lineLimit(1)
        if !triggers.isEmpty {
          Text(triggers)
            .font(.subheadline)
            .foregroundStyle(Color.junoSecondaryInk)
            .lineLimit(2)
        }
        Text(meta)
          .font(.footnote)
          .monospacedDigit()
          .foregroundStyle(Color.junoSecondaryInk)
          .lineLimit(2)
      }
      Spacer(minLength: 0)
      if isBusy {
        ProgressView().accessibilityLabel("Working")
      }
    }
    .accessibilityElement(children: .combine)
  }
}

// MARK: - One routine

struct JunoMobileRoutineDetailView: View {
  let model: NativeWorkAutomationModel
  let scheduleID: String

  @Environment(\.dismiss) private var dismiss
  @State private var editing = false
  @State private var busy = false
  @State private var message: JunoMobileRoutineMessage?
  @State private var confirmingDelete = false

  private var schedule: NativeWorkSchedule? { model.schedule(id: scheduleID) }

  var body: some View {
    Group {
      if let schedule {
        form(schedule)
      } else if model.missingIDs.contains(scheduleID) {
        ContentUnavailableView {
          Label("Routine not found", icon: .circleHelp, size: 44)
        } description: {
          Text("It may have been deleted on another device.")
        }
      } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .navigationTitle(schedule?.name ?? "Routine")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if let schedule, schedule.isEditableHere {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Edit") { editing = true }
            .accessibilityIdentifier("juno.mobile.routine.edit")
        }
      }
    }
    .sheet(isPresented: $editing) {
      if let schedule {
        NavigationStack {
          JunoMobileRoutineEditor(model: model, schedule: schedule)
        }
        .tint(Color.junoAccent)
      }
    }
    .routineMessage($message)
    .confirmationDialog(
      "Delete “\(schedule?.name ?? "")”?",
      isPresented: $confirmingDelete,
      titleVisibility: .visible
    ) {
      Button("Delete Routine", role: .destructive) { delete() }
      .contentShape(.rect)
    } message: {
      Text(JunoMobileRoutineCopy.deleteMessage)
    }
    .task {
      if schedule == nil { await model.loadSchedule(id: scheduleID) }
      await model.loadRuns(for: scheduleID)
    }
  }

  private func form(_ schedule: NativeWorkSchedule) -> some View {
    Form {
      Section("Schedule") {
        ForEach(schedule.triggers) { trigger in
          Text(NativeWorkScheduleCopy.describe(trigger))
        }
        LabeledContent("Next", value: nextValue(schedule))
        LabeledContent("Last ran", value: schedule.lastRunAt.map { NativeWorkScheduleCopy.timeAgo($0) } ?? "Not yet")
        if let notify = NativeWorkScheduleCopy.notifySentence(schedule.notifyPolicy), !schedule.isCode {
          LabeledContent("Email", value: notify)
        }
        LabeledContent("Time zone", value: schedule.timezone)
      }

      Section("Instructions") {
        Text(schedule.instructions.isEmpty ? "No instructions." : schedule.instructions)
          .foregroundStyle(schedule.instructions.isEmpty ? Color.junoSecondaryInk : Color.primary)
          .textSelection(.enabled)
      }

      Section {
        Button {
          runNow()
        } label: {
          Label("Run Now", icon: .play)
        }
        .disabled(busy)
        .accessibilityIdentifier("juno.mobile.routine.run-now")
        Button {
          toggle(schedule)
        } label: {
          Label(schedule.enabled ? "Pause" : "Resume", icon: schedule.enabled ? .pause : .play)
        }
        .disabled(busy)
      } footer: {
        Text("Run Now is an extra run; the schedule still fires when it was going to.")
      }

      if model.recentRunsScheduleID == scheduleID, !model.recentRuns.isEmpty {
        Section("Recent runs") {
          ForEach(model.recentRuns.prefix(8)) { run in
            HStack {
              Text(NativeWorkScheduleCopy.statusLabel(run.status))
                .foregroundStyle(tone(run.status))
              Spacer()
              if let date = run.finishedAt ?? run.startedAt ?? run.createdAt {
                Text(NativeWorkScheduleCopy.timeAgo(date))
                  .monospacedDigit()
                  .foregroundStyle(Color.junoSecondaryInk)
              }
            }
          }
        }
      }

      Section {
        Button("Delete Routine", role: .destructive) { confirmingDelete = true }
          .disabled(busy)
      }
    }
  }

  private func nextValue(_ schedule: NativeWorkSchedule) -> String {
    guard schedule.enabled else { return "Paused" }
    guard let next = schedule.nextRunAt else { return "When its trigger fires" }
    return NativeWorkScheduleCopy.formattedFire(next)
  }

  /// Plain words; only a failure takes a colour.
  private func tone(_ status: String) -> Color {
    switch NativeWorkScheduleCopy.statusTone(status) {
    case .bad: Color.junoDestructiveInk
    case .attention: Color.junoWarningInk
    default: Color.primary
    }
  }

  private func runNow() {
    busy = true
    Task {
      let result = await model.runNowReporting(id: scheduleID)
      busy = false
      message = JunoMobileRoutineCopy.ranNow(result)
      if case .done = result { await model.loadRuns(for: scheduleID) }
    }
  }

  private func toggle(_ schedule: NativeWorkSchedule) {
    busy = true
    let pausing = schedule.enabled
    Task {
      let result = await model.setEnabledReporting(id: scheduleID, enabled: !pausing)
      busy = false
      message = JunoMobileRoutineCopy.toggled(result, pausing: pausing)
    }
  }

  private func delete() {
    busy = true
    Task {
      let result = await model.deleteReporting(id: scheduleID)
      busy = false
      if case .done = result {
        dismiss()
      } else {
        message = JunoMobileRoutineCopy.deleted(result)
      }
    }
  }
}

// MARK: - Editor

/// A routine's name, its instructions and when it runs. The schedule is one
/// clock — hourly, daily, weekdays, weekly or monthly at a time; a routine
/// whose triggers are anything else keeps them untouched and says so (they
/// are edited on alevr.com or the Mac).
struct JunoMobileRoutineEditor: View {
  let model: NativeWorkAutomationModel
  /// Nil for a new routine.
  let schedule: NativeWorkSchedule?

  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var instructions = ""
  @State private var cadence = NativeRoutineCadence()
  @State private var editsCadence = true
  @State private var time = Date()
  @State private var saving = false
  @State private var refusal: String?
  @State private var loaded = false

  var body: some View {
    Form {
      Section("Name") {
        TextField("Morning brief", text: $name)
          .accessibilityIdentifier("juno.mobile.routine.name")
      }
      Section {
        TextField("What should Alevr do each time?", text: $instructions, axis: .vertical)
          .lineLimit(4...12)
          .accessibilityIdentifier("juno.mobile.routine.prompt")
      } header: {
        Text("Prompt")
      }
      Section {
        if editsCadence {
          Picker("Repeat", selection: $cadence.kind) {
            ForEach(NativeRoutineCadence.Kind.allCases) { kind in
              Text(kind.label).tag(kind)
            }
          }
          if cadence.kind == .weekly {
            Picker("Day", selection: $cadence.weekday) {
              ForEach(0..<7, id: \.self) { day in
                Text(NativeWorkScheduleCopy.weekdayNames[day]).tag(day)
              }
            }
          }
          if cadence.kind == .monthly {
            Picker("Day of month", selection: $cadence.monthday) {
              ForEach(1...31, id: \.self) { day in Text("\(day)").tag(day) }
            }
          }
          if cadence.kind == .hourly {
            Picker("Minute past", selection: $cadence.minute) {
              ForEach(Array(stride(from: 0, through: 55, by: 5)), id: \.self) { minute in
                Text(String(format: ":%02d", minute)).tag(minute)
              }
            }
          } else {
            DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
          }
        } else if let schedule {
          ForEach(schedule.triggers) { trigger in
            Text(NativeWorkScheduleCopy.describe(trigger))
          }
        }
      } header: {
        Text("Schedule")
      } footer: {
        if editsCadence {
          Text("\(cadence.sentence), \(TimeZone.current.identifier.replacingOccurrences(of: "_", with: " ")) time.")
        } else {
          Text("This routine starts in a way only alevr.com and the Mac can edit. Its schedule stays as it is.")
        }
      }
      if let refusal {
        Section { Text(refusal).foregroundStyle(Color.junoDestructiveInk) }
      }
    }
    .navigationTitle(schedule == nil ? "New Routine" : "Edit Routine")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button("Cancel") { dismiss() }.disabled(saving)
      }
      ToolbarItem(placement: .confirmationAction) {
        Button(schedule == nil ? "Create" : "Save") { save() }
          .disabled(saving || !isValid)
          .accessibilityIdentifier("juno.mobile.routine.save")
      }
    }
    .onChange(of: time) { _, value in
      let parts = Calendar.current.dateComponents([.hour, .minute], from: value)
      cadence.hour = parts.hour ?? cadence.hour
      cadence.minute = parts.minute ?? cadence.minute
    }
    .onAppear(perform: seed)
  }

  private var isValid: Bool {
    !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private func seed() {
    guard !loaded else { return }
    loaded = true
    if let schedule {
      name = schedule.name
      instructions = schedule.instructions
      if let read = NativeRoutineCadence(triggers: schedule.draft.triggers) {
        cadence = read
      } else {
        editsCadence = false
      }
    }
    time = Calendar.current.date(
      bySettingHour: cadence.hour, minute: cadence.minute, second: 0, of: Date()
    ) ?? Date()
  }

  private func save() {
    var draft = schedule?.draft ?? NativeWorkScheduleDraft()
    draft.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    draft.instructions = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
    if editsCadence {
      draft.triggers = [cadence.trigger(id: draft.triggers.first?.id ?? UUID().uuidString)]
      if schedule == nil { draft.timezone = TimeZone.current.identifier }
    }
    saving = true
    refusal = nil
    Task {
      let result: NativeWorkAutomationResult<NativeWorkSchedule>
      if let schedule {
        result = await model.saveReporting(id: schedule.id, draft: draft)
      } else {
        result = await model.createReporting(draft)
      }
      saving = false
      switch result {
      case .done:
        dismiss()
      case .refused(let sentence):
        refusal = sentence
      case .failed:
        refusal = "Couldn’t save this routine. Nothing was changed, so trying again is safe."
      }
    }
  }
}

// MARK: - Words

struct JunoMobileRoutineMessage: Identifiable, Equatable {
  let id = UUID()
  let title: String
  let isError: Bool
}

enum JunoMobileRoutineCopy {
  static let deleteMessage =
    "Fires that have not started are cancelled. A run already under way carries on to the end, and the tasks it has already produced stay where they are."

  static func ranNow(_ result: NativeWorkAutomationResult<NativeWorkScheduleRunResult>) -> JunoMobileRoutineMessage {
    switch result {
    case .done:
      JunoMobileRoutineMessage(title: "Started. This run is extra, and the schedule still fires when it was going to.", isError: false)
    case .refused(let sentence):
      JunoMobileRoutineMessage(title: sentence, isError: true)
    case .failed:
      JunoMobileRoutineMessage(title: "Couldn’t start this. Nothing was queued, so trying again is safe.", isError: true)
    }
  }

  static func toggled(_ result: NativeWorkAutomationResult<NativeWorkSchedule>, pausing: Bool) -> JunoMobileRoutineMessage {
    switch result {
    case .done(_, let notes):
      JunoMobileRoutineMessage(
        title: notes.isEmpty ? (pausing ? "Paused. Nothing new will start." : "Resumed.") : notes.joined(separator: " "),
        isError: false
      )
    case .refused(let sentence):
      JunoMobileRoutineMessage(title: sentence, isError: true)
    case .failed:
      JunoMobileRoutineMessage(title: "Couldn’t change this routine. It is exactly as it was.", isError: true)
    }
  }

  static func deleted(_ result: NativeWorkAutomationResult<String?>) -> JunoMobileRoutineMessage {
    switch result {
    case .done(let note, _):
      JunoMobileRoutineMessage(title: note ?? "Deleted.", isError: false)
    case .refused(let sentence):
      JunoMobileRoutineMessage(title: sentence, isError: true)
    case .failed:
      JunoMobileRoutineMessage(title: "Couldn’t delete this routine. It is exactly as it was.", isError: true)
    }
  }
}

private extension View {
  /// A routine action's outcome, as a system alert. Successes are said too:
  /// "Run Now" has no other visible effect until the run lands.
  func routineMessage(_ message: Binding<JunoMobileRoutineMessage?>) -> some View {
    alert(
      message.wrappedValue?.isError == true ? "Couldn’t do that" : "Done",
      isPresented: Binding(get: { message.wrappedValue != nil }, set: { if !$0 { message.wrappedValue = nil } }),
      presenting: message.wrappedValue
    ) { _ in
      Button("OK", role: .cancel) {}
      .contentShape(.rect)
    } message: { item in
      Text(item.title)
    }
  }
}
