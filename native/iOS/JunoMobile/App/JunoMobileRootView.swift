import JunoAuth
import JunoChatKit
import JunoStorage
import JunoSync
import SwiftUI

struct JunoMobileRootView: View {
    let authModel: NativeAuthModel
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    @State private var selection: JunoMobileSection? = .chat
    @State private var sidebarSearch = ""

    var body: some View {
        Group {
            switch authModel.phase {
            case .signedIn(let session):
                authenticatedContent(session: session)
            case .restoring:
                ProgressView("auth.restoring")
            case .signedOut, .signingIn, .unavailable:
                JunoMobileSignInView(authModel: authModel)
            }
        }
        .task {
            await authModel.restore()
        }
        .onChange(of: authModel.phase) { _, phase in
            if case .signedIn(let session) = phase {
                syncModel?.start(for: session.profile.id)
                Task { await conversationModel?.start(for: session.profile.id) }
            } else {
                syncModel?.stop()
                conversationModel?.stop()
            }
        }
        .onChange(of: syncModel?.synchronizationGeneration) { _, generation in
            guard let generation else { return }
            Task { await conversationModel?.synchronizationDidAdvance(to: generation) }
        }
        .onChange(of: syncModel?.phase) { _, _ in
            Task { await conversationModel?.reload() }
        }
    }

    private func authenticatedContent(
        session: NativeAuthenticatedSession
    ) -> some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section("section.product") {
                    rows(for: [.chat, .search, .projects, .files, .artifacts, .tasks, .connections])
                }

                Section("section.code") {
                    rows(for: [.codeCloud, .codeRemote])
                }

                Section("section.account") {
                    rows(for: [.settings])
                }
            }
            .accessibilityIdentifier("juno.mobile.sidebar")
            .navigationTitle("Juno")
            .searchable(text: $sidebarSearch, prompt: "sidebar.search.prompt")
        } detail: {
            if let selection {
                JunoMobileDetailView(
                    section: selection,
                    conversationModel: conversationModel
                )
                    .id(selection)
            } else {
                ContentUnavailableView("shell.choose.title", systemImage: "sidebar.left")
            }
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                JunoMobileSyncStatus(model: syncModel)
            }
            ToolbarItem(placement: .topBarTrailing) {
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
                .accessibilityIdentifier("juno.mobile.account-menu")
            }
        }
    }

    @ViewBuilder
    private func rows(for sections: [JunoMobileSection]) -> some View {
        ForEach(filtered(sections)) { section in
            NavigationLink(value: section) {
                Label(section.title, systemImage: section.systemImage)
            }
        }
    }

    private func filtered(_ sections: [JunoMobileSection]) -> [JunoMobileSection] {
        guard !sidebarSearch.isEmpty else { return sections }
        return sections.filter { section in
            section.rawValue.localizedStandardContains(sidebarSearch)
        }
    }
}

private struct JunoMobileSyncStatus: View {
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
                    Image(systemName: "checkmark.icloud.fill")
                case .offline:
                    Image(systemName: "icloud.slash")
                }
            }
            .accessibilityLabel(model.phase == .offline ? "Offline" : "Synced")
            .accessibilityIdentifier("juno.mobile.sync-status")
        }
    }
}

private struct JunoMobileSignInView: View {
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
            if let error = authModel.lastErrorDescription {
                Text(error)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("juno.mobile.auth-error")
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
                .accessibilityIdentifier("juno.mobile.sign-in")
            }
        }
        .padding(32)
    }
}

private struct JunoMobileDetailView: View {
    let section: JunoMobileSection
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?

    @ViewBuilder
    var body: some View {
        if section == .chat, let conversationModel {
            JunoMobileConversationsView(model: conversationModel)
        } else {
            NavigationStack {
                ContentUnavailableView {
                    Label(section.title, systemImage: section.systemImage)
                } description: {
                    Text("shell.foundation.description")
                }
                .accessibilityIdentifier("juno.mobile.detail")
                .navigationTitle(section.title)
            }
        }
    }
}
