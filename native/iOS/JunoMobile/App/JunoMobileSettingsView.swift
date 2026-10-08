import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
import UIKit

#if DEBUG
  import JunoPreviewSupport
#endif

/// **Settings**, the way the system's own Settings and ChatGPT's settings sheet
/// are built: one inset-grouped `List`, an identity header, rows that are a
/// plain SF Symbol, a title and a chevron, and a red "Log out" alone at the end.
///
/// Two hosts render this view: a modal sheet that owns a `NavigationStack` and an
/// × (``JunoMobileRootView``), and the sidebar's Settings destination. That is
/// why there is no `NavigationStack` here — adding one doubles the bars in the
/// first host. Every leaf is a stock `Form` on the grouped background.
private enum JunoMobileSettingsRoute: Hashable {
  case usage, appearance, models, writing, language, memory, notifications, data, advanced, about
  case archived, voice, code
  /// The profile page and the @username field (JunoMobileProfileView.swift).
  case profile, username

  /// The name a preview launch uses: `--juno-preview-settings-route voice`.
  init?(previewName: String) {
    switch previewName {
    case "usage": self = .usage
    case "appearance": self = .appearance
    case "models": self = .models
    case "writing", "personalization": self = .writing
    case "language": self = .language
    case "memory": self = .memory
    case "notifications": self = .notifications
    case "account", "data": self = .data
    case "advanced": self = .advanced
    case "about": self = .about
    case "archived": self = .archived
    case "voice": self = .voice
    case "code": self = .code
    case "profile": self = .profile
    case "username": self = .username
    default: return nil
    }
  }
}

private enum JunoMobileSettingsPreferenceSection {
  case appearance, models, writing, language
}

struct JunoMobileSettingsView: View {
  @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>
  /// What ``MemoryExtractionEngine`` has noticed and not yet been answered on.
  ///
  /// Nil where nothing runs the engine — the DEBUG preview harness, and a launch
  /// that could not open the local store. The review row is absent then rather
  /// than leading to a queue that can never fill.
  var learningModel: MemoryLearningModel<SQLiteAccountRepository>?
  let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
  var authModel: NativeAuthModel?
  var session: NativeAuthenticatedSession?
  /// The account photo's bytes, fetched through the authenticated file route.
  var avatarData: Data?
  var syncModel: NativeSyncModel<SQLiteAccountRepository>?
  var outbox: (any MutationOutboxRepository)?
  /// Backs export and delete. Nil where the app could not be configured, in
  /// which case those rows are absent rather than present and broken.
  var accountDataClient: NativeAccountDataClient?
  /// The authenticated transport, used by the Usage page to read the ledger.
  var requestSender: (any NativeAuthenticatedRequestSending)?
  /// Lists and revokes the account's public links.
  var shareClient: NativeShareClient?
  /// Opens a chat from the Archived page. Nil where nothing can navigate.
  var openConversation: ((String) -> Void)?
  /// Backs the voice preview. Nil falls back to the device synthesiser.
  var messageActionsClient: NativeMessageActionsClient?
  /// The paired Macs, for Settings › Code.
  var remoteCodeModel: CodeRemoteBrowserModel?

  @State private var showingSignOut = false
  @State private var showMemoryPage = false
  @State private var showDiagnosticsPage = false
  @State private var showingDeleteAccount = false
  @State private var deleteConfirmation = ""
  @State private var isDeletingAccount = false
  @State private var isExporting = false
  @State private var exportURL: URL?
  @State private var dangerError: String?
  /// A page the preview harness asked to open on launch.
  @State private var previewRoute: JunoMobileSettingsRoute?

