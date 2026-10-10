import AppKit
import Foundation
import JunoCodeCore
import SwiftUI
import WebKit

// Remote control's hand-off and sync seam for a Code v2 thread
// (docs/code-v2/REMOTE-CONTROL.md §5). The thread view says what happens to
// its draft and composer choices; the app that hosts it (the Mac) owns the
// account, the backend and the debouncing, and hands back what another device
// wrote. Kept as a protocol so this package stays free of the account and
// sync clients, and so the view can be exercised with a fake.

/// The composer choices a thread carries between devices, in the strings the
/// backend stores (`ThreadSyncPrefs` on the wire).
public struct CodeV2SyncedPrefs: Equatable, Sendable, Hashable {
    /// `<instanceId>/<model>`: the provider instance, then the model id.
    public var model: String?
    public var effort: String?
    public var mode: String?
    public var interactionMode: String?
    /// The team preset (`solo`, `lead-workers`, …).
    public var team: String?
    /// Skill names, in the order chosen.
    public var skills: [String]?

    public init(
        model: String? = nil, effort: String? = nil, mode: String? = nil, interactionMode: String? = nil,
        team: String? = nil, skills: [String]? = nil
    ) {
        self.model = model
        self.effort = effort
        self.mode = mode
        self.interactionMode = interactionMode
        self.team = team
        self.skills = skills
    }

    public var isEmpty: Bool { self == CodeV2SyncedPrefs() }

    /// What the composer shows for a thread now.
    @MainActor
    public init(composer: CodeV2ComposerModel, skills: CodeSkillsModel?) {
        let selection = composer.selection
        self.init(
            model: selection.model.isEmpty ? nil : Self.modelKey(instanceId: selection.instanceId, model: selection.model),
            effort: selection.effort?.rawValue,
            mode: composer.runtimeMode.rawValue,
            interactionMode: composer.interactionMode.rawValue,
            team: composer.roles.preset.rawValue,
            skills: skills.map { model in model.selectedIDs.map(Self.skillName) }
        )
    }

    public static func modelKey(instanceId: String, model: String) -> String { "\(instanceId)/\(model)" }

    /// Splits `<instanceId>/<model>` at its first slash (model ids may hold more).
    public static func parseModel(_ key: String) -> (instanceId: String, model: String)? {
        guard let slash = key.firstIndex(of: "/") else { return nil }
        let instance = String(key[..<slash])
        let model = String(key[key.index(after: slash)...])
        guard !instance.isEmpty, !model.isEmpty else { return nil }
        return (instance, model)
    }

    /// `source:name` (a ``CodeSkillChoice`` id) to `name`.
    static func skillName(_ id: String) -> String {
        guard let colon = id.firstIndex(of: ":") else { return id }
        return String(id[id.index(after: colon)...])
    }

    /// Puts another device's choices into the composer. Values this Mac
    /// cannot read (an unknown mode, a malformed model) are left as they were.
    @MainActor
    public func apply(to composer: CodeV2ComposerModel, skills: CodeSkillsModel?) {
        if let model, let parsed = Self.parseModel(model) {
            var selection = composer.selection
            if selection.instanceId != parsed.instanceId || selection.model != parsed.model {
                selection = CodeV2.ModelSelection(instanceId: parsed.instanceId, model: parsed.model)
            }
            if let effort { selection.effort = CodeV2.EffortLevel(rawValue: effort) ?? selection.effort }
            if selection != composer.selection { composer.selection = selection }
        } else if let effort, let level = CodeV2.EffortLevel(rawValue: effort), composer.selection.effort != level {
            composer.selection.effort = level
        }
        if let mode, let value = CodeV2.RuntimeMode(rawValue: mode), composer.runtimeMode != value {
            composer.runtimeMode = value
        }
        if let interactionMode, let value = CodeV2.InteractionMode(rawValue: interactionMode), composer.interactionMode != value {
            composer.interactionMode = value
        }
        if let team, let preset = CodeV2.RolePreset(rawValue: team), composer.roles.preset != preset {
            composer.roles.preset = preset
        }
        if let names = self.skills, let skills {
            skills.adoptRemote(names: names)
        }
    }
}

