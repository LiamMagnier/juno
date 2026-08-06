import Foundation
import JunoWorkCore

/// Why a granted folder could not be opened at all.
///
/// Separate from ``WorkGrantAccessError`` on purpose. That type answers "may
/// Juno touch this location inside a grant it already holds"; this one answers
/// "is there a grant at all". Folding the two together would put
/// `bookmarkInvalid` next to `symlinkEscapesGrant` in the same switch, and the
/// two need opposite copy: one is a lapsed permission the person can restore in
/// a file dialog, the other is Juno refusing to leave a folder and must never
/// invite them to "fix" it.
public enum WorkGrantOpenError: Error, Equatable, Sendable {
    /// The stored bookmark no longer resolves to anything.
    case bookmarkInvalid
    /// The folder resolved but is not reachable — moved, renamed, or on a disk
    /// that is not mounted.
    case rootUnavailable
    case rootIsNotADirectory
}

extension WorkGrantOpenError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .bookmarkInvalid:
            "Juno's permission to open this folder is no longer valid. macOS withdraws a folder grant when the app is rebuilt, re-signed, or the folder is moved."
        case .rootUnavailable:
            "Juno could not reach this folder. It may have been moved, renamed, or be on a disk that is not plugged in."
        case .rootIsNotADirectory:
            "That is a file, not a folder."
        }
    }

    public var recoverySuggestion: String? {
        "Share the folder with Juno again to restore access."
    }
}

/// Bookmark-backed access to one granted folder, with canonical containment
/// enforced on every single resolution.
///
/// This is the containment boundary for Work. Everything else — the file
/// service, the batch executor, the tools above them — reaches the disk through
/// the three methods below and through nothing else.
///
/// Three properties are load-bearing, and each one exists because leaving it out
/// produced a real escape in the equivalent Juno Code type:
///
/// 1. **Containment is re-checked on every resolution and never cached per
///    path.** The answer is only true for as long as the filesystem does not
///    move underneath it, and on a Mac with a sync client running that is not
///    long. A resolution memoized at the top of a batch authorises the world as
///    it was when the batch started.
/// 2. **Reading and mutating canonicalize different things.** Reading
///    canonicalizes the whole candidate; mutating canonicalizes the deepest
///    *existing* ancestor and re-appends the rest. Canonicalizing a location
///    that does not exist yet returns it unchanged, so a leaf-only check waves
///    through a new file under a symlinked folder.
/// 3. **Canonicalization is `realpath(3)`, never Foundation.** See
///    ``canonicalPath(_:)``.
public final class GrantAccess: GrantAccessing, @unchecked Sendable {
    public let grantID: WorkGrantID
    public let mode: WorkAccessMode
    public let rootURL: URL

    /// The grant root with every symlink resolved. Computed once because the
    /// root is fixed for the lifetime of the object; every *candidate* is
    /// canonicalized afresh.
    private let canonicalRootPath: String
    private let securityScoped: Bool

    // `bookmarkNeedsRefresh` and the revocation date are the only mutable state,
    // and both are read from whatever thread happens to be running an operation,
    // so both go behind the lock rather than relying on the class being used
    // politely.
    private let lock = NSLock()
    private var mutableRevokedAt: Date?
    private var mutableBookmarkNeedsRefresh = false

    deinit {
        if securityScoped {
            rootURL.stopAccessingSecurityScopedResource()
        }
    }

    /// True when the bookmark that opened this grant needs re-minting.
    ///
    /// Resolution still succeeded — the folder was found — but the stored data
    /// is out of date. The caller should persist a fresh bookmark rather than
    /// treat this as a failure.
    public var bookmarkNeedsRefresh: Bool {
        lock.lock()
        defer { lock.unlock() }
        return mutableBookmarkNeedsRefresh
    }

    /// When the person took this grant back, if they have.
    public var revokedAt: Date? {
        lock.lock()
        defer { lock.unlock() }
        return mutableRevokedAt
    }

    // MARK: - Opening