  var body: some View {
    Group {
      switch model.phase {
      case .idle, .loading:
        JunoMobileQuietLoading()
      case .failed where model.settings == nil && model.memories.isEmpty:
        ContentUnavailableView {
          Label("Settings unavailable", icon: .triangleAlert, size: 44)
        } description: {
          Text(model.lastErrorDescription ?? "Try again.")
        } actions: {
          Button("Retry") { Task { await model.refresh() } }
            .buttonStyle(.bordered)
            .contentShape(.rect)
        }
      default:
        page
      }
    }
    .navigationTitle("Settings")
    .navigationBarTitleDisplayMode(.inline)
    .navigationDestination(isPresented: $showMemoryPage) {
      JunoMobileMemoryView(
        model: model,
        requestSender: requestSender,
        accountID: session?.profile.id,
        openConversation: openConversation
      )
    }
    .navigationDestination(isPresented: $showDiagnosticsPage) {
      NativeDiagnosticsView(
        syncModel: syncModel,
        outbox: outbox,
        accountID: session.map { StorageAccountID($0.profile.id.rawValue) }
      )
    }
    .navigationDestination(item: $previewRoute) { route in
      settingsDestination(route)
    }
    .task {
      #if DEBUG
        // `--juno-preview-route` names Settings pages (profile, username) and
        // the feature sheets (notifications, skills…); only the former here.
        let settingsRoute = JunoPreviewEnvironment.initialRoute.flatMap {
          ["profile", "username"].contains($0) ? $0 : nil
        }
        if let raw = JunoPreviewEnvironment.initialSettingsRoute ?? settingsRoute,
          let route = JunoMobileSettingsRoute(previewName: raw)
        {
          try? await Task.sleep(nanoseconds: 350_000_000)
          previewRoute = route
        }
        if CommandLine.arguments.contains("--juno-preview-memory") {
          try? await Task.sleep(nanoseconds: 350_000_000)
          showMemoryPage = true
        }
        if CommandLine.arguments.contains("--juno-preview-diagnostics") {
          try? await Task.sleep(nanoseconds: 350_000_000)
          showDiagnosticsPage = true
        }
      #endif
    }
    .safeAreaInset(edge: .bottom) {
      if model.conflictedMutationCount > 0 {
        conflictBanner
      } else if model.phase == .offline || model.lastErrorDescription != nil {
        statusBanner
      }
    }
    .confirmationDialog(
      "auth.sign-out.confirm.title",
      isPresented: $showingSignOut,
      titleVisibility: .visible
    ) {
      Button("auth.sign-out", role: .destructive) {
        Task { await authModel?.signOut() }
      }
      .contentShape(.rect)
      Button("action.cancel", role: .cancel) {}
        .contentShape(.rect)
    } message: {
      Text("auth.sign-out.confirm.message")
    }
    // A sheet, not an alert: an alert's `TextField` is one unlabelled line,
    // and this one has to show *which* email is being asked for while it is
    // being typed.
    .sheet(isPresented: $showingDeleteAccount) { deleteAccountSheet }
    // The system share sheet, straight from the finished download.
    .sheet(
      item: Binding(
        get: { exportURL.map(JunoMobileExportFile.init) },
        set: { if $0 == nil { exportURL = nil } }
      )
    ) { file in
      JunoMobileShareSheet(items: [file.url])
    }
    .accessibilityIdentifier("juno.mobile.settings")
  }

  // MARK: - The page

  private var page: some View {
    List {
      if let session {
        Section {
          profileHeader(session)
        }
        .listSectionSpacing(.compact)
      }

      Section {
        if session != nil {
          settingsLink(.data, title: "Account", icon: .userCircle)
        }
        if session != nil, requestSender != nil {
          settingsLink(.usage, title: "Plan & Usage", icon: .usage)
        }
      }

      Section {
        settingsLink(.appearance, title: "Appearance", icon: .appearance)
        settingsLink(.writing, title: "Personalization", icon: .personalization)
        settingsLink(.memory, title: "Memory", icon: .memory)
        settingsLink(.language, title: "Language", icon: .language)
      }

      Section {
        settingsLink(.models, title: "Models", icon: .models)
        settingsLink(.voice, title: "Voice", icon: .voice)
        settingsLink(.code, title: "Code", icon: .code)
      }

      Section {
        settingsLink(.notifications, title: "Notifications", icon: .notifications)
        settingsLink(.archived, title: "Archived chats", icon: .archive)
      }

      Section("About") {
        settingsLink(.about, title: "About Alevr", icon: .about)
        #if DEBUG
          settingsLink(.advanced, title: "Advanced", icon: .tools)
        #endif
      }

      // Log out on its own, in red, last — where ChatGPT and the system's
      // own Settings put the one row that ends the session.
      if authModel != nil {
        Section {
          Button(role: .destructive) {
            showingSignOut = true
          } label: {
            JunoMobileSettingsLabel(
              title: "Log out",
              icon: .logOut,
              destructive: true
            )
          }
          .accessibilityIdentifier("juno.mobile.settings-log-out")
        }
      }
    }
    .listStyle(.insetGrouped)
    .junoGroupedPage()
    .refreshable { await model.refresh() }
    .navigationTitle("Settings")
    .navigationBarTitleDisplayMode(.inline)
    .navigationDestination(for: JunoMobileSettingsRoute.self) { route in
      settingsDestination(route)
    }
  }

