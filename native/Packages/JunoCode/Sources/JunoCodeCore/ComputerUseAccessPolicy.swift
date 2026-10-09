import Foundation

/// Whether one screen action may run without asking, by the session's
/// runtime mode (Code v2 SPEC §3.7, §3.12).
///
/// The Mac's own sessions get this from `PermissionCoordinator`'s ladder
/// (`.critical` asks in Ask and Workspace-write, proceeds in Full access).
/// Connected agents reaching the Mac through the env server's bridge carry a
/// v2 `RuntimeMode` instead, and this is the same ladder in those terms, plus
/// the reader's per-app allowlist:
///
/// | mode       | look | act (allowlisted app) | act (other app) | floor |
/// |------------|------|-----------------------|-----------------|-------|
/// | read-only  | yes  | no                    | no              | no    |
/// | ask        | yes  | ask                   | ask             | ask   |
/// | auto-edit  | yes  | yes                   | ask             | ask   |
/// | auto       | yes  | yes                   | ask             | ask   |
/// | full       | yes  | yes                   | yes             | ask   |
///
/// The floor — sending, buying, deleting, signing in, System Settings — asks
/// in every mode and no allowlist silences it. Granting an app always asks.
public enum ComputerUseAccessPolicy {
    public enum Decision: Hashable, Sendable {
        case allow
        case ask
        case deny(String)
    }

    public static let readOnlySentence =
        "This session is read-only: Alevr can look at apps but not click or type in them. Switch the mode to let it act."

    public static func decide(
        mode: CodeV2.RuntimeMode,
        isInput: Bool,
        hitsFloor: Bool,
        appAllowlisted: Bool
    ) -> Decision {
        guard isInput else { return .allow }
        if mode == .readOnly { return .deny(readOnlySentence) }
        if hitsFloor { return .ask }
        switch mode {
        case .readOnly: return .deny(readOnlySentence)
        case .ask: return .ask
        case .autoEdit, .auto: return appAllowlisted ? .allow : .ask
        case .full: return .allow
        }
    }
}

/// Builds the `computer_action` turn item for a screen step (Code v2 SPEC
/// §3.2, §3.12), so the thread can show a screenshot timeline.
public enum ComputerActionItems {
    /// `alevr-shot://<session>/<call>.<ext>`: resolved by the screenshot store
    /// on the Mac and by the env server's screenshot route for the web.
    public static func screenshotRef(sessionID: String, callID: String, mediaType: String) -> String {
        let ext = mediaType.contains("png") ? "png" : "jpg"
        return "alevr-shot://\(sanitize(sessionID))/\(sanitize(callID)).\(ext)"
    }

    /// Path-safe: letters, digits, `-`, `_`, `.` and `:` stay; anything else is `_`.
    public static func sanitize(_ component: String) -> String {
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:")
        let mapped = String(component.map { allowed.contains($0) ? $0 : "_" })
        let trimmed = mapped.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return trimmed.isEmpty ? "_" : String(trimmed.prefix(120))
    }

    public static func isoTimestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    public static func item(
        callID: String,
        action: CodeV2.ComputerActionKind,
        status: CodeV2.ItemStatus,
        at date: Date,
        turnID: String? = nil,
        app: String? = nil,
        target: String? = nil,
        summary: String? = nil,
        screenshotRef: String? = nil,
        framePoint: [Double]? = nil,
        frameSize: (width: Int, height: Int)? = nil,
        error: String? = nil,
        durationMs: Double? = nil
    ) -> CodeV2.TurnItem {
        var point: CodeV2.ComputerAction.UnitPoint?
        if let framePoint, framePoint.count == 2, let frameSize, frameSize.width > 0, frameSize.height > 0 {
            point = CodeV2.ComputerAction.UnitPoint(
                x: min(1, max(0, framePoint[0] / Double(frameSize.width))),
                y: min(1, max(0, framePoint[1] / Double(frameSize.height)))
            )
        }
        return .computerAction(CodeV2.ComputerAction(
            id: "ca_\(callID)",
            turnId: turnID,
            createdAt: isoTimestamp(date),
            callId: callID,
            action: action,
            target: target,
            screenshotRef: screenshotRef,
            status: status,
            app: app,
            summary: summary,
            point: point,
            frameSize: frameSize.map { CodeV2.ComputerAction.FrameSize(width: $0.width, height: $0.height) },
            error: error,
            durationMs: durationMs
        ))
    }
}