    /// Opens a grant from persisted bookmark data.
    ///
    /// **Resolution falls back from scoped to plain, and that is the fix for a
    /// real dead end.** A security-scoped bookmark is bound to the code identity
    /// of the app that created it: re-sign the app and resolving it throws, so a
    /// folder the person shared last week stops opening after an update and Work
    /// looks broken rather than un-permitted. A plain bookmark carries no such
    /// binding and still tracks the folder by file id, so it survives a rename
    /// or a move. Preferring scoped and accepting plain keeps this correct if
    /// the app is ever sandboxed, while making a stored grant survive a
    /// re-signing in the meantime.
    ///
    /// A *stale* bookmark is not fatal either. Staleness means "this resolved,
    /// but re-mint it", and throwing turns a folder that merely moved into a
    /// folder the person has to grant again.
    public convenience init(
        grantID: WorkGrantID,
        mode: WorkAccessMode,
        bookmarkData: Data
    ) throws {
        var isStale = false
        var scoped = false
        var resolved: URL?

        if let url = try? URL(
            resolvingBookmarkData: bookmarkData,
            options: [.withSecurityScope],
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        ) {
            resolved = url
            scoped = true
        } else {
            var plainIsStale = false
            if let url = try? URL(
                resolvingBookmarkData: bookmarkData,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &plainIsStale
            ) {
                resolved = url
                isStale = plainIsStale
            }
        }

        guard let resolved else { throw WorkGrantOpenError.bookmarkInvalid }

        // Only meaningful for a scoped resolution; a plain bookmark in an
        // unsandboxed process needs no scope to be started or stopped.
        let didStart = scoped && resolved.startAccessingSecurityScopedResource()
        try self.init(grantID: grantID, mode: mode, rootURL: resolved, securityScoped: didStart)
        lock.lock()
        mutableBookmarkNeedsRefresh = isStale
        lock.unlock()
    }

    /// Opens a grant from a folder the person just chose in a file dialog.
    public convenience init(grantID: WorkGrantID, mode: WorkAccessMode, grantedURL: URL) throws {
        try self.init(grantID: grantID, mode: mode, rootURL: grantedURL, securityScoped: false)
    }

    /// Opens the folder behind a stored ``WorkGrant``, carrying its revocation
    /// forward so an already-revoked grant refuses from its first use.
    public convenience init(grant: WorkGrant, grantedURL: URL) throws {
        try self.init(grantID: grant.id, mode: grant.mode, grantedURL: grantedURL)
        if let revokedAt = grant.revokedAt { revoke(at: revokedAt) }
    }

