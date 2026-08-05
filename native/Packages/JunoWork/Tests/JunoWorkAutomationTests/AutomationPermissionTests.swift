import Foundation
import JunoWorkCore
import JunoWorkRuntime
import XCTest

@testable import JunoWorkAutomation

final class AutomationPermissionTests: XCTestCase {
    // MARK: - The vocabulary the wire shares

    func testTierRawValuesAndOrderMatchTheSharedVocabulary() {
        XCTAssertEqual(
            AutomationTier.allCases.map(\.rawValue),
            ["connector", "structured_file", "browser_dom", "accessibility", "visual", "shell"]
        )
        XCTAssertEqual(AutomationTier.allCases.map(\.rank), [1, 2, 3, 4, 5, 6])
        XCTAssertTrue(AutomationTier.browserDOM < AutomationTier.accessibility)
        XCTAssertTrue(AutomationTier.accessibility < AutomationTier.visual)
    }

    func testIntentRawValuesAreStableIdentifiers() {
        XCTAssertEqual(
            AutomationIntent.allCases.map(\.rawValue).sorted(),
            [
                "activate_control", "capture_screen", "change_account_setting",
                "change_security_setting", "delete_item", "enter_text", "inspect",
                "navigate", "publish", "purchase", "send_message",
            ]
        )
    }

    // MARK: - Intent classification

    /// Everything that cannot be taken back is named from
    /// ``WorkIrreversibleAction`` rather than guessed from a word in the intent.
    func testIrreversibleIntentsMapOntoNamedActions() {
        XCTAssertEqual(
            AutomationIntent.sendMessage.irreversibleAction(inTier: .browserDOM),
            .connectorSendMessage
        )
        XCTAssertEqual(
            AutomationIntent.publish.irreversibleAction(inTier: .visual), .connectorPublish
        )
        XCTAssertEqual(
            AutomationIntent.deleteItem.irreversibleAction(inTier: .accessibility),
            .connectorDelete
        )
        XCTAssertEqual(
            AutomationIntent.changeSecuritySetting.irreversibleAction(inTier: .visual),
            .changeSecuritySetting
        )
    }

    /// A purchase in a browser and a purchase by driving an app are different
    /// rows and the same catastrophe, so the tier decides which is recorded.
    func testPurchaseNamesTheTierItHappenedOn() {
        XCTAssertEqual(
            AutomationIntent.purchase.irreversibleAction(inTier: .browserDOM), .browserPurchase
        )
        XCTAssertEqual(
            AutomationIntent.purchase.irreversibleAction(inTier: .accessibility), .appPurchase
        )
        XCTAssertEqual(
            AutomationIntent.purchase.irreversibleAction(inTier: .visual), .appPurchase
        )
    }

    /// Risk and irreversibility cannot disagree, because one is derived from the
    /// other rather than kept in a second table that drifts.
    func testEveryIrreversibleIntentIsClassifiedIrreversible() {
        for tier in AutomationTier.allCases {
            for intent in AutomationIntent.allCases
            where intent.irreversibleAction(inTier: tier) != nil {
                XCTAssertEqual(
                    intent.risk(inTier: tier), .irreversible,
                    "\(intent.rawValue) on \(tier.rawValue)"
                )
                XCTAssertTrue(intent.requiresApprovalReceipt(inTier: tier))
            }
        }
    }

    func testHarmlessIntentsDoNotDemandAReceipt() {
        let harmless: [AutomationIntent] = [
            .inspect, .captureScreen, .navigate, .enterText, .activateControl,
        ]
        for intent in harmless {
            XCTAssertFalse(intent.requiresApprovalReceipt(inTier: .visual), intent.rawValue)
        }
    }

    // MARK: - The default

    /// A Mac that has never been configured drives nothing. The failure this
    /// prevents is a feature shipping switched on for everybody who never opened
    /// settings.
    func testEverythingIsRefusedByDefault() {
        let permission = AutomationPermission.denied
        for tier in AutomationTier.allCases {
            XCTAssertFalse(permission.permits(tier: tier).isAllowed, tier.rawValue)
        }
        XCTAssertEqual(
            permission.permits(app: "com.example.notes").refusal?.code, .automationDisabled
        )
        XCTAssertEqual(
            permission.permits(domain: "example.com").refusal?.code, .automationDisabled
        )
    }

