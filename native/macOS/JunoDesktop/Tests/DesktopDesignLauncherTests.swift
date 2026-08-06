import Foundation
import Testing

@testable import JunoDesktop

/// The door into Juno Design, and the four sizes behind it.
///
/// Two things here are contracts with code that is not in this repository's Swift
/// at all — the sizes are a table in `src/app/api/design/route.ts`, and the preset
/// names are the wire enum that route parses. Both fail *silently* when they
/// drift: a mistyped preset falls through to the route's `.default("phone")`, so
/// clicking Desktop would quietly produce a 375×812 frame and every label on the
/// page would be a lie.
struct DesktopDesignLauncherTests {

    // MARK: - The wire contract

    /// The raw values are what `POST /api/design` parses, not display strings.
    ///
    /// `bodySchema` declares `z.enum(["phone", "tablet", "desktop", "square"])
    /// .default("phone")`, and a default is exactly what makes this worth pinning:
    /// an unrecognised preset is not rejected, it is replaced. Renaming a case
    /// here would ship a grid of four buttons that all start a phone.
    @Test
    func everyPresetSpellsItselfTheWayTheRouteExpects() {
        #expect(DesktopDesignPreset.phone.rawValue == "phone")
        #expect(DesktopDesignPreset.tablet.rawValue == "tablet")
        #expect(DesktopDesignPreset.desktop.rawValue == "desktop")
        #expect(DesktopDesignPreset.square.rawValue == "square")
        // Every case is pinned above, so a preset added without a line here fails
        // rather than shipping an unchecked wire value.
        #expect(DesktopDesignPreset.allCases.count == 4)
    }

    /// The numbers printed under each name are the frame the route actually
    /// builds — `PRESETS` in `src/app/api/design/route.ts`.
    ///
    /// This app never sends the dimensions; it sends a name and the server
    /// resolves it. So these are a *label*, and a label claiming 1440 × 900 over a
    /// button that produces something else is worse than no label — it is the one
    /// piece of the page a designer would take at its word.
    @Test
    func thePrintedSizesAreTheFramesTheRouteBuilds() {
        #expect(DesktopDesignPreset.phone.size == CGSize(width: 375, height: 812))
        #expect(DesktopDesignPreset.tablet.size == CGSize(width: 834, height: 1_194))
        #expect(DesktopDesignPreset.desktop.size == CGSize(width: 1_440, height: 900))
        #expect(DesktopDesignPreset.square.size == CGSize(width: 1_080, height: 1_080))
    }

    /// The multiplication sign, not the letter x. The web renders "375 × 812" and
    /// a page that renders "375 x 812" beside it reads as a different product.
    @Test
    func aPresetReadsAsDimensionsRatherThanAsCode() {
        #expect(DesktopDesignPreset.phone.detail == "375 × 812")
        #expect(DesktopDesignPreset.desktop.detail == "1440 × 900")
        for preset in DesktopDesignPreset.allCases {
            #expect(!preset.label.isEmpty, "\(preset.rawValue) has no name")
            #expect(!preset.detail.contains("x"), "\(preset.rawValue) uses a letter x")
        }
    }

    // MARK: - Where the door is

    /// Design is a destination, and specifically **not** a product.
    ///
    /// This is the finding the website paid for: a mode owns the whole sidebar —
    /// its nav rows, its list, its collapsed rail — and Design has none of that,
    /// so as a fourth segment it only routed away and left Home's sidebar
    /// standing. ``JunoDesktopSmokeTests`` pins the product count from the other
    /// side; this pins the half of the decision that lives here.
    @Test
    func designIsADestinationAndNotAProduct() {
        #expect(DesktopDestination.design.label == "Design")
        #expect(DesktopProductMode.allCases.allSatisfy { $0.label != "Design" })
    }

    /// The footer, not the rail.
    ///
    /// `sidebarCases` is the list at the *top* of Chat's column. Design belongs
    /// with the account row at the bottom — where `app-sidebar.tsx` puts it —
    /// and adding it to the rail would put the same door in two places, one of
    /// which the web does not have.
    @Test
    func designIsNotOneOfTheRailDestinations() {
        #expect(!DesktopDestination.sidebarCases.contains(.design))
        // Usage and Settings are the comparison that makes the rule readable:
        // Settings is likewise absent, and Usage is present.
        #expect(!DesktopDestination.sidebarCases.contains(.settings))
        #expect(DesktopDestination.sidebarCases.contains(.usage))
    }

    /// Code's column reaches its own copy of the page, so its selection has to
    /// survive scene storage like every other account-level page.
    ///
    /// The hazard is the one ``DesktopNavigationStateTests`` documents for
    /// `allProjects` and `draft`: a single-field selection returns nil from a
    /// decoder written around "kind + value" pairs, and the reader lands back on
    /// a repository draft with no explanation.
    @Test
    func codesDesignSelectionSurvivesSceneStorage() {
        let encoded = DesktopCodeNavigationState.encode(.design)
        #expect(encoded == "design")
        #expect(DesktopCodeNavigationState.decode(encoded) == .design)
    }

    /// Design names an account-level page, not a local record, so nothing that
    /// happens to this Mac's sessions, tasks or repositories can invalidate it.
    @Test
    func codesDesignSelectionSurvivesAnEmptyWorkspace() {
        #expect(
            DesktopCodeNavigationState.validate(
                .design,
                sessions: [],
                tasks: [],
                repositories: []
            ) == .design
        )
    }

    /// Work's footer row writes Chat's destination and then switches product.
    ///
    /// Work's window is handed a Work transport and nothing else, so it cannot
    /// draw the page itself; the crossing is the mechanism, and the string it
    /// writes is the one ``DesktopNavigationState`` has to be able to read back.
    /// If the two ever disagreed the row would land the reader on Chat's last
    /// conversation instead — a button that appears to do nothing.
    @Test
    func theStoredDesignDestinationIsTheOneChatRestores() {
        #expect(DesktopDestination.design.rawValue == "design")
        #expect(
            DesktopNavigationState.destination(
                fromStored: DesktopDestination.design.rawValue
            ) == .design
        )
    }

    /// Opening Design leaves the conversation where it was.
    ///
    /// Same rule as Library and Artifacts: leaving Chat must not clear the open
    /// conversation, or coming back shows an empty draft instead of what the
    /// reader was reading.
    @Test
    func openingDesignKeepsTheOpenConversation() {
        let resolved = DesktopNavigationState.resolve(
            selection: .destination(.design),
            current: (.chat, "conv-4")
        )
        #expect(resolved.destination == .design)
        #expect(resolved.conversationID == "conv-4")
        #expect(resolved.isDrafting == false)
    }
}
