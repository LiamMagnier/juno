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

        #expect(build.version == "0.1.2")
        #expect(build.build == "3")
        #expect(build.contractVersion != "unknown")
        #expect(build.channel != "unknown")
        #expect(!build.contractVersion.hasPrefix("$("))
        #expect(!build.channel.hasPrefix("$("))
        #expect(bundle.object(forInfoDictionaryKey: "JunoGitSHA") != nil)
    }

    @Test
    func productModesHaveStableSceneStorageValues() {
        #expect(DesktopProductMode.chat.rawValue == "chat")
        #expect(DesktopProductMode.code.rawValue == "code")
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