    func testMasterSwitchBeatsEveryOtherAnswer() {
        let permission = AutomationPermission(
            automationEnabled: false,
            allowsBrowserControl: true,
            allowsAccessibilityControl: true,
            allowsVisualControl: true,
            allowedApps: ["com.example.notes"],
            allowedDomains: ["example.com"]
        )
        XCTAssertEqual(
            permission.permits(app: "com.example.notes").refusal?.code, .automationDisabled
        )
        XCTAssertEqual(
            permission.permits(domain: "example.com").refusal?.code, .automationDisabled
        )
        XCTAssertEqual(permission.permits(tier: .browserDOM).refusal?.code, .automationDisabled)
    }

    /// The three tiers this module does not implement are refused rather than
    /// waved through: this gate does not govern a connector call, and answering
    /// "allowed" for something it cannot see would be answering a question it
    /// was not asked.
    func testTiersThisGateDoesNotGovernAreRefused() {
        let permission = AutomationPermission(
            automationEnabled: true,
            allowsBrowserControl: true,
            allowsAccessibilityControl: true,
            allowsVisualControl: true
        )
        for tier in [AutomationTier.connector, .structuredFile, .shell] {
            XCTAssertEqual(
                permission.permits(tier: tier).refusal?.code, .tierDisabled, tier.rawValue
            )
        }
        for tier in [AutomationTier.browserDOM, .accessibility, .visual] {
            XCTAssertTrue(permission.permits(tier: tier).isAllowed, tier.rawValue)
        }
    }

    // MARK: - Apps

    private func appPermission(
        allowed: Set<String> = [],
        blocked: Set<String> = []
    ) -> AutomationPermission {
        AutomationPermission(
            automationEnabled: true,
            allowsAccessibilityControl: true,
            allowsVisualControl: true,
            allowedApps: allowed,
            blockedApps: blocked
        )
    }

    func testAnAppNobodyConsideredIsRefused() {
        let permission = appPermission(allowed: ["com.example.notes"])
        XCTAssertTrue(permission.permits(app: "com.example.notes").isAllowed)
        XCTAssertEqual(permission.permits(app: "com.other.thing").refusal?.code, .notConsidered)
    }

    func testABlockBeatsAnAllow() {
        let permission = appPermission(
            allowed: ["com.example.notes"],
            blocked: ["com.example.notes"]
        )
        XCTAssertEqual(permission.permits(app: "com.example.notes").refusal?.code, .appBlocked)
    }

    /// macOS treats bundle identifiers case-insensitively. A literal comparison
    /// lets `COM.EXAMPLE.NOTES` walk past a blocklist entry spelled in lower
    /// case, which is why this file case-folds and says so.
    func testIdentifiersAreComparedCaseInsensitively() {
        let permission = appPermission(blocked: ["com.example.notes"])
        XCTAssertEqual(permission.permits(app: "COM.Example.Notes").refusal?.code, .appBlocked)

        let allowing = appPermission(allowed: ["COM.EXAMPLE.NOTES"])
        XCTAssertTrue(allowing.permits(app: "com.example.notes").isAllowed)
    }

    func testAnEmptyIdentifierIsRefusedRatherThanMatchedAgainstAnything() {
        let permission = appPermission(allowed: ["com.example.notes"])
        XCTAssertEqual(permission.permits(app: "   ").refusal?.code, .malformedIdentifier)

        let browsing = AutomationPermission(
            automationEnabled: true,
            allowsBrowserControl: true,
            allowedDomains: ["example.com"]
        )
        XCTAssertEqual(browsing.permits(domain: "").refusal?.code, .malformedIdentifier)
    }

    /// Every restricted category is refused even when explicitly allowed, and
    /// the refusal names the category so the person is told which promise is
    /// being kept.
    func testRestrictedCategoriesAreRefusedEvenWhenExplicitlyAllowed() {
        let everything = Set(AutomationPermission.restrictedApps.keys)
        let permission = appPermission(allowed: everything)
        for (identifier, category) in AutomationPermission.restrictedApps {
            let decision = permission.permits(app: identifier)
            XCTAssertEqual(decision.refusal?.code, .restrictedCategory, identifier)
            XCTAssertEqual(decision.refusal?.category, category, identifier)
        }
    }

