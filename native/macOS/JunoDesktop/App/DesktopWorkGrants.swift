import AppKit
import Foundation
import JunoCore
import JunoWorkCore
import JunoWorkKit
import JunoWorkLocal
import JunoWorkRuntime
import Observation

/// The folders somebody at this Mac has handed to Juno Work, and the only place
/// one can be created.
///
/// Before this existed there was no way to make a grant at all: `GrantAccess`
/// could open one from bookmark data nobody ever wrote, `LocalWorkExecutor` took
/// a `WorkGrantRequesting` nobody conformed to, and the settings card listed
/// grants that could not exist. A Mac with Juno Work switched on and every
/// capability allowed still had nothing any task could touch.
///
/// Three rules shape it, and each one is the reason a piece of it looks the way
/// it does:
///
/// * **A grant is made by pointing at a folder, never by naming one.** The panel
///   is the grant: macOS issues the permission from the person's own selection
///   in it. A settings field that took a typed path would be a field that could
///   be talked into granting the wrong folder — including by a remote
///   instruction, which is exactly what `WorkGrantRequesting` exists to prevent.
/// * **A remote instruction may ask for the panel and can never widen what comes
///   back.** See ``requestFolderGrant(sessionID:)``.
/// * **No path is ever published.** What leaves this type is a display name and
///   an access mode, matching `WorkGrantSummary`, because these values reach a
///   phone's lock screen and a home directory path names its owner.
@MainActor
@Observable
final class DesktopWorkGrantStore {
    /// The grants as every surface outside this file sees them: names and modes,
    /// never a location.
    private(set) var summaries: [WorkGrantSummary] = []
    private(set) var lastError: String?

    /// The host row these grants belong to, once this Mac has one. Nil until
    /// registration lands, which is normal on a first launch and is why
    /// `WorkGrantSummary.hostID` is optional.
    private var hostID: String?

    /// Whoever needs telling when the set changes: the local executor, so a
    /// revocation reaches a run that is already going, and the host model, so the
    /// settings card and the relay's manifest agree with what is actually shared.
    private var observers: [@MainActor ([WorkGrantRuntime], [WorkGrantSummary]) -> Void] = []

    private let defaults: UserDefaults
    private let undo: WorkUndoLedger
    private let supportDirectory: URL
    private var records: [Record] = []
    /// Opened grants, kept alive for as long as they are shared.
    ///
    /// `GrantAccess` balances a security scope in `deinit`, so dropping and
    /// rebuilding one per run would stop and restart the scope underneath a
    /// batch that is halfway through it.
    private var runtimes: [WorkGrantID: WorkGrantRuntime] = [:]

    static let storageKey = "juno.work.grants"

    init(
        defaults: UserDefaults = .standard,
        undo: WorkUndoLedger = WorkUndoLedger(),
        supportDirectory: URL? = nil
    ) {
        self.defaults = defaults
        self.undo = undo
        self.supportDirectory = supportDirectory ?? Self.defaultSupportDirectory()
        records = Self.loadRecords(from: defaults)
        rebuild()
    }

