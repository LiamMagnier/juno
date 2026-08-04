import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
import UIKit

/// **Settings**, laid out the way the website's is: a serif title over the
/// account, then a column of tiles — each one a card with a small monospaced
/// eyebrow naming what it governs.
///
/// It was a plain `Form` before, which is the iOS Settings idiom: correct for a
/// system pane, wrong for a product surface that has its own typography and its
/// own grouping. The controls inside the tiles are still native pickers and
/// toggles, because those are what a phone user knows how to operate — it is the
/// *frame* that changed, not the mechanics.
///
/// This pass closed three gaps against the web page:
///
/// - **The account was stated twice** — name and email in the header, then the
///   *same* name and email in the Account tile, one scroll apart. The header is
///   now the identity and the tile is the actions.
/// - **Memory had a link and no switch.** The web puts the pause toggle on the
///   Settings tile itself; the app made you open the subpage to find out whether
///   memory was even on.
/// - **There was no Danger zone.** Export and Delete account are the two things
///   a person is most likely to come to Settings for and could not do here at
///   all, on a page that otherwise claims to be the account's home.
///
/// **Usage** is here now. It was the one tile this page could not honestly
/// show — plan and quota reached the browser through the server-rendered
/// bootstrap, with no REST route behind them — and `/api/profile/usage` plus
/// `/api/profile/usage/breakdown` are what closed that. The screen behind the
/// row is ``JunoMobileUsageView``, reading the same ledger the Mac reads.
struct JunoMobileSettingsView: View {
    @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    var authModel: NativeAuthModel?
    var session: NativeAuthenticatedSession?
    /// The account photo's bytes, fetched through the authenticated file route.
    var avatarData: Data?
    var syncModel: NativeSyncModel<SQLiteAccountRepository>?
    var outbox: (any MutationOutboxRepository)?
    /// Backs the Danger zone. Nil where the app could not be configured, in which
    /// case the tile is absent rather than present and broken.
    var accountDataClient: NativeAccountDataClient?
    /// The authenticated transport, used by the Usage page to read the ledger.
    /// Nil where the app could not be configured — the row is absent rather than
    /// present and leading to a screen that can only apologise.
    var requestSender: (any NativeAuthenticatedRequestSending)?
    @State private var showingSignOut = false
    @State private var showMemoryPage = false
    @State private var showUsagePage = false
    @State private var showDiagnosticsPage = false
    @State private var showingDeleteAccount = false
    @State private var deleteConfirmation = ""
    @State private var isDeletingAccount = false
    @State private var isExporting = false
    @State private var exportURL: URL?
    @State private var dangerError: String?

    var body: some View {
        Group {
            switch model.phase {
            case .idle, .loading:
                JunoMobileQuietLoading()
            case .failed where model.settings == nil && model.memories.isEmpty:
                ContentUnavailableView {
                    Label("Settings unavailable", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(model.lastErrorDescription ?? "Try again.")
                } actions: {
                    Button("Retry") { Task { await model.refresh() } }
                        .buttonStyle(.borderedProminent)
                }
            default:
                tiles
            }
        }
        .background(Color.junoCanvas)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: $showMemoryPage) {
            JunoMobileMemoryView(model: model)
        }
        .navigationDestination(isPresented: $showUsagePage) {
            if let session {
                JunoMobileUsageView(
                    session: session,
                    requestSender: requestSender,
                    modelCatalog: conversationModel?.modelCatalog ?? []
                )
            }
        }
        .navigationDestination(isPresented: $showDiagnosticsPage) {
            NativeDiagnosticsView(
                syncModel: syncModel,
                outbox: outbox,
                accountID: session.map { StorageAccountID($0.profile.id.rawValue) }
            )
        }
        .task {
            #if DEBUG
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
            Button("action.cancel", role: .cancel) {}
        } message: {
            Text("auth.sign-out.confirm.message")
        }
        // A sheet, not an alert: an alert's `TextField` is one unlabelled line,
        // and this one has to show *which* email is being asked for while it is
        // being typed. Getting that wrong burns one of the three attempts an hour
        // the route allows.
        .sheet(isPresented: $showingDeleteAccount) { deleteAccountSheet }
        // The system share sheet, straight from the finished download.
        //
        // Not a `ShareLink`: that needs its item up front, and this one does not
        // exist until a request comes back. The alternative — a sheet holding a
        // single `ShareLink` — made "save my data" three taps and two modals.
        // `item:` rather than a Bool for the usual reason: the URL's existence
        // *is* the presentation.
        .sheet(item: Binding(
            get: { exportURL.map(JunoMobileExportFile.init) },
            set: { if $0 == nil { exportURL = nil } }
        )) { file in
            JunoMobileShareSheet(items: [file.url])
        }
        .accessibilityIdentifier("juno.mobile.settings")
    }

