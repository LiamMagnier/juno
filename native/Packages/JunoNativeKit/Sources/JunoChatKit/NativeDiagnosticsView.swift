import JunoCore
import JunoStorage
import JunoSync
import SwiftUI

/// Settings › About & Diagnostics, shared by both apps.
///
/// One implementation rather than two on purpose: the whole value of this
/// screen is that the *same* facts can be compared across the Mac, the phone
/// and the server, and two copies would eventually disagree about what they
/// report or how they label it.
///
/// This screen exists because of a specific dead end: a corrected build was
/// produced, but there was no way to tell from the phone whether it was the
/// build actually installed, what backend it was talking to, or what the sync
/// layer had last heard from the server. Every row here is one of the facts
/// that were missing.
///
/// Nothing on this screen is secret. It shows versions, a commit, a public
/// base URL, HTTP status codes and error *kinds* — never a token, a header or
/// a response body.
public struct NativeDiagnosticsView: View {
    private let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    private let outbox: (any MutationOutboxRepository)?
    private let accountID: StorageAccountID?

    private let build = JunoBuildInfo.current
    @State private var outboxCounts: NativeOutboxDiagnostics?
    @State private var outboxError: String?

    public init(
        syncModel: NativeSyncModel<SQLiteAccountRepository>?,
        outbox: (any MutationOutboxRepository)?,
        accountID: StorageAccountID?
    ) {
        self.syncModel = syncModel
        self.outbox = outbox
        self.accountID = accountID
    }

    public var body: some View {
        Form {
            buildSection
            syncSection
            outboxSection
        }
        .navigationTitle("diagnostics.title")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task(id: syncModel?.synchronizationGeneration) { await reloadOutbox() }
        .refreshable { await reloadOutbox() }
        .accessibilityIdentifier("juno.diagnostics")
    }

    // MARK: - Build

    private var buildSection: some View {
        Section {
            row("diagnostics.version", build.displayVersion)
            row(
                "diagnostics.commit",
                build.hasResolvedCommit ? build.gitSHA : String(localized: "diagnostics.commit.unknown"),
                monospaced: true
            )
            row("diagnostics.contract", build.contractVersion, monospaced: true)
            row("diagnostics.server", build.apiBaseURL, monospaced: true)
            row("diagnostics.channel", build.channel)
        } header: {
            Text("diagnostics.section.build")
        } footer: {
            // The comparison the owner actually has to make, spelled out, so it
            // does not depend on remembering which three values must agree.
            Text("diagnostics.section.build.footer")
        }
    }

    // MARK: - Synchronization

    private var syncSection: some View {
        Section {
            row("diagnostics.phase", phaseDescription)
            if let cursor = syncModel?.cursor {
                row("diagnostics.cursor", cursor, monospaced: true)
            }
            row("diagnostics.last-sync", lastSyncDescription)
            if let status = syncModel?.lastHTTPStatusCode {
                row("diagnostics.http-status", String(status), monospaced: true)
            }
            if let kind = syncModel?.lastFailureKind {
                row("diagnostics.failure-kind", kind, monospaced: true)
            }
            if let message = syncModel?.lastErrorDescription {
                VStack(alignment: .leading, spacing: 4) {
                    Text("diagnostics.last-error")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Text(message)
                        .font(.callout)
                        .textSelection(.enabled)
                }
            }
            if let syncModel {
                Button("diagnostics.retry") { Task { await syncModel.refresh() } }
                    .accessibilityIdentifier("juno.diagnostics.retry")
            }
        } header: {
            Text("diagnostics.section.sync")
        }
    }

    private var phaseDescription: String {
        switch syncModel?.phase {
        case .none, .some(.idle): String(localized: "diagnostics.phase.idle")
        case .some(.synchronizing): String(localized: "diagnostics.phase.synchronizing")
        case .some(.live): String(localized: "diagnostics.phase.live")
        case .some(.offline): String(localized: "diagnostics.phase.offline")
        // Named apart from "offline" on purpose: a refused or incompatible
        // server is not a network problem, and calling it one is what sent the
        // last investigation looking in the wrong place.
        case .some(.failed): String(localized: "diagnostics.phase.failed")
        }
    }

    private var lastSyncDescription: String {
        guard let date = syncModel?.lastSuccessfulSyncAt else {
            return String(localized: "diagnostics.last-sync.never")
        }
        return date.formatted(date: .abbreviated, time: .standard)
    }

    // MARK: - Outbox

    private var outboxSection: some View {
        Section {
            if let outboxError {
                Text(outboxError).foregroundStyle(.secondary)
            } else if let counts = outboxCounts {
                row("diagnostics.outbox.pending", String(counts.pending))
                row("diagnostics.outbox.in-flight", String(counts.inFlight))
                row("diagnostics.outbox.retrying", String(counts.retryScheduled))
                row("diagnostics.outbox.conflicted", String(counts.conflicted))
                row("diagnostics.outbox.unresolved", String(counts.unresolved))
            } else {
                ProgressView()
            }
        } header: {
            Text("diagnostics.section.outbox")
        } footer: {
            // The reason this count is on screen at all: it is what says
            // whether replacing the installed app would lose work.
            Text("diagnostics.section.outbox.footer")
        }
    }

    private func reloadOutbox() async {
        guard let outbox, let accountID else {
            outboxCounts = .empty
            return
        }
        do {
            outboxCounts = try await NativeOutboxDiagnostics.read(
                from: outbox, accountID: accountID
            )
            outboxError = nil
        } catch {
            outboxError = error.localizedDescription
        }
    }

    // MARK: - Rows

    private func row(
        _ label: LocalizedStringKey,
        _ value: String,
        monospaced: Bool = false
    ) -> some View {
        LabeledContent {
            Text(value)
                .font(monospaced ? .system(.callout, design: .monospaced) : .callout)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .multilineTextAlignment(.trailing)
        } label: {
            Text(label)
        }
        // Read as one item rather than two, so VoiceOver says
        // "Contract, 1.3.0" instead of stopping between them.
        .accessibilityElement(children: .combine)
    }
}
