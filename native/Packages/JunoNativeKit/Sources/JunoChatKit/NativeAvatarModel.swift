import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

/// Fetches the account photo when it lives behind Juno's own authenticated file
/// route.
///
/// **Why this exists at all.** An avatar uploaded to Juno is stored on the user
/// row as a *relative* path — `/api/files/<key>` — and that route requires a
/// signed-in caller. Neither half survives `AsyncImage`: a relative string makes
/// a `URL` with no host, so the request is never even attempted (the view sits
/// in its loading phase forever, which is exactly the permanently blank circle
/// that was reported), and even given an absolute URL it would be refused,
/// because `AsyncImage` sends no `Authorization` header.
///
/// So the photo is fetched the same way every other Juno resource is: through
/// the bearer sender, by path. Held in memory for the session — it is a single
/// small image, and re-reading it once per launch is cheaper than owning a cache
/// that can go stale against a changed avatar.
@MainActor
@Observable
public final class NativeAvatarModel {
    /// The decoded bytes, or nil when there is no photo, it has not arrived yet,
    /// or it could not be read. Callers fall back to initials in all three
    /// cases, which is the same thing the web does.
    public private(set) var imageData: Data?

    private let sender: any NativeAuthenticatedRequestSending
    private var loadedPath: String?
    private var task: Task<Void, Never>?

    /// A profile photo is small; anything larger is not one, and decoding it
    /// into a 40pt circle would be a waste of memory at best.
    private static let maximumBytes = 8 * 1_024 * 1_024

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    /// Loads `profile`'s photo if it is one this loader is responsible for.
    /// Absolute URLs are left alone — `JunoAvatar` loads those directly.
    public func start(for profile: NativeAccountProfile) {
        guard let path = profile.imagePath else {
            clear()
            return
        }
        guard path != loadedPath || imageData == nil else { return }
        loadedPath = path
        task?.cancel()
        let accountID = profile.id
        task = Task { [weak self] in
            guard let self else { return }
            let data = await fetch(path: path, accountID: accountID)
            guard !Task.isCancelled, loadedPath == path else { return }
            imageData = data
        }
    }

    public func clear() {
        task?.cancel()
        task = nil
        loadedPath = nil
        imageData = nil
    }

    private func fetch(path: String, accountID: AccountID) async -> Data? {
        guard let request = try? NativeBearerRequest(
            path: path, headers: try HTTPHeaders(["accept": "image/*"])
        ) else { return nil }
        guard let response = try? await sender.send(request, for: accountID),
            (200...299).contains(response.statusCode),
            response.body.count <= Self.maximumBytes,
            !response.body.isEmpty
        else { return nil }
        return response.body
    }
}
