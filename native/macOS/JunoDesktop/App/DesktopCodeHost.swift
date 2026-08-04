import Foundation
import JunoAuth
import JunoCodeCore
import JunoCore
import JunoCodeKit
import JunoCodeUI
import JunoSync
import Observation

/// Announces this Mac to Juno Code as a computer that is signed in — and keeps
/// announcing it, because being listed is a heartbeat and not an event.
///
/// Until this existed, no Swift code anywhere registered the Mac. `GET
/// /api/code/devices` returned an empty list, so the iPhone said "No computers
/// signed in" while JunoDesktop sat open and signed in beside it. The row is
/// created by `POST /api/code/devices`, which writes `lastSeenAt` on every post,
/// and the list route calls a device online only while that timestamp is inside
/// a two-minute window (`ONLINE_WINDOW_MS`, `src/lib/code-remote.ts`). A single
/// registration at launch therefore buys two minutes of visibility and then
/// silently expires — which is why this beats every sixty seconds rather than
/// registering once. The Windows client
/// (`juno-windows/src/lib/code/remoteHost.ts`) is the working reference and uses
/// the same interval and the same persisted-id key.
///
/// **This registers presence, not capability, and the difference is
/// load-bearing.** A task the phone dispatches at this Mac is written to the
/// queue and stays `queued`: nothing here claims it, and nothing here runs it.
/// ``CodeRemoteHost`` is the loop that would, and it is deliberately not wired
/// up — a Mac that silently began executing instructions sent from elsewhere the
/// moment someone signed in would be a genuinely dangerous default, so serving
/// remote work is a separate change that needs its own explicit switch.
/// ``servesQueuedTasks`` exists so a settings row can say that out loud, rather
/// than leaving the reader to infer it from a task that never starts.
@MainActor
@Observable
final class DesktopCodeHostModel {
    enum Phase: Equatable, Sendable {
        case idle
        /// The first registration of this sign-in has not landed yet.
        case registering
        /// The server has this Mac, and will keep calling it online for as long
        /// as the beats keep arriving.
        case listed
        /// The last registration was refused or could not be sent. The beat
        /// continues; ``lastError`` says what happened.
        case failed
    }

    private(set) var phase: Phase = .idle
    /// The server's own id for this Mac's row, once it has one.
    private(set) var deviceID: String?
    /// When the last registration succeeded. A settings row showing "last seen"
    /// needs this to distinguish "listed" from "listed an hour ago".
    private(set) var lastRegisteredAt: Date?
    private(set) var lastError: String?

    /// The folders this Mac tells the account it can work in.
    ///
    /// Kept in sync by the root view rather than snapshotted at start, because
    /// the workbench loads its grants asynchronously well after sign-in: a copy
    /// taken when the beat starts is always empty, and an empty list is what
    /// makes the phone show this Mac with nothing to run in.
    private(set) var workspaces: [NativeCodeDevice.Workspace] = []

    /// Whether a task dispatched at this Mac would actually be picked up. It
    /// would not — see the note at the top of this file. Stated as a value so
    /// the surface that eventually shows hosting can read the truth from the
    /// model instead of hard-coding a sentence that will rot when this changes.
    /// Whether this Mac will claim and execute queued remote work.
    ///
    /// Off by default and only ever changed by the person at the machine. A Mac
    /// that began accepting instructions from elsewhere the moment someone
    /// signed in would be a genuinely dangerous default — signing in is not
    /// consent to hand a phone the shell.
    ///
    /// Persisted, because the switch is a standing decision about this machine
    /// rather than a per-launch one, and it is read back on the next launch.
    var servesQueuedTasks: Bool {
        get { defaults.bool(forKey: Self.servesQueuedTasksKey) }
        set {
            defaults.set(newValue, forKey: Self.servesQueuedTasksKey)
            // Re-register immediately rather than waiting for the next
            // heartbeat: until the relay knows, the phone still shows this Mac
            // as unavailable (or, worse, as available after it was switched
            // off) for up to a minute.
            Task { await self.register() }
        }
    }

    static let servesQueuedTasksKey = "juno.code.remote.servesQueuedTasks"

    /// The immediate kill switch. Stops serving and tells the relay in one step,
    /// so "off" means off now rather than off at the next heartbeat.
    func stopServingRemoteWork() {
        servesQueuedTasks = false
    }

    /// Matches the Windows client's `DEVICE_ID_KEY` so the two hosts describe
    /// the same idea with the same name.
    private static let deviceIDKey = "juno.code.deviceId"
    private static let heartbeatInterval = Duration.seconds(60)

    private let client: NativeCodeTaskClient
    private let defaults: UserDefaults
    /// Resolved once rather than per beat: `Host.current()` consults the system
    /// configuration store, and the beat runs on the main actor. A Mac renamed
    /// while Juno is open therefore keeps its old label until the next launch —
    /// at which point the replayed device id updates the existing row instead of
    /// stranding the old name as a second, permanently offline computer.
    private let deviceName: String
    private let appVersion: String

    private var accountID: AccountID?
    private var beat: Task<Void, Never>?
    private var isRegistering = false
    /// Set when a workspace change arrives while a registration is in flight, so
    /// the change is folded into the next post instead of being dropped and
    /// waiting a full minute for the following beat.
    private var needsAnotherRegistration = false

    init(client: NativeCodeTaskClient, defaults: UserDefaults = .standard) {
        self.client = client
        self.defaults = defaults
        // Read exactly as `JunoDesktopConfiguration` reads them, so the computer
        // named in the phone's picker is the computer named everywhere else.
        deviceName = Host.current().localizedName ?? "Mac"
        appVersion = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String ?? "0.1.0"
    }

