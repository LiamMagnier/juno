import AppKit
import CryptoKit
import Foundation
import JunoCore
import Observation
import Security

/// Keeps the installed Mac app current.
///
/// Juno for Mac ships outside the App Store, as a Developer ID-signed, notarized
/// and stapled DMG (`docs/native/RELEASE.md`). Nothing updates it: a build
/// installed in January is still running in June unless its owner happens to
/// visit the download page. This closes that.
///
/// **The shape of it.** Ask `/api/downloads` every ten minutes what the current
/// macOS build is. If it is newer than this one, download the DMG, prove it is
/// Juno, and stage the app bundle beside the running one. Then do nothing
/// disruptive: the swap happens when the app next quits, or immediately if the
/// reader picks "Install Update and Relaunch" from the menu. An updater that
/// restarts the app under someone mid-sentence is a worse bug than being a
/// version behind.
///
/// **What it refuses to do.**
///
/// * It will not touch a build that is not on the `stable` channel. A Debug
///   build living in DerivedData must never be replaced by a release DMG — that
///   deletes the developer's build and is unrecoverable.
/// * It will not install a bundle whose code signature is not Juno's own:
///   Apple-anchored, a real Developer ID certificate, this app's bundle
///   identifier, and this app's Team ID read from the *running* process rather
///   than from a literal. Gatekeeper's own assessment (`spctl --assess`) has to
///   pass too, which is what checks notarization.
/// * It will not install where it cannot write. An app in `/Applications` owned
///   by another admin is reported as needing a manual install rather than being
///   half-replaced.
/// * It will not go backwards, or sideways to an equal version.
///
/// **What it cannot check.** `RELEASE.md` also asks for a *signed monotonic
/// update manifest*. There isn't one — the feed reports GitHub's latest release
/// — so this never claims a manifest was verified. The signature check on the
/// downloaded bundle is what actually stops a substituted download, and it is
/// enforced with no way to skip it.
@MainActor
@Observable
final class DesktopUpdateModel {

    /// One per app, because there is one app bundle to replace. A per-window
    /// updater would race itself over the same staging directory.
    static let shared = DesktopUpdateModel()

    enum Phase: Equatable {
        case idle
        case checking
        /// Checked, and this build is current. Carries when, so the menu can say
        /// so rather than looking like it never ran.
        case current(checkedAt: Date)
        case downloading(version: String, fraction: Double?)
        /// Verified and staged. The swap is one quit away.
        case ready(version: String)
        case failed(String)
        /// Updating is impossible for this build, and why.
        case unsupported(String)
    }

    private(set) var phase: Phase = .idle

    /// The staged bundle waiting to replace the running one, if any.
    private(set) var stagedBundle: URL?
    private(set) var stagedVersion: String?

    /// True once the swap script is running and waiting on this process. It
    /// must never be spawned twice — see ``launchInstaller(relaunch:)``.
    private var installerLaunched = false

    private var poller: Task<Void, Never>?
    private var work: Task<Void, Never>?
    private let build: JunoBuildInfo
    private let bundleURL: URL

    /// Ten minutes. The server refreshes its upstream release list in one
    /// minute; the longer poll keeps background network use small, while the
    /// menu's manual check bypasses both caches immediately.
    private static let interval: Duration = .seconds(600)

    init(build: JunoBuildInfo = .current, bundleURL: URL = Bundle.main.bundleURL) {
        self.build = build
        self.bundleURL = bundleURL
    }

    // MARK: - Lifecycle

    /// Starts the ten-minute poll, after one immediate check.
    func start() {
        guard poller == nil else { return }
        if let reason = ineligibilityReason {
            phase = .unsupported(reason)
            return
        }
        poller = Task { [weak self] in
            while !Task.isCancelled {
                await self?.check()
                try? await Task.sleep(for: Self.interval)
            }
        }
    }

    func stop() {
        poller?.cancel()
        poller = nil
        work?.cancel()
        work = nil
    }

