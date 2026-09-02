import JunoAuth
import JunoChatKit
import JunoCodeBridge
import JunoCodeUI
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoWorkKit
import SwiftUI

struct JunoDesktopRootView: View {
    let configuration: JunoDesktopConfiguration
    @Environment(\.scenePhase) private var scenePhase
    @SceneStorage("juno.desktop.product") private var storedProduct = DesktopProductMode.chat.rawValue
    @State private var workbenchModel: WorkbenchModel?
    /// The main window is a launch surface, not a resume surface. Keep this
    /// pending until the Chat workspace has consumed the one-shot route so a
    /// stored Code or Work product, or a stored Chat destination, cannot win the
    /// first frame.
    @State private var startupRoutePending = true

    /// The launch policy is deliberately unchanged for Juno Work.
    ///
    /// Work is the product most likely to be mid-flight when the app opens — a
    /// task running on this Mac, a task waiting on an approval — and that is
    /// exactly the argument for *not* opening on it. Restoring straight into a
    /// thread means the first thing a new window presents is an approval card
    /// for an action the reader has no context for yet, decided in the second
    /// after launch. Chat is where the app opens; one click on the switcher is
    /// the whole cost of getting to Work, and the sidebar's attention section
    /// is what says something is waiting.
    private var productBinding: Binding<DesktopProductMode> {
        Binding(
            get: {
                // Do not let a restored Code or Work selection paint even one
                // launch frame. The route is released only after Chat appears.
                guard !startupRoutePending else { return .chat }
                return DesktopProductMode(rawValue: storedProduct) ?? .chat
            },
            set: { storedProduct = $0.rawValue }
        )
    }

    private var preferredColorScheme: ColorScheme? {
        switch configuration.memorySettingsModel?.settings?.theme {
        case .light: .light
        case .dark: .dark
        case .system, .none: nil
        }
    }

    var body: some View {
        phaseContent
            .preferredColorScheme(preferredColorScheme)
            .task {
                applyStartupRouteIfNeeded()
                await configuration.authModel.restore()
            }
            .onChange(of: configuration.authModel.phase) { _, phase in
                Task {
                    await updateLifecycle(for: phase)
                }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                Task { await configuration.authModel.retryRestore() }
            }
            .onChange(of: configuration.syncModel?.synchronizationGeneration) {
                _, generation in
                guard let generation else { return }
                Task {
                    await configuration.conversationModel?
                        .synchronizationDidAdvance(to: generation)
                    await configuration.projectModel?
                        .synchronizationDidAdvance(to: generation)
                    await configuration.projectWorkspaceModel?
                        .synchronizationDidAdvance(to: generation)
                    await configuration.artifactModel?
                        .synchronizationDidAdvance(to: generation)
                    await configuration.memorySettingsModel?
                        .synchronizationDidAdvance(to: generation)
                    configuration.searchModel?
                        .synchronizationDidAdvance(to: generation)
                }
            }
            .onChange(of: configuration.memorySettingsModel?.settings?.accent) {
                _, accent in
                JunoAccentSelection.shared.apply(setting: accent)
            }
            .onChange(of: workbenchModel?.workspaces) { _, workspaces in
                // The workbench is built at the end of `updateLifecycle` and
                // loads its grants asynchronously in `bootstrap()`, so there is
                // no moment during sign-in at which a one-shot copy would be
                // anything but empty. Watching the property is the only way the
                // heartbeat carries real folders rather than an empty list the
                // phone reads as "this Mac has nowhere to work".
                configuration.codeHostModel?.setWorkspaces(from: workspaces ?? [])
            }
            .onChange(of: configuration.conversationModel?.selectableModels) {
                _, models in
                // `nil` means the manifest has not loaded. An empty array is an
                // authoritative revocation and must clear stale capabilities.
                guard let models else { return }
                let codeModels = Self.codeModels(from: models)
                Task {
                    await workbenchModel?.setAvailableModels(codeModels)
                }
            }
    }

