import SwiftUI

struct JunoMobileRootView: View {
    @State private var selection: JunoMobileSection? = .chat
    @State private var sidebarSearch = ""

    var body: some View {
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
