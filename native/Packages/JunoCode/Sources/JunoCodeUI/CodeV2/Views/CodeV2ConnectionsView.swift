import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem

/// Settings › Connections (DESIGN §5.13): the plans the user already pays
/// for, their own API keys, and Alevr's plan. Alevr starts each vendor's own
/// agent on this Mac; the sign-in, billing and limits stay with the vendor.
///
/// Health is words, never a badge. Install and Sign in open Terminal with
/// the vendor's command typed in, not run; Re-check runs the probe, which
/// never starts a login or a session.
public struct CodeV2ConnectionsView: View {
    let hub: EnvServerHub
    let keys: CodeV2KeysModel
    var alevrPlanLine: String?
    var antigravityEnabled = true

    @State private var addingKey: CodeV2.ByokProvider?
    @State private var keyDraft = ""

    public init(hub: EnvServerHub, keys: CodeV2KeysModel, alevrPlanLine: String? = nil, antigravityEnabled: Bool = true) {
        self.hub = hub
        self.keys = keys
        self.alevrPlanLine = alevrPlanLine
        self.antigravityEnabled = antigravityEnabled
    }

    /// What the Antigravity row says while it is on legal hold (docs/code-v2/PROVIDERS-LEGAL.md).
    static let heldSentence = "Not available yet. It turns on once Google confirms other apps may run it with your sign-in."

    private var subscriptions: [CodeV2.ProviderInstance] {
        CodeV2ProviderDirectory.build(
            alevr: CodeV2AlevrCatalog.instance(from: []),
            envInstances: hub.instances,
            antigravityEnabled: antigravityEnabled
        ).instances.filter { $0.kind != .alevr && $0.kind != .byok }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                Text("Connections").junoFont(size: 22, relativeTo: .title2, weight: .medium)
                Text("Use the plans you already pay for. Alevr starts each vendor's own agent on your Mac, so your sign-in, billing and limits stay with the vendor.")
                    .font(Studio.Font.label).foregroundStyle(Studio.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if case let .failed(message) = hub.phase {
                    Text(message).font(Studio.Font.meta).foregroundStyle(Studio.Signal.ink)
                } else if hub.phase == .starting {
                    Text("Starting Alevr's local environment…").font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                }
            }
            // On the grouped form's own leading edge (its inset plus a
            // section's), so the title lines up with the section headings.
            .padding(.horizontal, 38)
            .padding(.top, JunoSpace.roomy)
        Form {
            Section("Subscriptions") {
                ForEach(subscriptions, id: \.id) { instance in
                    CodeV2SubscriptionRow(
                        instance: instance,
                        isProbing: hub.probing.contains(instance.id),
                        isOpening: hub.openingSetup.contains(instance.id),
                        setup: { action in Task { await hub.openSetup(for: instance.id, action: action) } },
                        recheck: { Task { await hub.probe(instance.id) } },
                        managed: hub.managesRuntime(instance.id) ? CodeV2ManagedRuntime(hub: hub, instanceId: instance.id) : nil
                    )
                }
                if !antigravityEnabled {
                    // Listed, honestly, rather than missing while its terms check is open.
                    HStack(spacing: JunoSpace.cozy) {
                        CodeV2MarkTile(id: "google", name: "Antigravity", dimmed: true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Antigravity").font(Studio.Font.labelEmphasis).foregroundStyle(Studio.Ink.secondary)
                            Text(Self.heldSentence)
                                .font(Studio.Font.meta).foregroundStyle(Studio.Ink.tertiary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer()
                    }
                    .padding(.vertical, JunoSpace.tight)
                }
                if let error = hub.lastError {
                    Text(error).font(Studio.Font.meta).foregroundStyle(Studio.Ink.danger)
                }
            }

            Section {
                ForEach(CodeV2.ByokProvider.allCases, id: \.self) { provider in
                    keyRow(provider)
                }
                if keys.canUndo {
                    HStack {
                        Text("Key removed.").font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                        Button("Undo") { Task { await keys.undoRemove() } }.buttonStyle(StudioQuietButtonStyle())
                    }
                }
            } header: {
                Text("Your API keys")
            } footer: {
                Text("Used by the Alevr engine and never billed by Alevr.").font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
            }

            Section("Alevr") {
                HStack(spacing: JunoSpace.cozy) {
                    CodeV2MarkTile(id: "alevr", name: "Alevr")
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Alevr").font(Studio.Font.labelEmphasis)
                        Text(alevrPlanLine ?? "Alevr models on your plan.").font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                    }
                    Spacer()
                }
                .padding(.vertical, JunoSpace.tight)
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        }
        .background(Studio.Surface.canvas)
        .task {
            hub.start()
            await keys.reload()
        }
    }

    @ViewBuilder
    private func keyRow(_ provider: CodeV2.ByokProvider) -> some View {
        let record = keys.record(for: provider)
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.cozy) {
                CodeV2MarkTile(id: provider.markID, name: provider.labName)
                VStack(alignment: .leading, spacing: 2) {
                    Text(provider.labName).font(Studio.Font.labelEmphasis)
                    if let record {
                        Text(keyLine(record)).font(Studio.Font.meta).foregroundStyle(record.isValid ? Studio.Ink.secondary : Studio.Signal.ink)
                    } else {
                        Text("No key").font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                    }
                }
                Spacer()
                if keys.isWorking.contains(provider) {
                    StudioSpinner().frame(width: 14, height: 14)
                } else if record != nil {
                    Button("Remove") { Task { await keys.remove(provider) } }.buttonStyle(StudioQuietButtonStyle()).contentShape(.rect)
                } else if addingKey != provider {
                    Button("Add key") { addingKey = provider; keyDraft = "" }.buttonStyle(CodeV2OutlineButtonStyle(compact: true)).contentShape(.rect)
                }
            }
            if addingKey == provider {
                HStack(spacing: JunoSpace.snug) {
                    SecureField(provider.keyPrefix.map { "\($0)…" } ?? "Paste your key", text: $keyDraft)
                        .textFieldStyle(.roundedBorder)
                        .font(Studio.Font.mono)
                        .onSubmit { commit(provider) }
                    Button("Cancel") { addingKey = nil }.buttonStyle(StudioQuietButtonStyle()).contentShape(.rect)
                    Button("Save") { commit(provider) }.buttonStyle(CodeV2InkButtonStyle()).disabled(keyDraft.isEmpty).contentShape(.rect)
                }
                .padding(.leading, 44)
            }
            if let error = keys.errors[provider] {
                Text(error).font(Studio.Font.meta).foregroundStyle(Studio.Ink.danger).padding(.leading, 44)
            }
        }
        .padding(.vertical, JunoSpace.tight)
    }

