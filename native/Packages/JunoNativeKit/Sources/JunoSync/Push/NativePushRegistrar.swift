import Foundation
import JunoCore
import Observation

/// This device's place on the server's push list.
///
/// Two halves arrive separately and in either order: the APNs token, which
/// the system hands the app delegate some time after launch, and the signed-in
/// account, which the shell learns once auth has restored. The registrar
/// holds both and tells the server whenever the pair — or the person's two
/// switches — differs from what the server last accepted, so a launch that
/// hands over the same token for the same account costs one request at most
/// and a switch flipped in Settings reaches the server on its own.
///
/// Signing out only forgets the account. The server deactivates a device
/// session's tokens when that session is revoked, which is the one moment the
/// bearer a DELETE would need has already gone.
///
/// Shared by both apps: one per process, like the token it holds.
@MainActor
@Observable
public final class NativePushRegistrar {
    public static let shared = NativePushRegistrar()

    /// The APNs token as the server stores it, once the system has given one.
    public private(set) var tokenHex: String?
    /// Why the last registration did not land, as a sentence; nil once one has.
    public private(set) var lastError: String?

    /// What this device's pushes follow. Stored on the device, because the
    /// switches belong to this device's token rather than to the account, and
    /// setting it tells the server straight away.
    public var preferences: NativePushPreferences {
        didSet {
            guard preferences != oldValue else { return }
            if let data = try? JSONEncoder().encode(preferences) {
                defaults.set(data, forKey: Self.preferencesKey)
            }
            sync()
        }
    }

    private static let preferencesKey = "juno.push.preferences"
    /// Opened notifications waiting to be marked read, bounded so a device
    /// that never signs in does not collect them forever.
    private static let maximumUnsentReads = 20

    private let defaults: UserDefaults
    private let bundleID: String?
    private let platform: String
    private let environment: String

    private var accountID: AccountID?
    private var client: NativePushTokenClient?
    /// The registration the server last accepted, and for whom.
    private var registered: Registration?
    private var syncTask: Task<Void, Never>?
    private var unsentReads: [String] = []

    private struct Registration: Equatable {
        let accountID: AccountID
        let registration: NativePushTokenRegistration
    }

    public init(
        defaults: UserDefaults = .standard,
        bundleID: String? = Bundle.main.bundleIdentifier,
        platform: String = NativePushRegistrar.currentPlatform,
        environment: String = NativePushRegistrar.buildEnvironment
    ) {
        self.defaults = defaults
        self.bundleID = bundleID
        self.platform = platform
        self.environment = environment
        var stored = NativePushPreferences()
        if let data = defaults.data(forKey: Self.preferencesKey),
            let decoded = try? JSONDecoder().decode(NativePushPreferences.self, from: data)
        {
            stored = decoded
        }
        self.preferences = stored
    }

    /// `ios` on the phone and the iPad, `macos` on the Mac.
    public nonisolated static var currentPlatform: String {
        #if os(macOS)
        return "macos"
        #else
        return "ios"
        #endif
    }

    /// Which APNs gateway this build's token belongs to. A Debug build is
    /// signed for development and its tokens are sandbox tokens; everything
    /// else is taken to be production. A build signed otherwise — a Next build
    /// run from Xcode, say — is corrected by the server on its first push.
    public nonisolated static var buildEnvironment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    // MARK: - The token

    public func didRegister(deviceToken: Data) {
        let hex = deviceToken.map { byte in String(format: "%02x", byte) }.joined()
        guard !hex.isEmpty else { return }
        tokenHex = hex
        sync()
    }

    public func didFailToRegister(_ error: any Error) {
        lastError = "Notifications could not be set up on this device."
    }

    // MARK: - The account

    /// Called at sign-in, with the same bearer transport everything else uses.
    public func start(for accountID: AccountID, sender: any NativeAuthenticatedRequestSending) {
        self.accountID = accountID
        client = NativePushTokenClient(sender: sender)
        sync()
    }

    /// Called at sign-out. Forgets the account and what was registered for it,
    /// so signing back in registers again under the new device session.
    public func stop() {
        accountID = nil
        client = nil
        registered = nil
        lastError = nil
        unsentReads = []
    }

    /// Marks a notification read once it has been opened. A tap that launched
    /// the app arrives before sign-in has restored, so it waits for the account.
    public func markOpened(notificationID: String) {
        guard JunoNotificationRoute.isValidIdentifier(notificationID) else { return }
        unsentReads.append(notificationID)
        if unsentReads.count > Self.maximumUnsentReads {
            unsentReads.removeFirst(unsentReads.count - Self.maximumUnsentReads)
        }
        flushReads()
    }

    // MARK: - Sending

    /// What the server should hold now, or nil while either half is missing.
    private var wanted: Registration? {
        guard let tokenHex, let accountID, client != nil else { return nil }
        let registration = NativePushTokenRegistration(
            token: tokenHex,
            platform: platform,
            bundleID: bundleID,
            environment: environment,
            preferences: preferences
        )
        return Registration(accountID: accountID, registration: registration)
    }

    private func sync() {
        flushReads()
        // One request at a time. A change made while one is out is picked up
        // by the loop in `drain()` when it comes back.
        guard syncTask == nil else { return }
        syncTask = Task { [weak self] in
            await self?.drain()
        }
    }

    private func drain() async {
        while let next = wanted, next != registered, let client {
            do {
                _ = try await client.register(next.registration, for: next.accountID)
                if accountID == next.accountID {
                    registered = next
                    lastError = nil
                }
            } catch {
                // A change made while the request was out gets its own pass.
                // Otherwise stop: the next launch, sign-in or switch retries,
                // rather than a loop hammering a server that said no.
                if wanted != next { continue }
                lastError = NativeFailureMessage.presentable(error)
                break
            }
        }
        syncTask = nil
    }

    private func flushReads() {
        guard let accountID, let client, !unsentReads.isEmpty else { return }
        let identifiers = unsentReads
        unsentReads = []
        Task {
            for identifier in identifiers {
                try? await client.markRead(notificationID: identifier, for: accountID)
            }
        }
    }

    /// Waits until nothing is being sent. For tests.
    func settle() async {
        while let task = syncTask {
            await task.value
        }
    }
}
