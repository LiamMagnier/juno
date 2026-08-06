import Foundation
import JunoChatKit
import JunoCore
import Testing
@testable import JunoDesktop

struct JunoDesktopSmokeTests {
    @Test
    func appBundlePublishesResolvedBuildIdentityForDiagnostics() {
        let bundle = Bundle.main
        let build = JunoBuildInfo.read(from: bundle)

        // RESOLVED is the claim, not any particular number. This pinned
        // `0.1.2` and `3` literally, which made a release fail its own test gate
        // for the crime of bumping the version — and said nothing about whether
        // the xcconfig chain had actually reached the plist, which is the thing
        // that has broken before and the reason this test exists.
        #expect(build.version.wholeMatch(of: /\d+\.\d+\.\d+/) != nil, "version is \(build.version)")
        #expect(build.build.wholeMatch(of: /\d+/) != nil, "build is \(build.build)")
        #expect(build.version != "0.0.0", "the fallback means MARKETING_VERSION never arrived")
        #expect(build.build != "0", "the fallback means CURRENT_PROJECT_VERSION never arrived")
        #expect(build.contractVersion != "unknown")
        #expect(build.channel != "unknown")
        // An unsubstituted `$(FOO)` is the specific failure: the variable was
        // never defined, and the plist carries build syntax as a value.
        #expect(!build.contractVersion.hasPrefix("$("))
        #expect(!build.channel.hasPrefix("$("))
        #expect(!build.version.hasPrefix("$("))
        #expect(bundle.object(forInfoDictionaryKey: "JunoGitSHA") != nil)
    }

    /// The raw values are `@SceneStorage` keys, not labels.
    ///
    /// `JunoDesktopRootView` persists the window's product as
    /// `DesktopProductMode.rawValue` under "juno.desktop.product" and restores it
    /// by `init(rawValue:)`. Renaming a case therefore silently retires every
    /// stored window: the lookup fails, the `?? .chat` fallback fires, and a
    /// reader who left the app in Work comes back to Chat with no error anywhere
    /// to explain it. Pinning the strings makes that rename a failing test.
    @Test
    func productModesHaveStableSceneStorageValues() {
        #expect(DesktopProductMode.chat.rawValue == "chat")
        #expect(DesktopProductMode.code.rawValue == "code")
        #expect(DesktopProductMode.work.rawValue == "work")
        // Every case is pinned above, so a product added without a line here
        // fails rather than shipping an unpinned scene-storage value.
        #expect(DesktopProductMode.allCases.count == 3)
    }

    /// The menu bar and the toolbar switcher both enumerate `allCases`, so a
    /// product with no label of its own would render as an empty menu row and an
    /// empty segment — a control the reader can hit but cannot read.
    @Test
    func everyProductModeNamesItself() {
        for mode in DesktopProductMode.allCases {
            #expect(!mode.label.isEmpty, "\(mode.rawValue) has no label")
            #expect(!mode.symbol.isEmpty, "\(mode.rawValue) has no symbol")
        }
    }

    @Test
    func modelSelectionPrefersConversationThenFirstAvailable() {
        let first = makeModel(id: "juno:auto")
        let second = makeModel(id: "anthropic:claude")

        #expect(
            DesktopChatSelection.resolvedModelID(
                current: "",
                conversationModel: second.id,
                selectable: [first, second]
            ) == second.id
        )
        #expect(
            DesktopChatSelection.resolvedModelID(
                current: "removed:model",
                conversationModel: "removed:model",
                selectable: [first, second]
            ) == first.id
        )
    }

    private func makeModel(id: String) -> NativeChatModelOption {
        NativeChatModelOption(
            id: id,
            providerID: "test",
            providerName: "Test",
            displayName: id,
            minimumPlan: "free",
            availability: "available",
            supportedReasoningEfforts: [],
            canDisableReasoning: false,
            supportsStreaming: true
        )
    }
}
