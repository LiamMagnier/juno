import AppKit
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem
import SwiftUI

// The Preview's two surfaces: the dock beside the Code canvas and the pop-out
// window. Both are views onto the session's preview in the registry and its
// one page (CODE_AGENT_SPEC §4.1, §4.7); neither owns a server. Closing either,
// or switching sessions, stops nothing (PV-1).

/// Posted when the agent starts a preview, so the workbench can show the pane
/// for the session in view. A hint only: the preview runs whether or not a
/// pane shows it (PV-2).
public extension Notification.Name {
    static let junoCodePreviewOpenRequested = Notification.Name(
        "com.liammagnier.juno.code.preview.open-requested"
    )
}

/// Which preview a surface shows: a workspace and the session that owns the
/// preview, and optionally a configuration. Carried as the pop-out window's
/// value for scene restoration.
public struct CodePreviewTarget: Hashable, Codable, Sendable {
    /// Stable identity shared by the dock and pop-out window.
    public var previewID: UUID
    public var workspaceRootPath: String?
    /// An address to open, from an older build's scene restoration.
    public var address: URL?
    /// The Code session that owns this preview. Older scene-restoration values
    /// decode as nil and stay visible to the reader but not to an agent tool.
    public var sessionID: CodeSessionID?
    /// The configuration to show, when one was named.
    public var configurationName: String?

    public init(
        previewID: UUID = UUID(),
        workspaceRootPath: String? = nil,
        address: URL? = nil,
        sessionID: CodeSessionID? = nil,
        configurationName: String? = nil
    ) {
        self.previewID = previewID
        self.workspaceRootPath = workspaceRootPath
        self.address = address
        self.sessionID = sessionID
        self.configurationName = configurationName
    }

    public init(
        previewID: UUID = UUID(),
        workspaceRoot: URL?,
        address: URL? = nil,
        sessionID: CodeSessionID? = nil,
        configurationName: String? = nil
    ) {
        self.previewID = previewID
        self.workspaceRootPath = workspaceRoot?.path
        self.address = address
        self.sessionID = sessionID
        self.configurationName = configurationName
    }

    private enum CodingKeys: String, CodingKey {
        case previewID, workspaceRootPath, address, sessionID, configurationName
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        previewID = try values.decodeIfPresent(UUID.self, forKey: .previewID) ?? UUID()
        workspaceRootPath = try values.decodeIfPresent(String.self, forKey: .workspaceRootPath)
        address = try values.decodeIfPresent(URL.self, forKey: .address)
        sessionID = try values.decodeIfPresent(CodeSessionID.self, forKey: .sessionID)
        configurationName = try values.decodeIfPresent(String.self, forKey: .configurationName)
    }

    var workspaceRoot: URL? {
        workspaceRootPath.map { URL(fileURLWithPath: $0, isDirectory: true) }
    }
}

/// The in-workspace Preview, beside the Code canvas.
public struct CodePreviewDock: View {
    private let target: CodePreviewTarget
    @State private var lease: PreviewLeaseModel
    private let close: () -> Void
    private let openInWindow: (() -> Void)?

    /// - Parameter lease: the session's lease model, so the dock and the
    ///   session share one; a fresh one is made when absent.
    public init(
        target: CodePreviewTarget,
        lease: PreviewLeaseModel? = nil,
        close: @escaping () -> Void,
        openInWindow: (() -> Void)? = nil
    ) {
        self.target = target
        _lease = State(initialValue: lease ?? PreviewLeaseModel())
        self.close = close
        self.openInWindow = openInWindow
    }

    public var body: some View {
        PreviewPaneView(lease: lease, style: .dock, close: close, openInWindow: openInWindow)
            .task(id: target) { bind() }
            .accessibilityIdentifier("juno.code.preview.dock")
    }

    private func bind() {
        lease.bind(sessionID: target.sessionID, workspaceRoot: target.workspaceRoot)
        if let name = target.configurationName { lease.selectedName = name }
    }
}

/// The Preview in its own window, for a second display or a phone-width
/// window beside the code. It shows the same page as the dock.
public struct CodePreviewWindowView: View {
    private let target: CodePreviewTarget
    @State private var lease = PreviewLeaseModel()

    public init(target: CodePreviewTarget = CodePreviewTarget()) {
        self.target = target
    }

    public var body: some View {
        PreviewPaneView(lease: lease, style: .window)
            .navigationTitle("Preview")
            .navigationSubtitle(lease.statusSentence)
            .task(id: target) {
                lease.bind(sessionID: target.sessionID, workspaceRoot: target.workspaceRoot)
                if let name = target.configurationName { lease.selectedName = name }
            }
    }
}

/// The preview's window scene. The host app adds `CodePreviewScene()`;
/// opening one is
/// `openWindow(id: CodePreviewScene.windowID, value: CodePreviewTarget(workspaceRoot: root))`.
public struct CodePreviewScene: Scene {
    public static let windowID = "juno.code.preview"

    public init() {}

    public var body: some Scene {
        WindowGroup(id: Self.windowID, for: CodePreviewTarget.self) { $target in
            CodePreviewWindowView(target: target ?? CodePreviewTarget())
                .frame(minWidth: 520, minHeight: 360)
        }
        .defaultSize(width: 960, height: 760)
    }
}
