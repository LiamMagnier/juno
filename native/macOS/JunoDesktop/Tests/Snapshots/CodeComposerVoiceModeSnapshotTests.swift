import AppKit
import Foundation
import JunoCodeCore
import JunoCodeUI
import JunoDesignSystem
import SwiftUI
import Testing
@testable import JunoDesktop

/// The Code composer with voice and the mode (owner, 2026-10-10), drawn
/// offscreen: `$JUNO_SNAPSHOT_DIR/code-voice/mac-<shot>-<light|dark>.png`.
///
/// The mode menu is the system's own menu, which only the window server
/// draws, so `mode-menu` draws what that menu holds (the five rungs, each
/// with its line) as a stand-in. Dictation is drawn in its starting phase,
/// with the microphone never opened.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the Code voice and mode snapshots."
    ),
    .serialized
)
struct CodeComposerVoiceModeSnapshotTests {
    enum Shot: String, CaseIterable {
        case composerFull = "composer-full-access"
        case composerAsk = "composer-ask"
        case composerPlan = "composer-plan"
        case modeMenu = "mode-menu"
        case dictation = "dictation"
        case voice = "voice"
        /// Chat's composer in a call, the reference the Code call matches.
        case chatVoice = "chat-voice-reference"
    }

    private static let size = CGSize(width: 980, height: 620)

    private static func composer(_ mode: CodeComposerMode) -> CodeV2ComposerModel {
        let model = CodeV2ComposerModel(selection: CodeV2Fixtures.claudeSelection)
        model.composerMode = mode
        return model
    }

    private static func thread(_ mode: CodeComposerMode, speech: CodeComposerSpeech = CodeComposerSpeech(dictate: {}, talk: {})) -> some View {
        CodeV2EnvSessionView(
            session: CodeV2EnvSession(preview: CodeV2Fixtures.settledSnapshot),
            composer: composer(mode),
            directory: CodeV2Fixtures.directory,
            openConnections: {},
            place: CodeV2SessionPlace(project: "storefront", branch: "alevr/server-totals", machine: "This Mac"),
            speech: speech
        )
    }

    private static var dictating: CodeComposerSpeech {
        CodeComposerSpeech(dictation: AnyView(DesktopCodeDictation(onCancel: {}, onStop: { _ in }, onSend: { _ in }, listens: false)))
    }

    private static var inCall: CodeComposerSpeech {
        let column = VoiceShots.call(.speaking)
        let hangUp = DesktopVoiceHangUp()
        return CodeComposerSpeech(
            callRow: { hasDraft, send in
                AnyView(DesktopVoiceCallBar(column: column, hangUp: hangUp, hasDraft: hasDraft, leading: { EmptyView() }, primary: { send }))
            },
            callGlow: AnyView(DesktopVoiceComposerGlow(controller: column.controller))
        )
    }

    private static func view(_ shot: Shot) async throws -> AnyView {
        switch shot {
        case .chatVoice:
            let world = try await SnapshotPreviewWorld.shared()
            return AnyView(VoiceShots.composer(world: world, call: VoiceShots.call(.speaking)).frame(maxHeight: .infinity, alignment: .bottom))
        case .composerFull: return AnyView(thread(.full))
        case .composerAsk: return AnyView(thread(.ask))
        case .composerPlan: return AnyView(thread(.plan))
        case .modeMenu: return AnyView(ModeMenuStandIn(current: .full).frame(maxWidth: .infinity, maxHeight: .infinity))
        case .dictation: return AnyView(thread(.full, speech: dictating))
        case .voice: return AnyView(thread(.full, speech: inCall))
        }
    }

    @Test(arguments: Shot.allCases)
    func drawsInBothAppearances(_ shot: Shot) async throws {
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
            .appendingPathComponent("code-voice", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let size = shot == .modeMenu ? CGSize(width: 520, height: 420) : Self.size
        let content = try await Self.view(shot)
        for dark in [false, true] {
            let hosting = NSHostingView(
                rootView: content
                    .frame(width: size.width, height: size.height)
                    .background(Color.junoCanvas)
                    .environment(\.colorScheme, dark ? .dark : .light)
                    .environment(\.junoSnapshotOpaqueGlass, true)
                    .environment(\.codeV2Now, CodeV2Fixtures.now)
                    .environment(\.locale, Locale(identifier: "en_US"))
            )
            hosting.frame = CGRect(origin: .zero, size: size)
            let window = NSWindow(
                contentRect: CGRect(origin: CGPoint(x: -10_000, y: -10_000), size: size),
                styleMask: [.borderless], backing: .buffered, defer: false
            )
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            window.contentView = hosting
            for _ in 0..<8 {
                try await Task.sleep(for: .milliseconds(80))
                hosting.layoutSubtreeIfNeeded()
            }
            let rep = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: rep)
            let data = try #require(rep.representation(using: .png, properties: [:]))
            let url = root.appendingPathComponent("mac-\(shot.rawValue)-\(dark ? "dark" : "light").png")
            try data.write(to: url)
            window.contentView = nil
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}

/// What the mode menu holds, drawn as a menu panel: each rung's glyph, name
/// and line, the current one checked, and the shortcut.
private struct ModeMenuStandIn: View {
    let current: CodeComposerMode

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(CodeComposerMode.ladder) { mode in
                HStack(alignment: .top, spacing: JunoSpace.snug) {
                    JunoIconView(.check, size: 12)
                        .opacity(mode == current ? 1 : 0)
                        .padding(.top, 3)
                    JunoIconView(mode.icon, size: 14)
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(mode.title).font(.system(size: 13, weight: .medium))
                        Text(mode.detail).font(.system(size: 11)).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, JunoSpace.snug)
                .padding(.vertical, 5)
            }
            Divider().padding(.vertical, 4)
            Text("\u{21E7}\u{2318}A cycles the mode")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .padding(.horizontal, JunoSpace.snug)
                .padding(.bottom, 4)
        }
        .padding(6)
        .frame(width: 380)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.junoSurface))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.junoBorder))
        .shadow(color: .black.opacity(0.18), radius: 16, y: 6)
    }
}
