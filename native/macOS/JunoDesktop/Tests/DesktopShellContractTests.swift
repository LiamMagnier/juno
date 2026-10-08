import JunoCore
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
    @Test func theContractIsVersionTwoWithADigest() {
        #expect(JunoShellContract.version == 2)
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
        // Code is Pro and up; Chat is for everyone. The Mac's gate asks the
        // shared catalogue, so the two must name the same plan.
        #expect(JunoShellProduct.chat.minPlan == .free)
        #expect(JunoShellProduct.code.minPlan == .pro)
        #expect(JunoShellProduct.code.minPlan.rawValue == JunoPlanFeature.code.minimumTier.rawValue)
    }

    // MARK: Chat's sidebar

    @Test func chatsRowsAreTheContractsWithNoneDropped() {
        #expect(DesktopDestination.sidebarCases.count == JunoShellChatSidebar.destinations.count)
        #expect(DesktopDestination.sidebarCases.compactMap(\.shell) == JunoShellChatSidebar.destinations)
        // Contract v2 (the V3 shell): Projects, Library, Customize.
        #expect(DesktopDestination.sidebarCases == [.projects, .library, .connections])
        #expect(DesktopDestination.sidebarCases.map(\.label) == JunoShellChatSidebar.destinations.map(\.label))
        #expect(DesktopDestination.sidebarCases.map(\.junoIcon) == JunoShellChatSidebar.destinations.map(\.icon))
    }

    @Test func chatsMoreIsTheContractsWithNoneDropped() {
        let items = JunoShellChatSidebar.More.items
        #expect(DesktopDestination.moreCases.count == items.count)
        #expect(DesktopDestination.moreCases.compactMap(\.shell) == items.map(\.destination))
        // Contract v2 empties More: the archive is its only entry, in the
        // account menu.
        #expect(DesktopDestination.moreCases.isEmpty)
        #expect(JunoShellChatSidebar.More.archivedTitle == "Archived Chats")
        #expect(JunoShellChatSidebar.More.archivedIcon == .archive)
        // Every item is open to every plan today, as on the web.
        #expect(items.allSatisfy { $0.isUnlocked(for: .free) })
    }

    @Test func everyWebDestinationHasAChatPageOrBelongsToCode() {
        for destination in JunoShellDestination.allCases {
            if let page = DesktopDestination(destination) {
                // Contract v2 has two names for the one Customize page:
                // `connections` (/connections) and `accountCustomize`
                // (/customize). The Mac page answers to the second.
                let canonical: JunoShellDestination = destination == .connections ? .accountCustomize : destination
                #expect(page.shell == canonical, "\(destination)")
                #expect(page.label == canonical.label, "\(destination)")
                #expect(page.junoIcon == canonical.icon, "\(destination)")
            } else {
                // Only Code's own places have no Chat page: its Customize,
                // and Pull requests, which v2 moved out of Code's rows.
                #expect([.customize, .pulls].contains(destination), "\(destination)")
                #expect(!JunoShellChatSidebar.destinations.contains(destination), "\(destination)")
            }
        }
    }

    @Test func theMacsOwnDestinationsAreTheStoredAndSettingsReachedOnes() {
        let macOnly = DesktopDestination.allCases.filter { $0.shell == nil }
        #expect(macOnly == [.chat, .search, .design, .memory, .permissions])
    }

    @Test func theColumnSaysTheWebsWords() {
        // Contract v2 moved Notifications out of the column into headerActions.
        #expect(JunoShellChatSidebar.Action.allCases == [.new, .search])
        #expect(JunoShellChatSidebar.Action.new.label == "New chat")
        #expect(JunoShellChatSidebar.Heading.allCases.map(\.label) == [
            "Needs you", "Orbit", "Pinned projects", "Pinned chats", "Recent",
        ])
        #expect(JunoShellChatSidebar.emptyLines.count == 2)
    }

    // MARK: The composer

    @Test func thePlusMenusRowsAreTheContractsInTitleCase() {
        #expect(JunoShellPlusMenu.chat == [
            [.files, .screenshot, .sketch, .library],
            [.mention, .skill],
            [.research, .search, .memory],
            [.project, .connectors],
        ])
        #expect(JunoShellPlusMenu.chat.joined().map(\.title) == [
            "Add Photos and Files", "Take a Screenshot", "Sketch", "Add from Library",
            "Mention a File, App or Agent", "Run a Skill",
            "Deep Field", "Web Search", "Memory",
            "Add to Project", "Apps",
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
        #expect(JunoShellPlan.allCases == [.free, .lite, .pro, .plus, .max, .max20, .ultra, .owner])
        #expect(JunoShellPlan.free < .lite && JunoShellPlan.lite < .pro)
        #expect(JunoShellPlan.max20 < .ultra && JunoShellPlan.ultra < .owner)
        // The contract's plans are the shared catalogue's, in the same order.
        #expect(JunoShellPlan.allCases.map(\.rawValue) == JunoPlanTier.allCases.map(\.rawValue))
        let gated = JunoShellMoreItem(destination: .skills, minPlan: .pro)
        #expect(!gated.isUnlocked(for: .free))
        #expect(gated.isUnlocked(for: .pro))
        #expect(gated.isUnlocked(for: .owner))
    }
}