    private var deleteAccountSheet: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                Text("This permanently deletes every conversation, project, file and memory on this account. It cannot be undone.")
                    .font(.system(size: 15))
                    .lineSpacing(3)
                    .foregroundStyle(Color.junoMutedForeground)

                if let email = session?.profile.email {
                    Text("Type \(email) to confirm.")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                }

                TextField("Email", text: $deleteConfirmation)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.emailAddress)
                    .font(.system(size: 16))
                    .padding(12)
                    .background(
                        RoundedRectangle(cornerRadius: JunoCornerRadius.control, style: .continuous)
                            .fill(Color.junoSurface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoCornerRadius.control, style: .continuous)
                            .strokeBorder(Color.junoHairline, lineWidth: 1)
                    )
                    .accessibilityIdentifier("juno.mobile.settings-delete-confirm")

                if let dangerError {
                    Label(dangerError, systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                Spacer(minLength: 0)
            }
            .padding(JunoSpace.regular)
            .frame(maxWidth: .infinity, alignment: .leading)
            .junoScreenCanvas()
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
        .tint(Color.junoAccent)
    }

    /// The same comparison the server makes. Checked here so the button is dead
    /// until the confirmation is right, rather than live and then refused.
    private var deleteConfirmationMatches: Bool {
        guard let email = session?.profile.email, !email.isEmpty else { return false }
        return deleteConfirmation
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .caseInsensitiveCompare(email) == .orderedSame
    }

    private var tiles: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                header

                if let settings = model.settings {
                    JunoMobileSettingsSections(
                        settings: settings,
                        modelCatalog: conversationModel?.selectableModels ?? [],
                        disabled: model.isMutating,
                        update: { patch in Task { await model.updateSettings(patch) } }
                    )
                } else {
                    JunoSettingsTile(eyebrow: "Preferences") {
                        Label(
                            "Account settings have not finished synchronizing.",
                            systemImage: "clock.arrow.circlepath"
                        )
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    }
                }

                // The switch *and* the link, as the web has it. A tile whose only
                // control was "go and look" could not answer the question the
                // reader most often opens Settings with: is memory on?
                JunoSettingsTile(eyebrow: "Memory") {
                    Toggle(isOn: Binding(
                        get: { model.settings?.memoryEnabled ?? true },
                        set: { enabled in
                            Task {
                                await model.updateSettings(
                                    NativeSettingsPatch(memoryEnabled: enabled)
                                )
                            }
                        }
                    )) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Remember details").font(.system(size: 16))
                            Text("Juno keeps helpful details from your chats.")
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .tint(Color.junoAccent)
                    .disabled(model.isMutating || model.settings == nil)
                    .accessibilityIdentifier("juno.mobile.settings-memory-toggle")

                    Divider()

                    JunoSettingsLink(
                        title: "What Juno remembers",
                        value: Text("^[\(model.memories.count) memory](inflect: true)"),
                        symbol: "brain"
                    ) { showMemoryPage = true }
                    .accessibilityIdentifier("juno.mobile.settings-memory-link")
                }

                // Where the work above is allowed to send the content it reads.
                //
                // On the same page as the memory switch on purpose: the switch
                // decides *whether* Juno extracts from your chats, and this
                // decides *who sees them* when it does. Showing the first
                // without the second was the gap — a reader could turn memory
                // on with no way to find out that extraction had been going to
                // whichever provider answered fastest.
                if let settings = model.settings {
                    JunoSettingsTile(eyebrow: "settings.background-provider.title") {
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
                        .disabled(model.isMutating)
                        .accessibilityIdentifier("juno.mobile.settings-background-provider")

                        Text(settings.backgroundProviderMode.explanation)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        // Only the one mode that can cross is flagged. Marking
                        // every mode with a caution would train the reader to
                        // ignore the one that matters.
                        if settings.backgroundProviderMode.permitsCrossProvider {
                            Label(
                                String(localized: "settings.background-provider.crosses"),
                                systemImage: "exclamationmark.triangle"
                            )
                            .font(.system(size: 12))
                            .foregroundStyle(.orange)
                        }
                    }
                }

                // The web's Usage page, reachable at last. Offered only where the
                // ledger can actually be read: without a session or a transport
                // the row would push a screen whose only content is an apology.
                if session != nil, requestSender != nil {
                    JunoSettingsTile(eyebrow: "Usage") {
                        JunoSettingsLink(
                            title: "Your usage",
                            value: nil,
                            symbol: "chart.bar"
                        ) { showUsagePage = true }
                        .accessibilityIdentifier("juno.mobile.settings-usage-link")
                    }
                }

                // Identity lives in the header; this tile is what you can *do*.
                // Restating name and email one scroll below where they already
                // appear was the page's most obvious piece of duplication.
                JunoSettingsTile(eyebrow: "Account") {
                    if authModel != nil {
                        Button {
                            showingSignOut = true
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "rectangle.portrait.and.arrow.right")
                                    .font(.system(size: 16))
                                    .frame(width: 22)
                                Text("auth.sign-out").font(.system(size: 16))
                                Spacer(minLength: 0)
                            }
                            .foregroundStyle(.red)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("juno.mobile.account-signout")
                    } else {
                        Text("Signed in on this device.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }

                JunoSettingsTile(eyebrow: "About") {
                    // Diagnostics is a developer pane — sync cursors, outbox
                    // depth, contract digests. It is genuinely useful while
                    // building and pure noise in a shipped app, so a release
                    // build states the version and stops there.
                    #if DEBUG
                    JunoSettingsLink(
                        title: "diagnostics.title",
                        value: Text(JunoBuildInfo.current.displayVersion),
                        symbol: "stethoscope"
                    ) { showDiagnosticsPage = true }
                    .accessibilityIdentifier("juno.mobile.settings-diagnostics-link")
                    #else
                    HStack {
                        Text("settings.version").font(.system(size: 16))
                        Spacer(minLength: 6)
                        Text(JunoBuildInfo.current.displayVersion)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    #endif
                }

                dangerZone
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
        .refreshable { await model.refresh() }
    }

    /// **Danger zone** — the two irreversible things, kept together, last, and
    /// visibly apart from everything above.
    ///
    /// Export first on purpose: it is the thing a person should do *before* they
    /// delete, and putting it in the same tile is the only place the ordering can
    /// be made obvious.
    ///
    /// Neither is one tap. Export runs a fetch and then hands the file to the
    /// share sheet — nothing leaves the device without the reader choosing where.
    /// Delete requires typing the account's own email back, which is the server's
    /// rule and not a flourish added here: `/api/account/delete` rejects the
    /// request without it.
    @ViewBuilder
    private var dangerZone: some View {
        if accountDataClient != nil, session != nil {
            JunoSettingsTile(eyebrow: "Danger zone") {
                VStack(alignment: .leading, spacing: 12) {
                    Button {
                        exportAccount()
                    } label: {
                        HStack(spacing: 10) {
                            if isExporting {
                                ProgressView().controlSize(.small).frame(width: 22)
                            } else {
                                Image(systemName: "square.and.arrow.down")
                                    .font(.system(size: 16))
                                    .foregroundStyle(Color.junoAccent)
                                    .frame(width: 22)
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Export your data").font(.system(size: 16))
                                Text("Every chat, project and memory, as JSON.")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(isExporting)
                    .accessibilityIdentifier("juno.mobile.settings-export")

                    Divider()

                    Button {
                        deleteConfirmation = ""
                        showingDeleteAccount = true
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "trash")
                                .font(.system(size: 16))
                                .foregroundStyle(.red)
                                .frame(width: 22)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Delete account")
                                    .font(.system(size: 16))
                                    .foregroundStyle(.red)
                                // Red on the *label*, not on the row. Tinting the
                                // whole stack dragged the explanation to a pale
                                // red that read as disabled — and the sentence is
                                // secondary text, not a second warning.
                                Text("Removes everything, permanently.")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(isDeletingAccount)
                    .accessibilityIdentifier("juno.mobile.settings-delete-account")

                    if let dangerError {
                        Label(dangerError, systemImage: "exclamationmark.circle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
            }
        }
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

    private var header: some View {
        HStack(spacing: 12) {
            if let session {
                JunoAvatar(
                    imageData: avatarData,
                    imageURL: session.profile.imageURL,
                    name: session.profile.name ?? session.profile.email,
                    size: 44
                )
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("Settings")
                    .junoPageHeading(compact: true)
                    .accessibilityAddTraits(.isHeader)
                if let session {
                    Text(session.profile.email)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 6)
        .padding(.bottom, 2)
    }

    private var conflictBanner: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                Text("Memory or settings changed on another device.")
                    .lineLimit(2)
                Spacer()
            }
            HStack {
                Button("Keep mine") {
                    Task { await model.resolveConflicts(keepLocalChanges: true) }
                }
                Spacer()
                Button("Use server version") {
                    Task { await model.resolveConflicts(keepLocalChanges: false) }
                }
            }
        }
        .font(.caption)
        .padding(10)
        .background(.bar)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.mobile.settings-conflict")
    }

    private var statusBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: model.phase == .offline
                ? "wifi.slash" : "exclamationmark.circle")
            Text(model.lastErrorDescription
                ?? "Offline — showing saved settings. Changes will sync when Juno reconnects.")
                .lineLimit(2)
            Spacer()
            Button("Retry") { Task { await model.refresh() } }
        }
        .font(.caption)
        .padding(10)
        .background(.bar)
        .accessibilityIdentifier("juno.mobile.settings-status")
    }
}

/// A finished export, wrapped so `.sheet(item:)` can key on it. A bare `URL` is
/// not `Identifiable`, and identity here is genuinely the file path.
private struct JunoMobileExportFile: Identifiable {
    let url: URL
    var id: String { url.path }
}

/// The system share sheet, for the one case a `ShareLink` cannot serve: an item
/// that does not exist until a request comes back.
private struct JunoMobileShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_: UIActivityViewController, context: Context) {}
}

/// One settings tile: a card with a monospaced eyebrow naming what it governs.
/// The eyebrow is the web page's own device — it lets a section be identified
/// without spending a heading-sized line on it.
struct JunoSettingsTile<Content: View>: View {
    let eyebrow: LocalizedStringKey
    @ViewBuilder var content: Content

    var body: some View {
        JunoCard(padding: 16) {
            VStack(alignment: .leading, spacing: 12) {
                Text(eyebrow)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                content
            }
        }
    }
}

/// A row inside a tile that pushes a subpage. Deliberately not a `NavigationLink`
/// in a `List`: these tiles are not list rows, and the chevron has to sit at the
/// card's own trailing edge.
private struct JunoSettingsLink: View {
    let title: LocalizedStringKey
    let value: Text?
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: 16))
                    .foregroundStyle(Color.junoAccent)
                    .frame(width: 22)
                Text(title).font(.system(size: 16))
                Spacer(minLength: 6)
                if let value {
                    value.font(.callout).foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct JunoMobileSettingsSections: View {
    let settings: NativeAccountSettings
    let modelCatalog: [NativeChatModelOption]
    let disabled: Bool
    let update: (NativeSettingsPatch) -> Void
    @State private var instructionsDraft = ""
    @State private var editingInstructions = false

    private static let accents = ["coral", "teal", "violet", "amber", "sage"]
    private static let personalities = [
        "default", "concise", "encouraging", "socratic", "formal", "nerdy",
    ]
    private static let responseLanguages = [
        "auto", "English", "Spanish", "French", "German", "Portuguese",
        "Italian", "Japanese", "Korean", "Chinese", "Hindi", "Arabic",
    ]
    private static let interfaceLocales = [
        "auto", "en", "es", "fr", "de", "it", "pt-BR", "nl", "pl", "tr", "ru",
        "uk", "sv", "id", "vi", "th", "hi", "ja", "ko", "zh-Hans", "zh-Hant",
    ]

    var body: some View {
        JunoSettingsTile(eyebrow: "Appearance") {
            Picker("Theme", selection: binding(\.theme) { NativeSettingsPatch(theme: $0) }) {
                Text("System").tag(NativeThemePreference.system)
                Text("Light").tag(NativeThemePreference.light)
                Text("Dark").tag(NativeThemePreference.dark)
            }
            .pickerStyle(.segmented)
            .disabled(disabled)
            // Swatches, not a menu of words. An accent picker whose options are
            // the strings "Coral" and "Teal" asks the reader to imagine the
            // result; showing the five colours is the whole decision at a glance —
            // and it is what the web does.
            row("Accent") {
                JunoMobileAccentPicker(
                    selection: binding(\.accent) { NativeSettingsPatch(accent: $0) },
                    disabled: disabled
                )
            }
        }

        JunoSettingsTile(eyebrow: "Default model") {
            row("Model") {
                Picker(
                    "Default model",
                    selection: binding(\.defaultModel) { NativeSettingsPatch(defaultModel: $0) }
                ) {
                    if !modelCatalog.contains(where: { $0.id == settings.defaultModel }) {
                        Text(junoDisplayModelName(settings.defaultModel))
                            .tag(settings.defaultModel)
                    }
                    ForEach(modelCatalog) { option in
                        Text(option.displayName).tag(option.id)
                    }
                }
                .labelsHidden()
                .disabled(disabled)
            }
            if !modelCatalog.isEmpty {
                NavigationLink {
                    JunoMobileFavoriteModelsView(
                        settings: settings,
                        modelCatalog: modelCatalog,
                        disabled: disabled,
                        update: update
                    )
                } label: {
                    HStack {
                        Text("Favorite models").font(.system(size: 16))
                        Spacer(minLength: 6)
                        Text("\(settings.favoriteModels.count)")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }

        JunoSettingsTile(eyebrow: "Response style") {
            row("Personality") {
                Picker(
                    "Personality",
                    selection: binding(\.personality) { NativeSettingsPatch(personality: $0) }
                ) {
                    ForEach(
                        knownOrCurrent(Self.personalities, current: settings.personality),
                        id: \.self
                    ) {
                        Text($0.capitalized).tag($0)
                    }
                }
                .labelsHidden()
                .disabled(disabled)
            }
        }

        JunoSettingsTile(eyebrow: "Custom instructions") {
            if editingInstructions {
                TextEditor(text: $instructionsDraft)
                    .font(.callout)
                    .frame(minHeight: 110)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Color.junoCanvas)
                    )
                    .accessibilityLabel("Custom instructions")
                HStack {
                    Button("Cancel") { editingInstructions = false }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Save") {
                        editingInstructions = false
                        update(NativeSettingsPatch(customInstructions: instructionsDraft))
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.junoAccent)
                    .disabled(disabled)
                }
                .font(.system(size: 15, weight: .medium))
            } else {
                Text(settings.customInstructions.isEmpty
                    ? "Nothing set — tell Juno how you'd like it to answer."
                    : settings.customInstructions)
                    .font(.callout)
                    .foregroundStyle(settings.customInstructions.isEmpty ? .secondary : .primary)
                    .lineLimit(5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Edit instructions") {
                    instructionsDraft = settings.customInstructions
                    editingInstructions = true
                }
                .buttonStyle(.plain)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.junoAccent)
                .disabled(disabled)
                .accessibilityIdentifier("juno.mobile.settings-edit-instructions")
            }
        }

        JunoSettingsTile(eyebrow: "Language") {
            row("Responses") {
                Picker(
                    "Response language",
                    selection: binding(\.responseLanguage) {
                        NativeSettingsPatch(responseLanguage: $0)
                    }
                ) {
                    ForEach(
                        knownOrCurrent(Self.responseLanguages, current: settings.responseLanguage),
                        id: \.self
                    ) {
                        Text($0 == "auto" ? "Auto-detect" : $0).tag($0)
                    }
                }
                .labelsHidden()
                .disabled(disabled)
            }
            row("Interface") {
                Picker(
                    "Interface language",
                    selection: binding(\.interfaceLocale) {
                        NativeSettingsPatch(interfaceLocale: $0)
                    }
                ) {
                    ForEach(
                        knownOrCurrent(Self.interfaceLocales, current: settings.interfaceLocale),
                        id: \.self
                    ) { locale in
                        Text(locale == "auto"
                            ? "Match system"
                            : (Locale.current.localizedString(forIdentifier: locale) ?? locale))
                            .tag(locale)
                    }
                }
                .labelsHidden()
                .disabled(disabled)
            }
        }

        JunoSettingsTile(eyebrow: "Email notifications") {
            Toggle(
                "Budget alerts",
                isOn: binding(\.emailBudgetAlerts) {
                    NativeSettingsPatch(emailBudgetAlerts: $0)
                }
            )
            .tint(Color.junoAccent)
            .disabled(disabled)
            Toggle(
                "Weekly digest",
                isOn: binding(\.emailWeeklyDigest) {
                    NativeSettingsPatch(emailWeeklyDigest: $0)
                }
            )
            .tint(Color.junoAccent)
            .disabled(disabled)
        }
    }

    /// A label and its control on one line. Pickers inside a card have no `Form`
    /// to supply that layout, and a bare `Picker` with a visible label collapses
    /// to a menu button with the label lost inside it.
    private func row<Control: View>(
        _ label: LocalizedStringKey, @ViewBuilder control: () -> Control
    ) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.system(size: 16))
            Spacer(minLength: 6)
            control()
        }
    }

    /// Keeps an unknown stored value selectable so the picker never silently
    /// rewrites a preference this build does not recognize.
    private func knownOrCurrent(_ known: [String], current: String) -> [String] {
        known.contains(current) ? known : [current] + known
    }

    private func binding<Value: Equatable>(
        _ keyPath: KeyPath<NativeAccountSettings, Value>,
        patch: @escaping (Value) -> NativeSettingsPatch
    ) -> Binding<Value> {
        Binding(
            get: { settings[keyPath: keyPath] },
            set: { value in
                guard value != settings[keyPath: keyPath] else { return }
                update(patch(value))
            }
        )
    }
}

