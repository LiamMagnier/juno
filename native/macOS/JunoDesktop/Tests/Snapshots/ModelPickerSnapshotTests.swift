import AppKit
import Foundation
import JunoDesignSystem
import SwiftUI
import Testing

@testable import JunoDesktop

/// The composer's model control, the website's two stages (owner, 2026-10-09:
/// "when you click first, you have the thing in slider. And when you click on
/// the models, it opens the new model selector"), light and dark:
/// `$JUNO_SNAPSHOT_DIR/model-picker/model-picker-<name>-<light|dark>.png`.
///
/// The catalogue is the web's own (``ModelPickerWebFixtures``, generated from
/// src/lib/models.ts for a Pro account), so each picture can be read beside
/// the web's /dev/model-picker in the same state.
///
/// A popover is the window server's to draw, so each stage is photographed in
/// a stand-in for one: the popover's fill, its corner and its shadow.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the model picker snapshots."
    ),
    .serialized
)
struct ModelPickerSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
            .appendingPathComponent("model-picker", isDirectory: true)
    }

    private static let opus = "anthropic:claude-opus-5-5"
    private static let image = "google:gemini-3.1-flash-image"

    private static func model(_ id: String) -> JunoModelDescriptor {
        ModelPickerWebFixtures.models.first { $0.id == id }!
    }

    /// Stage one: Opus 5.5 at High, Flash on. Its model name is the door to
    /// the catalogue; reset returns to Medium, Opus's own default.
    @Test
    func theEffortPanelOpensFirst() async throws {
        let opus = Self.model(Self.opus)
        #expect(JunoModelPickerStage.first(for: opus.thinking) == .effort)
        try await render(name: "effort-panel", width: JunoEffortPanelMetrics.width) {
            JunoEffortPanel(
                ladder: opus.thinking,
                stopID: .constant("high"),
                modelName: opus.displayName,
                fastMode: .constant(true),
                openModels: {}
            )
            .frame(width: JunoEffortPanelMetrics.width, height: JunoEffortPanelMetrics.height)
        }
        // The first rung, where the fill hides and reset is live, and Flash off.
        try await render(name: "effort-panel-first-rung", width: JunoEffortPanelMetrics.width) {
            JunoEffortPanel(
                ladder: opus.thinking,
                stopID: .constant("low"),
                modelName: opus.displayName,
                fastMode: .constant(false),
                openModels: {}
            )
            .frame(width: JunoEffortPanelMetrics.width, height: JunoEffortPanelMetrics.height)
        }
    }

    /// Stage two, reached from the panel's model name: the catalogue opens on
    /// Opus 5.5, its row lit and Anthropic's section in view.
    @Test
    func theCatalogueOpensFromThePanel() async throws {
        try await render(name: "catalog-from-panel", width: JunoModelSelectorMetrics.standard.width) {
            catalogue(selected: Self.opus)
        }
    }

    /// A model with no thinking levels (an image model) skips the panel: the
    /// chip opens the catalogue on Google's Image rows.
    @Test
    func aModelWithoutLevelsOpensTheCatalogueDirectly() async throws {
        let image = Self.model(Self.image)
        #expect(JunoModelPickerStage.first(for: image.thinking, modality: image.modality) == .catalog)
        try await render(name: "catalog-direct", width: JunoModelSelectorMetrics.standard.width) {
            catalogue(selected: Self.image)
        }
    }

    /// The chip: words only, the effort when it is not the model's usual one,
    /// one chevron; at rest and open.
    @Test
    func theChipIsTheWebsWords() async throws {
        let opus = Self.model(Self.opus)
        try await render(name: "chip", width: 520, popover: false) {
            HStack(spacing: JunoSpace.regular) {
                JunoModelChipLabel(
                    name: opus.displayName,
                    effort: JunoModelPicker.effortLabel(ladder: opus.thinking, stopID: "high"),
                    mark: .provider(id: opus.providerID, name: opus.providerName),
                    isOpen: false
                )
                .fixedSize()
                JunoModelChipLabel(
                    name: opus.displayName,
                    mark: .provider(id: opus.providerID, name: opus.providerName),
                    isOpen: true
                )
                .fixedSize()
                JunoModelChipLabel(name: "Auto", mark: .product, isOpen: false)
                    .fixedSize()
            }
            .padding(JunoSpace.regular)
        }
    }

    // MARK: Rendering

    private func catalogue(selected: String) -> some View {
        JunoModelSelector(
            models: ModelPickerWebFixtures.models,
            selectedModelID: selected,
            metrics: .standard,
            favorites: [],
            toggleFavorite: { _ in },
            select: { _ in }
        )
    }

    private func render<V: View>(
        name: String,
        width: CGFloat,
        popover: Bool = true,
        @ViewBuilder _ view: () -> V
    ) async throws {
        // The web gallery has no recents; neither does the picture.
        let defaults = UserDefaults.standard
        let saved = defaults.string(forKey: JunoModelRecents.key)
        defaults.set("", forKey: JunoModelRecents.key)
        defer { defaults.set(saved, forKey: JunoModelRecents.key) }

        let gutter = JunoSpace.region
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let content = view()
            let framed = Group {
                if popover {
                    content
                        .background(Color.junoPopover)
                        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.menu, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: JunoRadius.menu, style: .continuous)
                                .strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 0.5)
                        }
                        .shadow(color: .black.opacity(0.16), radius: 18, y: 8)
                } else {
                    content
                }
            }
            .padding(gutter)
            let url = try await TranscriptSnapshotRenderer.render(
                framed,
                name: "model-picker-\(name)",
                width: width + gutter * 2,
                appearance: appearance,
                into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}
