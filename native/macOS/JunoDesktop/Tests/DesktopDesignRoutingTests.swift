import JunoChatKit
import Testing

@testable import JunoDesktop

/// Which renderer a design document is allowed to reach.
///
/// The bug these pin down shipped: the artifacts library sent every artifact to
/// `NativeArtifactPreview`, so opening a stored Juno Design document showed its
/// `DesignDocument` JSON in a monospaced dump — while opening the *same* document
/// from the conversation it came out of showed the real editor. Two surfaces, one
/// document, two answers.
///
/// These are contract tests, not view tests. The editor is a `WKWebView` loading a
/// local bundle over a validated bridge, and nothing about that is assertable
/// here; what *is* assertable is the pair of flags every surface branches on
/// before it picks a renderer, and the reason the second of them says what it
/// says.
struct DesktopDesignRoutingTests {

    // MARK: - The diverting flag

    /// `isDesignDocument` is the branch every design surface takes first — the
    /// Mac's ``DesktopDesignSurface``, the phone's `JunoMobileArtifactBody`. If it
    /// ever answered for a second kind, that kind would be handed to a design
    /// editor that cannot read it.
    @Test func onlyTheDesignKindIsADesignDocument() {
        for kind in NativeArtifactKind.allCases {
            #expect(kind.isDesignDocument == (kind == .design))
        }
    }

    // MARK: - Why the shared preview still says no

    /// `supportsRenderedPreview` reads like a lie for `.design` — a design plainly
    /// has a visual form — so this is the assertion that stops someone "fixing" it.
    ///
    /// The property answers for `NativeArtifactPreview` alone, and that view has no
    /// design renderer: it is in JunoChatKit, which owns no bundle, no bridge and
    /// no web host, and should not. Every caller uses the flag to pick that view's
    /// starting mode or to decide whether a Preview/Source pair is worth offering.
    @Test func theSharedPreviewDoesNotClaimToRenderADesign() {
        #expect(NativeArtifactKind.design.supportsRenderedPreview == false)
    }

    /// The evidence for the assertion above, rather than a restatement of it.
    ///
    /// Flipping the flag would not open an editor anywhere: it would route the
    /// body through `NativeArtifactSandbox`, whose `.design` branch escapes the
    /// JSON into a `<pre>`. The reader would get the same JSON dump they get today
    /// — through a `WKWebView` instead of a `Text`, and now with a Preview/Source
    /// switch over it that moves between two spellings of the same dump.
    @Test func theSandboxHasOnlyASourceDumpForADesign() {
        let body = #"{"schemaVersion":1,"name":"Sign-in screen","note":"a<b"}"#
        let document = NativeArtifactSandbox.document(kind: .design, content: body)

        // The body, escaped into a `<pre>` — a listing of the file, which is the
        // most an artifact sandbox with no design renderer can honestly offer.
        #expect(document.contains("<pre>"))
        #expect(document.contains(#""name":"Sign-in screen""#))
        #expect(document.contains("a&lt;b"))
        // Not a canvas, not the bundled editor. Nothing here draws the document.
        #expect(!document.contains("DesignEditor"))
        #expect(!document.contains("<svg"))
    }

    /// Kinds the shared preview really can draw are unaffected by any of the
    /// above. This is the row that would have caught it if the `.design` case had
    /// been folded into the wrong arm of the switch.
    @Test func theKindsWithARealRendererStillHaveOne() {
        #expect(NativeArtifactKind.html.supportsRenderedPreview)
        #expect(NativeArtifactKind.markdown.supportsRenderedPreview)
        #expect(NativeArtifactKind.svg.supportsRenderedPreview)

        #expect(!NativeArtifactKind.react.supportsRenderedPreview)
        #expect(!NativeArtifactKind.code.supportsRenderedPreview)
        #expect(!NativeArtifactKind.mermaid.supportsRenderedPreview)
    }
}