private struct JunoMobileFavoriteModelsView: View {
    let settings: NativeAccountSettings
    let modelCatalog: [NativeChatModelOption]
    let disabled: Bool
    let update: (NativeSettingsPatch) -> Void

    var body: some View {
        List(modelCatalog) { option in
            Toggle(isOn: favoriteBinding(option.id)) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(option.displayName)
                    Text(option.providerName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(disabled)
        }
        .junoScreenCanvas()
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
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

struct JunoMobileAccentPicker: View {
    @Binding var selection: String
    var disabled: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 10) {
            ForEach(JunoAccent.allCases) { accent in
                let chosen = accent.rawValue == JunoAccent(setting: selection).rawValue
                Button {
                    withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                        selection = accent.rawValue
                    }
                } label: {
                    Circle()
                        .fill(accent.color)
                        .frame(width: 22, height: 22)
                        .overlay(
                            Circle().strokeBorder(Color.junoHairline, lineWidth: 1)
                        )
                        // The ring sits *outside* the swatch, so the colour is
                        // never partly covered by its own selected state.
                        .overlay {
                            Circle()
                                .strokeBorder(accent.color, lineWidth: 2)
                                .padding(-4)
                                .opacity(chosen ? 1 : 0)
                        }
                        .frame(width: 34, height: 34)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(disabled)
                .accessibilityLabel(accent.displayName)
                .accessibilityAddTraits(chosen ? [.isSelected, .isButton] : .isButton)
                .accessibilityIdentifier("juno.mobile.accent-\(accent.rawValue)")
            }
        }
        .opacity(disabled ? 0.5 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Accent")
        // A picker should say what it is set to, not only which of its options
        // carries the selected trait.
        .accessibilityValue(JunoAccent(setting: selection).displayName)
    }
}