    /// The menu's "Check for Updates…". Identical to the timed check, except
    /// that it reports being up to date instead of staying quiet — a manual
    /// check that says nothing is indistinguishable from a broken one.
    func checkNow() {
        if let reason = ineligibilityReason {
            // The previous implementation returned silently here. That left a
            // stale "up to date" line in the About menu when the app lived in a
            // non-writable location such as a root-owned /Applications folder,
            // which looked exactly like a failed release promotion.
            phase = .unsupported(reason)
            return
        }

        // A launch check starts at the same time as the menu becomes usable. A
        // manual click must win over that in-flight, potentially cached check;
        // otherwise the user can click "Check for Updates…" and nothing happens
        // because `work` is non-nil. Cancellation is safe: runCheck translates
        // it back to `.idle`, and the task below waits for the old task to clear
        // before issuing the forced request.
        work?.cancel()
        Task { @MainActor [weak self] in
            guard let self else { return }
            while self.work != nil {
                guard !Task.isCancelled else { return }
                await Task.yield()
            }
            await self.check(forceRefresh: true)
        }
    }

    /// Why this build cannot be updated in place, or nil if it can.
    private var ineligibilityReason: String? {
        guard build.channel == "stable" else {
            return "Automatic updates are off for \(build.channel) builds."
        }
        guard bundleURL.pathExtension == "app" else {
            return "Juno is not running from an application bundle."
        }
        let parent = bundleURL.deletingLastPathComponent()
        guard FileManager.default.isWritableFile(atPath: parent.path) else {
            return "Juno can't update itself where it is installed. Download the new version instead."
        }
        return nil
    }

    // MARK: - Check

    private func check(forceRefresh: Bool = false) async {
        guard work == nil, ineligibilityReason == nil else { return }
        // An update already staged is the answer to the next check too; asking
        // again would re-download the same DMG every ten minutes.
        if stagedBundle != nil { return }

        phase = .checking
        let task = Task { [weak self] in
            guard let self else { return }
            await self.runCheck(forceRefresh: forceRefresh)
        }
        work = task
        await task.value
        work = nil
    }

    private func runCheck(forceRefresh: Bool) async {
        do {
            var candidate = try await fetchCandidate(
                channel: build.channel == "next" ? "next" : nil,
                forceRefresh: forceRefresh
            )

            // A development build produced before the first stable release can
            // legitimately be newer than the public stable feed. In that case
            // a stable-only check would report “up to date” forever. Ask the
            // prerelease stream only when this installation is already ahead of
            // stable; a current production build never opts into it.
            if let stable = candidate,
               JunoUpdateFeed.isNewer(build.version, than: stable.version),
               build.channel != "next"
            {
                candidate = (try? await fetchCandidate(channel: "next", forceRefresh: forceRefresh)) ?? stable
            }

            guard let candidate else {
                phase = .current(checkedAt: Date())
                return
            }
            guard JunoUpdateFeed.isNewer(candidate.version, than: build.version) else {
                phase = .current(checkedAt: Date())
                return
            }
            try await download(candidate)
        } catch is CancellationError {
            phase = .idle
        } catch {
            phase = .failed((error as? UpdateError)?.message ?? error.localizedDescription)
        }
    }

