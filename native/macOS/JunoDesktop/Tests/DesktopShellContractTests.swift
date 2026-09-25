import JunoDesignSystem
import Testing

@testable import JunoDesktop

/// The Mac reads the web's shell through the generated contract
/// (`Generated/JunoShellContract.swift`, from
/// contracts/product/juno-shell-v1.json): the products, Chat's sidebar, the
/// composer's `+` menu and primary action, and the Settings rail.
///
/// The exhaustive switches in `DesktopShellContract.swift` make a new web case
/// a compile error. These tests hold the rest: that nothing the contract lists
/// for Chat is dropped on the way into the Mac's enums, that the order the Mac
/// draws is the contract's, and that the Mac's own additions are exactly the
/// ones the register names.
@Suite struct DesktopShellContractTests {
    @Test func theContractIsVersionOneWithADigest() {
        #expect(JunoShellContract.version == 1)
        #expect(JunoShellContract.digest.count == 64)
    }

    // MARK: Products

    @Test func theSwitchOffersTheWebsProductsInItsOrder() {
        #expect(DesktopProductMode.switchable.map(\.rawValue) == JunoShellProduct.allCases.map(\.rawValue))
        #expect(DesktopProductMode.switchable.map(\.label) == ["Chat", "Code"])
        for product in JunoShellProduct.allCases {
            #expect(DesktopProductMode(product).shell == product)
            #expect(DesktopProductMode(product).icon == product.icon)
        }
        // Juno does not gate a product by plan today; the web greys a locked
        // one rather than hiding it, and the Mac has no locked segment yet.
        #expect(JunoShellProduct.allCases.allSatisfy { $0.minPlan == .free })
    }

    // MARK: Chat's sidebar

    @Test func chatsRowsAreTheContractsWithNoneDropped() {
        #expect(DesktopDestination.sidebarCases.count == JunoShellChatSidebar.destinations.count)
        #expect(DesktopDestination.sidebarCases.compactMap(\.shell) == JunoShellChatSidebar.destinations)
        #expect(DesktopDestination.sidebarCases == [.library, .projects, .artifacts, .agents])
        #expect(DesktopDestination.sidebarCases.map(\.label) == JunoShellChatSidebar.destinations.map(\.label))
        #expect(DesktopDestination.sidebarCases.map(\.junoIcon) == JunoShellChatSidebar.destinations.map(\.icon))
    }

    @Test func chatsMoreIsTheContractsWithNoneDropped() {
        let items = JunoShellChatSidebar.More.items
        #expect(DesktopDestination.moreCases.count == items.count)
        #expect(DesktopDestination.moreCases.compactMap(\.shell) == items.map(\.destination))
        #expect(DesktopDestination.moreCases == [.assistants, .skills, .automations])
        #expect(JunoShellChatSidebar.More.archivedTitle == "Archived Chats")
        #expect(JunoShellChatSidebar.More.archivedIcon == .archive)
        // Every item is open to every plan today, as on the web.
        #expect(items.allSatisfy { $0.isUnlocked(for: .free) })
    }

    @Test func everyWebDestinationHasAChatPageOrBelongsToCode() {
        for destination in JunoShellDestination.allCases {
            if let page = DesktopDestination(destination) {
                #expect(page.shell == destination, "\(destination)")
                #expect(page.label == destination.label, "\(destination)")
                #expect(page.junoIcon == destination.icon, "\(destination)")
            } else {
                // Only Code's own rows have no Chat page.
                #expect(JunoShellCodeSidebar.destinations.contains(destination), "\(destination)")
                #expect(!JunoShellChatSidebar.destinations.contains(destination), "\(destination)")
            }
        }
    }

    @Test func theMacsOwnDestinationsAreTheStoredAndSettingsReachedOnes() {
        let macOnly = DesktopDestination.allCases.filter { $0.shell == nil }
        #expect(macOnly == [.chat, .search, .design, .memory, .permissions])
    }

