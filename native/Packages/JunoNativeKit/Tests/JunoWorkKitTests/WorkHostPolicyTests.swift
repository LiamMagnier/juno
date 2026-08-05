import XCTest
import JunoWorkKit

/// The policy lattice, tested for the one property that matters.
///
/// Every test here is a variation on "narrowing cannot widen". That is the
/// whole security argument for letting five different layers — host, project,
/// session, schedule, skill — each have a say in what a run may do.
final class WorkHostPolicyTests: XCTestCase {
    private var permissive: WorkHostPolicy {
        WorkHostPolicy(
            enabled: true,
            allowsFileWork: true,
            allowsBrowser: true,
            allowsComputerUse: true,
            allowsShell: true,
            allowsBackground: true,
            approvalPolicy: .permissive,
            allowedApps: ["com.apple.Notes", "com.apple.mail"],
            blockedApps: [],
            allowedDomains: ["example.com", ".corp.example"]
        )
    }

    func testNarrowingNeverGrantsWhatNeitherSideAllowed() {
        let a = WorkHostPolicy(enabled: true, allowsFileWork: true)
        let b = WorkHostPolicy(enabled: true, allowsBrowser: true)
        let met = a.narrowed(by: b)

        XCTAssertTrue(met.enabled)
        XCTAssertFalse(met.allowsFileWork, "b did not allow file work")
        XCTAssertFalse(met.allowsBrowser, "a did not allow browser work")
        XCTAssertFalse(met.allowsComputerUse)
        XCTAssertFalse(met.allowsShell)
    }

    func testDisabledOnEitherSideDisablesEverything() {
        let met = permissive.narrowed(by: WorkHostPolicy(enabled: false))
        XCTAssertFalse(met.enabled)
        XCTAssertTrue(
            met.advertisedCapabilities.isEmpty,
            "a disabled host must advertise nothing, whatever its other switches say"
        )
    }

    func testApprovalPolicyTakesTheStricterSide() {
        let strict = WorkHostPolicy(enabled: true, approvalPolicy: .conservative)
        XCTAssertEqual(permissive.narrowed(by: strict).approvalPolicy, .conservative)
        XCTAssertEqual(strict.narrowed(by: permissive).approvalPolicy, .conservative)
    }

    func testAllowlistsIntersectAndBlocklistsUnion() {
        // The asymmetry is the point: an allow needs every layer's agreement,
        // a block survives from any single layer.
        let other = WorkHostPolicy(
            enabled: true,
            allowsComputerUse: true,
            allowedApps: ["com.apple.Notes", "com.apple.Safari"],
            blockedApps: ["com.apple.mail"],
            allowedDomains: ["example.com", "other.test"]
        )
        let met = permissive.narrowed(by: other)

        XCTAssertEqual(met.allowedApps, ["com.apple.Notes"], "only the app both sides allowed survives")
        XCTAssertEqual(met.blockedApps, ["com.apple.mail"], "a block from one side survives the meet")
        XCTAssertEqual(met.allowedDomains, ["example.com"])
    }

    func testABlockBeatsAnAllowForTheSameApp() {
        var policy = permissive
        policy.blockedApps = ["com.apple.Notes"]
        XCTAssertFalse(
            policy.permits(app: "com.apple.Notes"),
            "an app on both lists must be refused; a later widening of the allowlist "
                + "must not be able to re-admit something explicitly refused"
        )
    }

    func testAnUnknownAppIsRefusedRatherThanAllowed() {
        XCTAssertFalse(
            permissive.permits(app: "com.unknown.app"),
            "a bundle identifier nobody has considered is one the user has not thought about"
        )
    }

    func testAnEmptyAllowlistMeansNoneNotAll() {
        let policy = WorkHostPolicy(enabled: true, allowsComputerUse: true, allowedApps: [])
        XCTAssertFalse(policy.permits(app: "com.apple.Notes"))
    }

    func testRestrictedCategoriesAreRefusedEvenWhenExplicitlyAllowed() {
        var policy = permissive
        policy.allowedApps.insert("com.apple.keychainaccess")
        policy.allowedApps.insert("com.bitwarden.desktop")

        XCTAssertFalse(
            policy.permits(app: "com.apple.keychainaccess"),
            "a credential store must not be drivable even when ticked in a settings list"
        )
        XCTAssertFalse(policy.permits(app: "com.bitwarden.desktop"))
    }

    func testComputerUseOffRefusesEveryApp() {
        var policy = permissive
        policy.allowsComputerUse = false
        XCTAssertFalse(policy.permits(app: "com.apple.Notes"))
    }

    // MARK: - Domains

    func testExactDomainMatch() {
        XCTAssertTrue(permissive.permits(domain: "example.com"))
        XCTAssertFalse(permissive.permits(domain: "sub.example.com"), "an exact entry is exact")
    }

    func testLeadingDotMatchesSubdomainsButNotASiblingName() {
        XCTAssertTrue(permissive.permits(domain: "a.corp.example"))
        XCTAssertTrue(permissive.permits(domain: "corp.example"))
        XCTAssertFalse(
            permissive.permits(domain: "notcorp.example"),
            "a plain suffix test would match a different party entirely"
        )
    }

    func testTrailingDotIsNormalisedAway() {
        XCTAssertTrue(
            permissive.permits(domain: "example.com."),
            "evil.com. and evil.com resolve identically; comparing them as plain strings "
                + "admits the first through a list containing the second"
        )
    }