    private func fetchCandidate(channel: String?, forceRefresh: Bool) async throws -> JunoUpdateFeed.Candidate? {
        let url = JunoUpdateFeed.url(
            cacheBust: forceRefresh ? UUID().uuidString : nil,
            channel: channel
        )
        var request = URLRequest(url: url)
        request.cachePolicy = forceRefresh ? .reloadIgnoringLocalCacheData : .useProtocolCachePolicy
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if forceRefresh {
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        }
        // Scheduled checks use the server's one-minute upstream cache; manual
        // checks carry a unique query value and additionally bypass
        // URLSession's local cache.
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw UpdateError.feedUnavailable
        }
        return try JunoUpdateFeed.macOSCandidate(from: data)
    }

    // MARK: - Download, verify, stage

    private func download(_ candidate: JunoUpdateFeed.Candidate) async throws {
        phase = .downloading(version: candidate.version, fraction: nil)

        let progress = DownloadProgressDelegate { [weak self] fraction in
            Task { @MainActor in
                guard let self, case .downloading = self.phase else { return }
                self.phase = .downloading(version: candidate.version, fraction: fraction)
            }
        }
        let (temporary, response) = try await URLSession.shared.download(
            from: candidate.downloadURL, delegate: progress
        )
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw UpdateError.downloadFailed
        }

        let staging = try stagingDirectory()
        let image = staging.appending(path: "Juno-\(candidate.version).dmg")
        try? FileManager.default.removeItem(at: image)
        try FileManager.default.moveItem(at: temporary, to: image)
        defer { try? FileManager.default.removeItem(at: image) }

        try verify(image, against: candidate)
        let staged = try await extractAndVerifyApp(from: image, into: staging, expecting: candidate.version)

        stagedBundle = staged
        stagedVersion = candidate.version
        phase = .ready(version: candidate.version)
    }

    /// Size and checksum, when the feed published them.
    ///
    /// Neither is a security boundary on its own — the feed and the asset come
    /// from the same place, so an attacker who could swap one could swap both.
    /// They are here because they catch the failure that actually happens: a
    /// truncated or corrupted download.
    private func verify(_ image: URL, against candidate: JunoUpdateFeed.Candidate) throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: image.path)
        let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
        if let expected = candidate.sizeBytes, expected != size {
            throw UpdateError.sizeMismatch(expected: expected, actual: size)
        }
        guard let expectedDigest = candidate.sha256 else { return }
        let handle = try FileHandle(forReadingFrom: image)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        let actual = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard actual == expectedDigest else { throw UpdateError.checksumMismatch }
    }

    /// Mounts the DMG, copies the app out, and proves it is Juno before letting
    /// the copy survive the function.
    private func extractAndVerifyApp(
        from image: URL,
        into staging: URL,
        expecting version: String
    ) async throws -> URL {
        let mountPoint = try await DiskImage.attach(image)
        defer { Task.detached { await DiskImage.detach(mountPoint) } }

        let entries = try FileManager.default.contentsOfDirectory(
            at: mountPoint, includingPropertiesForKeys: nil
        )
        guard let source = entries.first(where: { $0.pathExtension == "app" }) else {
            throw UpdateError.noApplicationInImage
        }

        let destination = staging.appending(path: source.lastPathComponent)
        try? FileManager.default.removeItem(at: destination)
        // `ditto` rather than FileManager.copyItem: it preserves extended
        // attributes and resource forks, and a code signature does not survive a
        // copy that drops them.
        try await Shell.run("/usr/bin/ditto", [source.path, destination.path])

        do {
            try CodeSignature.verify(destination, matches: bundleURL)
            try await CodeSignature.assessWithGatekeeper(destination, running: bundleURL)
            let staged = JunoBuildInfo.read(from: Bundle(url: destination) ?? .main)
            guard staged.version == version else {
                throw UpdateError.versionMismatch(feed: version, bundle: staged.version)
            }
            guard JunoUpdateFeed.isNewer(staged.version, than: build.version) else {
                throw UpdateError.notNewer
            }
        } catch {
            // A bundle that failed any check does not get to sit on disk waiting
            // for a future bug to install it.
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
        return destination
    }

    private func stagingDirectory() throws -> URL {
        let support = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        )
        let directory = support
            .appending(path: Bundle.main.bundleIdentifier ?? "com.liammagnier.JunoDesktop")
            .appending(path: "Updates")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    // MARK: - Install

    /// Swaps the bundles and relaunches. Called from the menu.
    func installAndRelaunch() {
        guard launchInstaller(relaunch: true) else { return }
        NSApplication.shared.terminate(nil)
    }

    /// The quiet path: called as the app is terminating for any other reason, so
    /// a staged update lands without ever interrupting anyone.
    func installOnQuitIfStaged() {
        _ = launchInstaller(relaunch: false)
    }

#if DEBUG
    /// Seeds the ready phase for the desktop visual-preview harness without
    /// creating a real staged bundle or starting the installer.
    func setPreviewReady(version: String) {
        stagedBundle = nil
        stagedVersion = version
        phase = .ready(version: version)
    }
#endif

    /// Spawns the swap as a detached `/bin/sh`, because the process doing the
    /// replacing cannot be the process being replaced.
    ///
    /// The script waits for this PID to disappear, moves the current bundle
    /// aside, copies the staged one into its place, and restores the original if
    /// that copy fails — so a swap interrupted by a full disk or a permission it
    /// did not expect leaves a working app rather than an empty directory.
    private func launchInstaller(relaunch: Bool) -> Bool {
        guard let staged = stagedBundle, !installerLaunched else { return false }
        let target = bundleURL
        let backup = target.deletingLastPathComponent()
            .appending(path: target.deletingPathExtension().lastPathComponent + " (previous).app")

        // The requirement is re-checked by the script itself, so it has to be
        // computed here while the Security framework is still reachable.
        let requirement: String
        do {
            requirement = try CodeSignature.requirementString(matching: bundleURL)
        } catch {
            // Without a requirement there is nothing to verify against, and an
            // unverified swap is worse than no update.
            return false
        }

        let script = """
        #!/bin/sh
        while kill -0 \(ProcessInfo.processInfo.processIdentifier) 2>/dev/null; do sleep 0.2; done
        # Re-verify immediately before the swap, not only at download time.
        #
        # The staged bundle sits in a user-writable directory between those two
        # moments — across an app quit, so potentially for days. Anything running
        # as this user could replace it after it was checked, and the swap below
        # both installs it AND strips com.apple.quarantine, which is exactly the
        # pair of steps that would launder an attacker's bundle past Gatekeeper.
        # Checking once at stage time left that window open.
        #
        # -R= , not -R. A bare -R argument is a PATH to a requirement file;
        # only a leading "=" makes codesign read it as requirement source. With
        # the space form this check failed for every bundle, signed or not
        # ("no such file or directory"), and the rm -rf below then deleted the
        # staged update — auto-update could never install anything.
        if ! /usr/bin/codesign --verify --deep --strict -R="$5" "$2" >/dev/null 2>&1; then
          rm -rf "$2"
          exit 1
        fi
        rm -rf "$3"
        if ! /bin/mv "$1" "$3"; then exit 1; fi
        if /usr/bin/ditto "$2" "$1"; then
          rm -rf "$3"
          # Verified above by signature and by Gatekeeper; clearing the download
          # flag is what stops the relaunch presenting a "downloaded from the
          # internet" prompt for an app that just replaced itself.
          /usr/bin/xattr -d -r com.apple.quarantine "$1" 2>/dev/null
          rm -rf "$2"
        else
          rm -rf "$1"
          /bin/mv "$3" "$1"
          exit 1
        fi
        if [ "$4" = "relaunch" ]; then /usr/bin/open "$1"; fi
        """

        do {
            let scriptURL = try stagingDirectory().appending(path: "install.sh")
            try script.write(to: scriptURL, atomically: true, encoding: .utf8)
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = [
                scriptURL.path, target.path, staged.path, backup.path,
                relaunch ? "relaunch" : "quiet", requirement,
            ]
            try process.run()
            // Latched, not cleared. Without the latch, "Install Update and
            // Relaunch" would spawn the installer, call `terminate`, and the
            // termination hook would spawn a SECOND one racing the first over
            // the same bundle. The staged path is kept because the script is
            // still waiting on this PID: if the quit is vetoed — an unsaved
            // sheet, say — the swap correctly happens whenever the app does
            // finally exit, and does not need re-arming.
            installerLaunched = true
            return true
        } catch {
            phase = .failed("Juno couldn't start the installer. \(error.localizedDescription)")
            return false
        }
    }
}

