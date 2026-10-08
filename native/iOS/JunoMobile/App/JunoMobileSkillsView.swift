import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// Skills (the web's `/skills`): instructions Alevr follows when you call
/// them by name — yours first, then each GitHub repository you installed from.
/// A row's switch turns a skill on or off; a row opens its page; Import pulls
/// skills from a GitHub repository after showing what is in it.
struct JunoMobileSkillsView: View {
  @Environment(\.junoFeatureHub) private var hub
  @State private var query = ""
  @State private var importing = false
  @State private var errorMessage: String?
  @State private var notice: String?

  private var model: NativeSkillLibraryModel? { hub?.skills }

  var body: some View {
    Group {
      if let model {
        content(model)
      } else {
        ContentUnavailableView("Skills are unavailable", systemImage: "wand.and.sparkles")
      }
    }
    .navigationTitle("Skills")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          importing = true
        } label: {
          Label("Import from GitHub", systemImage: "square.and.arrow.down")
        }
        .disabled(model?.currentAccountID == nil)
        .accessibilityIdentifier("juno.mobile.skills.import")
      }
    }
    .sheet(isPresented: $importing) {
      if let model {
        NavigationStack {
          JunoMobileSkillImportView(model: model) { sentence in notice = sentence }
        }
        .tint(Color.junoAccent)
      }
    }
    .alert("Couldn’t change that", isPresented: errorBinding) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(errorMessage ?? "")
    }
    .task { await model?.refresh() }
  }

  private var errorBinding: Binding<Bool> {
    Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
  }

  @ViewBuilder
  private func content(_ model: NativeSkillLibraryModel) -> some View {
    if let library = model.library {
      let filtered = NativeSkillRules.filter(library, query: query)
      List {
        if let notice {
          Section { Text(notice).foregroundStyle(Color.junoSecondaryInk) }
        }
        if library.isEmpty {
          Section {
            ContentUnavailableView {
              Label("No skills yet", systemImage: "wand.and.sparkles")
            } description: {
              Text("Import a skill from GitHub, or write one on alevr.com. Call it in chat by typing / and its name.")
            } actions: {
              Button("Import from GitHub") { importing = true }
            }
          }
        } else if filtered.isEmpty {
          Section {
            Text("No skills match “\(query)”.").foregroundStyle(Color.junoSecondaryInk)
          }
        }
        if !filtered.yours.isEmpty {
          Section("Yours") {
            ForEach(filtered.yours) { skill in
              row(skill, source: nil, model: model)
            }
          }
        }
        ForEach(filtered.sources, id: \.source.id) { entry in
          let source = entry.source
          Section {
            ForEach(entry.skills) { skill in
              row(skill, source: source, model: model)
            }
          } header: {
            Text(source.label)
          } footer: {
            if !source.enabled {
              Text("This repository is switched off, so its skills won’t run.")
            }
          }
        }
        if library.truncated {
          Section {
            Text("Showing \(library.listedCount) of \(library.total) skills.")
              .foregroundStyle(Color.junoSecondaryInk)
          }
        }
      }
      .listStyle(.insetGrouped)
      .searchable(text: $query, prompt: "Search skills")
      .refreshable { await model.refresh() }
    } else if let failure = model.failure {
      ContentUnavailableView {
        Label("Couldn’t load your skills", systemImage: "wifi.exclamationmark")
      } description: {
        Text(failure)
      } actions: {
        Button("Try Again") { Task { await model.refresh() } }
      .contentShape(.rect)
      }
    } else {
      ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  private func row(_ skill: NativeSkill, source: NativeSkillSource?, model: NativeSkillLibraryModel) -> some View {
    NavigationLink {
      JunoMobileSkillDetailView(skillID: skill.id, model: model)
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
        VStack(alignment: .leading, spacing: 2) {
          Text(skill.name)
            .foregroundStyle(skill.enabled ? Color.primary : Color.junoSecondaryInk)
          Text(verbatim: "/\(skill.slug)")
            .font(.footnote)
            .foregroundStyle(Color.junoSecondaryInk)
          if let attention = skill.attention {
            Label(attention.sentence, systemImage: attention == .blocked ? "xmark.octagon" : "exclamationmark.circle")
              .font(.footnote)
              .foregroundStyle(attention == .blocked ? Color.junoDestructiveInk : Color.junoWarningInk)
          } else if !skill.description.isEmpty {
            Text(skill.description)
              .font(.footnote)
              .foregroundStyle(Color.junoSecondaryInk)
              .lineLimit(2)
          }
        }
        Spacer(minLength: 0)
      }
    }
    .swipeActions(edge: .trailing) {
      Button(skill.enabled ? "Turn Off" : "Turn On") {
        Task {
          if let sentence = await model.setSkillEnabled(skill, !skill.enabled) { errorMessage = sentence }
        }
      }
      .tint(skill.enabled ? .gray : Color.junoAccent)
      .disabled(skill.isBlocked)
    }
    .contextMenu {
      Button(skill.enabled ? "Turn Off" : "Turn On", systemImage: skill.enabled ? "pause.circle" : "play.circle") {
        Task {
          if let sentence = await model.setSkillEnabled(skill, !skill.enabled) { errorMessage = sentence }
        }
      }
      .disabled(skill.isBlocked)
    }
    .accessibilityIdentifier("juno.mobile.skill.\(skill.slug)")
  }
}