    /// Where replaced bytes and undo journals live.
    ///
    /// **Outside every grant, always.** A stash inside the folder being
    /// reorganised would itself be reorganised, and a journal inside it would
    /// turn up in the person's own listings — the one place they would never
    /// think to look for Juno's scratch space.
    static func defaultSupportDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base
            .appendingPathComponent("Juno", isDirectory: true)
            .appendingPathComponent("Work", isDirectory: true)
    }

    /// Registers a listener and hands it the current set straight away.
    ///
    /// The immediate call is the point. The executor is built before the store
    /// has finished opening bookmarks on a cold launch, and a listener that only
    /// hears about *changes* would sit with an empty grant list until the person
    /// happened to add a folder — which reads as Juno having forgotten every
    /// folder they ever shared.
    func observe(_ observer: @escaping @MainActor ([WorkGrantRuntime], [WorkGrantSummary]) -> Void) {
        observers.append(observer)
        observer(liveRuntimes, summaries)
    }

    /// Adopts the host row id, so grants created before registration landed are
    /// attributed to the right Mac once it has one.
    func setHostID(_ hostID: String?) {
        guard self.hostID != hostID else { return }
        self.hostID = hostID
        rebuild()
    }

    var liveRuntimes: [WorkGrantRuntime] {
        records
            .filter { $0.revokedAt == nil }
            .compactMap { runtimes[WorkGrantID(value: $0.grantID)] }
    }

    // MARK: - Making a grant

    /// Puts the folder chooser on screen and records what came back.
    ///
    /// Returns the folder's display name, or nil when the person closed the panel
    /// — which is a normal answer and not a failure. `NSOpenPanel` rather than
    /// SwiftUI's `.fileImporter` for the reason `DesktopCodeStudio.regrantAccess`
    /// gives: the importer is bound to a presentation flag on a view, and this
    /// has to be presentable from a claimed relay command with no view involved.
    @discardableResult
    func addFolder(mode: WorkAccessMode, message: String? = nil) -> String? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Share Folder"
        panel.message = message
            ?? "Choose a folder Juno Work may use on this Mac. It can reach nothing outside it."
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        return adopt(url, mode: mode)
    }

    /// Records a folder the person has just chosen.
    ///
    /// Separated from the panel so the whole path below it — bookmark, open,
    /// containment, persistence — is reachable without putting a modal on screen.
    @discardableResult
    func adopt(_ url: URL, mode: WorkAccessMode) -> String? {
        do {
            let bookmark = try GrantAccess.makeBookmark(for: url)
            let record = Record(
                grantID: WorkGrantID().value,
                displayName: url.lastPathComponent,
                mode: mode.rawValue,
                bookmark: bookmark,
                grantedAt: Date(),
                revokedAt: nil
            )
            // Opened before it is persisted. A folder that cannot be opened is
            // not a grant, and storing it would put a row in the settings card
            // that names something Juno can never actually reach.
            _ = try open(record)
            records.append(record)
            persist()
            rebuild()
            lastError = nil
            return record.displayName
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    /// Takes a grant back.
    ///
    /// The `GrantAccess` is revoked before the record is rewritten, so a batch
    /// that is already running stops at its next operation rather than after it.
    /// Every resolution re-checks the revocation, which is what makes that true.
    func revoke(_ grantID: WorkGrantID) {
        guard let index = records.firstIndex(where: { $0.grantID == grantID.value }),
            records[index].revokedAt == nil
        else { return }
        (runtimes[grantID]?.access as? GrantAccess)?.revoke()
        records[index].revokedAt = Date()
        runtimes.removeValue(forKey: grantID)
        persist()
        rebuild()
    }

    /// Changes how much one grant permits.
    ///
    /// Rebuilt rather than mutated: `WorkAccessMode` is `let` on `GrantAccess`
    /// precisely so that a mode cannot drift out of step with the boundary that
    /// enforces it, and the file service and the approval gate both read it from
    /// there. Re-opening is the only way to change it that keeps the two agreed.
    func setMode(_ mode: WorkAccessMode, for grantID: WorkGrantID) {
        guard let index = records.firstIndex(where: { $0.grantID == grantID.value }),
            records[index].revokedAt == nil,
            records[index].mode != mode.rawValue
        else { return }
        records[index].mode = mode.rawValue
        runtimes.removeValue(forKey: grantID)
        persist()
        rebuild()
    }

    // MARK: - Internals

    /// One stored grant. The bookmark is the capability, so this value never
    /// leaves the process — `WorkGrantSummary` is what every surface reads.
    private struct Record: Codable, Sendable {
        let grantID: String
        var displayName: String
        var mode: String
        var bookmark: Data
        var grantedAt: Date
        var revokedAt: Date?
    }

    private static func loadRecords(from defaults: UserDefaults) -> [Record] {
        guard let data = defaults.data(forKey: storageKey) else { return [] }
        // A store this build cannot read is treated as no grants rather than as a
        // reason to fail: the person can share the folders again, and refusing to
        // launch over it would make an unreadable preference fatal.
        return (try? JSONDecoder().decode([Record].self, from: data)) ?? []
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(records) else { return }
        defaults.set(data, forKey: Self.storageKey)
    }

    private func open(_ record: Record) throws -> WorkGrantRuntime {
        let grantID = WorkGrantID(value: record.grantID)
        if let existing = runtimes[grantID] { return existing }
        let access = try GrantAccess(
            grantID: grantID,
            mode: WorkAccessMode(rawValue: record.mode) ?? .read,
            bookmarkData: record.bookmark
        )
        let runtime = WorkGrantRuntime.standard(
            access: access,
            supportDirectory: supportDirectory,
            undo: undo
        )
        runtimes[grantID] = runtime
        return runtime
    }

    /// Re-opens every live grant and republishes the set.
    ///
    /// A grant whose bookmark no longer resolves is dropped from what this Mac
    /// advertises rather than published as broken. Advertising it would put a
    /// folder in the phone's picker that this Mac cannot open: the task would be
    /// dispatched, arrive, and fail on a permission nobody was asked for. Failing
    /// to *offer* it is a smaller lie than offering it and failing — the same
    /// judgement `DesktopCodeHostModel.advertisable` makes.
    private func rebuild() {
        var published: [WorkGrantSummary] = []
        for record in records {
            if record.revokedAt == nil {
                do {
                    let runtime = try open(record)
                    // A bookmark that resolved but wants re-minting is re-minted
                    // now. Left alone it resolves until macOS decides otherwise,
                    // and the folder then stops opening for a reason nobody could
                    // connect to the update that caused it.
                    if let access = runtime.access as? GrantAccess, access.bookmarkNeedsRefresh {
                        refreshBookmark(for: record.grantID, at: access.rootURL)
                    }
                } catch {
                    lastError = error.localizedDescription
                    continue
                }
            }
            published.append(
                WorkGrantSummary(
                    grantID: record.grantID,
                    kind: JunoWorkGrantKind.localFolder.rawValue,
                    displayName: record.displayName,
                    accessMode: record.mode,
                    hostID: hostID,
                    revokedAt: record.revokedAt,
                    // Not tracked on this Mac. The relay records when a grant was
                    // last used from the run that used it, and a second, thinner
                    // copy kept here would be a second thing to keep in step.
                    lastUsedAt: nil
                )
            )
        }
        summaries = published
        let live = liveRuntimes
        for observer in observers { observer(live, published) }
    }

    private func refreshBookmark(for grantID: String, at url: URL) {
        guard let index = records.firstIndex(where: { $0.grantID == grantID }),
            let bookmark = try? GrantAccess.makeBookmark(for: url)
        else { return }
        records[index].bookmark = bookmark
        persist()
    }
}

/// What the settings card can do to the grant store.
///
/// Closures rather than the store itself, so `DesktopWorkHostModel` — which is
/// the only thing the settings surface is handed — can carry them without
/// learning what a `WorkGrantRuntime` is.
struct DesktopWorkGrantActions {
    /// Puts the folder chooser up and answers with the folder's display name, or
    /// nil when the person closed it.
    ///
    /// The answer is load-bearing rather than a convenience. The onboarding path
    /// in ``DesktopWorkHostModel/take(_:)`` turns file work on *after* a folder
    /// comes back, so that closing the panel — which is how somebody says no —
    /// leaves this Mac exactly as they found it instead of switching a capability
    /// on behind a refusal.
    let addFolder: @MainActor (WorkAccessMode) -> String?
    let setMode: @MainActor (WorkAccessMode, WorkGrantID) -> Void
    let revoke: @MainActor (WorkGrantID) -> Void

    @MainActor
    static func over(_ store: DesktopWorkGrantStore) -> DesktopWorkGrantActions {
        DesktopWorkGrantActions(
            addFolder: { mode in store.addFolder(mode: mode) },
            setMode: { mode, grantID in store.setMode(mode, for: grantID) },
            revoke: { grantID in store.revoke(grantID) }
        )
    }
}

/// The seam a claimed `grant_folder` or `revoke_grant` command reaches.
///
/// A remote instruction may ask this Mac to *offer* the folder chooser. It can
/// never mint the grant, and it cannot choose the mode either: what comes back
/// is read-only, and widening it is a separate act by the person in Settings.
/// That asymmetry is the whole point of routing this through a picker — a phone
/// can say what it wants and cannot say what this Mac may do.
struct DesktopWorkGrantRequests: WorkGrantRequesting {
    let store: DesktopWorkGrantStore

    func requestFolderGrant(sessionID: String) async throws -> String? {
        await MainActor.run {
            store.addFolder(
                mode: .read,
                message: "A Juno Work task has asked for a folder on this Mac. "
                    + "Choose one to share it for reading, or close this to refuse."
            )
        }
    }

    func revokeGrant(_ grantID: WorkGrantID) async throws {
        await MainActor.run { store.revoke(grantID) }
    }
}
