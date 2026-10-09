import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import SwiftUI

// Customize, as the web has it (`src/components/customize/customize-nav.tsx`):
// one home for the apps Alevr works in, its skills, routines, memory and
// instructions. Each tab is still its own destination — Apps is
// `.connections`, Routines is `.automations` — so ⌘K, Settings and stored
// window state keep opening them by name; the frame is what makes the five
// read as one place: a centred row of tabs above the page, the sidebar's
// Customize row lit on every one of them, and one identity for the group so
// moving between tabs slides the selection instead of reloading the window.

extension DesktopDestination {
    /// Customize's tabs, in the web's order: Apps, Skills, Routines, Memory,
    /// Instructions.
    static let customizeTabs: [Self] = [.connections, .skills, .automations, .memory, .instructions]

    /// Whether this destination is one of Customize's tabs.
    var isCustomize: Bool { Self.customizeTabs.contains(self) }

    /// The tab's name on the web (`FEATURE_NAMES`).
    var customizeLabel: String {
        switch self {
        case .connections: "Apps"
        case .skills: "Skills"
        case .automations: "Routines"
        case .memory: "Memory"
        case .instructions: "Instructions"
        default: label
        }
    }

    /// The identity the window gives a destination's view: one for the whole
    /// of Customize, so a tab change keeps the frame (and its sliding
    /// selection) and swaps only the page under it.
    var pageIdentity: String { isCustomize ? "customize" : rawValue }
}

/// Customize's frame: the tab row, centred over the page, then the page.
/// The tabs step aside while a detail page (a skill, a routine) is pushed on
/// the tab's own stack, as the web's detail routes draw no tab row.
struct DesktopCustomizeFrame<Content: View>: View {
    @Binding var destination: DesktopDestination
    var showsTabs = true
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            if showsTabs {
                DesktopCustomizeTabs(selection: $destination)
                    .padding(.top, JunoSpace.regular)
                    .padding(.horizontal, JunoSpace.regular)
                    .transition(.opacity)
            }
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .animation(JunoMotion.fast, value: showsTabs)
    }
}

/// The tab row itself: Customize's five destinations on the glass segmented
/// control, centred, hugging their words.
struct DesktopCustomizeTabs: View {
    @Binding var selection: DesktopDestination

    var body: some View {
        JunoSegmented(
            options: DesktopDestination.customizeTabs.map { JunoSegmentedOption($0, $0.customizeLabel) },
            selection: $selection,
            accessibilityLabel: "Customize",
            optionAccessibilityIdentifier: { "juno.desktop.customize.\($0.rawValue)" }
        )
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("juno.desktop.customize.tabs")
    }
}

// MARK: - Instructions

/// Customize › Instructions (`/customize/instructions`): how Alevr responds,
/// and what it should know about you before you say a word — the web's
/// Personalization section as a page of its own, on the same rows and the
/// same saves as Settings › Personalization.
struct DesktopInstructionsScreen: View {
    let context: DesktopSettingsContext

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            JunoPageHeader(
                "Instructions",
                lede: "How Alevr responds, and what it should know about you before you say a word."
            )
            .padding(.top, JunoSpace.wide)
            // On the rows' own edge: the grouped form insets its cards and
            // their labels, and the title lines up with the labels.
            .padding(.horizontal, 54)
            .frame(maxWidth: (JunoPageMeasure.reading.maxWidth ?? 720) + JunoSpace.section, alignment: .leading)
            .frame(maxWidth: .infinity)
            DesktopSettingsPersonalizationPane(context: context)
                .frame(maxWidth: (JunoPageMeasure.reading.maxWidth ?? 720) + JunoSpace.section, alignment: .top)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .junoToastHost(context.toasts)
        .task { await context.loadServerSettings() }
    }
}

extension DesktopSettingsContext {
    /// A context for a Settings pane shown as a page in the main window
    /// (Customize › Instructions): the account's settings and sender, its own
    /// saves and toasts.
    @MainActor
    static func page(
        configuration: JunoDesktopConfiguration,
        profile: NativeAccountProfile
    ) -> DesktopSettingsContext? {
        guard let settingsModel = configuration.memorySettingsModel else { return nil }
        var services = Services()
        services.sender = configuration.requestSender
        services.syncModel = configuration.syncModel
        services.outbox = configuration.outbox
        services.learningModel = configuration.memoryLearningModel
        return DesktopSettingsContext(
            profile: profile,
            settingsModel: settingsModel,
            services: services,
            modelCatalog: configuration.conversationModel?.selectableModels ?? []
        )
    }
}

/// Instructions for the signed-in account: one settings context for the
/// page's life, so a save in flight keeps its status while the page is up.
struct DesktopInstructionsRoute: View {
    @State private var context: DesktopSettingsContext?

    init(configuration: JunoDesktopConfiguration, profile: NativeAccountProfile) {
        _context = State(initialValue: DesktopSettingsContext.page(configuration: configuration, profile: profile))
    }

    var body: some View {
        if let context {
            DesktopInstructionsScreen(context: context)
        } else {
            JunoEmptyState(
                title: "Instructions are unavailable",
                message: "The synchronized settings store is unavailable.",
                icon: .warning
            )
        }
    }
}