    @ViewBuilder
    private var phaseContent: some View {
        switch configuration.authModel.phase {
        case .signedIn(let session):
            VStack(spacing: 0) {
                // Shown when the session was restored from the Keychain without
                // the server confirming it. The workspace below is real, local
                // and usable; only its freshness is unknown.
                if case .unreachable(let cause) = configuration.authModel.connectivity {
                    JunoDesktopOfflineBanner(cause: cause) {
                        Task { await configuration.authModel.retryRestore() }
                    }
                }
                JunoDesktopWorkspaceView(
                    configuration: configuration,
                    session: session,
                    product: productBinding,
                    workbenchModel: workbenchModel,
                    initialDestination: startupRoutePending ? .chat : nil,
                    consumeInitialDestination: {
                        startupRoutePending = false
                    }
                )
            }
        case .restoring:
            JunoDesktopLoadingView()
        case .signedOut, .signingIn, .unavailable:
            JunoDesktopSignInView(
                authModel: configuration.authModel,
                localStoreRecovery: configuration.localStoreRecovery
            )
        }
    }

    /// Reset only the launch route. Once the Chat workspace has appeared, its
    /// one-shot destination is retired and ordinary Chat/Code navigation is
    /// allowed to persist again for the rest of the session.
    @MainActor
    private func applyStartupRouteIfNeeded() {
        guard startupRoutePending else { return }
        storedProduct = DesktopProductMode.chat.rawValue
        configuration.conversationModel?.isDraftingNewConversation = true
        configuration.conversationModel?.selectedConversationID = nil
    }

    @MainActor
    private func updateLifecycle(for phase: NativeAuthModel.Phase) async {
        guard case .signedIn(let session) = phase else {
            let previousWorkbench = workbenchModel
            workbenchModel = nil
            DesktopWorkbenchRegistry.shared.register(workbench: nil, codeModel: nil)
            configuration.codeHostModel?.disconnectWorkbench()
            stopAuthenticatedModels()
            await previousWorkbench?.shutdown()
            return
        }

        let accountID = session.profile.id
        if let previousWorkbench = workbenchModel {
            workbenchModel = nil
            await previousWorkbench.shutdown()
            // A sign-out or another account switch can arrive while shutdown
            // is awaiting controller cancellation.
            guard case .signedIn(let currentSession) = configuration.authModel.phase,
                  currentSession.profile.id == accountID
            else { return }
        }
        configuration.syncModel?.start(for: accountID)
        configuration.attachmentModel?.start(for: accountID)
        configuration.workAttachmentModel?.start(for: accountID)
        configuration.workContextAttachmentModel?.start(for: accountID)
        configuration.avatarModel?.start(for: session.profile)
        configuration.searchModel?.start(for: accountID)
        configuration.privateChatModel?.start(for: accountID)
        configuration.libraryModel?.start(for: accountID)
        configuration.documentIndexModel?.start(for: accountID)
        // Before the first turn can be sent, and last so it runs after every
        // model it reads is started. Both hooks are pure composition and neither
        // touches the network, so they are set synchronously rather than inside
        // the task below — a whitelist that attaches a moment after the composer
        // is usable is a whitelist with a window in it.
        configuration.connectAssistantHooks()
        Task {
            await configuration.conversationModel?.start(for: accountID)
            await configuration.projectModel?.start(for: accountID)
            // After the projects, and given their ids: the workspace store reports
            // configurations whose project is missing so a screen can say so, and
            // "missing" is only meaningful once the project list has actually
            // loaded. Starting it first would report every assistant as orphaned.
            await configuration.projectWorkspaceModel?.start(for: accountID)
            await configuration.projectWorkspaceModel?.reload(
                knownProjectIDs: Set(
                    (configuration.projectModel?.projects ?? []).map(\.id)
                )
            )
            await configuration.artifactModel?.start(for: accountID)
            await configuration.memorySettingsModel?.start(for: accountID)
            await configuration.connectorModel?.start(for: accountID)
            await configuration.scheduledTaskModel?.start(for: accountID)
            await configuration.codeModel?.start(for: accountID)
            // Started at sign-in rather than when the Work product is first
            // opened, because the model is also what answers "is anything
            // waiting on me": its poll is the only thing that notices a task
            // that has stopped for an approval, and a model started on first
            // view would notice nothing until the reader had already gone
            // looking.
            await configuration.workModel?.start(for: accountID)
            await configuration.workAutomationModel?.start(for: accountID)
        }
        configuration.remoteCodeModel?.start(for: accountID)
        // Registration is presence, not capability — a signed-in Mac saying it
        // exists — so it starts with everything else rather than behind a
        // switch. What it does *not* do is accept work; see DesktopCodeHost.swift.
        configuration.codeHostModel?.start(for: accountID)
        // The same split, for Work. Its heartbeat is what creates the WorkHost
        // row and hands this Mac the id every host-plane route is addressed by —
        // nothing else in the product produces one, which is why switching Juno
        // Work on used to leave the settings card saying this Mac had not
        // finished pairing for ever. Whether it then *claims* anything is the
        // master switch's decision, made in DesktopWorkHost.swift.
        configuration.workHostModel?.start(for: accountID)

        if let runtime = configuration.runtime {
            let workbench = WorkbenchModel(
                dependencies: .standard(
                    accountID: accountID.rawValue,
                    modelClient: BackendCodeModelClient(
                        streamer: runtime,
                        accountID: accountID
                    ),
                    availableModels: initialCodeModels,
                    webSearch: BackendCodeWebSearchClient(
                        sender: runtime,
                        accountID: accountID
                    )
                )
            )
            workbenchModel = workbench
            configuration.codeHostModel?.connect(workbench: workbench)
            DesktopWorkbenchRegistry.shared.register(
                workbench: workbench,
                codeModel: configuration.codeModel
            )
        }
    }