    private func keyLine(_ record: ByokKeyRecord) -> String {
        var parts = [record.hint, "added " + record.addedAt.formatted(date: .abbreviated, time: .omitted)]
        if let used = record.lastUsedAt { parts.append("last used " + used.formatted(.relative(presentation: .named))) }
        if !record.isValid { parts.append(record.statusDetail ?? "the provider refused it") }
        parts.append(record.location == .account ? "in your account" : "on this Mac only")
        return parts.joined(separator: " · ")
    }

    private func commit(_ provider: CodeV2.ByokProvider) {
        let draft = keyDraft
        Task {
            if await keys.save(draft, for: provider) {
                addingKey = nil
                keyDraft = ""
            }
        }
    }
}

/// A 32pt mark tile: the mark on the quiet fill.
struct CodeV2MarkTile: View {
    let id: String
    let name: String
    var dimmed = false
    var body: some View {
        CodeV2Mark(id: id, name: name, size: 18, dimmed: dimmed)
            .frame(width: 32, height: 32)
            .background(RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous).fill(Studio.Surface.muted))
            .overlay(RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous).strokeBorder(Studio.Surface.hairline))
    }
}

/// One subscription: mark, name, the facts in a sentence, the plan windows
/// as thin meters, and the one action its state calls for.
struct CodeV2SubscriptionRow: View {
    let instance: CodeV2.ProviderInstance
    var isProbing = false
    var isOpening = false
    var setup: (CodeV2.ProviderSetupAction) -> Void
    var recheck: () -> Void
    /// Antigravity: Alevr installs and signs in the runtime itself.
    var managed: CodeV2ManagedRuntime?

