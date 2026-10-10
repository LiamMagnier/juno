import AppKit
import Foundation
import JunoChatKit
import JunoDesignSystem
import JunoPreviewSupport
import SwiftUI
import Testing

@testable import JunoDesktop

/// The composer tray (owner, Oct 10: "the same grey bar under the composer"),
/// the web's `composer-tray.tsx`, light and dark:
/// `$JUNO_SNAPSHOT_DIR/composer-tray/composer-tray-<name>-<light|dark>.png`.
///
/// Each tray hangs under the composer's own shell (`JunoComposerShell`, drawn
/// opaque because Liquid Glass is the window server's), with the field and
/// controls row the chat composer draws. The media trays read the schemas the
/// catalogue publishes (`PreviewMediaParams`, generated from media-params.ts).
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the composer tray snapshots."
    ),
    .serialized
)
struct ComposerTraySnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
            .appendingPathComponent("composer-tray", isDirectory: true)
    }

    static func schema(_ id: String) -> NativeMediaParamSchema {
        NativeMediaParamSchema.decode(Data(PreviewMediaParams.json[id]!.utf8))!
    }

    private static let projects = NativeComposerTrayProjects(
        items: [
            NativeComposerTrayProject(id: "p1", name: "Field Notes 2.0"),
            NativeComposerTrayProject(id: "p2", name: "Pricing"),
        ],
        selectedID: nil,
        select: { _ in }
    )

    @Test
    func theChatTray() async throws {
        try await render(name: "chat", placeholder: "Ask Alevr", model: "Gemini 3.8 Flash") {
            NativeComposerTray(
                projects: Self.projects,
                apps: NativeComposerTrayApps(connectors: [], enabled: [], toggle: { _ in }, manage: {}),
                skills: NativeComposerTraySkills(items: [NativeComposerTraySkill(slug: "brief", name: "Brief")], armed: nil, arm: { _ in })
            )
        }
    }

    @Test
    func theImageTray() async throws {
        let id = "openai:gpt-image-2.5-sunburst"
        let schema = Self.schema(id)
        try await render(name: "image", placeholder: "Describe an image to generate…", model: "GPT Image 2.5 Sunburst") {
            NativeComposerTray(
                projects: Self.projects,
                media: NativeComposerTrayMedia(schema: schema, params: schema.defaults(), set: { _, _ in })
            )
        }
        // Non-default choices: wide, 2K, high, four, opaque, WebP.
        var picked = schema.defaults()
        for (key, value) in [
            ("aspect", NativeMediaParamValue.string("16:9")), ("resolution", .string("2K")),
            ("quality", .string("high")), ("count", .number(4)),
            ("background", .string("opaque")), ("outputFormat", .string("webp")),
        ] {
            picked = schema.applying(key, value, to: picked)
        }
        try await render(name: "image-picked", placeholder: "Describe an image to generate…", model: "GPT Image 2.5 Sunburst") {
            NativeComposerTray(
                projects: Self.projects,
                media: NativeComposerTrayMedia(schema: schema, params: picked, set: { _, _ in })
            )
        }
    }

    @Test
    func theVideoTrays() async throws {
        for (name, id, model) in [
            ("video", "google:gemini-omni-1.1-flash", "Gemini Omni Flash"),
            ("video-veo", "google:veo-3.1-generate-preview", "Veo 3.1"),
            ("video-seedance", "seedance:dreamina-seedance-2-5-260628", "Seedance 2.5"),
        ] {
            let schema = Self.schema(id)
            try await render(name: name, placeholder: "Describe a video to generate…", model: model) {
                NativeComposerTray(
                    projects: Self.projects,
                    media: NativeComposerTrayMedia(schema: schema, params: schema.defaults(), set: { _, _ in })
                )
            }
        }
    }

    @Test
    func theAudioTray() async throws {
        let schema = Self.schema("google:lyria-3.5")
        try await render(name: "audio", placeholder: "Describe a song or a sound to generate…", model: "Lyria 3.5") {
            NativeComposerTray(
                projects: Self.projects,
                media: NativeComposerTrayMedia(schema: schema, params: schema.defaults(), set: { _, _ in })
            )
        }
    }

    /// The answers: a picture made at 16:9 with the non-default choices, and
    /// a track with its player.
    @Test
    func theResultsInChat() async throws {
        let (width, height) = (1536, 864)
        let pictureID = PreviewImageFixtures.generatedID(width: width, height: height)
        let picture = NativeChatAttachment(
            id: pictureID, fileName: "generated.png", mimeType: "image/png", kind: "IMAGE",
            size: 182_000, width: width, height: height
        )
        let track = NativeChatAttachment(
            id: PreviewImageFixtures.generatedAudioID, fileName: "evening-drive.wav", mimeType: "audio/wav",
            kind: "FILE", size: PreviewAudioFixtures.wav.count, width: nil, height: nil
        )
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("evening-drive.wav")
        try PreviewAudioFixtures.wav.write(to: file)
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let view = VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                Text("Wide, 2K, high quality, opaque background, WebP")
                    .junoFont(size: 13, relativeTo: .subheadline)
                    .foregroundStyle(Color.junoSecondaryInk)
                ResultPicture(id: pictureID, attachment: picture)
                Text("Evening Drive")
                    .junoFont(size: 15, relativeTo: .body, weight: .semibold)
                Text("Soft synths over a slow arpeggio, no vocals.")
                    .junoFont(size: 15, relativeTo: .body)
                NativeGeneratedAudioCard(attachment: track) { file }
            }
            .padding(JunoSpace.region)
            let url = try await TranscriptSnapshotRenderer.render(
                view, name: "composer-tray-results", width: 640, appearance: appearance, into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }

    /// The generated picture as the transcript frames it, from the fixture's bytes.
    private struct ResultPicture: View {
        let id: String
        let attachment: NativeChatAttachment

        var body: some View {
            if let data = PreviewImageFixtures.png(for: id), let image = NSImage(data: data) {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 480)
                    .clipShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
            }
        }
    }

    // MARK: Rendering

    /// The tray under a composer shell drawn the chat composer's way: the
    /// placeholder in the field, `+`, the model's name, the send disc.
    private func render<Tray: View>(
        name: String,
        placeholder: String,
        model: String,
        @ViewBuilder tray: () -> Tray
    ) async throws {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let view = JunoComposerShell(
                captionAbove: { EmptyView() },
                above: { EmptyView() },
                field: {
                    Text(placeholder)
                        .junoFont(size: 15, relativeTo: .body)
                        .foregroundStyle(Color.junoSecondaryInk)
                },
                controls: {
                    HStack(spacing: JunoComposerMetrics.controlSpacing) {
                        JunoIconView(.plus, size: 16)
                            .frame(width: JunoComposerMetrics.controlHeight, height: JunoComposerMetrics.controlHeight)
                        Spacer(minLength: JunoSpace.snug)
                        HStack(spacing: JunoSpace.tight) {
                            Text(model)
                            JunoIconView(.chevronDown, size: 12)
                        }
                        .junoFont(size: 13, relativeTo: .subheadline)
                        .foregroundStyle(Color.junoForeground.opacity(0.8))
                        .padding(.horizontal, JunoSpace.snug)
                        ZStack {
                            Circle().fill(Color.junoForeground.opacity(0.12))
                            JunoIconView(.arrowUp, size: 16).foregroundStyle(Color.junoCanvas)
                        }
                        .frame(width: JunoComposerMetrics.controlHeight, height: JunoComposerMetrics.controlHeight)
                    }
                },
                edge: { EmptyView() },
                tray: tray,
                captionBelow: { EmptyView() }
            )
            .padding(.horizontal, JunoSpace.region)
            .padding(.vertical, JunoSpace.region)
            .environment(\.junoSnapshotOpaqueGlass, true)
            let url = try await TranscriptSnapshotRenderer.render(
                view, name: "composer-tray-\(name)", width: 800, appearance: appearance, into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}