  /// The account at the head of the sheet: face, name, address, centred, on
  /// the grouped background — identity, not a row to tap.
  private func profileHeader(_ session: NativeAuthenticatedSession) -> some View {
    VStack(spacing: 10) {
      JunoAvatar(
        imageData: avatarData,
        imageURL: session.profile.imageURL,
        name: session.profile.name ?? session.profile.email,
        size: 64
      )
      VStack(spacing: 2) {
        Text(session.profile.name ?? session.profile.email)
          .font(.title3.weight(.semibold))
          .foregroundStyle(Color.primary)
          .lineLimit(1)
        if session.profile.name != nil {
          Text(session.profile.email)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
    }
    .frame(maxWidth: .infinity)
    .listRowBackground(Color.clear)
    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("juno.mobile.settings-profile")
  }

  private func settingsLink(
    _ route: JunoMobileSettingsRoute,
    title: LocalizedStringKey,
    icon: JunoIcon
  ) -> some View {
    NavigationLink(value: route) {
      JunoMobileSettingsLabel(title: title, icon: icon)
    }
    .accessibilityIdentifier(settingsRouteIdentifier(route))
  }

  private func settingsRouteIdentifier(_ route: JunoMobileSettingsRoute) -> String {
    switch route {
    case .usage: "juno.mobile.settings-route-usage"
    case .appearance: "juno.mobile.settings-route-appearance"
    case .models: "juno.mobile.settings-route-models"
    case .writing: "juno.mobile.settings-route-writing"
    case .language: "juno.mobile.settings-route-language"
    case .memory: "juno.mobile.settings-route-memory"
    case .notifications: "juno.mobile.settings-route-notifications"
    case .data: "juno.mobile.settings-route-account"
    case .advanced: "juno.mobile.settings-route-advanced"
    case .about: "juno.mobile.settings-route-about"
    case .archived: "juno.mobile.settings-route-archived"
    case .voice: "juno.mobile.settings-route-voice"
    case .code: "juno.mobile.settings-route-code"
    case .profile: "juno.mobile.settings-route-profile"
    case .username: "juno.mobile.settings-route-username"
    }
  }

  @ViewBuilder
  private func settingsDestination(_ route: JunoMobileSettingsRoute) -> some View {
    switch route {
    case .usage:
      if let session {
        JunoMobileUsageView(
          session: session,
          requestSender: requestSender,
          modelCatalog: conversationModel?.modelCatalog ?? []
        )
      }
    case .appearance:
      preferencePage(.appearance, title: "Appearance")
    case .models:
      // Auto's two settings come from `GET /api/settings`, not the sync record.
      preferencePage(.models, title: "Models")
        .task { await model.refreshServerSettings() }
    case .writing:
      preferencePage(.writing, title: "Personalization")
    case .language:
      preferencePage(.language, title: "Language")
    case .memory:
      detailPage(title: "Memory") { memorySections }
    case .notifications:
      JunoMobileNotificationSettingsView(
        settings: model.settings, disabled: model.isMutating, update: update
      )
    case .data:
      accountPage
    case .advanced:
      NativeDiagnosticsView(
        syncModel: syncModel,
        outbox: outbox,
        accountID: session.map { StorageAccountID($0.profile.id.rawValue) }
      )
    case .about:
      detailPage(title: "About Alevr") { aboutSection }
    case .archived:
      if let conversationModel {
        JunoMobileArchivedView(
          model: conversationModel,
          openConversation: { id in openConversation?(id) }
        )
      } else {
        detailPage(title: "Archived chats") { unsyncedSection }
      }
    case .voice:
      JunoMobileVoiceSettingsView(
        settings: model.settings, disabled: model.isMutating, update: update,
        messageActions: messageActionsClient, accountID: session?.profile.id,
        ttsProvider: model.ttsProvider
      )
      .task { await model.refreshServerSettings() }
    case .code:
      JunoMobileCodeSettingsView(remoteModel: remoteCodeModel)
    case .profile:
      JunoMobileProfileView(session: session, requestSender: requestSender, avatarData: avatarData)
    case .username:
      JunoMobileUsernameView(session: session, requestSender: requestSender)
    }
  }

  @ViewBuilder
  private func preferencePage(
    _ section: JunoMobileSettingsPreferenceSection,
    title: LocalizedStringKey
  ) -> some View {
    detailPage(title: title) {
      if let settings = model.settings {
        JunoMobileSettingsPreferences(
          settings: settings,
          modelCatalog: conversationModel?.selectableModels ?? [],
          disabled: model.isMutating,
          section: section,
          update: update
        )
      } else {
        unsyncedSection
      }
    }
  }

  /// Every leaf is a stock `Form` on the system's grouped background.
  private func detailPage<Content: View>(
    title: LocalizedStringKey,
    @ViewBuilder content: () -> Content
  ) -> some View {
    Form {
      content()
    }
    .junoGroupedPage()
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
    .scrollDismissesKeyboard(.interactively)
  }

  private func update(_ patch: NativeSettingsPatch) {
    Task { await model.updateSettings(patch) }
  }

  // MARK: - Account

  /// Identity, then what you can do with the account, then the one act that
  /// cannot be undone, alone and last.
  private var accountPage: some View {
    Form {
      if let session {
        Section {
          HStack(spacing: 14) {
            JunoAvatar(
              imageData: avatarData,
              imageURL: session.profile.imageURL,
              name: session.profile.name ?? session.profile.email,
              size: 64
            )
            VStack(alignment: .leading, spacing: 2) {
              Text(session.profile.name ?? session.profile.email)
                .font(.title3.weight(.semibold))
                .lineLimit(1)
              if session.profile.name != nil {
                Text(session.profile.email)
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
                  .lineLimit(1)
              }
            }
          }
          .padding(.vertical, 4)
          .accessibilityElement(children: .combine)
        }
      }

      if session != nil, requestSender != nil {
        Section {
          settingsLink(.profile, title: "Profile", icon: .user)
          settingsLink(.username, title: "Username", icon: .edit)
        }
      }

      if let session {
        Section {
          NavigationLink {
            JunoMobileAccountSecurityView(email: session.profile.email) {
              await authModel?.signOut()
            }
          } label: {
            JunoMobileSettingsLabel(title: "Sign-in & Security", icon: .security)
          }
          .accessibilityIdentifier("juno.mobile.settings-security")
        }
      }

      if canManageAccountData {
        Section {
          Button(action: exportAccount) {
            HStack {
              JunoMobileSettingsLabel(title: "Export data", icon: .share)
              Spacer(minLength: 8)
              if isExporting { ProgressView() }
            }
          }
          .disabled(isExporting)
          .accessibilityIdentifier("juno.mobile.settings-export")
        } footer: {
          if let dangerError, !isExporting, !showingDeleteAccount {
            Text(dangerError).foregroundStyle(.red)
          } else {
            Text("Every chat, project and memory, as a JSON file.")
          }
        }

        Section {
          Button(role: .destructive) {
            deleteConfirmation = ""
            dangerError = nil
            showingDeleteAccount = true
          } label: {
            JunoMobileSettingsLabel(title: "Delete account", icon: .trash, destructive: true)
          }
          .disabled(isDeletingAccount)
          .accessibilityIdentifier("juno.mobile.settings-delete-account")
        } footer: {
          Text("Permanently deletes your account, conversations and memories.")
        }
      }
    }
    .junoGroupedPage()
    .navigationTitle("Account")
    .navigationBarTitleDisplayMode(.inline)
  }

  // MARK: - Sections the page owns

  /// The account's settings row has not arrived yet. Stated, rather than
  /// rendering controls bound to defaults that would write themselves back.
  private var unsyncedSection: some View {
    Section {
      Label("Account settings have not finished syncing.", icon: .refresh)
        .foregroundStyle(.secondary)
    }
  }

  @ViewBuilder
  private var memorySections: some View {
    Section {
      Toggle("Reference saved memories", isOn: memoryEnabled)
        .disabled(model.isMutating || model.settings == nil)
        .accessibilityIdentifier("juno.mobile.settings-memory-toggle")
    } footer: {
      Text("Alevr keeps helpful details from your chats and uses them as context.")
    }

    Section {
      NavigationLink {
        JunoMobileMemoryView(
          model: model,
          requestSender: requestSender,
          accountID: session?.profile.id,
          openConversation: openConversation
        )
      } label: {
        LabeledContent("Manage memories") {
          Text("^[\(model.memories.count) memory](inflect: true)")
        }
      }
      .accessibilityIdentifier("juno.mobile.settings-memory-link")

      if let learningModel {
        NavigationLink {
          // `onDecideProposal` is the whole contract: keeping a candidate
          // writes through `NativeMemorySettingsModel.createMemory`, the
          // same call the "Add a memory" field makes, so an accepted
          // suggestion is a normal memory afterwards.
          NativeMemoryManagerView(
            model: model,
            proposals: learningModel.proposals,
            onDecideProposal: { candidate, keep in
              Task {
                if keep {
                  await learningModel.accept(candidate)
                } else {
                  learningModel.decline(candidate)
                }
              }
            }
          )
        } label: {
          LabeledContent("Suggestions") {
            if learningModel.proposals.isEmpty {
              Text("None")
            } else {
              Text("^[\(learningModel.proposals.count) suggestion](inflect: true)")
            }
          }
        }
        .accessibilityIdentifier("juno.mobile.settings-memory-proposals")
      }

      if shareClient != nil {
        NavigationLink {
          NativeSharedLinksView(client: shareClient, accountID: session?.profile.id)
        } label: {
          Text("Shared links")
        }
        .accessibilityIdentifier("juno.mobile.settings-shared-links")
      }
    }

    if let settings = model.settings {
      Section {
        Picker(
          "settings.background-provider.title",
          selection: Binding(
            get: { settings.backgroundProviderMode },
            set: { mode in
              Task {
                await model.updateSettings(
                  NativeSettingsPatch(backgroundProviderMode: mode)
                )
              }
            }
          )
        ) {
          ForEach(BackgroundProviderMode.allCases, id: \.self) { mode in
            Text(mode.title).tag(mode)
          }
        }
        .pickerStyle(.navigationLink)
        .disabled(model.isMutating)
        .accessibilityIdentifier("juno.mobile.settings-background-provider")
      } header: {
        Text("Background work")
      } footer: {
        VStack(alignment: .leading, spacing: 6) {
          Text(settings.backgroundProviderMode.explanation)
          if settings.backgroundProviderMode.permitsCrossProvider {
            Label("settings.background-provider.crosses", icon: .triangleAlert, size: 13)
              .foregroundStyle(Color.junoCaution)
          }
        }
      }
    }
  }

  private var memoryEnabled: Binding<Bool> {
    Binding(
      get: { model.settings?.memoryEnabled ?? true },
      set: { enabled in
        guard enabled != model.settings?.memoryEnabled else { return }
        update(NativeSettingsPatch(memoryEnabled: enabled))
      }
    )
  }

  private var canManageAccountData: Bool {
    accountDataClient != nil && session != nil
  }

  @ViewBuilder
  private var aboutSection: some View {
    Section {
      LabeledContent("settings.version", value: JunoBuildInfo.current.displayVersion)
      // Diagnostics is a developer pane — sync cursors, outbox depth,
      // contract digests. A release build states the version and stops.
      #if DEBUG
        Button {
          showDiagnosticsPage = true
        } label: {
          HStack {
            Text("diagnostics.title").foregroundStyle(Color.primary)
            Spacer()
            JunoIconView(.chevronRight, size: 13)
              .foregroundStyle(.tertiary)
          }
          .contentShape(.rect)
        }
        .accessibilityIdentifier("juno.mobile.settings-diagnostics-link")
      #endif
    } footer: {
      Text("Alevr for iPhone and iPad. The same account, chats and projects as the web and the Mac.")
    }
  }

  // MARK: - Delete account

  private var deleteAccountSheet: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Email", text: $deleteConfirmation)
            .textContentType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.emailAddress)
            .accessibilityIdentifier("juno.mobile.settings-delete-confirm")
        } header: {
          if let email = session?.profile.email {
            Text("Type \(email) to confirm")
              .textCase(nil)
          }
        } footer: {
          if let dangerError {
            Text(dangerError).foregroundStyle(.red)
          } else {
            Text(
              "This permanently deletes every conversation, project, file and memory on this account. It cannot be undone."
            )
          }
        }
      }
      .navigationTitle("Delete account")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("action.cancel") { showingDeleteAccount = false }
        }
        ToolbarItem(placement: .confirmationAction) {
          if isDeletingAccount {
            ProgressView()
          } else {
            Button("Delete", role: .destructive) { deleteAccount() }
              .disabled(!deleteConfirmationMatches)
          }
        }
      }
    }
    .presentationDetents([.medium])
  }

  /// The same comparison the server makes. Checked here so the button is dead
  /// until the confirmation is right, rather than live and then refused.
  private var deleteConfirmationMatches: Bool {
    guard let email = session?.profile.email, !email.isEmpty else { return false }
    return
      deleteConfirmation
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .caseInsensitiveCompare(email) == .orderedSame
  }

  private func exportAccount() {
    guard let accountDataClient, let session else { return }
    isExporting = true
    dangerError = nil
    Task {
      defer { isExporting = false }
      do {
        exportURL = try await accountDataClient.export(
          format: .json,
          for: session.profile.id
        )
      } catch {
        dangerError = error.localizedDescription
      }
    }
  }

  private func deleteAccount() {
    guard let accountDataClient, let session else { return }
    isDeletingAccount = true
    dangerError = nil
    Task {
      defer { isDeletingAccount = false }
      do {
        try await accountDataClient.deleteAccount(
          confirmEmail: deleteConfirmation,
          accountEmail: session.profile.email,
          for: session.profile.id
        )
        showingDeleteAccount = false
        // The account is gone; the local mirror of it must go too, and
        // signing out is what tears down every model holding a copy.
        await authModel?.signOut()
      } catch {
        dangerError = error.localizedDescription
      }
    }
  }

  // MARK: - Banners

  private var conflictBanner: some View {
    VStack(spacing: JunoSpace.snug) {
      HStack(spacing: JunoSpace.snug) {
        JunoIconView(.refresh, size: 15)
        Text("Memory or settings changed on another device.")
          .lineLimit(2)
        Spacer()
      }
      HStack {
        Button("Keep mine") {
          Task { await model.resolveConflicts(keepLocalChanges: true) }
        }
        .contentShape(.rect)
        Spacer()
        Button("Use server version") {
          Task { await model.resolveConflicts(keepLocalChanges: false) }
        }
        .contentShape(.rect)
      }
    }
    .font(.footnote)
    .padding(JunoSpace.cozy)
    .background(.bar)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("juno.mobile.settings-conflict")
  }

  private var statusBanner: some View {
    HStack(spacing: JunoSpace.snug) {
      JunoIconView(model.phase == .offline ? .cloudOff : .error, size: 15)
      Text(
        model.lastErrorDescription
          ?? "Offline — showing saved settings. Changes will sync when Alevr reconnects."
      )
      .lineLimit(2)
      Spacer()
      Button("Retry") { Task { await model.refresh() } }
        .contentShape(.rect)
    }
    .font(.footnote)
    .padding(JunoSpace.cozy)
    .background(.bar)
    .accessibilityIdentifier("juno.mobile.settings-status")
  }
}

