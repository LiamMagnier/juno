import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// The words and the diagnostics for a computer-use grant macOS refused.
///
/// The case they exist for (Mac 1.10.9): Alevr showed as on in Device
/// Control and Data Access while `AXIsProcessTrusted()` said no, because
/// tccd held the Accessibility grant against an earlier ad-hoc build's
/// `cdhash` requirement. Flipping the switch does not rewrite that; removing
/// Alevr and adding it again does.
final class ComputerUseDiagnosticsTests: XCTestCase {
    // MARK: Settings pages

    func testEachGrantIsNamedByThePageThisMacOSShows() {
        XCTAssertEqual(ComputerUsePermission.accessibility.settingsPageName(macOSMajor: 26), "Accessibility")
        XCTAssertEqual(ComputerUsePermission.accessibility.settingsPageName(macOSMajor: 27), "Device Control and Data Access")
        XCTAssertEqual(ComputerUsePermission.screenRecording.settingsPageName(macOSMajor: 14), "Screen Recording")
        XCTAssertEqual(ComputerUsePermission.screenRecording.settingsPageName(macOSMajor: 26), "Screen & System Audio Recording")
        XCTAssertEqual(
            ComputerUsePermission.accessibility.settingsPath(macOSMajor: 27),
            "System Settings › Privacy & Security › Device Control and Data Access"
        )
    }

    func testAccessibilityAdviceNamesThePageAndTheStaleSwitchFix() {
        let status = ComputerUsePermissionStatus(screenRecording: .granted, accessibility: .denied)
        let advice = status.advice(macOSMajor: 27)
        XCTAssertTrue(advice.hasPrefix("Alevr needs Accessibility to use apps. Open System Settings › Privacy & Security › Device Control and Data Access and turn Alevr on."), advice)
        XCTAssertTrue(advice.contains(ComputerUsePermissionStatus.staleGrantSteps))
        XCTAssertTrue(advice.contains("no need to reopen"))
        XCTAssertFalse(advice.contains("—"), "no em-dashes in UI copy")
    }

    func testBothMissingNamesBothPagesInOrder() {
        let status = ComputerUsePermissionStatus(screenRecording: .denied, accessibility: .denied)
        let advice = status.advice(macOSMajor: 26)
        XCTAssertTrue(advice.contains("Screen Recording and Accessibility"))
        XCTAssertTrue(advice.contains("Open System Settings › Privacy & Security › Screen & System Audio Recording"))
        XCTAssertTrue(advice.contains("Then do the same in System Settings › Privacy & Security › Accessibility."))
        XCTAssertTrue(advice.contains("quit and reopen"), "Screen Recording can need a relaunch")
    }

    func testNothingMissingSaysNothing() {
        XCTAssertEqual(ComputerUsePermissionStatus(screenRecording: .granted, accessibility: .granted).advice(), "")
    }

    // MARK: Diagnostics

    private func sample(adHoc: Bool, trusted: Bool, capture: Bool) -> ComputerUseDiagnostics {
        ComputerUseDiagnostics(
            bundlePath: "/Applications/Alevr.app",
            bundleIdentifier: "com.liammagnier.JunoDesktop",
            version: "1.10.9 (104)",
            executablePath: "/Applications/Alevr.app/Contents/MacOS/Alevr",
            processID: 3743,
            macOSVersion: "Version 27.2",
            designatedRequirement: adHoc
                ? "cdhash H\"fdc8f8c02f2ca144a592e5d041620690ecbad27b\""
                : "identifier \"com.liammagnier.JunoDesktop\" and anchor apple generic",
            teamIdentifier: adHoc ? nil : "58PVP763WX",
            isAdHocSigned: adHoc,
            accessibilityTrusted: trusted,
            screenCapturePreflight: capture
        )
    }

    func testTheReportCarriesWhatTellsAStaleGrantFromAMissingOne() {
        let report = sample(adHoc: false, trusted: false, capture: true).report
        for expected in [
            "bundle: /Applications/Alevr.app",
            "identifier: com.liammagnier.JunoDesktop",
            "version: 1.10.9 (104)",
            "designated requirement: identifier \"com.liammagnier.JunoDesktop\"",
            "team: 58PVP763WX",
            "ad-hoc signed: no",
            "AXIsProcessTrusted: false",
            "CGPreflightScreenCaptureAccess: true",
            "remove Alevr with the minus button",
            "eventMessage CONTAINS \"code requirement\"",
        ] {
            XCTAssertTrue(report.contains(expected), "missing \(expected) in\n\(report)")
        }
    }

    func testFindingsCallOutAdHocSigningAndEachRefusal() {
        let adHoc = sample(adHoc: true, trusted: false, capture: false).findings
        XCTAssertEqual(adHoc.count, 3)
        XCTAssertTrue(adHoc[0].contains("ad-hoc"))
        XCTAssertEqual(sample(adHoc: false, trusted: true, capture: true).findings, ["Both grants are in place for this process."])
        XCTAssertTrue(sample(adHoc: false, trusted: true, capture: true).logLine.contains("AXIsProcessTrusted=true"))
    }

    func testCollectReadsThisProcessWithoutPrompting() {
        let live = ComputerUseDiagnostics.collect()
        XCTAssertEqual(live.processID, ProcessInfo.processInfo.processIdentifier)
        XCTAssertFalse(live.bundlePath.isEmpty)
        XCTAssertFalse(live.designatedRequirement.isEmpty)
        XCTAssertTrue(live.report.contains("AXIsProcessTrusted: \(live.accessibilityTrusted)"))
    }
}
