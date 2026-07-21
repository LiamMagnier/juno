import SwiftUI

struct JunoMacRootView: View {
    @Binding var selection: JunoMacSection
    @State private var sidebarSearch = ""

    var body: some View {
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