// MARK: - One skill

/// A skill's page: what it is, whether it is on, how it is called, its
/// current instructions, and Delete.
struct JunoMobileSkillDetailView: View {
  let skillID: String
  let model: NativeSkillLibraryModel

  @Environment(\.dismiss) private var dismiss
  @State private var detail: NativeSkillDetail?
  @State private var failure: String?
  @State private var confirmingDelete = false
  @State private var errorMessage: String?
  @State private var busy = false

  /// The live row from the library, so a switch here and in the list agree.
  private var skill: NativeSkill? {
    guard let library = model.library else { return detail?.skill }
    return library.yours.first { $0.id == skillID }
      ?? library.sources.lazy.flatMap(\.skills).first { $0.id == skillID }
      ?? detail?.skill
  }

  private var source: NativeSkillSource? {
    model.library?.sources.first { source in source.skills.contains { $0.id == skillID } }
  }

  var body: some View {
    Group {
      if let skill {
        form(skill)
      } else if let failure {
        ContentUnavailableView {
          Label("Couldn’t load this skill", systemImage: "wifi.exclamationmark")
        } description: {
          Text(failure)
        } actions: {
          Button("Try Again") { Task { await load() } }
      .contentShape(.rect)
        }
      } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .navigationTitle(skill?.name ?? "Skill")
    .navigationBarTitleDisplayMode(.inline)
    .task { await load() }
    .confirmationDialog(
      "Delete “\(skill?.name ?? "this skill")”?",
      isPresented: $confirmingDelete,
      titleVisibility: .visible
    ) {
      Button("Delete Skill", role: .destructive) { delete() }
      .contentShape(.rect)
    } message: {
      Text("It’s removed from your skills and can’t run again. Chats and tasks that used it keep their history.")
    }
    .alert("Couldn’t change that", isPresented: errorBinding) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(errorMessage ?? "")
    }
  }

  private var errorBinding: Binding<Bool> {
    Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
  }

  private func form(_ skill: NativeSkill) -> some View {
    Form {
      Section {
        if !skill.description.isEmpty {
          Text(skill.description)
        }
        Toggle("On", isOn: Binding(
          get: { skill.enabled },
          set: { value in
            Task { if let sentence = await model.setSkillEnabled(skill, value) { errorMessage = sentence } }
          }
        ))
        .disabled(skill.isBlocked || busy)
      } footer: {
        Text("Type /\(skill.slug) in chat, or pick it from the + menu.")
      }

      if let attention = skill.attention {
        Section {
          Label(attention.sentence, systemImage: attention == .blocked ? "xmark.octagon" : "exclamationmark.circle")
            .foregroundStyle(attention == .blocked ? Color.junoDestructiveInk : Color.junoWarningInk)
        } footer: {
          Text(attention == .blocked
            ? "This version can’t run or be switched on."
            : "It won’t run until you approve what it asks for on alevr.com.")
        }
      }

      Section("Details") {
        LabeledContent("Version", value: "\(skill.currentVersion)")
        if let source {
          LabeledContent("From", value: source.label)
          if !source.enabled {
            Text("\(source.label) is switched off, so this skill won’t run.")
              .foregroundStyle(Color.junoWarningInk)
          }
        } else {
          LabeledContent("From", value: "Yours")
        }
        LabeledContent("Used", value: NativeSkillRules.isAutomatic(skill) ? "Automatically when relevant" : "Only when called")
        if let project = detail?.projectName {
          LabeledContent("Project", value: project)
        }
      }

      Section("Instructions") {
        if let instructions = detail?.version?.instructions, !instructions.isEmpty {
          Text(instructions)
            .font(.callout.monospaced())
            .textSelection(.enabled)
        } else if detail == nil {
          ProgressView()
        } else {
          Text("No instructions yet.").foregroundStyle(Color.junoSecondaryInk)
        }
      }

      Section {
        Button("Delete Skill", role: .destructive) { confirmingDelete = true }
          .disabled(busy)
          .accessibilityIdentifier("juno.mobile.skill.delete")
      }
    }
  }

  private func load() async {
    guard let accountID = model.currentAccountID else { return }
    failure = nil
    let result = await model.skillsClient.skill(id: skillID, for: accountID)
    if let value = result.value {
      detail = value
    } else if detail == nil {
      failure = result.message(fallback: "Couldn’t load this skill. Nothing has been changed by the attempt.")
    }
  }

  private func delete() {
    guard let skill else { return }
    busy = true
    Task {
      defer { busy = false }
      if let sentence = await model.deleteSkill(skill) {
        errorMessage = sentence
      } else {
        dismiss()
      }
    }
  }
}

// MARK: - Import

