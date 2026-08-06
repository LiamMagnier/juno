import Foundation
import JunoWorkCore
import JunoWorkRuntime
import XCTest

@testable import JunoWorkAutomation

#if os(macOS)
/// Everything about ``SystemBrowserDriver`` that can be checked without sending
/// a single Apple event.
///
/// Nothing here starts, focuses or drives a real browser, and that is a
/// deliberate limit rather than a gap in the suite: a test that opened somebody's
/// Safari would be a test that types into whatever they had signed into. What is
/// covered is everything the driver decides *before* the event goes out — which
/// browser, whether the policy allows it, what address is built, and how the
/// answers coming back are read — plus every path where it refuses instead of
/// sending anything at all.
final class SystemBrowserDriverTests: XCTestCase {
    private func permissive(
        allowedApps: Set<String> = ["com.apple.Safari", "com.google.Chrome"],
        blockedApps: Set<String> = [],
        allowedDomains: Set<String> = [".example.com"],
        blockedDomains: Set<String> = []
    ) -> AutomationPermission {
        AutomationPermission(
            automationEnabled: true,
            allowsBrowserControl: true,
            allowedApps: allowedApps,
            blockedApps: blockedApps,
            allowedDomains: allowedDomains,
            blockedDomains: blockedDomains
        )
    }

    // MARK: - Choosing a browser

    func testFrontmostKnownBrowserIsTheOneDriven() {
        let choice = SystemBrowserDriver.choose(
            from: ["com.apple.Safari", "com.google.Chrome"],
            frontmost: "com.google.Chrome",
            preferred: nil,
            permission: permissive()
        )
        XCTAssertEqual(try? choice.get(), .chrome)
    }

    /// A browser Juno has not been taught to speak to is refused rather than
    /// tried with Chrome's vocabulary on the grounds that it shares an engine.
    func testAnUnknownBrowserIsRefusedRatherThanGuessedAt() {
        let choice = SystemBrowserDriver.choose(
            from: ["com.brave.Browser", "company.thebrowser.Browser"],
            frontmost: "com.brave.Browser",
            preferred: nil,
            permission: permissive(allowedApps: ["com.brave.Browser"])
        )
        XCTAssertEqual(choice.refusalCode, .driverUnavailable)
    }

    /// Two browsers open and neither in front is genuinely ambiguous. Picking
    /// one would eventually type into the session the person was not looking at.
    func testTwoBrowsersAndNoFocusIsRefusedRatherThanPicked() {
        let choice = SystemBrowserDriver.choose(
            from: ["com.apple.Safari", "com.google.Chrome"],
            frontmost: "com.apple.Finder",
            preferred: nil,
            permission: permissive()
        )
        XCTAssertEqual(choice.refusalCode, .notConsidered)
    }

    func testOneBrowserOpenIsDrivenEvenWhenSomethingElseIsInFront() {
        let choice = SystemBrowserDriver.choose(
            from: ["com.apple.Safari", "com.apple.Finder"],
            frontmost: "com.apple.Finder",
            preferred: nil,
            permission: permissive()
        )
        XCTAssertEqual(try? choice.get(), .safari)
    }

    func testNoBrowserAtAllIsAReasonToFallThroughRatherThanFail() {
        let choice = SystemBrowserDriver.choose(
            from: ["com.apple.Finder"],
            frontmost: "com.apple.Finder",
            preferred: nil,
            permission: permissive()
        )
        XCTAssertEqual(choice.refusalCode, .driverUnavailable)
    }

    func testAPreferredBrowserThatIsNotOpenIsNotSilentlyReplaced() {
        let choice = SystemBrowserDriver.choose(
            from: ["com.apple.Safari"],
            frontmost: "com.apple.Safari",
            preferred: .chrome,
            permission: permissive()
        )
        XCTAssertEqual(choice.refusalCode, .driverUnavailable)
    }

    // MARK: - The lists, and the case they are compared in