    func testCaseIsNormalised() {
        XCTAssertTrue(permissive.permits(domain: "EXAMPLE.COM"))
    }

    func testBrowserOffRefusesEveryDomain() {
        var policy = permissive
        policy.allowsBrowser = false
        XCTAssertFalse(policy.permits(domain: "example.com"))
    }

    // MARK: - Advertisement

    func testAdvertisedCapabilitiesAreDerivedFromTheSwitches() {
        let policy = WorkHostPolicy(enabled: true, allowsFileWork: true)
        XCTAssertEqual(policy.advertisedCapabilities, ["local_files"])
        XCTAssertTrue(policy.permits(capability: "local_files"))
        XCTAssertFalse(policy.permits(capability: "local_computer_use"))
    }

    func testComputerUseAdvertisesAppControlToo() {
        let policy = WorkHostPolicy(enabled: true, allowsComputerUse: true)
        XCTAssertEqual(Set(policy.advertisedCapabilities), ["local_computer_use", "local_apps"])
    }

    func testNarrowestOfNothingIsDenied() {
        XCTAssertEqual(WorkHostPolicy.narrowest([]), .denied)
        XCTAssertFalse(WorkHostPolicy.denied.enabled)
    }

    func testNarrowestFoldsEveryLayer() {
        let met = WorkHostPolicy.narrowest([
            permissive,
            WorkHostPolicy(enabled: true, allowsFileWork: true, allowsBrowser: true,
                           approvalPolicy: .balanced, allowedDomains: ["example.com"]),
            WorkHostPolicy(enabled: true, allowsFileWork: true,
                           approvalPolicy: .permissive, allowedDomains: ["example.com"]),
        ])
        XCTAssertTrue(met.allowsFileWork)
        XCTAssertFalse(met.allowsBrowser, "the third layer withheld it")
        XCTAssertFalse(met.allowsShell)
        XCTAssertEqual(met.approvalPolicy, .balanced)
    }

    // MARK: - Canonical form

    func testCanonicalFormIsStableAcrossSetOrdering() {
        let one = WorkResolvedPolicy(
            policy: WorkHostPolicy(
                enabled: true, allowedApps: ["b", "a"], allowedDomains: ["z.test", "a.test"]
            ),
            contributingLayers: ["host"]
        )
        let two = WorkResolvedPolicy(
            policy: WorkHostPolicy(
                enabled: true, allowedApps: ["a", "b"], allowedDomains: ["a.test", "z.test"]
            ),
            contributingLayers: ["host"]
        )
        XCTAssertEqual(
            one.canonicalForm, two.canonicalForm,
            "two structurally equal policies must digest identically, or the digest proves nothing"
        )
    }

    func testCanonicalFormChangesWhenThePolicyNarrows() {
        let wide = WorkResolvedPolicy(
            policy: WorkHostPolicy(enabled: true, allowsFileWork: true),
            contributingLayers: ["host"]
        )
        let narrow = WorkResolvedPolicy(
            policy: WorkHostPolicy(enabled: true, allowsFileWork: false),
            contributingLayers: ["host"]
        )
        XCTAssertNotEqual(
            wide.canonicalForm, narrow.canonicalForm,
            "an approval granted under one resolution must not execute after it narrowed"
        )
    }
}

/// The refusal lists, attacked with the one input that used to walk past them.
final class WorkHostPolicyCaseTests: XCTestCase {
    func testABlockedAppIsRefusedWhateverCaseItReportsItselfIn() {
        let policy = WorkHostPolicy(
            enabled: true, allowsComputerUse: true,
            allowedApps: ["com.apple.terminal", "COM.APPLE.Terminal"],
            blockedApps: ["com.apple.terminal"]
        )
        XCTAssertFalse(policy.permits(app: "com.apple.terminal"))
        XCTAssertFalse(
            policy.permits(app: "COM.APPLE.Terminal"),
            "macOS does not guarantee the identifier a process reports matches the case written "
                + "in a settings list, and an exact comparison made the blocklist decorative"
        )
    }

    func testARestrictedCategoryIsRefusedWhateverCaseItReportsItselfIn() {
        let policy = WorkHostPolicy(
            enabled: true, allowsComputerUse: true,
            allowedApps: ["COM.APPLE.KeychainAccess", "Com.Bitwarden.Desktop"]
        )
        XCTAssertFalse(policy.permits(app: "COM.APPLE.KeychainAccess"))
        XCTAssertFalse(policy.permits(app: "Com.Bitwarden.Desktop"))
    }

    func testAnAllowedAppStillMatchesAcrossCase() {
        let policy = WorkHostPolicy(
            enabled: true, allowsComputerUse: true, allowedApps: ["com.apple.Notes"]
        )
        XCTAssertTrue(policy.permits(app: "COM.APPLE.NOTES"), "folding must not break the allow path")
    }

    func testWhitespaceTypedIntoASettingsFieldDoesNotDefeatTheList() {
        let policy = WorkHostPolicy(
            enabled: true, allowsComputerUse: true,
            allowedApps: ["com.apple.Notes"], blockedApps: [" com.apple.Notes "]
        )
        XCTAssertFalse(
            policy.permits(app: "com.apple.Notes"),
            "a trailing space is exactly as invisible as a capital letter"
        )
    }

    func testAnEmptyIdentifierIsRefused() {
        let policy = WorkHostPolicy(enabled: true, allowsComputerUse: true, allowedApps: [""])
        XCTAssertFalse(policy.permits(app: ""))
        XCTAssertFalse(policy.permits(app: "   "))
    }
}
