import Foundation
import JunoCodeCore
#if os(macOS)
import ApplicationServices
import CoreGraphics
import Security
#endif

/// What macOS sees of this process when it decides a computer-use grant:
/// where the app runs from, how it is signed, and what the two preflight
/// calls say right now.
///
/// macOS keeps each grant with the code requirement it recorded when the
/// switch was turned on, and answers "no" for a process whose signature does
/// not satisfy it, while System Settings goes on showing the switch on. The
/// requirement printed here is what a fresh grant would record; when it
/// changes between builds (ad-hoc signing, a different certificate), every
/// grant has to be given again.
public struct ComputerUseDiagnostics: Equatable, Sendable {
    public var bundlePath: String
    public var bundleIdentifier: String
    public var version: String
    public var executablePath: String
    public var processID: Int32
    public var macOSVersion: String
    /// `codesign -dr -`'s designated requirement, or why it could not be read.
    public var designatedRequirement: String
    public var teamIdentifier: String?
    public var isAdHocSigned: Bool
    public var accessibilityTrusted: Bool
    public var screenCapturePreflight: Bool

    public init(
        bundlePath: String, bundleIdentifier: String, version: String, executablePath: String,
        processID: Int32, macOSVersion: String, designatedRequirement: String, teamIdentifier: String?,
        isAdHocSigned: Bool, accessibilityTrusted: Bool, screenCapturePreflight: Bool
    ) {
        self.bundlePath = bundlePath
        self.bundleIdentifier = bundleIdentifier
        self.version = version
        self.executablePath = executablePath
        self.processID = processID
        self.macOSVersion = macOSVersion
        self.designatedRequirement = designatedRequirement
        self.teamIdentifier = teamIdentifier
        self.isAdHocSigned = isAdHocSigned
        self.accessibilityTrusted = accessibilityTrusted
        self.screenCapturePreflight = screenCapturePreflight
    }

    /// What to read first, in plain words.
    public var findings: [String] {
        var lines: [String] = []
        if isAdHocSigned {
            lines.append("This build is ad-hoc signed, so macOS records its grants against this exact build and forgets them on the next update.")
        }
        if !accessibilityTrusted {
            lines.append("AXIsProcessTrusted is false. If Alevr shows as on in Settings, the switch belongs to an older signature: remove Alevr with the minus button and add it again.")
        }
        if !screenCapturePreflight {
            lines.append("Screen capture preflight is false. Allow Alevr in \(ComputerUsePermission.screenRecording.settingsPath()); macOS may ask to reopen Alevr.")
        }
        if lines.isEmpty { lines.append("Both grants are in place for this process.") }
        return lines
    }

    /// The text "Copy computer-use diagnostics" puts on the clipboard.
    public var report: String {
        var lines = [
            "Alevr computer-use diagnostics",
            "bundle: \(bundlePath)",
            "identifier: \(bundleIdentifier)",
            "version: \(version)",
            "executable: \(executablePath)",
            "pid: \(processID)",
            "macOS: \(macOSVersion)",
            "designated requirement: \(designatedRequirement)",
            "team: \(teamIdentifier ?? "none")",
            "ad-hoc signed: \(isAdHocSigned ? "yes" : "no")",
            "AXIsProcessTrusted: \(accessibilityTrusted)",
            "CGPreflightScreenCaptureAccess: \(screenCapturePreflight)",
            "",
        ]
        lines += findings
        lines += [
            "",
            "Why macOS said no (run in Terminal):",
            "/usr/bin/log show --last 1h --predicate 'process == \"tccd\" AND eventMessage CONTAINS \"\(bundleIdentifier)\" AND eventMessage CONTAINS \"code requirement\"'",
        ]
        return lines.joined(separator: "\n")
    }

    /// One line for the log.
    public var logLine: String {
        "computer-use: bundle=\(bundlePath) id=\(bundleIdentifier) version=\(version) adhoc=\(isAdHocSigned) AXIsProcessTrusted=\(accessibilityTrusted) CGPreflightScreenCaptureAccess=\(screenCapturePreflight) requirement=\(designatedRequirement)"
    }

    #if os(macOS)
    /// This process, now. Reads only: nothing here prompts.
    public static func collect(bundle: Bundle = .main) -> ComputerUseDiagnostics {
        let info = bundle.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        let signing = signingIdentity()
        return ComputerUseDiagnostics(
            bundlePath: bundle.bundleURL.path,
            bundleIdentifier: bundle.bundleIdentifier ?? "none",
            version: "\(short) (\(build))",
            executablePath: bundle.executableURL?.path ?? ProcessInfo.processInfo.arguments.first ?? "?",
            processID: ProcessInfo.processInfo.processIdentifier,
            macOSVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            designatedRequirement: signing.requirement,
            teamIdentifier: signing.team,
            isAdHocSigned: signing.adHoc,
            accessibilityTrusted: AXIsProcessTrusted(),
            screenCapturePreflight: CGPreflightScreenCaptureAccess()
        )
    }

    private static func signingIdentity() -> (requirement: String, team: String?, adHoc: Bool) {
        var dynamic: SecCode?
        guard SecCodeCopySelf([], &dynamic) == errSecSuccess, let dynamic else {
            return ("unreadable (SecCodeCopySelf failed)", nil, false)
        }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(dynamic, [], &staticCode) == errSecSuccess, let staticCode else {
            return ("unreadable (SecCodeCopyStaticCode failed)", nil, false)
        }
        var requirementText = "none (unsigned)"
        var requirement: SecRequirement?
        if SecCodeCopyDesignatedRequirement(staticCode, [], &requirement) == errSecSuccess, let requirement {
            var text: CFString?
            if SecRequirementCopyString(requirement, [], &text) == errSecSuccess, let text {
                requirementText = text as String
            }
        }
        var information: CFDictionary?
        SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information)
        let dictionary = information as? [String: Any] ?? [:]
        let team = dictionary[kSecCodeInfoTeamIdentifier as String] as? String
        let flags = (dictionary[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
        // kSecCodeSignatureAdhoc: no certificate, so the requirement is the
        // build's own hash and no later build can satisfy it.
        let adHoc = flags & 0x0002 != 0 || requirementText.hasPrefix("cdhash")
        return (requirementText, team, adHoc)
    }
    #endif
}
