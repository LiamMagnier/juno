import JunoChatKit
import Testing
@testable import JunoDesktop

struct JunoDesktopSmokeTests {
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