    private var known: CodeV2KnownSubscription? {
        CodeV2KnownSubscription.allCases.first { $0.instanceId == instance.id }
    }
    private var connected: Bool { instance.status == .ready || instance.status == .limited }
    private var expired: Bool { instance.status == .signedOut && instance.statusMessage != nil }

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            CodeV2MarkTile(id: CodeV2Marks.markID(instance: instance), name: instance.label, dimmed: !connected)
            VStack(alignment: .leading, spacing: 3) {
                Text(instance.label).font(Studio.Font.labelEmphasis)
                Text(CodeV2ProviderDirectory.statusSentence(instance))
                    .font(Studio.Font.meta)
                    .foregroundStyle(expired ? Studio.Signal.ink : Studio.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let note = known?.note {
                    Text(note).font(Studio.Font.meta).foregroundStyle(Studio.Ink.tertiary)
                }
                if let managed {
                    CodeV2ManagedRuntimeDetail(managed: managed)
                }
                if connected, let limits = instance.limits, !limits.isEmpty {
                    HStack(spacing: JunoSpace.regular) {
                        ForEach(limits, id: \.id) { window in
                            HStack(spacing: JunoSpace.tight) {
                                Text(window.label).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                                CodeV2Meter(fraction: (window.usedPct ?? 0) / 100, width: 56)
                                Text("\(Int((window.usedPct ?? 0).rounded()))%"
                                     + (window.resetsAt.flatMap { CodeV2Formatting.clockTime(iso: $0) }.map { " resets \($0)" } ?? ""))
                                    .font(Studio.Font.metaDigits).foregroundStyle(Studio.Ink.secondary)
                            }
                        }
                    }
                    .padding(.top, 2)
                }
            }
            .opacity(isProbing ? 0.55 : 1)
            Spacer(minLength: JunoSpace.snug)
            action
        }
        .padding(.vertical, JunoSpace.tight)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var action: some View {
        if let managed {
            CodeV2ManagedRuntimeAction(managed: managed, status: instance.status, recheck: recheck)
        } else if isProbing || isOpening {
            StudioSpinner().frame(width: 14, height: 14).frame(width: 28, height: 28)
        } else {
            switch instance.status {
            case .notInstalled:
                Button("Install") { setup(.install) }.buttonStyle(CodeV2OutlineButtonStyle(compact: true)).contentShape(.rect)
                    .help("Alevr opens a terminal with the install command so you can read it first.")
            case .signedOut:
                Button(expired ? "Sign in again" : "Sign in") { setup(.login) }.buttonStyle(CodeV2OutlineButtonStyle(compact: true)).contentShape(.rect)
            case .error, .unknown:
                Button("Re-check", action: recheck).buttonStyle(CodeV2OutlineButtonStyle(compact: true)).contentShape(.rect)
            case .ready, .limited:
                Menu {
                    Button("Re-check", action: recheck)
                    Button("Sign in again") { setup(.login) }
                } label: {
                    Text("Manage")
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .buttonStyle(CodeV2OutlineButtonStyle(compact: true))
                .fixedSize()
                .help("Re-check or sign in again")
                .contentShape(.rect)
            }
        }
    }
}

// MARK: - Managed runtimes (Antigravity)

/// What a managed runtime's row reads and does: the hub's state for it and
/// the hub's install and sign-in commands.
@MainActor
struct CodeV2ManagedRuntime {
    let hub: EnvServerHub
    let instanceId: String

    var state: CodeV2RuntimeSetup { hub.runtimeSetup[instanceId] ?? CodeV2RuntimeSetup() }
    var installing: Bool { state.install?.isRunning == true }
    var signingIn: Bool { state.auth?.isOpen == true }
}

/// The row's trailing control for a managed runtime.
struct CodeV2ManagedRuntimeAction: View {
    let managed: CodeV2ManagedRuntime
    let status: CodeV2.ProviderStatus
    let recheck: () -> Void