    func testEveryRestrictedCategoryIsRepresented() {
        let covered = Set(AutomationPermission.restrictedApps.values)
            .union(AutomationPermission.restrictedDomains.values)
        XCTAssertEqual(covered, Set(AutomationRestrictedCategory.allCases))
    }

    // MARK: - Domains

    private func domainPermission(
        allowed: Set<String> = [],
        blocked: Set<String> = []
    ) -> AutomationPermission {
        AutomationPermission(
            automationEnabled: true,
            allowsBrowserControl: true,
            allowedDomains: allowed,
            blockedDomains: blocked
        )
    }

    /// The leading dot is the whole rule. A plain suffix test matches
    /// `notexample.com` against `example.com`, and buying a domain that ends in
    /// somebody else's is the cheapest attack there is.
    func testALookalikeDomainDoesNotMatchASuffixRule() {
        let permission = domainPermission(allowed: [".example.com"])
        XCTAssertTrue(permission.permits(domain: "example.com").isAllowed)
        XCTAssertTrue(permission.permits(domain: "mail.example.com").isAllowed)
        XCTAssertTrue(permission.permits(domain: "a.b.example.com").isAllowed)
        XCTAssertEqual(permission.permits(domain: "notexample.com").refusal?.code, .notConsidered)
        XCTAssertEqual(
            permission.permits(domain: "example.com.evil.net").refusal?.code, .notConsidered
        )
    }

    func testARuleWithoutALeadingDotIsExactOnly() {
        let permission = domainPermission(allowed: ["example.com"])
        XCTAssertTrue(permission.permits(domain: "example.com").isAllowed)
        XCTAssertEqual(permission.permits(domain: "mail.example.com").refusal?.code, .notConsidered)
    }

    /// `evil.com.` and `evil.com` resolve identically, so a policy comparing
    /// them as plain strings admits the first through a list containing the
    /// second.
    func testTrailingDotsAndCaseAreNormalisedAway() {
        let permission = domainPermission(allowed: ["example.com"])
        XCTAssertTrue(permission.permits(domain: "EXAMPLE.com.").isAllowed)
        XCTAssertTrue(permission.permits(domain: "  example.com  ").isAllowed)

        let blocking = domainPermission(allowed: ["example.com"], blocked: ["EXAMPLE.COM."])
        XCTAssertEqual(blocking.permits(domain: "example.com").refusal?.code, .domainBlocked)
    }

    /// The case the allowlist cannot cover: somebody adds `.google.com` and,
    /// without meaning to, adds Google Pay.
    func testARestrictedSiteUnderAnAllowedParentIsStillRefused() {
        let permission = domainPermission(allowed: [".google.com"])
        XCTAssertTrue(permission.permits(domain: "docs.google.com").isAllowed)
        let decision = permission.permits(domain: "pay.google.com")
        XCTAssertEqual(decision.refusal?.code, .restrictedCategory)
        XCTAssertEqual(decision.refusal?.category, .banking)
    }

    func testRestrictedDomainsCoverTheirSubdomains() {
        let permission = domainPermission(allowed: [".paypal.com", ".ssa.gov"])
        XCTAssertEqual(
            permission.permits(domain: "checkout.paypal.com").refusal?.category, .banking
        )
        XCTAssertEqual(
            permission.permits(domain: "secure.ssa.gov").refusal?.category, .governmentIdentity
        )
    }

    // MARK: - The lattice of layers

    /// Permissions AND, denials OR. A single `union` in the wrong place lets a
    /// skill add a site the person never approved.
    func testNarrowingIntersectsAllowancesAndUnionsDenials() {
        let host = AutomationPermission(
            automationEnabled: true,
            allowsBrowserControl: true,
            allowsVisualControl: true,
            allowedApps: ["com.a", "com.b"],
            blockedApps: ["com.x"],
            allowedDomains: ["a.com", "b.com"],
            blockedDomains: ["x.com"]
        )
        let skill = AutomationPermission(
            automationEnabled: true,
            allowsBrowserControl: true,
            allowsVisualControl: false,
            allowedApps: ["com.b", "com.c"],
            blockedApps: ["com.y"],
            allowedDomains: ["b.com", "c.com"],
            blockedDomains: ["y.com"]
        )
        let result = host.narrowed(by: skill)
        XCTAssertTrue(result.allowsBrowserControl)
        XCTAssertFalse(result.allowsVisualControl)
        XCTAssertEqual(result.allowedApps, ["com.b"])
        XCTAssertEqual(result.blockedApps, ["com.x", "com.y"])
        XCTAssertEqual(result.allowedDomains, ["b.com"])
        XCTAssertEqual(result.blockedDomains, ["x.com", "y.com"])
    }

