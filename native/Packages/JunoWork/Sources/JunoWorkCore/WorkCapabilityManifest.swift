import Foundation

/// What a task can require and a host can offer.
///
/// Raw values match `WORK_CAPABILITIES` in `src/lib/work/domain.ts`. Named for
/// what the person asked for rather than for the tool that happens to implement
/// it, so `localFiles` stays true when the file tool is rewritten — and so the
/// list shown to somebody explaining why their task cannot run reads like their
/// request rather than like an inventory.
public enum WorkCapability: String, Codable, CaseIterable, Sendable, Comparable {
    case localFiles = "local_files"
    case localApps = "local_apps"
    case localBrowser = "local_browser"
    case localComputerUse = "local_computer_use"
    case localShell = "local_shell"
    case webResearch = "web_research"
    case connectors
    case cloudFiles = "cloud_files"
    case deliverables
    case backgroundContinuation = "background_continuation"

    /// Capabilities that only ever exist on a Mac somebody opted in.
    public static let localOnly: Set<WorkCapability> = [
        .localFiles, .localApps, .localBrowser, .localComputerUse, .localShell,
    ]

    public var requiresLocalHost: Bool { Self.localOnly.contains(self) }

    /// One phrase, addressed to the person, matching `describeCapability` in
    /// `domain.ts`. Deliberately not `description`: this belongs in a sentence
    /// somebody reads, and a log line that printed it instead of the raw value
    /// would no longer say which capability it meant.
    public var phrase: String {
        switch self {
        case .localFiles: "access to a folder on your Mac"
        case .localApps: "control of an app on your Mac"
        case .localBrowser: "your signed-in browser"
        case .localComputerUse: "screen control on your Mac"
        case .localShell: "a shell on your Mac"
        case .webResearch: "web research"
        case .connectors: "your connected apps"
        case .cloudFiles: "files stored with Juno"
        case .deliverables: "document and spreadsheet creation"
        case .backgroundContinuation: "running while your devices are offline"
        }
    }

    public static func < (lhs: WorkCapability, rhs: WorkCapability) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

/// The switches and system permissions that actually exist on one Mac, right
/// now.
///
/// Every field is something with an observable answer — a row in the grant
/// store, an `AXIsProcessTrusted()` call, a preference the person set. Nothing
/// here is an intention.
public struct WorkHostToggles: Hashable, Sendable {
    /// The master switch. Off means this Mac advertises nothing at all, whatever
    /// else is true.
    public let workEnabled: Bool
    /// How many folder grants are live. Zero means no files capability, however
    /// many folders were once shared.
    public let activeFolderGrants: Int
    /// macOS Accessibility permission, which is what makes driving another app
    /// possible at all.
    public let accessibilityPermissionGranted: Bool
    /// How many browser profiles the person connected.
    public let browserProfileGrants: Int
    /// macOS Screen Recording permission.
    public let screenRecordingPermissionGranted: Bool
    /// Shell access, which is off unless the person turned it on.
    public let shellEnabled: Bool
    public let webResearchEnabled: Bool
    public let deliverablesAvailable: Bool

    public init(
        workEnabled: Bool,
        activeFolderGrants: Int = 0,
        accessibilityPermissionGranted: Bool = false,
        browserProfileGrants: Int = 0,
        screenRecordingPermissionGranted: Bool = false,
        shellEnabled: Bool = false,
        webResearchEnabled: Bool = false,
        deliverablesAvailable: Bool = false
    ) {
        self.workEnabled = workEnabled
        self.activeFolderGrants = activeFolderGrants
        self.accessibilityPermissionGranted = accessibilityPermissionGranted
        self.browserProfileGrants = browserProfileGrants
        self.screenRecordingPermissionGranted = screenRecordingPermissionGranted
        self.shellEnabled = shellEnabled
        self.webResearchEnabled = webResearchEnabled
        self.deliverablesAvailable = deliverablesAvailable
    }
}

/// What one Mac truthfully advertises it can do.
///
/// A manifest cannot be assembled from a list of capabilities. The only way to
/// make one is ``init(hostID:displayName:toggles:generatedAt:)``, which derives
/// every entry from a real grant or a real system permission — so a capability
/// appears here because something granted it, not because a caller believed it
/// was available. The failure this prevents is concrete and expensive: a Mac
/// that claims `local_files` with no live folder grant is chosen to run a task
/// it cannot start, and the person watches a task sit at "preparing" until it
/// times out.
///
/// Cloud-served capabilities are deliberately absent. Whether the connectors
/// work, whether Juno holds cloud files, and whether a run can continue with
/// every device asleep are facts about the service, and a Mac asserting them
/// would be a Mac speaking for something it cannot see.
public struct WorkCapabilityManifest: Hashable, Codable, Sendable {
    /// Bumped when the derivation rules change in a way that makes an older
    /// host's manifest mean something different.
    public static let currentVersion = 1

    public let version: Int
    public let hostID: String
    public let displayName: String
    /// Sorted, so two manifests describing the same Mac compare equal and a
    /// heartbeat that changed nothing does not look like a change.
    public let capabilities: [WorkCapability]
    public let generatedAt: Date

    /// Builds a manifest from what is actually true of this Mac.
    public init(
        hostID: String,
        displayName: String,
        toggles: WorkHostToggles,
        generatedAt: Date
    ) {
        self.version = Self.currentVersion
        self.hostID = hostID
        self.displayName = displayName
        self.generatedAt = generatedAt

        guard toggles.workEnabled else {
            self.capabilities = []
            return
        }
        var granted: [WorkCapability] = []
        if toggles.activeFolderGrants > 0 { granted.append(.localFiles) }
        if toggles.accessibilityPermissionGranted { granted.append(.localApps) }
        if toggles.browserProfileGrants > 0 { granted.append(.localBrowser) }
        // Both permissions, because screen control without Accessibility can see
        // the screen and not touch it, and advertising it would win this Mac a
        // task it can only half do.
        if toggles.screenRecordingPermissionGranted, toggles.accessibilityPermissionGranted {
            granted.append(.localComputerUse)
        }
        if toggles.shellEnabled { granted.append(.localShell) }
        if toggles.webResearchEnabled { granted.append(.webResearch) }
        if toggles.deliverablesAvailable { granted.append(.deliverables) }
        self.capabilities = granted.sorted()
    }

    /// Whether this manifest was written by a build that understands the same
    /// rules.
    ///
    /// Reported rather than thrown on decode. A newer Mac's heartbeat is still
    /// worth reading — the host is online, it has a name, it can be shown — and
    /// refusing to decode it would make that Mac vanish from the person's device
    /// list at the exact moment they went looking for it.
    public var isFromNewerHost: Bool { version > Self.currentVersion }

    public func supports(_ capability: WorkCapability) -> Bool {
        capabilities.contains(capability)
    }

    /// The required capabilities this Mac cannot serve, sorted.
    public func missing(from required: [WorkCapability]) -> [WorkCapability] {
        Set(required).subtracting(capabilities).sorted()
    }
}
