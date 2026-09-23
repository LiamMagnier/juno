import Foundation
import JunoChatKit
import JunoDesignKit
import Testing

@testable import JunoDesktop

/// A design made in chat opens from its stored row, never from its tag
/// (Artifacts & Design audit, X-11).
///
/// The model writes the compact authoring form — a small tree of typed nodes
/// with no `schemaVersion` — and the server expands it into a
/// `DesignDocument` when it stores the artifact. The Mac's codec reads only
/// the expanded form, so the dock opened from the tag body refused every
/// chat-made design with "This design can't be opened".
struct DesktopChatDesignSourceTests {
    /// The compact form, as `lib/chat/system-prompt.ts` asks a model to write it.
    private let compactTagBody = #"""
    {"name":"Sign in","nodes":[{"type":"frame","name":"Screen","width":375,"height":812,"fill":"#FFFFFF","children":[{"type":"text","name":"Title","text":"Welcome back","x":24,"y":80,"fontSize":28},{"type":"rectangle","name":"Button","x":24,"y":700,"width":327,"height":48,"fill":"#E27D5F","radius":12}]}]}
    """#

    private var reference: NativeMessageContent.ArtifactReference {
        NativeMessageContent.ArtifactReference(
            identifier: "signin-screen",
            title: "Sign-in screen",
            kind: "DESIGN",
            language: nil,
            streaming: false,
            content: compactTagBody
        )
    }

    @Test
    func theCompactTagBodyIsNotADocumentTheMacCanOpen() {
        #expect(throws: (any Error).self) {
            _ = try DesignDocumentCodec.load(Data(compactTagBody.utf8))
        }
    }

    @Test
    func withoutAStoredRowTheCanvasHasNothingToOpen() {
        let artifact = DesktopChatArtifact(reference: reference)
        #expect(artifact.kind == .design)
        #expect(artifact.storedDesignContent == nil)
        #expect(!ChatArtifactResolver.empty.card(for: reference, messageID: "msg-6", messageIsPending: false).drawsDesign)
    }

    @Test
    @MainActor
    func theStoredRowIsTheDocumentThatOpens() throws {
        let expanded = TranscriptSnapshotFixtures.designResolver.artifact(for: reference)
        let stored = try #require(expanded)
        let artifact = DesktopChatArtifact(reference: reference, stored: stored)
        let content = try #require(artifact.storedDesignContent)
        #expect(content != compactTagBody)
        #expect(throws: Never.self) { _ = try DesignDocumentCodec.load(Data(content.utf8)) }
        #expect(TranscriptSnapshotFixtures.designResolver.card(for: reference, messageID: "msg-6", messageIsPending: false).drawsDesign)
    }
}