    func testNarrowingCanOnlyEverRemove() {
        let wide = AutomationPermission(
            automationEnabled: true,
            allowsBrowserControl: true,
            allowsAccessibilityControl: true,
            allowsVisualControl: true,
            allowedApps: ["com.a"],
            allowedDomains: ["a.com"]
        )
        XCTAssertEqual(wide.narrowed(by: .denied), .denied)
        XCTAssertEqual(AutomationPermission.narrowest([]), .denied)
        XCTAssertEqual(AutomationPermission.narrowest([wide, .denied, wide]), .denied)
    }

    // MARK: - The tier ordering

    func testALowerTierIsRefusedWhileAFinerOneCanServeTheIntent() {
        XCTAssertFalse(
            AutomationTierLattice.permits(chosen: .visual, candidates: [.browserDOM, .visual])
        )
        XCTAssertTrue(
            AutomationTierLattice.permits(chosen: .browserDOM, candidates: [.browserDOM, .visual])
        )
        XCTAssertTrue(AutomationTierLattice.permits(chosen: .visual, candidates: [.visual]))
    }

    /// A tier that declared nothing is not a candidate for anything. "Not
    /// considered" reads as no here for the same reason it does for a bundle
    /// identifier.
    func testAnIntentNothingDeclaredIsRefused() {
        XCTAssertFalse(AutomationTierLattice.permits(chosen: .visual, candidates: []))
    }

    // MARK: - Argument parsing

    func testAnUnknownIntentIsRefusedRatherThanRoundedToTheNearestKnownOne() {
        let input: WorkToolValue = ["intent": "click_send", "target": "example.com"]
        guard case .failure(let error) = AutomationRequest.parse(input) else {
            return XCTFail("An unknown intent must not parse.")
        }
        guard case .invalidInput(let message) = error else {
            return XCTFail("Expected invalid input, got \(error).")
        }
        XCTAssertTrue(message.contains("send_message"), message)
    }

    /// The summary is stored with the approval and replayed to a lock screen, so
    /// it carries the length of what is being typed and never the text.
    func testTheApprovalSummaryNeverQuotesWhatIsBeingTyped() {
        let request = AutomationRequest(
            intent: .enterText,
            target: "example.com",
            element: "field-1",
            text: "hunter2-and-a-diary-entry",
            x: nil,
            y: nil
        )
        let summary = request.summary(tier: .browserDOM)
        XCTAssertFalse(summary.contains("hunter2"))
        XCTAssertTrue(summary.contains("25 characters"), summary)
    }

    func testTypingSomethingCredentialShapedIsRefusedBeforeAnybodyIsAsked() {
        let input: WorkToolValue = [
            "intent": "enter_text",
            "target": "example.com",
            "element": "field-1",
            "text": "4111 1111 1111 1111",
        ]
        let refusal = AutomationRequest.precheck(
            input,
            tier: .browserDOM,
            declaredIntents: [.enterText]
        )
        guard case .denied(let reason)? = refusal else {
            return XCTFail("A card number must not reach the approval sheet.")
        }
        XCTAssertTrue(reason.contains("card number"), reason)
    }

    func testAnIntentTheTierNeverDeclaredIsRefusedBeforeAnythingElse() {
        let input: WorkToolValue = [
            "intent": "change_security_setting", "target": "com.example.notes",
        ]
        XCTAssertNotNil(
            AutomationRequest.precheck(input, tier: .visual, declaredIntents: [.captureScreen])
        )
        XCTAssertNil(
            AutomationRequest.precheck(
                input,
                tier: .visual,
                declaredIntents: [.changeSecuritySetting]
            )
        )
    }
}
