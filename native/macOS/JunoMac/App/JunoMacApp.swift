import JunoCore
import JunoDesignSystem
import SwiftUI

@main
struct JunoMacApp: App {
    @State private var selectedSection = JunoMacSection.chat

    var body: some Scene {
        WindowGroup("Juno") {
            JunoMacRootView(selection: $selectedSection)
                .frame(minWidth: 760, minHeight: 520)
        }
        .defaultSize(width: 1_180, height: 760)
        .commands {
            SidebarCommands()
            JunoMacNavigationCommands(selection: $selectedSection)
        }
    }
}

private struct JunoMacNavigationCommands: Commands {
    @Binding var selection: JunoMacSection

    var body: some Commands {
        CommandMenu("menu.navigate") {
            ForEach(JunoMacSection.allCases) { section in
                Button {
                    selection = section
                } label: {
                    Label(section.title, systemImage: section.systemImage)
                }
                .keyboardShortcut(section.keyboardShortcut, modifiers: .command)
            }
        }
    }
}