    /// The regression commit e0bb1e8 records: the block list once compared
    /// bundle identifiers literally, so an application reporting a different
    /// case walked straight past it and the list refused nothing at all.
    func testTheBlockListRefusesWhateverCaseTheIdentifierArrivesIn() {
        for spelling in ["com.apple.Safari", "COM.APPLE.SAFARI", "com.apple.safari"] {
            let choice = SystemBrowserDriver.choose(
                from: [spelling],
                frontmost: spelling,
                preferred: nil,
                permission: permissive(
                    allowedApps: ["com.apple.Safari"],
                    blockedApps: ["COM.Apple.SAFARI"]
                )
            )
            XCTAssertEqual(choice.refusalCode, .appBlocked, spelling)
        }
    }

    func testTheAllowListMatchesWhateverCaseTheIdentifierArrivesIn() {
        for spelling in ["com.apple.Safari", "COM.APPLE.SAFARI", "com.apple.safari"] {
            let choice = SystemBrowserDriver.choose(
                from: [spelling],
                frontmost: spelling,
                preferred: nil,
                permission: permissive(allowedApps: ["CoM.aPpLe.sAfArI"])
            )
            XCTAssertEqual(try? choice.get(), .safari, spelling)
        }
    }

    /// A browser nobody put on the list is refused, which is the default the
    /// whole permission value is built around.
    func testABrowserNobodyAllowedIsRefused() {
        let choice = SystemBrowserDriver.choose(
            from: ["com.google.Chrome"],
            frontmost: "com.google.Chrome",
            preferred: nil,
            permission: permissive(allowedApps: ["com.apple.Safari"])
        )
        XCTAssertEqual(choice.refusalCode, .notConsidered)
    }

    func testAMasterSwitchThatIsOffRefusesEveryBrowser() {
        let choice = SystemBrowserDriver.choose(
            from: ["com.apple.Safari"],
            frontmost: "com.apple.Safari",
            preferred: nil,
            permission: AutomationPermission(allowedApps: ["com.apple.Safari"])
        )
        XCTAssertEqual(choice.refusalCode, .automationDisabled)
    }

    // MARK: - Consent

    /// macOS refusing to deliver the event is reported as something a person can
    /// act on, not as "the browser did not respond".
    func testADeniedAutomationConsentIsANamedRefusal() async {
        let driver = makeDriver(consent: OSStatus(errAEEventNotPermitted))
        let available = await driver.isAvailable()
        XCTAssertFalse(available)
        await assertRefuses(driver, code: .driverUnavailable, mentioning: "Automation")
    }

    /// macOS not having asked yet is a different sentence with a different fix,
    /// so it is a different message.
    func testConsentNotYetAskedForSaysSoRatherThanClaimingADenial() async {
        let driver = makeDriver(consent: OSStatus(errAEEventWouldRequireUserConsent))
        await assertRefuses(driver, code: .driverUnavailable, mentioning: "not yet asked")
    }

    func testAvailabilityNeedsBothAKnownBrowserAndConsent() async {
        let granted = makeDriver(consent: noErr)
        let availableWithConsent = await granted.isAvailable()
        XCTAssertTrue(availableWithConsent)

        let unknownBrowser = makeDriver(consent: noErr, running: ["com.brave.Browser"])
        let availableWithoutBrowser = await unknownBrowser.isAvailable()
        XCTAssertFalse(availableWithoutBrowser)
    }

    // MARK: - Addresses

    func testAnAddressIsBuiltOnTheHostThatWasAllowed() throws {
        XCTAssertEqual(
            try SystemBrowserDriver.address(host: "Docs.Example.com.", path: "/team?tab=1"),
            "https://docs.example.com/team?tab=1"
        )
        XCTAssertEqual(
            try SystemBrowserDriver.address(host: "example.com", path: ""),
            "https://example.com/"
        )
        XCTAssertEqual(
            try SystemBrowserDriver.address(host: "example.com", path: "team"),
            "https://example.com/team"
        )
    }

    /// The path is concatenated onto the host, so the built address is re-parsed
    /// and its host compared against the one the policy ruled on. These are the
    /// shapes that would otherwise read as an authority.
    func testAPathCannotMoveTheAddressOntoAnotherSite() throws {
        let paths = [
            "@evil.example.net/",
            "//evil.example.net/x",
            "/\\evil.example.net",
            "?next=https://evil.example.net",
        ]
        for path in paths {
            let address = try SystemBrowserDriver.address(host: "example.com", path: path)
            XCTAssertEqual(URLComponents(string: address)?.host, "example.com", path)
        }
    }