    private init(
        grantID: WorkGrantID,
        mode: WorkAccessMode,
        rootURL: URL,
        securityScoped: Bool
    ) throws {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: rootURL.path, isDirectory: &isDirectory) else {
            if securityScoped { rootURL.stopAccessingSecurityScopedResource() }
            throw WorkGrantOpenError.rootUnavailable
        }
        guard isDirectory.boolValue else {
            if securityScoped { rootURL.stopAccessingSecurityScopedResource() }
            throw WorkGrantOpenError.rootIsNotADirectory
        }
        self.grantID = grantID
        self.mode = mode
        self.rootURL = rootURL
        self.securityScoped = securityScoped
        self.canonicalRootPath = Self.canonicalPath(rootURL.path)
    }

    /// Creates persistable bookmark data for a folder the person granted.
    ///
    /// **Plain, deliberately.** A security-scoped bookmark would tie the stored
    /// grant to this build's code signature, so the next re-signed build could
    /// not resolve it. Juno for Mac is not sandboxed, so the scope grants it
    /// nothing it does not already have.
    public static func makeBookmark(for grantedURL: URL) throws -> Data {
        do {
            return try grantedURL.bookmarkData(
                options: [],
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
        } catch {
            throw WorkGrantOpenError.bookmarkInvalid
        }
    }

    // MARK: - Revocation

    /// Records that the person took this grant back.
    ///
    /// Every resolution checks it, so a revocation that lands mid-batch stops
    /// the batch at the next operation rather than after it. Revoking twice does
    /// not move the moment access ended, matching ``WorkGrant/revoked(at:)``.
    public func revoke(at date: Date = Date()) {
        lock.lock()
        defer { lock.unlock() }
        mutableRevokedAt = mutableRevokedAt ?? date
    }

    /// Throws when the grant has been taken back.
    ///
    /// Reads the clock at the moment of the check rather than at the start of
    /// the batch: the question is whether access is live *now*, and answering it
    /// from a timestamp taken four minutes ago is how a revoked grant keeps
    /// working until the batch finishes.
    public func requireActiveGrant() throws {
        lock.lock()
        let revokedAt = mutableRevokedAt
        lock.unlock()
        if let revokedAt, Date() >= revokedAt {
            throw WorkGrantAccessError.grantRevoked(grantID: grantID)
        }
    }

    // MARK: - Resolution

    public func resolveForReading(_ path: GrantedPath) throws -> URL {
        try requireActiveGrant()
        let candidate = rootURL.appendingPathComponent(path.value, isDirectory: false)
        guard realpath(candidate.path, nil) != nil else {
            // A location that does not resolve is not a location inside the
            // grant. Failing closed keeps a dangling link from being treated as
            // a contained one; callers that need to tell "missing" from
            // "escaped" ask the filesystem *after* the refusal, never before it.
            throw WorkGrantAccessError.outsideGrant(path: path.value)
        }
        let canonical = Self.canonicalPath(candidate.path)
        guard isContained(canonical) else {
            throw WorkGrantAccessError.symlinkEscapesGrant(path: path.value)
        }
        return URL(fileURLWithPath: canonical)
    }

    public func resolveForMutation(_ path: GrantedPath) throws -> URL {
        try requireActiveGrant()
        let candidate = rootURL.appendingPathComponent(path.value, isDirectory: false)
        if FileManager.default.fileExists(atPath: candidate.path) {
            // Existing target: canonicalizing it covers both a symlinked
            // ancestor and the leaf itself being a symlink.
            let canonical = Self.canonicalPath(candidate.path)
            guard isContained(canonical) else {
                throw WorkGrantAccessError.symlinkEscapesGrant(path: path.value)
            }
            return URL(fileURLWithPath: canonical)
        }
        // New target: walk up to the deepest ancestor that actually exists,
        // canonicalize *that*, verify it, and re-attach the remaining
        // components. This is the half a leaf-only check misses — there is
        // nothing to canonicalize about a file that does not exist yet, so a
        // check on the leaf alone would happily create it under a folder that
        // links out of the grant.
        var ancestor = candidate.deletingLastPathComponent()
        var remaining = [candidate.lastPathComponent]
        while !FileManager.default.fileExists(atPath: ancestor.path) {
            guard ancestor.path.count > 1, ancestor.path != canonicalRootPath else { break }
            remaining.append(ancestor.lastPathComponent)
            let parent = ancestor.deletingLastPathComponent()
            guard parent.path != ancestor.path else {
                throw WorkGrantAccessError.parentDoesNotExist(path: path.value)
            }
            ancestor = parent
        }
        let canonicalAncestor = Self.canonicalPath(ancestor.path)
        guard isContained(canonicalAncestor) else {
            throw WorkGrantAccessError.symlinkEscapesGrant(path: path.value)
        }
        var resolved = URL(fileURLWithPath: canonicalAncestor)
        for component in remaining.reversed() { resolved.appendPathComponent(component) }
        return resolved
    }

    public func makeRelative(_ url: URL) throws -> GrantedPath {
        try requireActiveGrant()
        let canonical = Self.canonicalPath(url.path)
        let prefix = canonicalRootPath.hasSuffix("/") ? canonicalRootPath : canonicalRootPath + "/"
        guard canonical != canonicalRootPath, canonical.hasPrefix(prefix) else {
            throw WorkGrantAccessError.outsideGrant(path: url.path)
        }
        do {
            return try GrantedPath(String(canonical.dropFirst(prefix.count)))
        } catch {
            throw WorkGrantAccessError.outsideGrant(path: url.path)
        }
    }

    // MARK: - Helpers

    /// Canonicalizes with `realpath(3)`, never Foundation.
    ///
    /// `resolvingSymlinksInPath()` and `standardizedFileURL` both strip a
    /// leading `/private`, turning `/private/tmp/x` into `/tmp/x`. That is the
    /// opposite direction from the kernel. Canonicalize the root one way and a
    /// candidate the other and two names for the same directory stop comparing
    /// equal — which either lets a location out of the grant or locks the person
    /// out of their own folder, depending on which side lost its `/private`.
    ///
    /// Returns the input unchanged when the path does not resolve, so callers
    /// must decide separately whether a non-resolving path is acceptable;
    /// ``resolveForReading(_:)`` refuses it outright.
    public static func canonicalPath(_ path: String) -> String {
        guard let resolved = realpath(path, nil) else { return path }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    private func isContained(_ canonicalPath: String) -> Bool {
        if canonicalPath == canonicalRootPath { return true }
        // The trailing separator matters: without it `/Users/x/Documents-old`
        // has `/Users/x/Documents` as a prefix and a whole sibling folder counts
        // as inside the grant.
        let prefix = canonicalRootPath.hasSuffix("/") ? canonicalRootPath : canonicalRootPath + "/"
        return canonicalPath.hasPrefix(prefix)
    }
}
