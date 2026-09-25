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
        #expect(!ChatArtifactResolver.empty.card(for: reference, messageID: "msg-6", messageCreatedAt: nil, messageIsPending: false).drawsDesign)
    }

    @Test
    @MainActor
    func theStoredRowIsTheDocumentThatOpens() throws {
        let expanded = TranscriptSnapshotFixtures.designResolver.artifact(for: reference, messageID: "msg-6", messageCreatedAt: nil)
        let stored = try #require(expanded)
        let artifact = DesktopChatArtifact(reference: reference, stored: stored)
        let content = try #require(artifact.storedDesignContent)
        #expect(content != compactTagBody)
        #expect(throws: Never.self) { _ = try DesignDocumentCodec.load(Data(content.utf8)) }
        #expect(TranscriptSnapshotFixtures.designResolver.card(for: reference, messageID: "msg-6", messageCreatedAt: nil, messageIsPending: false).drawsDesign)
    }

    /// A1: the canvas dock follows the row it opened by id. When a later
    /// re-emission changes the type, the server gives the tag's identifier to
    /// a new row and retires the old one to `{identifier}~{id tail}`; the
    /// canvas must keep showing the row it opened, not jump to the new one.
    @Test
    func theDockFollowsTheRowItOpenedAfterTheIdentifierMoves() {
        let tag = NativeMessageContent.ArtifactReference(
            identifier: "chart", title: "Chart", kind: "HTML", language: nil, streaming: false, content: "<p>tag</p>"
        )
        let opened = Date(timeIntervalSince1970: 1_800_000_000)
        func row(_ id: String, _ identifier: String, _ kind: NativeArtifactKind, at offset: TimeInterval, message: String) -> NativeArtifact {
            NativeArtifact(
                id: id, conversationID: "conv-1", conversationTitle: "Chat", messageID: message,
                identifier: identifier, title: id, kind: kind, language: nil, currentVersion: 1,
                versions: [NativeArtifactVersion(id: "\(id)-v1", version: 1, content: id, origin: nil, createdAt: opened)],
                createdAt: opened.addingTimeInterval(offset), updatedAt: opened.addingTimeInterval(offset), revision: 1
            )
        }
        let original = row("art-aaaaaa", "chart", .html, at: 0, message: "m-1")
        let before = ChatArtifactResolver(artifacts: [original], conversationID: "conv-1")
        let open = DesktopChatArtifact(
            reference: tag,
            stored: before.artifact(for: tag, messageID: "m-1", messageCreatedAt: opened),
            messageID: "m-1",
            messageCreatedAt: opened
        )
        #expect(open.storedID == "art-aaaaaa")

        // M11: the identifier moves to a new CODE row; the old row is retired.
        let retired = row("art-aaaaaa", "chart~aaaaaa", .html, at: 0, message: "m-1")
        let replacement = row("art-bbbbbb", "chart", .code, at: 60, message: "m-2")
        let after = ChatArtifactResolver(artifacts: [retired, replacement], conversationID: "conv-1")
        let docked = open.current(in: after)
        #expect(docked.stored?.id == "art-aaaaaa")
        #expect(docked.kind == .html)
        #expect(docked.id == "art-aaaaaa")

        // Opened before any row existed: the tag resolves with its message.
        let early = DesktopChatArtifact(reference: tag, messageID: "m-2", messageCreatedAt: opened.addingTimeInterval(60))
        #expect(early.current(in: after).stored?.id == "art-bbbbbb")
    }
}