    /// Registers immediately, then once a minute until ``stop()``.
    func start(for accountID: AccountID) {
        guard self.accountID != accountID else { return }
        stop()
        self.accountID = accountID
        // Replayed on every post from here on. Without it the route falls back
        // to matching on `(user, name)`, so a rename would leave the old row
        // behind as a computer that is listed, never beats again, and can never
        // be selected.
        deviceID = defaults.string(forKey: Self.deviceIDKey)
        phase = .registering
        beat = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await register()
                guard !Task.isCancelled else { return }
                try? await Task.sleep(for: Self.heartbeatInterval)
            }
        }
    }

    /// Stops beating. There is no route that retires a device, and there does
    /// not need to be: the row simply stops being refreshed, and the list calls
    /// it offline two minutes later. The persisted id deliberately survives, so
    /// signing back in updates this Mac's own row rather than creating another.
    func stop() {
        beat?.cancel()
        beat = nil
        accountID = nil
        deviceID = nil
        workspaces = []
        lastRegisteredAt = nil
        lastError = nil
        isRegistering = false
        needsAnotherRegistration = false
        phase = .idle
    }

    /// Adopts the workbench's granted folders as the set this Mac advertises.
    ///
    /// A change registers straight away instead of waiting for the next beat.
    /// The workbench's `bootstrap()` loads its grants after the view exists, so
    /// the first beat of a sign-in almost always carries none; a minute of the
    /// phone listing this Mac with nothing to run in reads as the Mac being
    /// useless rather than as the app being early.
    func setWorkspaces(from records: [WorkspaceRecord]) {
        let advertisable = records.compactMap(Self.advertisable)
        guard advertisable != workspaces else { return }
        workspaces = advertisable
        guard accountID != nil else { return }
        Task { await register() }
    }

    // MARK: Internals

    private func register() async {
        guard let accountID else { return }
        guard !isRegistering else {
            needsAnotherRegistration = true
            return
        }
        isRegistering = true
        defer { isRegistering = false }
        repeat {
            needsAnotherRegistration = false
            do {
                let id = try await client.registerDevice(
                    deviceID: deviceID,
                    name: deviceName,
                    platform: "macos",
                    appVersion: appVersion,
                    // Zero and zero, not the local session counts: these describe
                    // the *remote* work this host is carrying, and it carries
                    // none. Reporting local sessions here would put a badge on
                    // the phone for work the phone never sent.
                    workspaces: workspaces,
                    sessionCount: 0,
                    activeCount: 0,
                    // The value the rest of the product now reads instead of
                    // inferring capability from presence.
                    servesQueuedTasks: servesQueuedTasks,
                    for: accountID
                )
                guard self.accountID == accountID else { return }
                deviceID = id
                defaults.set(id, forKey: Self.deviceIDKey)
                lastRegisteredAt = Date()
                lastError = nil
                phase = .listed
            } catch {
                guard self.accountID == accountID else { return }
                // Left readable and left beating. A refusal now is very often a
                // token that is about to be refreshed or a network that is about
                // to come back, and the next beat is a minute away — which is
                // both the retry and the reason no backoff is needed here.
                lastError = NativeFailureMessage.presentable(error)
                phase = .failed
            }
        } while needsAnotherRegistration && !Task.isCancelled
    }

    /// One granted folder, as the account should see it — or nothing, when the
    /// grant no longer resolves.
    ///
    /// The filter is the point. A workspace whose bookmark has lapsed still sits
    /// in the directory with a perfectly plausible name and path, so advertising
    /// it puts a folder in the phone's picker that this Mac cannot actually
    /// open: the task would be dispatched, arrive, and fail on a permission the
    /// reader was never asked for. Failing to *offer* it is a smaller lie than
    /// offering it and failing.
    ///
    /// The path does leave the Mac, and `WorkspaceDescriptor.localPathHint` says
    /// it should not — that comment predates remote dispatch. It is required
    /// now: `POST /api/code/tasks` 400s without `workspacePath`, and the picker
    /// has to name the folder for the reader to choose between two. It travels
    /// on the account's own authenticated request, into the account's own row.
    private static func advertisable(_ record: WorkspaceRecord) -> NativeCodeDevice.Workspace? {
        guard resolves(record.bookmarkData) else { return nil }
        return NativeCodeDevice.Workspace(
            name: record.descriptor.displayName,
            path: record.descriptor.localPathHint,
            // The stable identity, so the phone's choice survives the folder
            // being moved or renamed — the path will not.
            key: record.descriptor.id.value
        )
    }

    /// Whether bookmark data still names a real directory.
    ///
    /// Deliberately *not* `WorkspaceAccess(workspaceID:bookmarkData:)`, which is
    /// what a task does on arrival: that starts a security scope this would then
    /// have to balance, and it opens the folder for real on every beat. The
    /// resolution rules are copied from it — scoped first, plain as the
    /// fallback, staleness tolerated — because a check that is stricter than the
    /// open it predicts would hide folders that work.
    private static func resolves(_ bookmarkData: Data) -> Bool {
        var isStale = false
        var resolved = try? URL(
            resolvingBookmarkData: bookmarkData,
            options: [.withSecurityScope],
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        )
        if resolved == nil {
            resolved = try? URL(
                resolvingBookmarkData: bookmarkData,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
        }
        guard let resolved else { return false }
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(
            atPath: resolved.path, isDirectory: &isDirectory
        )
        return exists && isDirectory.boolValue
    }
}