// MARK: - Row label

/// A settings row's label: one of the website's marks in the secondary ink,
/// then the title — the way ChatGPT's settings sheet sets its rows, in Alevr's
/// own icon set. One shape for every row in this family, so icons line up and
/// weights never mix.
struct JunoMobileSettingsLabel: View {
  let title: LocalizedStringKey
  let icon: JunoIcon
  var destructive = false

  var body: some View {
    Label {
      Text(title)
        .foregroundStyle(destructive ? Color.red : Color.primary)
    } icon: {
      JunoIconView(icon, size: 20)
        .foregroundStyle(destructive ? Color.red : Color.secondary)
    }
  }
}

// MARK: - Preferences

/// Everything backed by the account's settings record.
///
/// A separate view because the instructions draft is state and this is where it
/// belongs — and because a `nil` settings record must take these controls off the
/// page rather than binding them to defaults they would then write back.
private struct JunoMobileSettingsPreferences: View {
  let settings: NativeAccountSettings
  let modelCatalog: [NativeChatModelOption]
  let disabled: Bool
  let section: JunoMobileSettingsPreferenceSection
  let update: @MainActor @Sendable (NativeSettingsPatch) -> Void

  @State private var instructionsDraft = ""
  /// What the field was last handed by the account record. Compared against the
  /// draft to tell "untouched" from "half-written", so a settings push landing
  /// mid-sentence cannot erase what is being typed.
  @State private var instructionsBaseline: String?
  @State private var selectionHaptic = JunoMobileHapticTrigger()

