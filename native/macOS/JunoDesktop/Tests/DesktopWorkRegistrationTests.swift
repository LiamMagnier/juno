import Foundation
import JunoCore
import JunoWorkKit
import Testing
@testable import JunoDesktop

/// What this Mac tells the relay about itself.
///
/// The regression these pin down is the one that made Juno Work inert on macOS:
/// nothing anywhere posted `/api/work/hosts/register`, so no `WorkHost` row could
/// exist, so no `hostID` could be obtained, so the claim loop had nothing to
/// address and every task dispatched here sat queued. Nothing crashed and
/// nothing logged — the Mac simply never appeared as somewhere work could run.
///
/// The payload is worth pinning field by field. Every key is either a permission
/// somebody is handing out or the identity the relay pairs this Mac by, and a
/// dropped one is a Mac that advertises more than its owner allowed, or less
/// than it can do, with no symptom either way except work going to the wrong
/// place.
struct DesktopWorkRegistrationTests {
    private let identity = WorkHostIdentity(
        deviceID: "device-1", displayName: "Liam's Mac", appVersion: "1.4.0"
    )

    private func body(
        _ policy: WorkHostPolicy,
        counts: WorkHostRunCounts = .none
    ) -> [String: JunoJSONValue] {
        guard case .object(let fields) = NativeWorkClient.hostRegistrationBody(
            identity: identity, policy: policy, counts: counts
        ) else {
            Issue.record("The registration body must be a JSON object.")
            return [:]
        }
        return fields
    }

    @Test func carriesEveryFieldTheRouteReads() {
        let fields = body(
            WorkHostPolicy(
                enabled: true,
                allowsFileWork: true,
                allowsBrowser: false,
                allowsComputerUse: true,
                allowsShell: false,
                allowsBackground: true,
                approvalPolicy: .balanced,
                allowedApps: ["com.apple.Notes"],
                blockedApps: ["com.apple.Terminal"],
                allowedDomains: ["example.com"]
            ),
            counts: WorkHostRunCounts(active: 2, queued: 5)
        )

        // Exactly the keys `hostRegistrationSchema` declares. An extra one is
        // ignored by the route and a missing one silently takes the schema's
        // default, which for every boolean here is `false` — so a typo in a key
        // name reads as the owner having switched that capability off.
        #expect(
            Set(fields.keys) == [
                "deviceId", "displayName", "platform", "appVersion", "protocolVersion",
                "enabled", "allowsFileWork", "allowsBrowser", "allowsComputerUse",
                "allowsShell", "allowsBackground", "approvalPolicy", "capabilities",
                "capabilitiesVersion", "allowedApps", "blockedApps", "allowedDomains",
                "activeRunCount", "queuedRunCount",
            ]
        )