    /// The account's manifest, projected onto Code's own option type **with the
    /// catalog entry attached**.
    ///
    /// This used to be `ModelOption(modelID:displayName:)`, which kept the two
    /// fields the runtime needs and discarded everything else. `ModelOption`'s
    /// `catalog` is what the shared selector reads for the provider mark, the
    /// lab's name, the capability chips, the pricing tier and the spec sheet —
    /// so dropping it left Juno Code with a picker of bare display names under
    /// "Unknown provider", while Chat, reading the identical manifest, showed
    /// the full website catalog. Two pickers, one manifest, and only one of them
    /// looked like the product.
    ///
    /// `ModelOption(catalog:)` also narrows the thinking ladder to the depths
    /// the entry actually publishes, so the reasoning control stops offering
    /// three fixed efforts for every model regardless of what it supports.
    /// Chat models only, and that filter is not redundant with the resolver's.
    ///
    /// `CodeModelProviderResolver.supports` answers a question about the
    /// *provider prefix* — whether `/api/agent` has a path for that lab — so it
    /// says yes to every id under a lab Juno can reach, including that lab's
    /// image and video models. The account manifest carries 27 of those, 23 of
    /// them under providers Code allows, so the picker was offering
    /// `openai:gpt-image-2`, `google:veo-3.1-generate-preview` and
    /// `xai:grok-imagine-video` as models to run a coding session on. None of
    /// them can hold a tool-calling loop; picking one produced a session whose
    /// first turn failed.
    ///
    /// `isChatCapable` is the manifest's own answer rather than a guess made from
    /// the id, and it is the same predicate the Chat composer already uses to
    /// keep those entries out of its picker — whose doc comment says exactly this:
    /// "Image and video generation entries share the manifest but are not
    /// selectable here … they are a different product."
    static func codeModels(from manifest: [NativeChatModelOption]) -> [ModelOption] {
        manifest
            .filter(\.isChatCapable)
            .filter { CodeModelProviderResolver.supports($0.id) }
            .map { ModelOption(catalog: $0.junoDescriptor) }
    }

    private var initialCodeModels: [ModelOption] {
        let catalog = configuration.conversationModel?.selectableModels ?? []
        if !catalog.isEmpty {
            let codeModels = Self.codeModels(from: catalog)
            if !codeModels.isEmpty { return codeModels }
        }
        // Only used during the brief bootstrap window before the signed-in
        // manifest arrives; `onChange` above replaces it with the full account
        // catalog immediately afterwards.
        return [
            ModelOption(
                modelID: "anthropic:claude-sonnet-5",
                displayName: "Claude Sonnet 5"
            ),
        ]
    }