  private static let responseLanguages = [
    "auto", "English", "Spanish", "French", "German", "Portuguese",
    "Italian", "Japanese", "Korean", "Chinese", "Hindi", "Arabic",
  ]
  private static let interfaceLocales = [
    "auto", "en", "es", "fr", "de", "it", "pt-BR", "nl", "pl", "tr", "ru",
    "uk", "sv", "id", "vi", "th", "hi", "ja", "ko", "zh-Hans", "zh-Hant",
  ]

  var body: some View {
    Group {
      switch section {
      case .appearance:
        appearanceSections
      case .models:
        defaultModelSections
      case .writing:
        responseStyleSection
        instructionsSection
      case .language:
        languageSections
      }
    }
    .junoHaptic(JunoMobileHaptic.selection, trigger: selectionHaptic)
  }

  // MARK: Appearance

  @ViewBuilder
  private var appearanceSections: some View {
    let theme = binding(\.theme) { NativeSettingsPatch(theme: $0) }
    Section {
      Picker("Theme", selection: theme) {
        ForEach(NativeThemePreference.allCases, id: \.self) { option in
          Text(Self.themeTitle(option)).tag(option)
        }
      }
      .pickerStyle(.segmented)
      .listRowInsets(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))
      .disabled(disabled)
      .accessibilityIdentifier("juno.mobile.theme-picker")
    } header: {
      Text("Theme")
    }

