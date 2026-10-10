import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem

/// Settings › Connections (code-v4 TARGET §11): master and detail. The list
/// names every source with one short status line (Subscriptions, Your API
/// keys, Alevr); the detail is a stock grouped form with the account, the
/// plan's windows as numbers, and the one action the state calls for.
///
/// Health is words, never a badge or a bar. Install and Sign in open
/// Terminal with the vendor's command typed in, not run; Re-check runs the
/// probe, which never starts a login or a session.
public struct CodeV2ConnectionsView: View {
    let hub: EnvServerHub
    let keys: CodeV2KeysModel
    var alevrPlanLine: String?
    var antigravityEnabled = true

    @State private var selection: String?
    @State private var addingKey = false
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

    private var current: String { selection ?? subscriptions.first?.id ?? "alevr" }

    /// Labs with a saved key, plus the one being added right now.
    private var listedKeyProviders: [CodeV2.ByokProvider] {
        CodeV2.ByokProvider.allCases.filter { keys.record(for: $0) != nil || current == "key:" + $0.rawValue }
    }

    private var unkeyedProviders: [CodeV2.ByokProvider] {
        CodeV2.ByokProvider.allCases.filter { !listedKeyProviders.contains($0) }
    }

    public var body: some View {
        HStack(spacing: 0) {
            list
                .frame(width: 280)
            Rectangle().fill(Studio.Surface.hairline).frame(width: 1)
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .background(Studio.Surface.canvas)
        .task {
            hub.start()
            await keys.reload()
        }
    }

    // MARK: List

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                heading("Subscriptions")
                ForEach(subscriptions, id: \.id) { instance in
                    sourceRow(
                        id: instance.id, mark: CodeV2Marks.markID(instance: instance), name: CodeV2ProviderDirectory.vendorName(instance),
                        status: Self.status(instance), danger: instance.status == .signedOut && instance.statusMessage != nil,
                        dimmed: !(instance.status == .ready || instance.status == .limited)
                    )
                }
                heading("Your API keys")
                // Only keys that exist get a row; the labs without one fold
                // into a single Add a key (the web's list does the same), so
                // the column is not a wall of "No key".
                ForEach(listedKeyProviders, id: \.self) { provider in
                    let record = keys.record(for: provider)
                    sourceRow(
                        id: "key:" + provider.rawValue, mark: provider.markID, name: provider.labName,
                        status: record.map { $0.isValid ? "Key \($0.hint)" : "Key refused" } ?? "No key",
                        danger: record?.isValid == false, dimmed: record == nil
                    )
                }
                if !unkeyedProviders.isEmpty {
                    Menu {
                        ForEach(unkeyedProviders, id: \.self) { provider in
                            Button(provider.labName) {
                                selection = "key:" + provider.rawValue
                                addingKey = true
                            }
                        }
                    } label: {
                        HStack(spacing: JunoSpace.snug + 2) {
                            JunoIconView(.plus, size: 13)
                                .foregroundStyle(Studio.Ink.secondary)
                                .frame(minWidth: 20)
                            Text("Add a key").studioType(.text).foregroundStyle(Studio.Ink.secondary)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, JunoSpace.snug)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(.rect)
                    }
                    .menuStyle(.button)
                    .buttonStyle(.plain)
                    .menuIndicator(.hidden)
                    .help("Add an API key")
                }
                heading("Alevr")
                sourceRow(id: "alevr", mark: "alevr", name: "Alevr", status: alevrPlanLine ?? "Your Alevr plan", danger: false, dimmed: false)
            }
            .padding(JunoSpace.snug)
        }
    }

    private func heading(_ title: String) -> some View {
        Text(title)
            .studioType(.smallMedium)
            .foregroundStyle(Studio.Ink.secondary)
            .padding(.horizontal, JunoSpace.snug)
            .padding(.top, JunoSpace.cozy)
            .padding(.bottom, 2)
    }

    private func sourceRow(id: String, mark: String, name: String, status: String, danger: Bool, dimmed: Bool) -> some View {
        Button { selection = id; addingKey = false } label: {
            HStack(spacing: JunoSpace.snug + 2) {
                CodeV2Mark(id: mark, name: name, size: 16, dimmed: dimmed)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(name).studioType(.text).foregroundStyle(Studio.Ink.primary).lineLimit(1)
                    Text(status).studioType(.small).monospacedDigit()
                        .foregroundStyle(danger ? Studio.Ink.danger : Studio.Ink.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.snug)
            .frame(height: 44)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                    .fill(current == id ? Studio.Surface.selected : Color.clear)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    /// The list's one line: "Max plan · 38% of 5-hour window", "Not signed in".
    static func status(_ instance: CodeV2.ProviderInstance) -> String {
        switch instance.status {
        case .ready, .limited:
            var parts: [String] = []
            if let plan = instance.account?.plan { parts.append(CodeV2ProviderDirectory.planName(plan) + " plan") }
            if let window = instance.limits?.first, let used = window.usedPct {
                parts.append("\(Int(used.rounded()))% of \(window.label.lowercased()) window")
            }
            return parts.isEmpty ? "Connected" : parts.joined(separator: " · ")
        case .signedOut: return instance.statusMessage == nil ? "Not signed in" : "Sign-in expired"
        case .notInstalled: return "Not installed"
        case .error, .unknown: return "Not responding"
        }
    }

    // MARK: Detail

    @ViewBuilder
    private var detail: some View {
        if current == "alevr" {
            alevrDetail
        } else if current.hasPrefix("key:"), let provider = CodeV2.ByokProvider(rawValue: String(current.dropFirst(4))) {
            keyDetail(provider)
        } else if let instance = subscriptions.first(where: { $0.id == current }) {
            subscriptionDetail(instance)
        }
    }

    private func header(mark: String, name: String, detail: String?) -> some View {
        HStack(spacing: JunoSpace.snug + 2) {
            CodeV2Mark(id: mark, name: name, size: 20)
            Text(name).studioType(.textMedium).foregroundStyle(Studio.Ink.primary)
            if let detail { Text(detail).studioType(.small).foregroundStyle(Studio.Ink.secondary) }
            Spacer()
        }
        .padding(.horizontal, 28)
        .padding(.top, JunoSpace.regular)
    }

    private func subscriptionDetail(_ instance: CodeV2.ProviderInstance) -> some View {
        let managed = hub.managesRuntime(instance.id) ? CodeV2ManagedRuntime(hub: hub, instanceId: instance.id) : nil
        let known = CodeV2KnownSubscription.allCases.first { $0.instanceId == instance.id }
        return VStack(alignment: .leading, spacing: 0) {
            header(mark: CodeV2Marks.markID(instance: instance), name: CodeV2ProviderDirectory.vendorName(instance),
                   detail: instance.version.map { "Version \($0)" })
            Text("Runs your own \(CodeV2ProviderDirectory.vendorName(instance)) agent on this Mac. Sign-in, billing and limits stay with the vendor.")
                .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                .padding(.horizontal, 28).padding(.top, JunoSpace.tight)
            Form {
                Section {
                    LabeledContent("Status") {
                        Text(instance.status == .ready ? "Connected" : (instance.status == .limited ? "Limit reached" : Self.status(instance)))
                            .foregroundStyle(instance.status == .signedOut && instance.statusMessage != nil ? Studio.Ink.danger : Studio.Ink.secondary)
                    }
                    if let email = instance.account?.email { LabeledContent("Account", value: email) }
                    if let plan = instance.account?.plan { LabeledContent("Plan", value: CodeV2ProviderDirectory.planName(plan)) }
                    ForEach(instance.limits ?? [], id: \.id) { window in
                        LabeledContent("\(window.label) window") {
                            Text("\(Int((window.usedPct ?? 0).rounded()))% used"
                                 + (window.resetsAt.flatMap { CodeV2Formatting.clockTime(iso: $0) }.map { ", resets \($0)" } ?? ""))
                                .monospacedDigit()
                        }
                    }
                    if let note = known?.note {
                        Text(note).foregroundStyle(Studio.Ink.secondary)
                    }
                    if let managed {
                        CodeV2ManagedRuntimeDetail(managed: managed)
                    }
                } footer: {
                    HStack {
                        Spacer()
                        if let managed {
                            CodeV2ManagedRuntimeAction(managed: managed, status: instance.status, recheck: { Task { await hub.probe(instance.id) } })
                        } else {
                            subscriptionAction(instance)
                        }
                    }
                }
                if let error = hub.lastError {
                    Section { Text(error).foregroundStyle(Studio.Ink.danger) }
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
    }

    @ViewBuilder
    private func subscriptionAction(_ instance: CodeV2.ProviderInstance) -> some View {
        let expired = instance.status == .signedOut && instance.statusMessage != nil
        if hub.probing.contains(instance.id) || hub.openingSetup.contains(instance.id) {
            ProgressView().controlSize(.small)
        } else {
            switch instance.status {
            case .notInstalled:
                Button("Install") { Task { await hub.openSetup(for: instance.id, action: .install) } }
                    .help("Alevr opens a terminal with the install command so you can read it first.")
                    .contentShape(.rect)
            case .signedOut:
                Button(expired ? "Sign In Again" : "Sign In") { Task { await hub.openSetup(for: instance.id, action: .login) } }
                    .contentShape(.rect)
            case .error, .unknown:
                Button("Re-check") { Task { await hub.probe(instance.id) } }
                    .contentShape(.rect)
            case .ready, .limited:
                Menu("Manage") {
                    Button("Re-check") { Task { await hub.probe(instance.id) } }
                    Button("Sign In Again") { Task { await hub.openSetup(for: instance.id, action: .login) } }
                }
                .fixedSize()
                    .contentShape(.rect)
            }
        }
    }

    private func keyDetail(_ provider: CodeV2.ByokProvider) -> some View {
        let record = keys.record(for: provider)
        return VStack(alignment: .leading, spacing: 0) {
            header(mark: provider.markID, name: provider.labName, detail: nil)
            Text("Used by the Alevr engine. \(provider.labName) bills it, never Alevr.")
                .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                .padding(.horizontal, 28).padding(.top, JunoSpace.tight)
            Form {
                Section {
                    if let record {
                        LabeledContent("Key", value: record.hint)
                        LabeledContent("Added", value: record.addedAt.formatted(date: .abbreviated, time: .omitted))
                        LabeledContent("Last used", value: record.lastUsedAt?.formatted(.relative(presentation: .named)) ?? "Not yet")
                        LabeledContent("Stored", value: record.location == .account ? "In your account" : "On this Mac only")
                        if !record.isValid {
                            Text(record.statusDetail ?? "The provider refused this key.").foregroundStyle(Studio.Ink.danger)
                        }
                    } else if addingKey {
                        SecureField("Key", text: $keyDraft, prompt: Text(provider.keyPrefix.map { "\($0)…" } ?? "Paste your key"))
                            .onSubmit { commit(provider) }
                    } else {
                        LabeledContent("Key", value: "None")
                    }
                    if let error = keys.errors[provider] {
                        Text(error).foregroundStyle(Studio.Ink.danger)
                    }
                } footer: {
                    HStack {
                        if keys.canUndo {
                            Text("Key removed.").foregroundStyle(Studio.Ink.secondary)
                            Button("Undo") { Task { await keys.undoRemove() } }
                        }
                        Spacer()
                        if keys.isWorking.contains(provider) {
                            ProgressView().controlSize(.small)
                        } else if record != nil {
                            Button("Remove Key", role: .destructive) { Task { await keys.remove(provider) } }
                        } else if addingKey {
                            Button("Cancel") { addingKey = false }
                            Button("Save") { commit(provider) }.disabled(keyDraft.isEmpty).keyboardShortcut(.defaultAction)
                        } else {
                            Button("Add Key…") { addingKey = true; keyDraft = "" }
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
    }

    private var alevrDetail: some View {
        VStack(alignment: .leading, spacing: 0) {
            header(mark: "alevr", name: "Alevr", detail: nil)
            Form {
                Section {
                    LabeledContent("Plan", value: alevrPlanLine ?? "Your Alevr plan")
                    Text("Alevr models run on Alevr and count against this plan.").foregroundStyle(Studio.Ink.secondary)
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
    }

    private func commit(_ provider: CodeV2.ByokProvider) {
        let draft = keyDraft
        Task {
            if await keys.save(draft, for: provider) {
                addingKey = false
                keyDraft = ""
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
                        TextField("Sign-in address", text: $pasted, prompt: Text("http://127.0.0.1:…"))
                            .labelsHidden()
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