        #expect(fields["deviceId"]?.stringValue == "device-1")
        #expect(fields["displayName"]?.stringValue == "Liam's Mac")
        #expect(fields["appVersion"]?.stringValue == "1.4.0")
        // The route takes a literal, not an open string.
        #expect(fields["platform"]?.stringValue == "macos")
        #expect(fields["approvalPolicy"]?.stringValue == "balanced")
        #expect(fields["enabled"]?.boolValue == true)
        #expect(fields["allowsFileWork"]?.boolValue == true)
        #expect(fields["allowsBrowser"]?.boolValue == false)
        #expect(fields["allowsComputerUse"]?.boolValue == true)
        #expect(fields["allowsShell"]?.boolValue == false)
        #expect(fields["allowsBackground"]?.boolValue == true)
        #expect(fields["activeRunCount"]?.numberValue == 2)
        #expect(fields["queuedRunCount"]?.numberValue == 5)
    }

    /// The relay withholds any command kind whose required version is above what
    /// the host declares. Declaring 1 against a relay at 2 is why `undo`,
    /// `grant_folder` and `revoke_grant` were never delivered to this Mac —
    /// implemented, tested inside the package, and unreachable in the product.
    /// 3 is `steer`, which would go the same way for the same reason.
    @Test func declaresTheRelaysCurrentProtocolVersion() {
        #expect(body(WorkHostPolicy())["protocolVersion"]?.numberValue == 3)
    }

    /// The manifest is derived from the switches, never assembled separately. A
    /// manifest that can disagree with the toggles is a manifest that can lie,
    /// and the relay routes local work by believing it.
    @Test func capabilitiesFollowTheSwitches() {
        let fields = body(
            WorkHostPolicy(
                enabled: true,
                allowsFileWork: true,
                allowsBrowser: true,
                allowsComputerUse: true,
                allowsShell: false
            )
        )
        guard case .array(let capabilities)? = fields["capabilities"] else {
            Issue.record("capabilities must be an array")
            return
        }
        #expect(
            capabilities.compactMap(\.stringValue)
                == ["local_files", "local_computer_use", "local_apps", "local_browser"]
        )
    }

    /// A Mac with Work switched off advertises nothing at all, whatever the
    /// individual switches say. The row still exists and still beats — presence
    /// and capability are different facts — but it offers nothing to route to.
    @Test func aDisabledHostOffersNothing() {
        let fields = body(
            WorkHostPolicy(enabled: false, allowsFileWork: true, allowsShell: true)
        )
        guard case .array(let capabilities)? = fields["capabilities"] else {
            Issue.record("capabilities must be an array")
            return
        }
        #expect(capabilities.isEmpty)
        #expect(fields["enabled"]?.boolValue == false)
    }

    /// Sorted, so two advertisements of the same policy are byte-identical.
    /// `allowedApps` is a `Set`, and an unordered list would make every heartbeat
    /// look like a change to anything downstream that diffs them.
    @Test func policyListsAreSorted() {
        let fields = body(
            WorkHostPolicy(
                enabled: true,
                allowedApps: ["com.zeta.app", "com.alpha.app"],
                blockedApps: ["com.zeta.blocked", "com.alpha.blocked"],
                allowedDomains: ["zeta.example", "alpha.example"]
            )
        )
        func strings(_ key: String) -> [String] {
            guard case .array(let items)? = fields[key] else { return [] }
            return items.compactMap(\.stringValue)
        }
        #expect(strings("allowedApps") == ["com.alpha.app", "com.zeta.app"])
        #expect(strings("blockedApps") == ["com.alpha.blocked", "com.zeta.blocked"])
        #expect(strings("allowedDomains") == ["alpha.example", "zeta.example"])
    }

    /// Negative counts would be refused by the schema's `min(0)` and take the
    /// whole heartbeat with them, so a count that has gone wrong costs a wrong
    /// number rather than this Mac's presence.
    @Test func countsAreClampedToWhatTheSchemaAccepts() {
        let fields = body(
            WorkHostPolicy(enabled: true),
            counts: WorkHostRunCounts(active: -3, queued: -1)
        )
        #expect(fields["activeRunCount"]?.numberValue == 0)
        #expect(fields["queuedRunCount"]?.numberValue == 0)
    }
}

/// What a Mac says it can do once macOS has had its say.
///
/// Both switches could be turned on with no permission held at all, and the
/// advertisement was built from the switches alone — so a Mac with neither TCC
/// grant told the relay it could drive a screen, won the task, and failed on its
/// first click.
@MainActor
struct DesktopWorkPermissionGatingTests {
    private func model(
        _ permissions: DesktopWorkSystemPermissions
    ) -> DesktopWorkHostModel {
        let defaults = UserDefaults(
            suiteName: "juno.work.tests.\(UUID().uuidString)"
        )!
        let model = DesktopWorkHostModel(defaults: defaults)
        model.systemPermissions = { permissions }
        model.allowWorkOnThisMac = true
        model.allowsFileWork = true
        model.allowsBrowser = true
        model.allowsComputerUse = true
        return model
    }

    @Test func withoutPermissionsOnlyFileWorkIsAdvertised() {
        let policy = model(.none).policy
        #expect(policy.allowsFileWork)
        #expect(!policy.allowsBrowser)
        #expect(!policy.allowsComputerUse)
        #expect(policy.advertisedCapabilities == ["local_files"])
    }

    /// Screen Recording without Accessibility can watch a screen it cannot
    /// touch. Advertising computer use on half of it wins this Mac a task it can
    /// only half do.
    @Test func screenControlNeedsBothPermissions() {
        let watching = model(
            DesktopWorkSystemPermissions(accessibility: false, screenRecording: true)
        )
        #expect(!watching.policy.allowsComputerUse)

        let touching = model(
            DesktopWorkSystemPermissions(accessibility: true, screenRecording: false)
        )
        #expect(!touching.policy.allowsComputerUse)
        // Accessibility alone is enough for the browser, which is driven through
        // the same permission an app is.
        #expect(touching.policy.allowsBrowser)
    }

    @Test func withBothPermissionsEverythingSwitchedOnIsAdvertised() {
        let policy = model(
            DesktopWorkSystemPermissions(accessibility: true, screenRecording: true)
        ).policy
        #expect(
            policy.advertisedCapabilities
                == ["local_files", "local_computer_use", "local_apps", "local_browser"]
        )
    }
}