/// Importing from GitHub (`import-dialog.tsx`): paste a repository, see what
/// is in it, keep ticked what to install. Nothing lands unread.
struct JunoMobileSkillImportView: View {
  let model: NativeSkillLibraryModel
  let installed: (String) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var source = ""
  @State private var preview: NativeSkillImportPreview?
  @State private var chosen: Set<String> = []
  @State private var renames: [String: String] = [:]
  @State private var looking = false
  @State private var installing = false
  @State private var refusal: String?

  var body: some View {
    Form {
      if let preview {
        choose(preview)
      } else {
        Section {
          TextField("github.com/owner/repository", text: $source)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
            .submitLabel(.go)
            .onSubmit { Task { await look() } }
            .accessibilityIdentifier("juno.mobile.skills.import-source")
        } header: {
          Text("Repository")
        } footer: {
          Text("Paste a repository. You’ll choose which skills to install. Private repositories need GitHub connected in Apps.")
        }
        Section("Popular") {
          ForEach(Array(NativeSkillRules.popularSources.enumerated()), id: \.offset) { _, item in
            Button("\(item.owner)/\(item.repo)") {
              source = "\(item.owner)/\(item.repo)"
              Task { await look() }
            }
          }
        }
      }
      if let refusal {
        Section { Text(refusal).foregroundStyle(Color.junoDestructiveInk) }
      }
    }
    .navigationTitle(preview == nil ? "Import from GitHub" : "\(preview!.repository.owner)/\(preview!.repository.repo)")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button("Cancel") { dismiss() }.disabled(installing)
      }
      ToolbarItem(placement: .confirmationAction) {
        if let preview {
          Button("Install") { Task { await install(preview) } }
            .disabled(installing || chosen.isEmpty)
        } else {
          Button("Look") { Task { await look() } }
            .disabled(looking || source.trimmingCharacters(in: .whitespaces).isEmpty)
        }
      }
    }
    .overlay {
      if looking || installing { ProgressView() }
    }
  }

  @ViewBuilder
  private func choose(_ preview: NativeSkillImportPreview) -> some View {
    Section {
      ForEach(preview.skills) { skill in
        Toggle(isOn: Binding(
          get: { chosen.contains(skill.path) },
          set: { on in if on { chosen.insert(skill.path) } else { chosen.remove(skill.path) } }
        )) {
          VStack(alignment: .leading, spacing: 2) {
            Text(skill.name)
            Text(skill.installed ? "Installed" : (skill.description.isEmpty ? skill.path : skill.description))
              .font(.footnote)
              .foregroundStyle(Color.junoSecondaryInk)
              .lineLimit(2)
            if skill.slugTaken, !skill.installed {
              Text("/\(skill.slug) is taken; it installs as /\(renames[skill.path] ?? skill.suggestedSlug ?? skill.slug).")
                .font(.footnote)
                .foregroundStyle(Color.junoWarningInk)
            }
          }
        }
        .disabled(skill.installed || skill.securityStatus == "blocked")
      }
    } header: {
      Text("\(preview.repository.ref)@\(NativeSkillRules.shortCommit(preview.repository.commit)) · \(preview.skills.count) \(preview.skills.count == 1 ? "skill" : "skills")")
    } footer: {
      Text("Imported skills only run when you call them.")
    }
    if !preview.problems.isEmpty {
      Section("Couldn’t read") {
        ForEach(preview.problems, id: \.path) { problem in
          VStack(alignment: .leading, spacing: 2) {
            Text(problem.path).font(.footnote.monospaced())
            Text(problem.message).font(.footnote).foregroundStyle(Color.junoSecondaryInk)
          }
        }
      }
    }
  }

  private func look() async {
    let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, let accountID = model.currentAccountID else { return }
    looking = true
    refusal = nil
    let result = await model.skillsClient.previewImport(source: trimmed, for: accountID)
    looking = false
    if let value = result.value {
      preview = value
      chosen = value.defaultChoice
      renames = value.defaultRenames
    } else {
      refusal = result.message(fallback: "Couldn’t look inside that repository. Nothing was installed.")
    }
  }

  private func install(_ preview: NativeSkillImportPreview) async {
    guard let accountID = model.currentAccountID else { return }
    let paths = preview.skills.filter { chosen.contains($0.path) }.map(\.path)
    guard !paths.isEmpty else { return }
    installing = true
    refusal = nil
    let takenPaths = Set(preview.skills.filter(\.slugTaken).map(\.path))
    let result = await model.skillsClient.install(
      source: source.trimmingCharacters(in: .whitespacesAndNewlines),
      commit: preview.repository.commit,
      paths: paths,
      renames: renames.filter { chosen.contains($0.key) && takenPaths.contains($0.key) },
      for: accountID
    )
    installing = false
    if let outcome = result.value {
      let count = outcome.importedCount
      installed("Installed \(count) \(count == 1 ? "skill" : "skills") from \(preview.repository.owner)/\(preview.repository.repo).")
      await model.refresh()
      dismiss()
    } else {
      refusal = result.message(fallback: "Couldn’t install those skills. Nothing was saved.")
    }
  }
}