    @Test func theColumnSaysTheWebsWords() {
        #expect(JunoShellChatSidebar.Action.allCases == [.new, .search, .notifications])
        #expect(JunoShellChatSidebar.Action.new.label == "New chat")
        #expect(JunoShellChatSidebar.Heading.allCases.map(\.label) == [
            "Needs you", "Agents", "Pinned projects", "Pinned chats", "Recent",
        ])
        #expect(JunoShellChatSidebar.emptyLines.count == 2)
    }

    // MARK: The composer

    @Test func thePlusMenusRowsAreTheContractsInTitleCase() {
        #expect(JunoShellPlusMenu.chat == [
            [.files, .screenshot, .library],
            [.project, .connectors],
            [.skill, .research, .search, .memory],
        ])
        #expect(JunoShellPlusMenu.chat.joined().map(\.title) == [
            "Add Files or Photos", "Take a Screenshot", "Add from Library",
            "Add to Project", "Connectors",
            "Use a Skill", "Research", "Web Search", "Memory",
        ])
        #expect(JunoShellPlusMenu.label == "Add")
        // The paperclip the Mac drew as `.paperclip` is the registry's
        // `ComposerIcons.attach`: one drawing, two names.
        #expect(JunoShellPlusRow.files.icon.symbolName == JunoIcon.paperclip.symbolName)
        #expect(JunoShellPlusRow.voiceFiles.variantOf == .files)
    }

    @Test func thePrimaryFacesWearTheWebsFills() {
        #expect(JunoShellPrimaryFace.allCases == [.send, .stop, .voice, .busy])
        let faces: [ChatComposerFace] = [.voice, .send, .stop, .busy("Uploading"), .disabled("Send")]
        for face in faces {
            #expect(face.isAccented == (face.shell?.isAccented ?? false), "\(face.kind)")
        }
        #expect(ChatComposerFace.send.isAccented)
        #expect(!ChatComposerFace.voice.isAccented)
        #expect(!ChatComposerFace.disabled("Send").isAccented)
        // Every face the web has, the Mac has; the Mac adds only `disabled`.
        #expect(Set(faces.compactMap(\.shell)) == Set(JunoShellPrimaryFace.allCases))
        #expect(JunoShellPrimaryFace(composerState: "checking") == .busy)
        #expect(JunoShellPrimaryFace.busy.icon == nil)
    }

    // MARK: Settings

    @Test func settingsIsTheWebsRailThenCode() {
        let web = DesktopSettingsSection.allCases.filter { $0.shell != nil }
        #expect(web.compactMap(\.shell) == JunoShellSettingsSection.allCases)
        #expect(DesktopSettingsSection.allCases.last == .code)
        #expect(DesktopSettingsSection.allCases.filter { $0.shell == nil } == [.code])
        for section in JunoShellSettingsSection.allCases {
            let pane = DesktopSettingsSection(section)
            #expect(pane.shell == section)
            #expect(pane.label == section.label)
            #expect(pane.icon == section.icon)
        }
    }

    @Test func everyWebAliasResolvesWhereTheWebSendsIt() {
        for (alias, section) in JunoShellSettingsSection.aliases {
            #expect(DesktopSettingsSection.resolve(alias) == DesktopSettingsSection(section), "\(alias)")
            #expect(JunoShellSettingsSection.resolve(alias) == section, "\(alias)")
        }
        #expect(DesktopSettingsSection.resolve("connections") == .connectors)
        #expect(DesktopSettingsSection.resolve("nowhere") == DesktopSettingsSection(JunoShellSettingsSection.defaultSection))
        #expect(JunoShellSettingsSection.billing.href == "/settings?section=billing")
        #expect(JunoShellSettingsSection.general.href == "/settings")
    }

    // MARK: Plans

    @Test func plansRankLowestToHighest() {
        #expect(JunoShellPlan.allCases == [.free, .pro, .max, .max20, .owner])
        #expect(JunoShellPlan.free < .pro)
        #expect(JunoShellPlan.max20 < .owner)
        let gated = JunoShellMoreItem(destination: .skills, minPlan: .pro)
        #expect(!gated.isUnlocked(for: .free))
        #expect(gated.isUnlocked(for: .pro))
        #expect(gated.isUnlocked(for: .owner))
    }
}