    /// A host carrying its own authority — credentials, a port, a path — is
    /// refused rather than trimmed down to whatever part of it parsed.
    func testAHostThatIsNotJustAHostIsRefused() {
        for host in ["user@evil.example.net", "example.com/../evil.example.net", "example.com:8443"] {
            XCTAssertThrowsError(
                try SystemBrowserDriver.address(host: host, path: "/"), host
            ) { error in
                XCTAssertEqual((error as? AutomationRefusal)?.code, .malformedIdentifier, host)
            }
        }
    }

    func testAnEmptyHostIsRefusedRatherThanTurnedIntoARelativeAddress() {
        for host in ["", "   ", "."] {
            XCTAssertThrowsError(try SystemBrowserDriver.address(host: host, path: "/"), host) {
                XCTAssertEqual(($0 as? AutomationRefusal)?.code, .malformedIdentifier, host)
            }
        }
    }

    func testARuleMarkerIsNotAHostToNavigateTo() {
        XCTAssertThrowsError(try SystemBrowserDriver.address(host: ".example.com", path: "/")) {
            XCTAssertEqual(($0 as? AutomationRefusal)?.code, .malformedIdentifier)
        }
    }

    func testNavigationToARefusedDomainNeverReachesTheBrowser() async {
        let driver = makeDriver(consent: noErr)
        do {
            try await driver.navigate(toHost: "evil.test", path: "/")
            XCTFail("navigating to a site nobody allowed should refuse")
        } catch let refusal as AutomationRefusal {
            XCTAssertEqual(refusal.code, .notConsidered)
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testABlockedDomainIsRefusedEvenThoughItIsAlsoAllowed() async {
        let driver = makeDriver(
            consent: noErr,
            permission: permissive(
                allowedDomains: [".example.com"],
                blockedDomains: ["docs.example.com"]
            )
        )
        do {
            try await driver.navigate(toHost: "docs.example.com", path: "/")
            XCTFail("a blocked site should be refused")
        } catch let refusal as AutomationRefusal {
            XCTAssertEqual(refusal.code, .domainBlocked)
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    // MARK: - Reading what comes back

    func testAPageAddressYieldsItsHostNormalised() throws {
        XCTAssertEqual(
            try SystemBrowserDriver.host(ofPageAddress: "https://Docs.Example.com./team"),
            "docs.example.com"
        )
        XCTAssertThrowsError(try SystemBrowserDriver.host(ofPageAddress: "about:blank"))
    }

    func testAnElementIdentifierIsAnIndexAndNothingElse() throws {
        XCTAssertEqual(try SystemBrowserDriver.index(ofElementID: "e12"), 12)
        for bad in ["12", "e", "e-1", "e1.5", "'; drop"] {
            XCTAssertThrowsError(try SystemBrowserDriver.index(ofElementID: bad), bad) {
                XCTAssertEqual(($0 as? AutomationRefusal)?.code, .malformedIdentifier, bad)
            }
        }
    }

    func testAnOutlineCarriesRolesAndLabelsAndNoRectangles() throws {
        let outline = try SystemBrowserDriver.parseOutline(
            """
            {"host":"Docs.Example.com","title":"Team","fields":[
              {"id":"e0","role":"input:password","label":"Password","secure":1,"hint":"current-password"},
              {"id":"e3","role":"button","label":"Send","secure":0,"hint":""}
            ]}
            """
        )
        XCTAssertEqual(outline.host, "docs.example.com")
        XCTAssertEqual(outline.title, "Team")
        XCTAssertEqual(outline.fields.count, 2)
        XCTAssertTrue(outline.fields[0].isSecureTextEntry)
        XCTAssertEqual(outline.fields[0].contentHint, "current-password")
        XCTAssertNil(outline.fields[1].contentHint)
        // A viewport rectangle is not a screen point, and the only consumer of
        // this field paints redactions in screen points.
        XCTAssertTrue(outline.fields.allSatisfy { $0.bounds == nil })
        // Which is enough for the detector to refuse the password box.
        XCTAssertEqual(
            SensitiveSurfaceDetector.classify(fields: outline.fields).map(\.kind), [.password]
        )
    }

    func testAnUnreadableOutlineIsAFailureRatherThanAnEmptyPage() {
        XCTAssertThrowsError(try SystemBrowserDriver.parseOutline("<html>")) {
            XCTAssertEqual(($0 as? AutomationRefusal)?.code, .driverUnavailable)
        }
    }

    /// The snippets answer in one word, and every word except `ok` is a refusal.
    /// An answer nobody recognises counts as a failure rather than as success,
    /// because the alternative reports a click that may never have happened.
    func testEveryAnswerFromThePageExceptOKIsARefusal() throws {
        XCTAssertNoThrow(try SystemBrowserDriver.check("ok", elementID: "e1"))
        let expected: [String: AutomationRefusal.Code] = [
            "missing": .focusMoved,
            "secure": .sensitiveSurface,
            "notafield": .intentNotServed,
            "": .driverUnavailable,
            "undefined": .driverUnavailable,
        ]
        for (answer, code) in expected {
            XCTAssertThrowsError(try SystemBrowserDriver.check(answer, elementID: "e1"), answer) {
                XCTAssertEqual(($0 as? AutomationRefusal)?.code, code, answer)
            }
        }
    }

    // MARK: - Escaping

    /// A page title or a person's typed text containing a quote must not be able
    /// to close the literal it is sitting in and have the rest read as code.
    func testValuesAreEscapedIntoTheirLiterals() {
        XCTAssertEqual(
            SystemBrowserDriver.appleScriptString("say \"hi\" \\ now\n"),
            "\"say \\\"hi\\\" \\\\ now\\n\""
        )
        XCTAssertEqual(SystemBrowserDriver.javaScriptLiteral("a\"b\\c"), "\"a\\\"b\\\\c\"")
        XCTAssertFalse(SystemBrowserDriver.javaScriptLiteral("</script>\n").contains("\n"))
    }

    /// The outline and both actions index into the same selector, so an id from
    /// one names the same node in the others.
    func testEveryScriptAddressesTheSameSelector() {
        let selector = SystemBrowserDriver.javaScriptLiteral(
            SystemBrowserDriver.interactiveSelector
        )
        XCTAssertTrue(SystemBrowserDriver.outlineScript.contains(selector))
        XCTAssertTrue(SystemBrowserDriver.activateScript(index: 4).contains(selector))
        XCTAssertTrue(
            SystemBrowserDriver.enterTextScript(index: 4, text: "hi").contains(selector)
        )
    }

    func testTypedTextIsCarriedAsALiteralRatherThanSplicedIn() {
        let script = SystemBrowserDriver.enterTextScript(index: 0, text: "');alert(1);('")
        XCTAssertTrue(script.contains(SystemBrowserDriver.javaScriptLiteral("');alert(1);('")))
        XCTAssertFalse(script.contains("alert(1);(')"))
    }

    // MARK: - Harness

    private func makeDriver(
        consent: OSStatus,
        permission: AutomationPermission? = nil,
        running: [String] = ["com.apple.Safari"],
        frontmost: String? = "com.apple.Safari"
    ) -> SystemBrowserDriver {
        SystemBrowserDriver(
            permission: permission ?? permissive(),
            consent: { _ in consent },
            runningBundleIdentifiers: { running },
            frontmostBundleIdentifier: { frontmost }
        )
    }

    /// Asserts that a call which would otherwise send an Apple event refuses
    /// before sending one.
    private func assertRefuses(
        _ driver: SystemBrowserDriver,
        code: AutomationRefusal.Code,
        mentioning fragment: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            _ = try await driver.currentHost()
            XCTFail("expected a refusal", file: file, line: line)
        } catch let refusal as AutomationRefusal {
            XCTAssertEqual(refusal.code, code, file: file, line: line)
            XCTAssertTrue(
                refusal.message.localizedCaseInsensitiveContains(fragment),
                "\(refusal.message) does not mention \(fragment)",
                file: file,
                line: line
            )
        } catch {
            XCTFail("unexpected error \(error)", file: file, line: line)
        }
    }
}

extension Result where Failure == AutomationRefusal {
    fileprivate var refusalCode: AutomationRefusal.Code? {
        if case .failure(let refusal) = self { return refusal.code }
        return nil
    }
}
#endif
