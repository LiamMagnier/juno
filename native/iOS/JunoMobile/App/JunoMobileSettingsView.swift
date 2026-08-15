import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
import UIKit

/// **Settings**, laid out as the website lays it out: one scrolling column of
/// tiles, in the website's order, using the website's control vocabulary.
///
/// The previous build had the right idea — cards, not a `Form` — and then wrote
/// its own version of every part. It sat at `spacing: JunoSpace.cozy` with no reading clamp
/// while every other rebuilt screen in this app is `24` clamped to 768
/// (``JunoMobileMemoryView``, the project detail). It set type in points —
/// `.system(size: 16)` for a row, `12` for its explanation — so the one screen a
/// person opens to *change* how the app reads was the one screen that ignored
/// Dynamic Type. And it hand-rolled a third copy of the section eyebrow that
/// already existed twice in shared code.
///
/// What this pass actually fixes, in order of how much it mattered:
///
/// - **Response style offered six capitalised ids.** `Text($0.capitalized)` over
///   `["default", "concise", …]` — so the phone offered "Socratic" with no hint
///   of what it does, while the Mac and the web both showed a label *and* a
///   sentence. It is ``JunoResponseStyle`` now: one table, three platforms, the
///   website's copy verbatim, rendered as the six cards the web renders.
/// - **Every ≤6-option choice is visible.** Theme and response style are
///   ``JunoChoiceCard``s; the accent is five swatches. A menu is kept for the
///   three genuinely long lists — the model catalog, twelve response languages,
///   twenty-one interface locales — and for nothing else.
/// - **The switches say what they do.** "Budget alerts" and "Weekly digest" were
///   two bare toggles; both platforms that got this right carry "Email me at 80%
///   of my monthly budget." and "Usage recap every Monday." underneath.
/// - **Custom instructions has its counter**, inset in the field as on the web,
///   and is editable in place rather than behind an Edit button — with the Mac's
///   baseline check, so a settings sync landing mid-sentence cannot wipe what is
///   being typed.
/// - **Account is one place again.** Sign out sat in Account and export sat in a
///   Danger zone two tiles below it, which is a partition no other platform
///   makes. Account is now what you can do *with* the account; the Danger zone
///   is the one act that cannot be undone.
///
/// Two hosts render this view: a modal sheet that owns a `NavigationStack` and an
/// × (``JunoMobileRootView``), and the sidebar's Settings destination. That is
/// why there is no `NavigationStack` here — adding one doubles the bars in the
/// first host — and why the four subpages are reached with
/// `.navigationDestination(isPresented:)` rather than by pushing links.
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
    /// Backs the Danger zone. Nil where the app could not be configured, in which
    /// case the tile is absent rather than present and broken.
    var accountDataClient: NativeAccountDataClient?
    /// The authenticated transport, used by the Usage page to read the ledger.
    /// Nil where the app could not be configured — the tile is absent rather than
    /// present and leading to a screen that can only apologise.
    var requestSender: (any NativeAuthenticatedRequestSending)?
    /// Lists and revokes the account's public links.
    var shareClient: NativeShareClient?

    @State private var showingSignOut = false
    @State private var showMemoryPage = false
    /// Pushes ``NativeMemoryManagerView`` — the consent surface where a proposal
    /// is kept or discarded. Its own destination rather than a section inside the
    /// memory page, so the reader can be sent straight to a decision.
    @State private var showProposalsPage = false
    @State private var showSharedLinks = false
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
                page
            }
        }
        .background(Color.junoCanvas)
        // Blank, deliberately: the page states its own name in the serif heading
        // a line below the bar, and an inline bar title repeated it verbatim.
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: $showMemoryPage) {
            JunoMobileMemoryView(model: model)
        }
        .navigationDestination(isPresented: $showProposalsPage) {
            if let learningModel {
                // `onDecideProposal` is the whole contract: keeping a candidate
                // writes through `NativeMemorySettingsModel.createMemory`, the
                // same call the "Add a memory" field makes. One write path means
                // an accepted suggestion is a normal memory afterwards — same
                // outbox, same sync, same delete — and the memory page above stays
                // an honest account of everything Juno holds.
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
            }
        }
        .navigationDestination(isPresented: $showSharedLinks) {
            NativeSharedLinksView(client: shareClient, accountID: session?.profile.id)
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

    // MARK: - The page

    /// The website's tile order, top to bottom: Usage, Appearance, Default model,
    /// Response language, Interface language, Response style, Custom
    /// instructions, Memory, Account, Email notifications, Danger zone. About is
    /// the one tile the web has no equivalent for — a phone has to be able to
    /// report its own build — and it sits above the Danger zone so the
    /// irreversible act stays last on the page.
    ///
    /// 24-point rhythm clamped to 768: the shape every other rebuilt screen in
    /// this app uses, and the reason a settings page on an iPad does not stretch
    /// a switch and its label to opposite edges of the window.
    private var page: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                header
                usageTile

                if let settings = model.settings {
                    JunoMobileSettingsPreferences(
                        settings: settings,
                        modelCatalog: conversationModel?.selectableModels ?? [],
                        disabled: model.isMutating,
                        update: update
                    )
                } else {
                    unsyncedTile
                }

                memoryTile
                accountTile

                if let settings = model.settings {
                    JunoMobileSettingsEmailTile(
                        settings: settings,
                        disabled: model.isMutating,
                        update: update
                    )
                }

                aboutTile
                dangerZone
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.hairline)
            .padding(.bottom, JunoSpace.region)
            .frame(maxWidth: 768)
            .frame(maxWidth: .infinity)
        }
        // The custom-instructions editor is the one field on this page, and its
        // Save button sits directly under it — a keyboard that only leaves on
        // Return would cover the control the edit exists for.
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await model.refresh() }
    }

    private func update(_ patch: NativeSettingsPatch) {
        Task { await model.updateSettings(patch) }
    }

    private var header: some View {
        HStack(spacing: JunoSpace.cozy) {
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
                // The account, stated once. It was here *and* repeated in the
                // Account tile one scroll below, which was this page's most
                // obvious piece of duplication.
                if let session {
                    Text(session.profile.email)
                        .junoCaption()
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Tiles the page owns

    /// Usage leads, as it does on the web: the question "how much have I used?"
    /// is the one people open this page with most often.
    ///
    /// A link rather than meters. The website reads its numbers from a bootstrap
    /// it already has; here the only route that carries them also scans a year of
    /// ledger rows, and paying for that on every settings open to show two bars
    /// is the wrong trade. ``JunoMobileUsageView`` draws the whole dashboard.
    @ViewBuilder
    private var usageTile: some View {
        if session != nil, requestSender != nil {
            JunoSettingsTile("Usage") {
                Text("Your plan, the rolling limits, and where your tokens went.")
                    .junoCaption()
                JunoMobileSettingsLink(
                    title: "Your usage",
                    symbol: "chart.bar"
                ) { showUsagePage = true }
                .accessibilityIdentifier("juno.mobile.settings-usage-link")
            }
        }
    }

    /// The account's settings row has not arrived yet. Stated, rather than
    /// rendering ten controls bound to defaults that would write themselves back.
    private var unsyncedTile: some View {
        JunoSettingsTile("Preferences") {
            Label(
                "Account settings have not finished synchronizing.",
                systemImage: "clock.arrow.circlepath"
            )
            .junoCaption()
        }
    }

    /// The switch *and* the link, as the web has it. A tile whose only control
    /// was "go and look" could not answer the question the reader most often
    /// opens Settings with: is memory on?
    private var memoryTile: some View {
        JunoSettingsTile("Memory") {
            JunoMobileSettingsSwitch(
                title: "Reference saved memories",
                detail: "Juno keeps helpful details from your chats and uses them as context.",
                isOn: memoryEnabled,
                isEnabled: !model.isMutating && model.settings != nil
            )
            .accessibilityIdentifier("juno.mobile.settings-memory-toggle")

            Divider()

            JunoMobileSettingsLink(
                title: "What Juno remembers",
                symbol: "brain",
                value: Text("^[\(model.memories.count) memory](inflect: true)")
            ) { showMemoryPage = true }
            .accessibilityIdentifier("juno.mobile.settings-memory-link")

            // A second row rather than a badge on the first, because the two are
            // different surfaces answering different questions. The page above is
            // the corpus — everything Juno has already stored. This is the short
            // queue of things it *noticed* and has deliberately not stored,
            // waiting for a yes or a no. An extraction that filed itself and
            // turned up later is the version of this feature people call creepy;
            // one that asks is the version they leave switched on, and it can only
            // ask if there is somewhere to ask from.
            if let learningModel {
                JunoMobileSettingsLink(
                    title: "Review what Juno noticed",
                    symbol: "sparkles",
                    value: Text(
                        learningModel.proposals.isEmpty
                            ? "Nothing waiting"
                            : "^[\(learningModel.proposals.count) suggestion](inflect: true)"
                    )
                ) { showProposalsPage = true }
                .accessibilityIdentifier("juno.mobile.settings-memory-proposals")
            }

            // Beside Memory because both answer "what does the world already have
            // of mine?" — and a link is only safe to hand out if it can be taken
            // back from somewhere findable.
            if shareClient != nil {
                JunoMobileSettingsLink(title: "Shared links", symbol: "link") {
                    showSharedLinks = true
                }
                .accessibilityIdentifier("juno.mobile.settings-shared-links")
            }

            Divider()

            // Where the work the switch above enables is allowed to send what
            // it reads. Beside the memory switch on purpose: that switch decides
            // *whether* Juno extracts from your chats, and this decides *who
            // sees them* when it does. Showing the first without the second is
            // how extraction could go to whichever provider answered fastest
            // with nothing in the product saying so.
            if let settings = model.settings {
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
                    .junoFont(size: 12, relativeTo: .caption)
                    .junoSecondaryInk()
                    .fixedSize(horizontal: false, vertical: true)

                // Only the one mode that can cross is flagged. A caution on
                // every option would train the reader to ignore it.
                if settings.backgroundProviderMode.permitsCrossProvider {
                    Label(
                        "settings.background-provider.crosses",
                        systemImage: "exclamationmark.triangle"
                    )
                    .junoFont(size: 12, relativeTo: .caption)
                    .foregroundStyle(Color.junoCaution)
                }
            }
        }
    }

    /// Memory's own switch, with the same no-op guard the settings pickers use:
    /// a `Toggle` that re-emits its value on a layout pass would otherwise queue
    /// a mutation that changes nothing.
    private var memoryEnabled: Binding<Bool> {
        Binding(
            get: { model.settings?.memoryEnabled ?? true },
            set: { enabled in
                guard enabled != model.settings?.memoryEnabled else { return }
                update(NativeSettingsPatch(memoryEnabled: enabled))
            }
        )
    }

    /// Whether the account's own data can be read and written from this build.
    /// Both halves have to be there: without them the export row would be a
    /// button with nothing behind it.
    private var canManageAccountData: Bool {
        accountDataClient != nil && session != nil
    }

    /// What you can *do* with the account, in one place.
    ///
    /// Export lives here rather than in the Danger zone, which is where the web
    /// puts it and where it belongs: taking a copy of your own data is not a
    /// dangerous act, and filing it next to account deletion made it read as one.
    ///
    /// Absent rather than empty on a shell that can do neither — a card whose
    /// only content is the word "Account" answers nothing.
    @ViewBuilder
    private var accountTile: some View {
        if canManageAccountData || authModel != nil {
            JunoSettingsTile("Account") {
                if canManageAccountData {
                    JunoMobileSettingsAction(
                        title: "Export your data",
                        detail: "Every chat, project and memory, as JSON.",
                        symbol: "square.and.arrow.down",
                        isBusy: isExporting,
                        isEnabled: !isExporting,
                        action: exportAccount
                    )
                    .accessibilityIdentifier("juno.mobile.settings-export")
                }

                if authModel != nil {
                    if canManageAccountData {
                        Divider()
                    }
                    JunoMobileSettingsAction(
                        title: "auth.sign-out",
                        symbol: "rectangle.portrait.and.arrow.right",
                        isDestructive: true
                    ) { showingSignOut = true }
                    .accessibilityIdentifier("juno.mobile.account-signout")
                }

                // Export's failures land here, next to the control that caused
                // them. The delete sheet renders its own, which is why the sheet
                // being up excludes this one.
                if let dangerError, !isExporting, !showingDeleteAccount {
                    JunoInlineError(message: dangerError)
                }
            }
        }
    }

    private var aboutTile: some View {
        JunoSettingsTile("About") {
            // Diagnostics is a developer pane — sync cursors, outbox depth,
            // contract digests. Genuinely useful while building and pure noise in
            // a shipped app, so a release build states the version and stops.
            #if DEBUG
            JunoMobileSettingsLink(
                title: "diagnostics.title",
                symbol: "stethoscope",
                value: Text(JunoBuildInfo.current.displayVersion)
            ) { showDiagnosticsPage = true }
            .accessibilityIdentifier("juno.mobile.settings-diagnostics-link")
            #else
            HStack(spacing: JunoSpace.snug) {
                Text("settings.version")
                    .junoRowLabel()
                    .fontWeight(.medium)
                Spacer(minLength: JunoSpace.tight)
                Text(JunoBuildInfo.current.displayVersion)
                    .junoCaption()
                    .textSelection(.enabled)
            }
            #endif
        }
    }

    /// **Danger zone** — the one act on this page that cannot be undone, kept
    /// last and alone.
    ///
    /// It is not one tap. Deleting requires typing the account's own email back,
    /// which is the server's rule and not a flourish added here:
    /// `/api/account/delete` rejects the request without it.
    @ViewBuilder
    private var dangerZone: some View {
        if canManageAccountData {
            JunoSettingsTile("Danger zone") {
                JunoMobileSettingsAction(
                    title: "Delete account",
                    detail: "Permanently deletes your account, conversations and memories.",
                    symbol: "trash",
                    isDestructive: true,
                    isEnabled: !isDeletingAccount
                ) {
                    deleteConfirmation = ""
                    dangerError = nil
                    showingDeleteAccount = true
                }
                .accessibilityIdentifier("juno.mobile.settings-delete-account")
            }
        }
    }

    // MARK: - Delete account

    private var deleteAccountSheet: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: JunoSpace.regular) {
                Text("This permanently deletes every conversation, project, file and memory on this account. It cannot be undone.")
                    .junoBody()
                    .foregroundStyle(Color.junoMutedForeground)

                if let email = session?.profile.email {
                    Text("Type \(email) to confirm.")
                        .junoCaption()
                }

                TextField("Email", text: $deleteConfirmation)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.emailAddress)
                    .junoRowLabel()
                    .padding(JunoSpace.cozy)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                            .fill(Color.junoSurface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                            .strokeBorder(Color.junoBorder, lineWidth: 1)
                    )
                    .accessibilityIdentifier("juno.mobile.settings-delete-confirm")

                if let dangerError {
                    JunoInlineError(message: dangerError)
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
        .padding(JunoSpace.cozy)
        .background(.bar)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.mobile.settings-conflict")
    }

    private var statusBanner: some View {
        HStack(spacing: JunoSpace.snug) {
            Image(systemName: model.phase == .offline
                ? "wifi.slash" : "exclamationmark.circle")
            Text(model.lastErrorDescription
                ?? "Offline — showing saved settings. Changes will sync when Juno reconnects.")
                .lineLimit(2)
            Spacer()
            Button("Retry") { Task { await model.refresh() } }
        }
        .font(.caption)
        .padding(JunoSpace.cozy)
        .background(.bar)
        .accessibilityIdentifier("juno.mobile.settings-status")
    }
}

// MARK: - Preferences

/// Tiles 2 through 7 of the website's page: everything backed by the account's
/// settings record, in the website's order.
///
/// A separate view because the instructions draft is state and this is where it
/// belongs — and because a `nil` settings record must take these controls off the
/// page rather than binding them to defaults they would then write back.
private struct JunoMobileSettingsPreferences: View {
    let settings: NativeAccountSettings
    let modelCatalog: [NativeChatModelOption]
    let disabled: Bool
    let update: @MainActor @Sendable (NativeSettingsPatch) -> Void

    @State private var instructionsDraft = ""
    /// What the field was last handed by the account record. Compared against the
    /// draft to tell "untouched" from "half-written", so a settings push landing
    /// mid-sentence cannot erase what is being typed.
    @State private var instructionsBaseline: String?

    private static let responseLanguages = [
        "auto", "English", "Spanish", "French", "German", "Portuguese",
        "Italian", "Japanese", "Korean", "Chinese", "Hindi", "Arabic",
    ]
    private static let interfaceLocales = [
        "auto", "en", "es", "fr", "de", "it", "pt-BR", "nl", "pl", "tr", "ru",
        "uk", "sv", "id", "vi", "th", "hi", "ja", "ko", "zh-Hans", "zh-Hant",
    ]

    var body: some View {
        appearanceTile
        defaultModelTile
        responseLanguageTile
        interfaceLanguageTile
        responseStyleTile
        instructionsTile
    }

    // MARK: Appearance

    private var appearanceTile: some View {
        let theme = binding(\.theme) { NativeSettingsPatch(theme: $0) }
        return JunoSettingsTile("Appearance") {
            JunoMobileSettingsField(label: "Theme") {
                // Three cards, not a segmented control and not a menu: the whole
                // choice is three words wide, and a control that shows all of it
                // costs one row and no taps to discover.
                HStack(spacing: JunoSpace.snug) {
                    ForEach(NativeThemePreference.allCases, id: \.self) { option in
                        JunoChoiceCard(
                            title: Self.themeTitle(option),
                            isSelected: settings.theme == option,
                            isEnabled: !disabled
                        ) {
                            theme.wrappedValue = option
                        }
                        .accessibilityIdentifier("juno.mobile.theme-\(option.rawValue.lowercased())")
                    }
                }
            }

            // Swatches, not a menu of words. An accent picker whose options are
            // the strings "Coral" and "Teal" asks the reader to imagine the
            // result; showing the five colours is the whole decision at a glance —
            // and it is what the web does.
            JunoMobileSettingsField(label: "Accent color") {
                JunoMobileAccentPicker(
                    selection: binding(\.accent) { NativeSettingsPatch(accent: $0) },
                    disabled: disabled
                )
            }
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

    private var defaultModelTile: some View {
        JunoSettingsTile("Default model") {
            Text("New chats start with this model. You can change it per chat from the composer.")
                .junoCaption()

            JunoMobileSettingsSelect(
                label: "Default model",
                options: modelOptions,
                title: { LocalizedStringKey(self.modelTitle($0)) },
                selection: binding(\.defaultModel) { NativeSettingsPatch(defaultModel: $0) },
                isEnabled: !disabled && !modelCatalog.isEmpty
            )
            .accessibilityIdentifier("juno.mobile.settings-default-model")

            if !modelCatalog.isEmpty {
                Divider()

                // A push, not a menu: favourites is a set over the whole catalog,
                // and a multi-select of thirty rows is a screen.
                NavigationLink {
                    JunoMobileFavoriteModelsView(
                        settings: settings,
                        modelCatalog: modelCatalog,
                        disabled: disabled,
                        update: update
                    )
                } label: {
                    JunoMobileSettingsRowLabel(
                        title: "Favorite models",
                        symbol: "star",
                        value: Text("^[\(settings.favoriteModels.count) favorite](inflect: true)")
                    )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("juno.mobile.settings-favorite-models")
            }
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

    /// Two tiles, as on the web, because they are two different questions and
    /// pairing them under one "Language" header is what made people set the wrong
    /// one: this is the language of the *answers*.
    private var responseLanguageTile: some View {
        JunoSettingsTile("Response language") {
            Text("The language Juno replies in.")
                .junoCaption()
            JunoMobileSettingsSelect(
                label: "Response language",
                options: knownOrCurrent(Self.responseLanguages, current: settings.responseLanguage),
                title: { $0 == "auto" ? "Auto-detect" : LocalizedStringKey($0) },
                selection: binding(\.responseLanguage) {
                    NativeSettingsPatch(responseLanguage: $0)
                },
                isEnabled: !disabled
            )
            .accessibilityIdentifier("juno.mobile.settings-response-language")
        }
    }

    private var interfaceLanguageTile: some View {
        JunoSettingsTile("Interface language") {
            Text("The language Juno's buttons and menus are in.")
                .junoCaption()
            JunoMobileSettingsSelect(
                label: "Interface language",
                options: knownOrCurrent(Self.interfaceLocales, current: settings.interfaceLocale),
                title: { LocalizedStringKey(Self.localeTitle($0)) },
                selection: binding(\.interfaceLocale) {
                    NativeSettingsPatch(interfaceLocale: $0)
                },
                isEnabled: !disabled
            )
            .accessibilityIdentifier("juno.mobile.settings-interface-language")
        }
    }

    /// Each language names itself — "Français", not "French" — which is the
    /// website's own rule and the only version a reader who needs the option can
    /// read. Falls back to this device's name for it, then to the raw identifier.
    private static func localeTitle(_ locale: String) -> String {
        guard locale != "auto" else { return "Match system" }
        let native = Locale(identifier: locale).localizedString(forIdentifier: locale)
        let name = native ?? Locale.current.localizedString(forIdentifier: locale) ?? locale
        return name.localizedCapitalized
    }

    // MARK: Response style

    /// The six styles as cards with their sentences, from the shared table.
    ///
    /// This is the control the rebuild existed for. It was a menu of
    /// `id.capitalized`, so the phone offered "Socratic" and "Nerdy" as bare
    /// words while the Mac and the web both explained them.
    private var responseStyleTile: some View {
        let personality = binding(\.personality) { NativeSettingsPatch(personality: $0) }
        return JunoSettingsTile("Response style") {
            Text("How Juno writes. Your custom instructions below still take priority.")
                .junoCaption()

            VStack(spacing: JunoSpace.snug) {
                // A style added to the web after this build shipped keeps its
                // place at the top of the group rather than disappearing — and
                // because nothing here writes on appearance, it stays chosen
                // until the reader picks something else.
                if JunoResponseStyle.named(settings.personality) == nil {
                    JunoChoiceCard(
                        title: LocalizedStringKey(settings.personality.localizedCapitalized),
                        detail: "Set on another Juno client. Choosing one below replaces it.",
                        isSelected: true,
                        isEnabled: false,
                        select: {}
                    )
                }
                ForEach(JunoResponseStyle.all) { style in
                    JunoChoiceCard(
                        title: style.localizedLabel,
                        detail: style.localizedDetail,
                        isSelected: style.id == settings.personality,
                        isEnabled: !disabled
                    ) {
                        personality.wrappedValue = style.id
                    }
                    .accessibilityIdentifier("juno.mobile.personality-\(style.id)")
                }
            }
        }
    }

    // MARK: Custom instructions

    /// Editable in place, with the count inset in the field.
    ///
    /// The Edit button this replaces bought nothing: it hid the field behind a
    /// tap and still needed Save. The counter is the web's, and it is not a cap —
    /// it is the one number that tells you a long paste actually landed.
    private var instructionsTile: some View {
        JunoSettingsTile("Custom instructions") {
            Text("Juno keeps these in mind in every conversation. There is no character cap — the model's context window is the only real limit.")
                .junoCaption()

            instructionsEditor

            HStack(spacing: JunoSpace.cozy) {
                Button("Revert") { instructionsDraft = settings.customInstructions }
                    .buttonStyle(.plain)
                    .junoRowLabel()
                    .junoSecondaryInk()
                    .disabled(instructionsDraft == settings.customInstructions)
                Spacer(minLength: 0)
                Button("Save") {
                    update(NativeSettingsPatch(customInstructions: instructionsDraft))
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.junoAccent)
                .disabled(disabled || instructionsDraft == settings.customInstructions)
                .accessibilityIdentifier("juno.mobile.settings-save-instructions")
            }
        }
        .task(id: settings.customInstructions) {
            let stored = settings.customInstructions
            if instructionsDraft == (instructionsBaseline ?? "") {
                instructionsDraft = stored
            }
            instructionsBaseline = stored
        }
    }

    private var instructionsEditor: some View {
        let shape = RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
        return TextEditor(text: $instructionsDraft)
            .junoBody()
            .frame(minHeight: 120)
            .scrollContentBackground(.hidden)
            .padding(.horizontal, JunoSpace.snug)
            .padding(.top, JunoSpace.snug)
            // Room for the counter, so a long instruction does not run under it.
            .padding(.bottom, JunoSpace.section)
            .background(shape.fill(Color.junoCanvas))
            .overlay(shape.strokeBorder(Color.junoBorder, lineWidth: 1))
            .overlay(alignment: .topLeading) {
                if instructionsDraft.isEmpty {
                    Text("E.g. I'm a product manager. Keep answers concise and use bullet points.")
                        .junoBody()
                        .junoMetaInk()
                        // The extra 5 points is `TextEditor`'s own text inset,
                        // which is not exposed and has to be matched by hand or
                        // the placeholder sits left of the caret.
                        .padding(.horizontal, JunoSpace.snug + 5)
                        .padding(.top, JunoSpace.snug + 8)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                Text("\(instructionsDraft.count) chars")
                    .junoCodeSmall()
                    .junoMetaInk()
                    .padding(.trailing, JunoSpace.cozy)
                    .padding(.bottom, JunoSpace.snug)
                    .allowsHitTesting(false)
            }
            .accessibilityLabel("Custom instructions")
            .accessibilityIdentifier("juno.mobile.settings-instructions")
    }

    // MARK: Helpers

    /// Keeps an unknown stored value selectable so the picker never silently
    /// rewrites a preference this build does not recognize.
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

// MARK: - Email notifications

/// The two switches, each with the sentence that says what it will send.
///
/// Its own view only because it sits *below* Account on the website's page, and
/// Account is the host's tile — the alternative was to reorder the page away from
/// the reference to keep the settings-backed tiles contiguous.
private struct JunoMobileSettingsEmailTile: View {
    let settings: NativeAccountSettings
    let disabled: Bool
    let update: @MainActor @Sendable (NativeSettingsPatch) -> Void

    var body: some View {
        JunoSettingsTile("Email notifications") {
            JunoMobileSettingsSwitch(
                title: "Budget alerts",
                detail: "Email me at 80% of my monthly budget.",
                isOn: binding(\.emailBudgetAlerts) {
                    NativeSettingsPatch(emailBudgetAlerts: $0)
                },
                isEnabled: !disabled
            )
            .accessibilityIdentifier("juno.mobile.settings-budget-alerts")

            Divider()

            JunoMobileSettingsSwitch(
                title: "Weekly digest",
                detail: "Usage recap every Monday.",
                isOn: binding(\.emailWeeklyDigest) {
                    NativeSettingsPatch(emailWeeklyDigest: $0)
                },
                isEnabled: !disabled
            )
            .accessibilityIdentifier("juno.mobile.settings-weekly-digest")

            Text("Both go to your account's email address, and both are stored on the account — turning one off here turns it off on the web too.")
                .junoCaption()
        }
    }

    private func binding<Value: Equatable & Sendable>(
        _ keyPath: KeyPath<NativeAccountSettings, Value> & Sendable,
        patch: @escaping @Sendable (Value) -> NativeSettingsPatch
    ) -> Binding<Value> {
        junoMobileSettingsBinding(settings, keyPath, update: update, patch: patch)
    }
}

/// A binding onto one field of the account's settings record.
///
/// The patch is only sent when the value actually changes. A `Picker` writes its
/// selection back on layout passes where nothing moved, and without this guard
/// the offline outbox filled with no-op mutations that then had to sync.
///
/// Everything this captures is `Sendable`, because `Binding`'s accessors are
/// `@Sendable` in the iOS 26 SDK: without the constraints the four captures — the
/// key path, the metatype and the two closures — are each diagnosed under Swift 6
/// strict concurrency. The Mac's equivalent carries the same signature for the
/// same reason; it was only invisible here while the helper was a method whose
/// captures rode in on `self`.
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
            // be re-stated rather than inferred. `assumeIsolated` records that
            // invariant instead of hiding it in a `Task`, which would also make the
            // write land a turn late — long enough for a picker to read back its
            // old value and flicker.
            MainActor.assumeIsolated { update(patch(value)) }
        }
    )
}

// MARK: - Favorite models

/// The catalog, grouped by provider, with a switch per model.
///
/// Cards on the canvas rather than a `List`: this app took the grouped list out
/// of every other screen it had one on, and a settings subpage is not the place
/// to put it back.
private struct JunoMobileFavoriteModelsView: View {
    let settings: NativeAccountSettings
    let modelCatalog: [NativeChatModelOption]
    let disabled: Bool
    let update: @MainActor @Sendable (NativeSettingsPatch) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                JunoPageTitle(
                    title: "Favorite models",
                    subtitle: "These sit at the top of the composer's model menu."
                )

                ForEach(groups, id: \.provider) { group in
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        JunoGroupLabel(text: group.provider)
                        JunoCard(padding: 0) {
                            VStack(spacing: 0) {
                                ForEach(Array(group.options.enumerated()), id: \.element.id) {
                                    index, option in
                                    if index > 0 {
                                        Divider().padding(.leading, JunoSpace.regular)
                                    }
                                    Toggle(isOn: favoriteBinding(option.id)) {
                                        Text(option.displayName)
                                            .junoRowLabel()
                                            .fontWeight(.medium)
                                    }
                                    .tint(Color.junoAccent)
                                    .disabled(disabled)
                                    .padding(.horizontal, JunoSpace.regular)
                                    .padding(.vertical, JunoSpace.cozy)
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.hairline)
            .padding(.bottom, JunoSpace.region)
            .frame(maxWidth: 768)
            .frame(maxWidth: .infinity)
        }
        .junoScreenCanvas()
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("juno.mobile.favorite-models")
    }

    /// Grouped in catalog order rather than alphabetically: the manifest already
    /// ranks providers the way the composer's menu shows them, and re-sorting here
    /// would put the two screens in different orders.
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

// MARK: - Tile furniture

/// A labelled field inside a tile — the web's `<Label>` above its control.
///
/// Only for tiles that hold more than one control. Where a tile has exactly one,
/// the eyebrow already names it and a label would print the same words twice.
private struct JunoMobileSettingsField<Control: View>: View {
    let label: LocalizedStringKey
    @ViewBuilder var control: Control

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text(label).junoCaption()
            control
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A dropdown for a list too long to show at once: the model catalog, the twelve
/// response languages, the twenty-one interface locales.
///
/// A `Menu` wrapping an inline `Picker` rather than `.pickerStyle(.menu)`: the
/// menu style renders a bare label with no field around it, and inside a card
/// that reads as text rather than as a control. The trigger here is the web's
/// `SelectTrigger` — full width, outlined, with the current value in it — while
/// the `Picker` inside still supplies the checkmarked list and, crucially, still
/// writes through the no-op-suppressing binding.
private struct JunoMobileSettingsSelect<Value: Hashable>: View {
    let label: LocalizedStringKey
    let options: [Value]
    let title: (Value) -> LocalizedStringKey
    @Binding var selection: Value
    var isEnabled = true

    var body: some View {
        Menu {
            Picker(label, selection: $selection) {
                ForEach(options, id: \.self) { option in
                    Text(title(option)).tag(option)
                }
            }
            .pickerStyle(.inline)
        } label: {
            HStack(spacing: JunoSpace.snug) {
                Text(title(selection))
                    .junoRowLabel()
                    .lineLimit(1)
                Spacer(minLength: JunoSpace.tight)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.semibold))
                    .junoSecondaryInk()
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.cozy)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .fill(Color.junoCanvas)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous))
        }
        // Ink, not coral. A `Menu` tints its whole label, so the *value* inside a
        // field-shaped trigger came out accent-coloured and read as a link rather
        // than as what the setting is currently set to. Same fix, and the same
        // reason, as the chat header's menu.
        .tint(Color.primary)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.5)
        .accessibilityLabel(label)
        .accessibilityValue(Text(title(selection)))
    }
}

/// A switch with the sentence that says what it will do.
///
/// The sentence is a hint rather than part of the name: VoiceOver reads the name
/// on every focus and the hint only when the reader waits for it.
private struct JunoMobileSettingsSwitch: View {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    @Binding var isOn: Bool
    var isEnabled = true

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(title)
                    .junoRowLabel()
                    .fontWeight(.medium)
                Text(detail)
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .tint(Color.junoAccent)
        .disabled(!isEnabled)
        .accessibilityLabel(title)
        .accessibilityHint(detail)
    }
}

/// The contents of a row that leads somewhere: glyph, title, value, chevron.
///
/// Split from the button so a `NavigationLink` and a `Button` can wear the same
/// row without either of them being wrapped in the other.
private struct JunoMobileSettingsRowLabel: View {
    let title: LocalizedStringKey
    let symbol: String
    var value: Text?

    var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            Image(systemName: symbol)
                .font(.body)
                .foregroundStyle(Color.junoAccent)
                .frame(width: 22)
            Text(title)
                .junoRowLabel()
                .fontWeight(.medium)
            Spacer(minLength: JunoSpace.tight)
            if let value {
                value.junoCaption()
            }
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .junoMetaInk()
        }
        .contentShape(Rectangle())
    }
}