    Section {
      JunoMobileAccentGrid(
        selection: binding(\.accent) { NativeSettingsPatch(accent: $0) },
        disabled: disabled
      )
    } header: {
      Text("Accent color")
    } footer: {
      Text("Used for the one primary action on each screen, and for what is active.")
    }
  }

  private static func themeTitle(_ theme: NativeThemePreference) -> LocalizedStringKey {
    switch theme {
    case .light: "Light"
    case .dark: "Dark"
    case .system: "System"
    }
  }

  // MARK: Default model

  @ViewBuilder
  private var defaultModelSections: some View {
    Section {
      Picker(
        "Default model",
        selection: binding(\.defaultModel) { NativeSettingsPatch(defaultModel: $0) }
      ) {
        ForEach(modelOptions, id: \.self) { id in
          Text(modelTitle(id)).tag(id)
        }
      }
      .pickerStyle(.navigationLink)
      .disabled(disabled || modelCatalog.isEmpty)
      .accessibilityIdentifier("juno.mobile.settings-default-model")

      if !modelCatalog.isEmpty {
        // A push, not a menu: favourites is a set over the whole catalog.
        NavigationLink {
          JunoMobileFavoriteModelsView(
            settings: settings,
            modelCatalog: modelCatalog,
            disabled: disabled,
            update: update
          )
        } label: {
          LabeledContent("Favorite models") {
            Text("\(settings.favoriteModels.count)")
          }
        }
        .accessibilityIdentifier("juno.mobile.settings-favorite-models")
      }
    } footer: {
      Text("New chats start with this model. Favorites sit at the top of the model menu.")
    }

    // Settings › Models › Auto (`sections/models.tsx`).
    let preference = NativeAutoPreference.option(for: settings.autoPreference)
    let boundary = NativeAutoDataBoundary.option(for: settings.autoDataBoundary)
    Section {
      Picker(
        "Optimize for",
        selection: Binding(
          get: { preference.id },
          set: { value in
            guard value != preference.id else { return }
            selectionHaptic.fire()
            update(NativeSettingsPatch(autoPreference: value))
          }
        )
      ) {
        ForEach(NativeAutoPreference.options) { option in
          Text(option.label).tag(option.id)
        }
      }
      .pickerStyle(.navigationLink)
      .disabled(disabled)
      .accessibilityIdentifier("juno.mobile.settings-auto-preference")
      Picker(
        "Labs",
        selection: Binding(
          get: { boundary.id },
          set: { value in
            guard value != boundary.id else { return }
            selectionHaptic.fire()
            update(NativeSettingsPatch(autoDataBoundary: value))
          }
        )
      ) {
        ForEach(NativeAutoDataBoundary.options) { option in
          Text(option.label).tag(option.id)
        }
      }
      .pickerStyle(.navigationLink)
      .disabled(disabled)
      .accessibilityIdentifier("juno.mobile.settings-auto-data-boundary")
    } header: {
      Text("Auto")
    } footer: {
      Text(
        "How Auto chooses when it picks the model for you. Choosing a model yourself always overrides it.\n\n"
          + preference.description + " " + boundary.description
      )
    }
  }

  /// The catalog's ids, with the stored one prepended when this build's manifest
  /// does not contain it — a model retired since the account chose it stays
  /// selectable instead of being silently swapped for the first in the list.
  private var modelOptions: [String] {
    let ids = modelCatalog.map(\.id)
    return ids.contains(settings.defaultModel) ? ids : [settings.defaultModel] + ids
  }

  private func modelTitle(_ id: String) -> String {
    modelCatalog.first { $0.id == id }?.displayName ?? junoDisplayModelName(id)
  }

  // MARK: Language

  /// Two pickers, as on the web, because they are two different questions:
  /// this is the language of the *answers*, and that one is the interface.
  @ViewBuilder
  private var languageSections: some View {
    Section {
      Picker(
        "Response language",
        selection: binding(\.responseLanguage) { NativeSettingsPatch(responseLanguage: $0) }
      ) {
        ForEach(knownOrCurrent(Self.responseLanguages, current: settings.responseLanguage), id: \.self) {
          Text($0 == "auto" ? "Auto-detect" : LocalizedStringKey($0)).tag($0)
        }
      }
      .pickerStyle(.navigationLink)
      .disabled(disabled)
      .accessibilityIdentifier("juno.mobile.settings-response-language")
    } footer: {
      Text("The language Alevr replies in.")
    }
    Section {
      Picker(
        "Interface language",
        selection: binding(\.interfaceLocale) { NativeSettingsPatch(interfaceLocale: $0) }
      ) {
        ForEach(knownOrCurrent(Self.interfaceLocales, current: settings.interfaceLocale), id: \.self) {
          Text(Self.localeTitle($0)).tag($0)
        }
      }
      .pickerStyle(.navigationLink)
      .disabled(disabled)
      .accessibilityIdentifier("juno.mobile.settings-interface-language")
    } footer: {
      Text("The language of Alevr's buttons and menus.")
    }
  }

  /// Each language names itself — "Français", not "French" — which is the
  /// website's own rule. Falls back to this device's name for it, then to the
  /// raw identifier.
  private static func localeTitle(_ locale: String) -> String {
    guard locale != "auto" else { return "Match system" }
    let native = Locale(identifier: locale).localizedString(forIdentifier: locale)
    let name = native ?? Locale.current.localizedString(forIdentifier: locale) ?? locale
    return name.localizedCapitalized
  }

  // MARK: Response style

  /// The six styles as rows with their sentences, from the shared table.
  private var responseStyleSection: some View {
    let personality = binding(\.personality) { NativeSettingsPatch(personality: $0) }
    return Section {
      // A style added to the web after this build shipped keeps its place
      // at the top rather than disappearing.
      if JunoResponseStyle.named(settings.personality) == nil {
        styleRow(
          title: LocalizedStringKey(settings.personality.localizedCapitalized),
          detail: "Set on another device. Choosing one below replaces it.",
          selected: true, enabled: false
        ) {}
      }
      ForEach(JunoResponseStyle.all) { style in
        styleRow(
          title: style.localizedLabel,
          detail: style.localizedDetail,
          selected: style.id == settings.personality,
          enabled: !disabled
        ) {
          selectionHaptic.fire()
          personality.wrappedValue = style.id
        }
        .accessibilityIdentifier("juno.mobile.personality-\(style.id)")
      }
    } header: {
      Text("Response style")
    } footer: {
      Text("How Alevr writes. Your custom instructions still take priority.")
    }
  }

  private func styleRow(
    title: LocalizedStringKey, detail: LocalizedStringKey, selected: Bool, enabled: Bool,
    select: @escaping () -> Void
  ) -> some View {
    Button(action: select) {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text(title).foregroundStyle(Color.primary)
          Text(detail)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 8)
        JunoIconView(.check, size: 17)
          .foregroundStyle(Color.accentColor)
          .opacity(selected ? 1 : 0)
          .accessibilityHidden(true)
      }
      .contentShape(.rect)
    }
    .disabled(!enabled)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  // MARK: Custom instructions

  /// Editable in place, with the count, Revert and Save as the row beneath.
  private var instructionsSection: some View {
    Section {
      TextField(
        "E.g. I'm a product manager. Keep answers concise and use bullet points.",
        text: $instructionsDraft,
        axis: .vertical
      )
      .lineLimit(5...14)
      .accessibilityLabel("Custom instructions")
      .accessibilityIdentifier("juno.mobile.settings-instructions")
      HStack(spacing: 16) {
        Text("^[\(instructionsDraft.count) character](inflect: true)")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .monospacedDigit()
        Spacer(minLength: 0)
        Button("Revert") { instructionsDraft = settings.customInstructions }
          .buttonStyle(.borderless)
          .disabled(instructionsDraft == settings.customInstructions)
        Button("Save") {
          update(NativeSettingsPatch(customInstructions: instructionsDraft))
        }
        .buttonStyle(.borderless)
        .fontWeight(.semibold)
        .disabled(disabled || instructionsDraft == settings.customInstructions)
        .accessibilityIdentifier("juno.mobile.settings-save-instructions")
      }
    } header: {
      Text("Custom instructions")
    } footer: {
      Text("Alevr keeps these in mind in every conversation.")
    }
    .task(id: settings.customInstructions) {
      let stored = settings.customInstructions
      if instructionsDraft == (instructionsBaseline ?? "") {
        instructionsDraft = stored
      }
      instructionsBaseline = stored
    }
  }

  // MARK: Helpers

  /// The known list, with the stored value prepended when it is not in it.
  private func knownOrCurrent(_ known: [String], current: String) -> [String] {
    known.contains(current) ? known : [current] + known
  }

  private func binding<Value: Equatable & Sendable>(
    _ keyPath: KeyPath<NativeAccountSettings, Value> & Sendable,
    patch: @escaping @Sendable (Value) -> NativeSettingsPatch
  ) -> Binding<Value> {
    junoMobileSettingsBinding(settings, keyPath, update: update, patch: patch)
  }
}