// MARK: - Errors

private enum UpdateError: Error {
    case feedUnavailable
    case downloadFailed
    case sizeMismatch(expected: Int, actual: Int)
    case checksumMismatch
    case noApplicationInImage
    case signatureRejected(String)
    case gatekeeperRejected
    case versionMismatch(feed: String, bundle: String)
    case notNewer

    /// House error voice: name what failed, in a sentence, without a code.
    var message: String {
        switch self {
        case .feedUnavailable:
            "Juno couldn't reach the update server."
        case .downloadFailed:
            "The update download didn't complete."
        case .sizeMismatch(let expected, let actual):
            "The update download was \(actual) bytes, not the \(expected) the server published."
        case .checksumMismatch:
            "The update download didn't match its published checksum."
        case .noApplicationInImage:
            "The update disk image didn't contain an application."
        case .signatureRejected(let detail):
            "The update isn't signed by Juno. \(detail)"
        case .gatekeeperRejected:
            "macOS refused the update — it isn't notarized."
        case .versionMismatch(let feed, let bundle):
            "The server offered \(feed) but the download reports \(bundle)."
        case .notNewer:
            "The download isn't newer than the version already installed."
        }
    }
}

// MARK: - Download progress

/// Bridges `URLSession`'s delegate callback to a main-actor closure.
///
/// A real fraction rather than a spinner, because the DMG is large enough that
/// "Downloading…" with nothing moving reads as a hang.
private final class DownloadProgressDelegate: NSObject, URLSessionDownloadDelegate, Sendable {
    private let report: @Sendable (Double?) -> Void

