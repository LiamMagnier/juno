import JunoAuth
import JunoStorage
import JunoSync
import SwiftUI

struct JunoMacRootView: View {
    @Binding var selection: JunoMacSection
    let authModel: NativeAuthModel
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    @State private var sidebarSearch = ""

    var body: some View {
        Group {
            switch authModel.phase {
            case .signedIn(let session):
                authenticatedContent(session: session)
            case .restoring:
                ProgressView("auth.restoring")
            case .signedOut, .signingIn, .unavailable:
                JunoMacSignInView(authModel: authModel)
            }
        }
        .task {
            await authModel.restore()
        }
        .onChange(of: authModel.phase) { _, phase in
            if case .signedIn(let session) = phase {
                syncModel?.start(for: session.profile.id)
            } else {
                syncModel?.stop()
            }
        }
    }

    private func authenticatedContent(
        session: NativeAuthenticatedSession
    ) -> some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section("section.product") {
                    rows(for: [.chat, .projects, .library, .artifacts, .tasks, .connections])
                }

                Section("section.intelligence") {
                    rows(for: [.search, .code])
                }

                Section("section.account") {
                    rows(for: [.settings])
                }
            }
            .accessibilityIdentifier("juno.mac.sidebar")
            .navigationTitle("Juno")
            .searchable(text: $sidebarSearch, prompt: "sidebar.search.prompt")
            .navigationSplitViewColumnWidth(min: 210, ideal: 250, max: 340)
        } detail: {
            JunoMacDetailView(section: selection)
                .id(selection)
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItem {
                JunoMacSyncStatus(model: syncModel)
            }
            ToolbarItem {
                Menu {
                    Button("auth.sign-out", role: .destructive) {
                        Task { await authModel.signOut() }
                    }
                } label: {
                    Label(
                        session.profile.name ?? session.profile.email,
                        systemImage: "person.crop.circle"
                    )
                }
                .accessibilityIdentifier("juno.mac.account-menu")
            }
        }
    }

    @ViewBuilder
    private func rows(for sections: [JunoMacSection]) -> some View {
        ForEach(filtered(sections)) { section in
            NavigationLink(value: section) {
                Label(section.title, systemImage: section.systemImage)
            }
        }
    }

    private func filtered(_ sections: [JunoMacSection]) -> [JunoMacSection] {
        guard !sidebarSearch.isEmpty else { return sections }
        return sections.filter { section in
            String(localized: String.LocalizationValue(section.rawValue))
                .localizedStandardContains(sidebarSearch)
                || section.rawValue.localizedStandardContains(sidebarSearch)
        }
    }
}

private struct JunoMacSyncStatus: View {
    let model: NativeSyncModel<SQLiteAccountRepository>?

    var body: some View {
        if let model {
            Button {
                Task { await model.refresh() }
            } label: {
                switch model.phase {
                case .idle, .synchronizing:
                    ProgressView().controlSize(.small)
                case .live:
                    Label("Synced", systemImage: "checkmark.circle.fill")
                case .offline:
                    Label("Offline", systemImage: "wifi.slash")
                }
            }
            .buttonStyle(.plain)
            .help(model.lastErrorDescription ?? "Refresh Juno")
            .accessibilityIdentifier("juno.mac.sync-status")
        }
    }
}

private struct JunoMacSignInView: View {
    let authModel: NativeAuthModel

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "circle.hexagongrid.fill")
                .font(.system(size: 42))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("auth.welcome.title")
                .font(.title2.weight(.semibold))
            Text("auth.welcome.description")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            if let error = authModel.lastErrorDescription {
                Text(error)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("juno.mac.auth-error")
            }
            if authModel.phase != .unavailable {
                Button {
                    Task { await authModel.signIn() }
                } label: {
                    if authModel.phase == .signingIn {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("auth.sign-in")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(authModel.phase == .signingIn)
                .accessibilityIdentifier("juno.mac.sign-in")
            }
        }
        .padding(40)
    }
}

private struct JunoMacDetailView: View {
    let section: JunoMacSection

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label(section.title, systemImage: section.systemImage)
            } description: {
                Text("shell.foundation.description")
            }
            .accessibilityIdentifier("juno.mac.detail")
            .navigationTitle(section.title)
        }
    }
}