/// The accents as a row of swatches — the whole decision visible at a glance.
struct JunoMobileAccentGrid: View {
  @Binding var selection: String
  var disabled: Bool

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var haptic = JunoMobileHapticTrigger()

  var body: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 56), spacing: 8)], spacing: 12) {
      ForEach(JunoAccent.allCases) { accent in
        let chosen = accent.rawValue == JunoAccent(setting: selection).rawValue
        Button {
          haptic.fire()
          withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
            selection = accent.rawValue
          }
        } label: {
          VStack(spacing: 6) {
            Circle()
              .fill(accent.color)
              .frame(width: 30, height: 30)
              .padding(3)
              .overlay {
                Circle()
                  .strokeBorder(Color.primary.opacity(0.35), lineWidth: 2)
                  .opacity(chosen ? 1 : 0)
              }
            Text(accent.displayName)
              .font(.caption)
              .foregroundStyle(chosen ? Color.primary : Color.secondary)
              .lineLimit(1)
          }
          .frame(maxWidth: .infinity, minHeight: 60)
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel(accent.displayName)
        .accessibilityAddTraits(chosen ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("juno.mobile.accent-\(accent.rawValue)")
      }
    }
    .padding(.vertical, 4)
    .opacity(disabled ? 0.5 : 1)
    .junoHaptic(JunoMobileHaptic.selection, trigger: haptic)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Accent")
    .accessibilityValue(JunoAccent(setting: selection).displayName)
  }
}