    private func stopAuthenticatedModels() {
        configuration.syncModel?.stop()
        configuration.attachmentModel?.stop()
        configuration.workAttachmentModel?.stop()
        configuration.workContextAttachmentModel?.stop()
        configuration.avatarModel?.clear()
        configuration.conversationModel?.stop()
        configuration.privateChatModel?.stop()
        configuration.projectModel?.stop()
        configuration.projectWorkspaceModel?.stop()
        configuration.artifactModel?.stop()
        configuration.memorySettingsModel?.stop()
        // Async because the extraction throttle lives in an actor. Proposals are
        // in-memory and account-scoped, so leaving them behind on sign-out would
        // show the next account what the previous one had been asked about.
        if let memoryLearningModel = configuration.memoryLearningModel {
            Task { await memoryLearningModel.stop() }
        }
        configuration.searchModel?.stop()
        configuration.connectorModel?.stop()
        configuration.scheduledTaskModel?.stop()
        configuration.codeModel?.stop()
        configuration.remoteCodeModel?.stop()
        configuration.codeHostModel?.stop()
        configuration.workModel?.stop()
        configuration.workAutomationModel?.stop()
        // Not `stopServingWork()`, which only writes the preference off.
        // Sign-out has to take the claim loop down *without* rewriting the
        // reader's standing decision about this machine, so that signing back
        // in restores the Mac they had set up rather than a Mac with Juno Work
        // silently switched off.
        configuration.workHostModel?.detach()
        configuration.libraryModel?.stop()
        // Not merely "forget the list": the plaintext of every indexed document
        // is in that index, so `stop()` wipes the account's partition. Signing
        // out has to leave nothing behind for the next person at this Mac.
        configuration.documentIndexModel?.stop()
    }
}

private struct JunoDesktopLoadingView: View {
    var body: some View {
        ProgressView()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.ultraThinMaterial)
    }
}

/// The signed-out window, built to the website's auth surface
/// (`src/app/(auth)/layout.tsx` + `sign-in/page.tsx`).
///
/// That surface is one centred column on the warm canvas — dot field, the Juno
/// mark, the mono wordmark, a white card, then fine print — not the two-pane
/// marketing split this used to be. The split's right half was a coral rectangle
/// holding `JunoIconView(systemImage: "circle.grid.cross")`, an SF Symbol standing in for
/// a brand mark Juno actually ships; and its headline asked for
/// `Font.custom("Newsreader", …)`, which resolves nothing, because the bundled
/// faces register under their PostScript names and not under that family. It
/// silently fell back to the system sans, so the one place the editorial voice
/// had to appear was the one place it did not. ``JunoSerif`` exists to make that
/// unrepeatable.
/// A strip above the workspace saying the obvious out loud: this is your data,
/// but Juno has not been reachable, so nothing here has been checked against the
/// server. Non-blocking on purpose — the previous behaviour was to sign the user
/// out entirely, which threw away a working local workspace to show a sign-in
/// screen that could not succeed either.
private struct JunoDesktopOfflineBanner: View {
    let cause: String
    let retry: () -> Void

    var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            JunoIconView(systemImage: "bolt.horizontal.circle")
            VStack(alignment: .leading, spacing: 2) {
                Text("Juno is unreachable — showing your local copy")
                    .font(.callout)
                Text(cause)
                    .junoCaption()
                    .lineLimit(2)
                    .textSelection(.enabled)
            }
            Spacer(minLength: JunoSpace.cozy)
            Button("Try again", action: retry)
                .junoGlassButton()
                .controlSize(.small)
        }
        .padding(.horizontal, JunoSpace.roomy)
        .padding(.vertical, JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.junoCanvasWarm)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.junoHairline).frame(height: 1)
        }
        .accessibilityIdentifier("juno.desktop.offline-banner")
    }
}

private struct JunoDesktopSignInView: View {
    /// The web's `max-w-sm` card column, and its `h-12 w-12` mark.
    private static let columnWidth: CGFloat = 360
    private static let markSize: CGFloat = 48

    let authModel: NativeAuthModel
    /// Present only for the one launch failure that has a way out; see
    /// ``JunoDesktopLocalStoreRecovery``.
    let localStoreRecovery: JunoDesktopLocalStoreRecovery?

