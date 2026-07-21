import JunoAuth
import SwiftUI

struct JunoMobileRootView: View {
    let authModel: NativeAuthModel
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
                JunoMobileDetailView(section: selection)
                    .id(selection)
            } else {
                ContentUnavailableView("shell.choose.title", systemImage: "sidebar.left")
            }
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
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

    var body: some View {
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