/// A binding onto one field of the account's settings record.
///
/// The patch is only sent when the value actually changes. A `Picker` writes its
/// selection back on layout passes where nothing moved, and without this guard
/// the offline outbox filled with no-op mutations that then had to sync.
///
/// Everything this captures is `Sendable`, because `Binding`'s accessors are
/// `@Sendable` in the iOS 26 SDK.
private func junoMobileSettingsBinding<Value: Equatable & Sendable>(
  _ settings: NativeAccountSettings,
  _ keyPath: KeyPath<NativeAccountSettings, Value> & Sendable,
  update: @escaping @MainActor @Sendable (NativeSettingsPatch) -> Void,
  patch: @escaping @Sendable (Value) -> NativeSettingsPatch
) -> Binding<Value> {
  Binding(
    get: { settings[keyPath: keyPath] },
    set: { value in
      guard value != settings[keyPath: keyPath] else { return }
      // SwiftUI drives a `Binding`'s setter on the main actor, but the
      // accessor itself is non-isolated `@Sendable`, so the isolation has to
      // be re-stated rather than inferred.
      MainActor.assumeIsolated { update(patch(value)) }
    }
  )
}

// MARK: - Favorite models

/// The catalog, grouped by provider, with a switch per model.
private struct JunoMobileFavoriteModelsView: View {
  let settings: NativeAccountSettings
  let modelCatalog: [NativeChatModelOption]
  let disabled: Bool
  let update: @MainActor @Sendable (NativeSettingsPatch) -> Void

  var body: some View {
    Form {
      ForEach(Array(groups.enumerated()), id: \.element.provider) { index, group in
        Section {
          ForEach(group.options, id: \.id) { option in
            Toggle(option.displayName, isOn: favoriteBinding(option.id))
              .disabled(disabled)
          }
        } header: {
          Text(group.provider)
        } footer: {
          if index == 0 {
            Text("Favorites sit at the top of the composer's model menu.")
          }
        }
      }
    }
    .junoGroupedPage()
    .navigationTitle("Favorite models")
    .navigationBarTitleDisplayMode(.inline)
    .accessibilityIdentifier("juno.mobile.favorite-models")
  }

  /// Grouped in catalog order rather than alphabetically: the manifest already
  /// ranks providers the way the composer's menu shows them.
  private var groups: [(provider: String, options: [NativeChatModelOption])] {
    var order: [String] = []
    var byProvider: [String: [NativeChatModelOption]] = [:]
    for option in modelCatalog {
      if byProvider[option.providerName] == nil { order.append(option.providerName) }
      byProvider[option.providerName, default: []].append(option)
    }
    return order.map { ($0, byProvider[$0] ?? []) }
  }

  private func favoriteBinding(_ modelID: String) -> Binding<Bool> {
    Binding(
      get: { settings.favoriteModels.contains(modelID) },
      set: { isFavorite in
        var favorites = settings.favoriteModels
        if isFavorite {
          guard !favorites.contains(modelID) else { return }
          favorites.append(modelID)
        } else {
          favorites.removeAll { $0 == modelID }
        }
        update(NativeSettingsPatch(favoriteModels: favorites))
      }
    )
  }
}

// MARK: - Export

/// A finished export, wrapped so `.sheet(item:)` can key on it. A bare `URL` is
/// not `Identifiable`, and identity here is genuinely the file path.
private struct JunoMobileExportFile: Identifiable {
  let url: URL
  var id: String { url.path }
}

/// The system share sheet, for the one case a `ShareLink` cannot serve: an item
/// that does not exist until a request comes back.
struct JunoMobileShareSheet: UIViewControllerRepresentable {
  let items: [Any]

  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: items, applicationActivities: nil)
  }

  func updateUIViewController(_: UIActivityViewController, context: Context) {}
}

extension View {
  /// The system's grouped page: grey ground, white groups. The Settings sheet
  /// hides scroll-content backgrounds for its whole stack
  /// (`junoSheetSurface`), which left every group white on white; each page in
  /// this family opts back in so the stock grouped look survives.
  func junoGroupedPage() -> some View {
    scrollContentBackground(.visible)
  }
}