    @State private var email = ""
    @State private var password = ""
    @FocusState private var focusedField: Field?

    private enum Field: Hashable { case email, password }

    private var isBusy: Bool { authModel.phase == .signingIn }
    private var canSubmitPassword: Bool {
        !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !password.isEmpty
            && !isBusy
            && authModel.phase != .unavailable
    }

    private func submitPassword() {
        guard canSubmitPassword else { return }
        let submittedPassword = password
        // Drop the plaintext from view state as soon as it is handed over; the
        // model does not retain it either.
        password = ""
        Task { await authModel.signIn(email: email, password: submittedPassword) }
    }

    var body: some View {
        VStack(spacing: JunoSpace.section) {
            VStack(spacing: JunoSpace.cozy) {
                JunoMark(size: Self.markSize)
                JunoWordmark()
            }

            card
                .frame(maxWidth: Self.columnWidth)

            // The two honest notes the web pairs under its card: what the
            // account is for, and — native-only, because only the app could get
            // this wrong — what happens to a password typed here. It is sent
            // once, over TLS, to Juno's own origin, and never written to disk;
            // what persists is the device token the server hands back.
            VStack(spacing: JunoSpace.tight) {
                Text(
                    "Your password is sent once to Juno and never stored on this Mac. Sign in through the browser instead if your account uses Google."
                )
                Text(
                    "By continuing you agree to use Juno responsibly. Your conversations are private to your account."
                )
            }
            .junoCaption()
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: Self.columnWidth)
        }
        .padding(JunoSpace.region)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            // Canvas first, dot field over it: the web layers the same two, and
            // the field has to read as printed *on* the paper rather than as a
            // texture the paper is sitting on.
            Color.junoCanvasWarm
            JunoDotField()
        }
    }

    private var card: some View {
        VStack(spacing: JunoSpace.roomy) {
            VStack(spacing: JunoSpace.tight) {
                Text("Welcome back")
                    .font(JunoSerif.pageHeading())
                Text("Sign in to continue to Juno.")
                    .font(.callout)
                    .junoSecondaryInk()
            }
            .multilineTextAlignment(.center)

            credentialFields

            Button(action: submitPassword) {
                Group {
                    if isBusy {
                        HStack(spacing: JunoSpace.snug) {
                            ProgressView()
                                .controlSize(.small)
                            Text("Signing in…")
                        }
                    } else {
                        Text("Sign in")
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .junoProminentGlassButton()
            .controlSize(.large)
            .disabled(!canSubmitPassword)
            .accessibilityIdentifier("Sign in")

            browserDivider

            Button {
                Task { await authModel.signIn() }
            } label: {
                Text("Continue in browser")
                    .frame(maxWidth: .infinity)
            }
            .junoGlassButton()
            .controlSize(.large)
            .disabled(isBusy || authModel.phase == .unavailable)
            .accessibilityIdentifier("Sign in to Juno")

            // The real failure, in full, selectable — a sign-in that cannot
            // explain itself is a sign-in nobody can report.
            if let error = authModel.lastErrorDescription {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(Color.junoDanger)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            if let localStoreRecovery {
                JunoDesktopLocalStoreRecoveryNotice(recovery: localStoreRecovery)
            }
        }
        .padding(JunoSpace.section)
        .junoCard(cornerRadius: JunoRadius.card)
    }

    private var credentialFields: some View {
        VStack(spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Email")
                    .junoCaption()
                TextField("you@example.com", text: $email)
                    .textContentType(.username)
                    .textFieldStyle(.roundedBorder)
                    .focused($focusedField, equals: .email)
                    .onSubmit { focusedField = .password }
                    .accessibilityIdentifier("Email")
            }
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Password")
                    .junoCaption()
                SecureField("", text: $password)
                    .textContentType(.password)
                    .textFieldStyle(.roundedBorder)
                    .focused($focusedField, equals: .password)
                    .onSubmit(submitPassword)
                    .accessibilityIdentifier("Password")
            }
        }
        .disabled(isBusy || authModel.phase == .unavailable)
    }

    private var browserDivider: some View {
        HStack(spacing: JunoSpace.cozy) {
            Rectangle().fill(Color.junoHairline).frame(height: 1)
            Text("or")
                .junoCaption()
            Rectangle().fill(Color.junoHairline).frame(height: 1)
        }
    }
}

/// The way out of a local database this build cannot unlock, offered inside the
/// sign-in card because that is the only screen the user can reach.
///
/// Shown for that failure alone. Every other startup error prints its sentence
/// and stops, which is correct — there is nothing the user could do — and an
/// offer to move their database aside attached to all of them would be a
/// destructive button waiting for an unrelated bug to surface it.
///
/// The copy names what does not come back. Records, projects, artifacts, memories
/// and settings are a cache of the account and are re-downloaded from the
/// bootstrap baseline on the next sign-in; the outbox of edits this Mac has not
/// managed to send yet lives in the same file and exists nowhere else. Saying
/// "nothing is lost" would have been shorter and untrue.
private struct JunoDesktopLocalStoreRecoveryNotice: View {
    let recovery: JunoDesktopLocalStoreRecovery

    private var isRunning: Bool { recovery.phase == .running }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Rectangle().fill(Color.junoHairline).frame(height: 1)

            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                JunoIconView(systemImage: "lock.slash")
                    .foregroundStyle(Color.junoCaution)
                // The error line above already says the store cannot be
                // unlocked; this says why, rather than saying it twice.
                Text("Its key is in a Keychain this build can't reach")
                    .font(.callout)
                    .fontWeight(.medium)
            }

            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text(
                    "Starting a fresh local copy gets you past this screen. Your conversations, projects, artifacts and settings download again once you sign in. Changes made on this Mac that hadn't reached Juno yet — anything edited while offline — won't come back."
                )
                Text(
                    "The old copy is moved aside in Application Support ▸ Juno ▸ Desktop, not deleted."
                )
            }
            .junoCaption()
            .fixedSize(horizontal: false, vertical: true)

            Button {
                Task { await recovery.recoverAndRestart() }
            } label: {
                Group {
                    if isRunning {
                        HStack(spacing: JunoSpace.snug) {
                            ProgressView()
                                .controlSize(.small)
                            Text("Starting a fresh copy…")
                        }
                    } else {
                        Text("Start a fresh copy and restart Juno")
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .junoGlassButton()
            .disabled(isRunning)
            .accessibilityIdentifier("juno.desktop.recover-local-store")

            if case .failed(let message) = recovery.phase {
                Text(message)
                    .junoCaption()
                    .foregroundStyle(Color.junoDanger)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The mono wordmark, matching the web's `AsciiWordmark`.
///
/// A logotype rather than a label, which is why it keeps the wide tracking the
/// rest of Juno's mono voice dropped.
private struct JunoWordmark: View {
    /// The web's `tracking-[0.12em]` resolved against its 14px mono size.
    private static let tracking: CGFloat = 1.7

    var body: some View {
        Text("Juno")
            .junoMono()
            .fontWeight(.semibold)
            .tracking(Self.tracking)
            .accessibilityHidden(true)
    }
}

/// The faint dotted grid the website paints behind its auth and marketing
/// surfaces (`src/components/signature/dot-field.tsx`).
///
/// Static, unlike the web's canvas: the pointer-reactive variant there is opt-in
/// (`interactive`) and the auth layout does not opt in, so animating it here
/// would be a flourish the brand does not have. Drawn in a `Canvas` rather than
/// as thousands of `Circle`s so the layout engine never sees the dots at all.
private struct JunoDotField: View {
    /// The web's `spacing = 24` and `r = 0.7`, in points.
    private static let spacing: CGFloat = JunoSpace.section
    private static let radius: CGFloat = 0.7

    var body: some View {
        Canvas { context, size in
            let diameter = Self.radius * 2
            var x = Self.spacing / 2
            while x < size.width {
                var y = Self.spacing / 2
                while y < size.height {
                    context.fill(
                        Path(
                            ellipseIn: CGRect(
                                x: x - Self.radius,
                                y: y - Self.radius,
                                width: diameter,
                                height: diameter
                            )
                        ),
                        with: .color(Color.junoSeparator)
                    )
                    y += Self.spacing
                }
                x += Self.spacing
            }
        }
        .accessibilityHidden(true)
    }
}