/// A row inside a tile that pushes a subpage. Deliberately not a
/// `NavigationLink` in a `List`: these tiles are not list rows, and the chevron
/// has to sit at the card's own trailing edge.
private struct JunoMobileSettingsLink: View {
    let title: LocalizedStringKey
    let symbol: String
    var value: Text?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            JunoMobileSettingsRowLabel(title: title, symbol: symbol, value: value)
        }
        .buttonStyle(.plain)
    }
}

/// A row inside a tile that *does* something: export, sign out, delete.
///
/// Destructive rows tint the glyph and the title and leave the explanation in
/// secondary ink. Tinting the whole stack dragged the sentence to a pale red that
/// read as disabled — and it is secondary text, not a second warning.
private struct JunoMobileSettingsAction: View {
    let title: LocalizedStringKey
    var detail: LocalizedStringKey?
    let symbol: String
    var isDestructive = false
    var isBusy = false
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.cozy) {
                Group {
                    if isBusy {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: symbol)
                            .font(.body)
                            .foregroundStyle(isDestructive ? Color.junoDanger : Color.junoAccent)
                    }
                }
                .frame(width: 22)
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(title)
                        .junoRowLabel()
                        .fontWeight(.medium)
                        .foregroundStyle(isDestructive ? Color.junoDanger : Color.primary)
                    if let detail {
                        Text(detail)
                            .junoCaption()
                            .fixedSize(horizontal: false, vertical: true)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
    }
}

// MARK: - Accent picker

struct JunoMobileAccentPicker: View {
    @Binding var selection: String
    var disabled: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
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
                                .padding(-JunoSpace.hairline)
                                .opacity(chosen ? 1 : 0)
                        }
                        .frame(width: 44, height: 44)
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

// MARK: - Export

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