/// What another device wrote for the open thread.
public struct CodeV2RemoteThreadUpdate: Equatable, Sendable {
    /// Replace the composer's draft with this (already checked: newer, not
    /// this Mac's own echo, and not over typing that has not been sent).
    public var draft: String?
    public var prefs: CodeV2SyncedPrefs?

    public init(draft: String? = nil, prefs: CodeV2SyncedPrefs? = nil) {
        self.draft = draft
        self.prefs = prefs
    }
}

/// The host's side of a thread's sync: drafts and composer choices out,
/// another device's back in.
@MainActor
public protocol CodeV2ThreadContinuity: AnyObject {
    /// The thread is on screen. `receive` is called with what another device
    /// wrote, until ``close(sessionID:)``.
    func open(sessionID: String, currentDraft: @escaping @MainActor () -> String, receive: @escaping @MainActor (CodeV2RemoteThreadUpdate) -> Void)
    /// The reader typed (or sent, which empties the field).
    func draftChanged(sessionID: String, text: String)
    /// The composer's model, effort, mode, team or skills changed.
    func prefsChanged(sessionID: String, prefs: CodeV2SyncedPrefs)
    /// The thread left the screen: flush the draft, stop listening.
    func close(sessionID: String)
}

public extension EnvironmentValues {
    /// Set by the Mac app while signed in; nil keeps a thread entirely local
    /// (previews, snapshots, a signed-out window).
    @Entry var codeV2ThreadContinuity: (any CodeV2ThreadContinuity)? = nil
}

/// Wires a thread view's composer to ``CodeV2ThreadContinuity``.
struct CodeV2ThreadContinuityModifier: ViewModifier {
    let sessionID: String
    let composer: CodeV2ComposerModel
    let skills: CodeSkillsModel?

    @Environment(\.codeV2ThreadContinuity) private var continuity

    func body(content: Content) -> some View {
        content
            .onChange(of: sessionID, initial: true) { old, new in
                guard let continuity else { return }
                if old != new { continuity.close(sessionID: old) }
                let composer = self.composer
                let skills = self.skills
                continuity.open(sessionID: new, currentDraft: { composer.draft }) { update in
                    if let prefs = update.prefs { prefs.apply(to: composer, skills: skills) }
                    if let draft = update.draft, draft != composer.draft { composer.draft = draft }
                }
            }
            .onChange(of: composer.draft) { _, text in
                continuity?.draftChanged(sessionID: sessionID, text: text)
            }
            .onChange(of: CodeV2SyncedPrefs(composer: composer, skills: skills)) { _, prefs in
                continuity?.prefsChanged(sessionID: sessionID, prefs: prefs)
            }
            .onDisappear { continuity?.close(sessionID: sessionID) }
    }
}

// MARK: - Session bindings

public extension CodeV2SessionBindings {
    /// The Code thread an env-server session is bound to, for opening it
    /// from a hand-off that names the env session.
    func threadID(forEnvSession envSessionID: String) -> String? {
        bindings.first { $0.value.envSessionId == envSessionID }?.key
    }
}

// MARK: - Preview capture

/// The Code preview pane, as remote control's `host.capture {target:"preview"}`
/// reads it: the page a pane shows (else any page with something loaded),
/// photographed by WebKit. Never the screen.
public enum CodeV2PreviewCapture {
    @MainActor
    public static var hasPage: Bool { page != nil }

    @MainActor
    private static var page: PreviewPage? {
        let pages = PreviewPageRegistry.shared.all.filter { $0.currentURL != nil }
        return pages.first(where: \.isShownInPane) ?? pages.first
    }

    /// The page's visible area at its backing resolution, or nil when no
    /// preview has a page.
    @MainActor
    public static func capture() async throws -> CGImage? {
        guard let page else { return nil }
        let configuration = WKSnapshotConfiguration()
        configuration.afterScreenUpdates = true
        let image = try await page.webView.takeSnapshot(configuration: configuration)
        return image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    }
}