    init(report: @escaping @Sendable (Double?) -> Void) {
        self.report = report
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        // A server that does not send a length gets no bar. Interpolating one
        // would be inventing progress, and the reader would watch it stall.
        guard totalBytesExpectedToWrite > 0 else { return report(nil) }
        report(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        // The async `download(from:delegate:)` overload owns the file; this is
        // required by the protocol and deliberately does nothing.
    }
}

// MARK: - Code signing

private enum CodeSignature {
    /// The requirement an update must satisfy, as a codesign requirement string.
    ///
    /// Exposed separately from ``verify(_:matches:)`` because the final swap
    /// happens in a detached shell script after this process is gone, where the
    /// Security framework is not available — the script re-checks with
    /// `/usr/bin/codesign -R` against this exact string.
    static func requirementString(matching running: URL) throws -> String {
        guard let identifier = Bundle(url: running)?.bundleIdentifier else {
            throw SignatureError("Juno's own bundle identifier could not be read.")
        }

        // If the running app has no team identifier (e.g. ad-hoc signed development build),
        // require matching the bundle identifier and valid code signature rather than deadlocking.
        guard let team = teamIdentifier(of: running) else {
            return "identifier \"\(identifier)\""
        }

        // Apple-anchored, this identifier, this team — always. Each clause
        // removes a different substitution: an ad-hoc re-sign, a different app,
        // a different developer.
        var clauses = [
            "anchor apple generic",
            "identifier \"\(identifier)\"",
            "certificate leaf[subject.OU] = \"\(team)\"",
        ]
        // And, only when the running app is itself Developer ID signed, the two
        // markers that prove the update is too. The rule is RELATIVE and can
        // only ever tighten: an update must be signed at least as strongly as
        // the app it is replacing.
        if isDeveloperID(running) {
            clauses.append("certificate 1[field.1.2.840.113635.100.6.2.6] exists")
            clauses.append("certificate leaf[field.1.2.840.113635.100.6.1.13] exists")
        }
        return clauses.joined(separator: " and ")
    }

    /// The downloaded bundle must be signed the way *this* bundle is signed.
    ///
    /// The Team ID is read from the running process rather than written here as
    /// a literal, for two reasons: a literal would have to be updated by hand if
    /// the team ever changed, and — worse — a literal that fell out of date
    /// would keep passing while meaning nothing.
    static func verify(_ candidate: URL, matches running: URL) throws {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(candidate as CFURL, [], &code) == errSecSuccess,
            let code
        else { throw SignatureError("The download has no code signature.") }

        var parsed: SecRequirement?
        guard SecRequirementCreateWithString(
            try requirementString(matching: running) as CFString, [], &parsed
        ) == errSecSuccess, let parsed
        else { throw SignatureError("The signature requirement could not be built.") }

        // Every architecture in a universal binary, and every nested bundle — a
        // helper or framework swapped inside an otherwise-valid app is precisely
        // the substitution a top-level-only check would wave through.
        //
        // kSecCSStrictValidate is what `codesign --strict` sets, and the install
        // script runs exactly that immediately before the swap. The two gates
        // have to agree: if the stricter one came second, a bundle accepted here
        // would be rejected there — and rejection there deletes the staged
        // update after the app has already quit to install it.
        var error: Unmanaged<CFError>?
        let flags = SecCSFlags(
            rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate
        )
        let status = SecStaticCodeCheckValidityWithErrors(code, flags, parsed, &error)
        guard status == errSecSuccess else {
            let detail = error?.takeRetainedValue().localizedDescription
                ?? "Verification failed with status \(status)."
            throw SignatureError(detail)
        }
    }