    var body: some View {
        if managed.installing {
            Button("Cancel") { Task { await managed.hub.cancelInstall(managed.instanceId) } }
                .buttonStyle(StudioQuietButtonStyle()).contentShape(.rect)
        } else if managed.signingIn {
            Button("Cancel") { Task { await managed.hub.cancelSignIn(managed.instanceId) } }
                .buttonStyle(StudioQuietButtonStyle()).contentShape(.rect)
        } else {
            switch status {
            case .notInstalled:
                Button("Install") { Task { await managed.hub.installRuntime(managed.instanceId) } }
                    .buttonStyle(CodeV2OutlineButtonStyle(compact: true)).contentShape(.rect)
                    .help("Alevr downloads Google's own runtime and checks it before it runs.")
            case .signedOut:
                Button("Sign in") { Task { await managed.hub.signIn(managed.instanceId) } }
                    .buttonStyle(CodeV2OutlineButtonStyle(compact: true)).contentShape(.rect)
                    .help("Opens Google's sign-in page in your browser.")
            case .ready, .limited:
                Menu {
                    Button("Re-check", action: recheck)
                    Button("Sign in again") { Task { await managed.hub.signIn(managed.instanceId) } }
                    Button("Sign out") { Task { await managed.hub.signOut(managed.instanceId) } }
                } label: {
                    Text("Manage")
                }
                .menuStyle(.button).menuIndicator(.hidden)
                .buttonStyle(CodeV2OutlineButtonStyle(compact: true)).fixedSize().contentShape(.rect)
            case .error, .unknown:
                Button("Re-check", action: recheck).buttonStyle(CodeV2OutlineButtonStyle(compact: true)).contentShape(.rect)
            }
        }
    }
}

/// Under the row: download progress, or the browser sign-in with its paste
/// fallback, or what went wrong.
struct CodeV2ManagedRuntimeDetail: View {
    let managed: CodeV2ManagedRuntime
    @State private var pasted = ""

    var body: some View {
        let state = managed.state
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            if let install = state.install {
                if install.isRunning {
                    Text(Self.progress(install)).font(Studio.Font.metaDigits).foregroundStyle(Studio.Ink.secondary)
                } else if install.phase == .failed {
                    Text(install.message ?? "The download did not finish. Try again.")
                        .font(Studio.Font.meta).foregroundStyle(Studio.Signal.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let auth = state.auth {
                switch auth.phase {
                case .starting:
                    Text("Starting the sign-in…").font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                case .waiting:
                    Text("Finish signing in with Google in your browser. Alevr picks it up from there.")
                        .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: JunoSpace.snug) {
                        Button("Open the page again") { managed.hub.openSignInPage(managed.instanceId) }
                            .buttonStyle(StudioQuietButtonStyle()).contentShape(.rect)
                    }
                    Text("Signed in on another device, or the page said it could not connect? Paste the address it ended on.")
                        .font(Studio.Font.meta).foregroundStyle(Studio.Ink.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: JunoSpace.snug) {
                        TextField("http://127.0.0.1:…", text: $pasted)
                            .textFieldStyle(.roundedBorder)
                            .font(Studio.Font.mono)
                            .onSubmit(complete)
                            .accessibilityLabel("Sign-in address")
                        Button("Continue", action: complete)
                            .buttonStyle(CodeV2OutlineButtonStyle(compact: true)).contentShape(.rect)
                            .disabled(pasted.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    if let error = state.pasteError {
                        Text(error).font(Studio.Font.meta).foregroundStyle(Studio.Signal.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                case .verifying:
                    Text("Checking your sign-in…").font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                case .failed:
                    Text(auth.message ?? "The sign-in did not finish. Try again.")
                        .font(Studio.Font.meta).foregroundStyle(Studio.Signal.ink)
                        .fixedSize(horizontal: false, vertical: true)
                case .idle, .succeeded, .cancelled:
                    EmptyView()
                }
            }
        }
    }

    private func complete() {
        let text = pasted
        Task {
            if await managed.hub.completeSignIn(managed.instanceId, redirect: text) { pasted = "" }
        }
    }

    /// "Downloading 34 of 120 MB", "Checking the download".
    static func progress(_ install: EnvRuntimeSetup.InstallState) -> String {
        switch install.phase {
        case .downloading:
            guard let done = install.downloadedBytes, let total = install.totalBytes, total > 0 else { return "Downloading…" }
            let mb = { (bytes: Int) in Int((Double(bytes) / 1_048_576).rounded()) }
            return "Downloading \(mb(done)) of \(mb(total)) MB"
        case .extracting: return "Unpacking…"
        case .verifying: return "Checking the download…"
        default: return ""
        }
    }
}
