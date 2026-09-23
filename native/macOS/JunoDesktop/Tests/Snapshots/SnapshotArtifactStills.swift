import AppKit
import Foundation
import JunoChatKit
import JunoDesignSystem
import JunoPreviewSupport
import SwiftUI

@testable import JunoDesktop

/// Stills for the Stage 3 fixtures: the running artifacts, the design
/// pictures and the Mermaid figures, each photographed from an offscreen web
/// view of its own before the fixture is drawn (``TranscriptFixture/prepare``)
/// and handed to the transcript through the environment.
///
/// A still is keyed by the exact document the live view would load, so a
/// fixture whose view builds a different document than the one prepared draws
/// the live (blank, offscreen) web view instead — visibly, rather than a
/// still of the wrong page.
@MainActor
final class SnapshotStillCache {
    static let shared = SnapshotStillCache()

    private var images: [String: NSImage] = [:]
    private var messages: [String: [ArtifactRuntimeMessage]] = [:]
    private var mermaid: [String: NSImage] = [:]

    /// The inline card's sheet: 768 less the 8pt mat each side, 360 less the
    /// mat top and bottom.
    static let sheet = CGSize(width: 752, height: 344)

    func prepare(document: String, size: CGSize = SnapshotStillCache.sheet) async throws {
        guard images[document] == nil else { return }
        let captured = try await SnapshotStills.capture(html: document, size: size)
        images[document] = captured.image
        messages[document] = captured.messages
    }

    /// An artifact as the transcript card and the canvas run it.
    func prepareArtifact(kind: NativeArtifactKind, content: String, language: String? = nil) async throws {
        try await prepare(document: NativeArtifactRuntimeDocument.build(kind: kind, content: content, language: language))
    }

    /// A design's exported SVG, on the inert thumbnail sheet.
    func prepareDesign(svg: String) async throws {
        try await prepare(document: NativeArtifactSandbox.document(
            kind: .svg,
            content: InlineDesignPreviewBody.fitted(svg),
            policy: .thumbnail
        ))
    }

    /// A Mermaid figure in both appearances, drawn by the bundled engine.
    func prepareMermaid(_ source: String) async throws {
        guard let engine = JunoDesktopApp.bundledMermaid() else { return }
        for isDark in [false, true] {
            let key = Self.mermaidKey(source, isDark)
            guard mermaid[key] == nil else { continue }
            let captured = try await SnapshotStills.capture(
                html: JunoMermaidMarkup.hostDocument(source: source, engine: engine, isDark: isDark),
                size: CGSize(width: 752, height: 288),
                timeout: 10,
                messageHandler: "junoDiagram",
                settle: .milliseconds(1_200),
                transparent: true
            )
            mermaid[key] = captured.image
        }
    }

    var webStills: JunoWebPreviewStills {
        JunoWebPreviewStills(
            { [weak self] document in self?.images[document] },
            messages: { [weak self] document in self?.messages[document] ?? [] }
        )
    }

    var mermaidStills: JunoMermaidStills {
        JunoMermaidStills { [weak self] source, isDark in self?.mermaid[Self.mermaidKey(source, isDark)] }
    }

    private static func mermaidKey(_ source: String, _ isDark: Bool) -> String {
        "\(isDark ? "dark" : "light")|\(source)"
    }
}

/// A design's picture without a network: the preview world's SVG, or a
/// forced state.
@MainActor
final class SnapshotDesignProvider: DesignPreviewProviding {
    let state: NativeDesignPreviewState

    init(state: NativeDesignPreviewState = .ready(svg: PreviewFixtures.designSVG)) {
        self.state = state
    }

    func designPreviewState(artifactID _: String, version _: Int) -> NativeDesignPreviewState { state }
    func loadDesignPreview(artifactID _: String, version _: Int) async {}
}