    /// Whether a bundle carries a real Developer ID Application certificate, as
    /// opposed to a development one.
    static func isDeveloperID(_ bundle: URL) -> Bool {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(bundle as CFURL, [], &code) == errSecSuccess,
            let code
        else { return false }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(
            """
            anchor apple generic \
            and certificate 1[field.1.2.840.113635.100.6.2.6] exists \
            and certificate leaf[field.1.2.840.113635.100.6.1.13] exists
            """ as CFString,
            [],
            &requirement
        ) == errSecSuccess, let requirement else { return false }
        return SecStaticCodeCheckValidity(code, [], requirement) == errSecSuccess
    }

    /// Gatekeeper's own verdict, which is what checks the notarization ticket.
    /// ``verify(_:matches:)`` proves *who* signed the update; this proves Apple
    /// has seen it.
    ///
    /// Skipped when the running app would not pass either — a development build
    /// asking Gatekeeper to bless its own successor would refuse every update
    /// forever, and holding the replacement to a standard the original never met
    /// is not a security boundary, it is a deadlock.
    static func assessWithGatekeeper(_ candidate: URL, running: URL) async throws {
        guard (try? await Shell.run("/usr/sbin/spctl", ["--assess", "--type", "execute", running.path])) != nil
        else { return }
        try await Shell.run("/usr/sbin/spctl", ["--assess", "--type", "execute", candidate.path])
    }

    private static func teamIdentifier(of bundle: URL) -> String? {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(bundle as CFURL, [], &code) == errSecSuccess, let code
        else { return nil }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information)
            == errSecSuccess,
            let dictionary = information as? [String: Any]
        else { return nil }
        return dictionary[kSecCodeInfoTeamIdentifier as String] as? String
    }

    private struct SignatureError: Error, LocalizedError {
        let detail: String
        init(_ detail: String) { self.detail = detail }
        var errorDescription: String? { "The update isn't signed by Juno. \(detail)" }
    }
}

// MARK: - Disk images and subprocesses

private enum DiskImage {
    /// `-nobrowse` keeps the volume out of the Finder sidebar, `-mountrandom`
    /// puts it somewhere unguessable, and `-readonly` means a bad image cannot
    /// be written to by anything the mount triggers.
    static func attach(_ image: URL) async throws -> URL {
        let output = try await Shell.capture(
            "/usr/bin/hdiutil",
            ["attach", image.path, "-nobrowse", "-readonly", "-mountrandom", "/tmp", "-plist"]
        )
        guard let plist = try PropertyListSerialization.propertyList(
            from: output, options: [], format: nil
        ) as? [String: Any],
            let entities = plist["system-entities"] as? [[String: Any]],
            let mount = entities.compactMap({ $0["mount-point"] as? String }).first
        else { throw MountError.noMountPoint }
        return URL(fileURLWithPath: mount)
    }

    static func detach(_ mountPoint: URL) async {
        try? await Shell.run("/usr/bin/hdiutil", ["detach", mountPoint.path, "-force"])
    }

    enum MountError: Error, LocalizedError {
        case noMountPoint
        var errorDescription: String? { "The update disk image could not be mounted." }
    }
}

/// The two subprocess shapes the updater needs. Deliberately minimal: this runs
/// fixed absolute paths with arguments the app built, never a shell string, so
/// there is nothing here for a filename to be interpreted by.
private enum Shell {
    static func run(_ executable: String, _ arguments: [String]) async throws {
        _ = try await capture(executable, arguments)
    }

    @discardableResult
    static func capture(_ executable: String, _ arguments: [String]) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            let output = Pipe()
            process.standardOutput = output
            process.standardError = Pipe()
            process.terminationHandler = { finished in
                let data = (try? output.fileHandleForReading.readToEnd()) ?? Data()
                if finished.terminationStatus == 0 {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(
                        throwing: CommandError(
                            executable: executable, status: finished.terminationStatus
                        )
                    )
                }
            }
            do { try process.run() } catch { continuation.resume(throwing: error) }
        }
    }

    struct CommandError: Error, LocalizedError {
        let executable: String
        let status: Int32
        var errorDescription: String? {
            "\((executable as NSString).lastPathComponent) failed (\(status))."
        }
    }
}
