import Foundation
import JunoAuth
import JunoCore
import JunoSync
import Observation

/// A file that travels with a message: a photo the reader attached to a
/// question, or the picture Juno generated as its answer.
///
/// Carried on ``NativeChatMessage`` rather than looked up at render time,
/// because the transcript is the one place the join is always needed and a row
/// that has to ask a second store for its own pictures is a row that flickers.
/// The server keeps attachments as their own sync entity with a `messageId`;
/// ``NativeConversationStore`` joins them here when it loads the snapshot.
public struct NativeChatAttachment: Identifiable, Equatable, Sendable, Hashable {
    public let id: String
    public let fileName: String
    public let mimeType: String
    /// `IMAGE` or `FILE`, as the server classifies it.
    public let kind: String
    public let size: Int
    public let width: Int?
    public let height: Int?

    public init(
        id: String, fileName: String, mimeType: String, kind: String, size: Int,
        width: Int?, height: Int?
    ) {
        self.id = id
        self.fileName = fileName
        self.mimeType = mimeType
        self.kind = kind
        self.size = size
        self.width = width
        self.height = height
    }

    public var isImage: Bool { kind == "IMAGE" || mimeType.hasPrefix("image/") }
    public var isVideo: Bool { mimeType.hasPrefix("video/") }

    /// Width over height, when the server measured the picture — used to lay
    /// out a placeholder the right shape before the bytes arrive.
    public var aspectRatio: CGFloat? {
        guard let width, let height, width > 0, height > 0 else { return nil }
        return CGFloat(width) / CGFloat(height)
    }
}

/// Fetches and caches the bytes of images in the transcript.
///
/// Images live behind the authenticated `/api/attachments/{id}` route, which
/// `AsyncImage` cannot reach: it has no way to carry a bearer. So the bytes are
/// fetched through the same transport as everything else and kept in memory,
/// keyed by attachment id, for as long as the screen lives. A failed fetch is
/// remembered too, so a broken image does not retry on every scroll.
@MainActor
@Observable
public final class NativeChatImageLoader {
    public enum State: Equatable, Sendable {
        case loading
        case loaded(Data)
        case failed
    }

    /// Bounded so a very long transcript full of pictures cannot grow without
    /// limit. Evicted oldest-first.
    public static let capacity = 60

    private var cache: [String: State] = [:]
    private var order: [String] = []
    private var inFlight: Set<String> = []
    private let sender: (any NativeAuthenticatedRequestSending)?
    private let accountID: AccountID?

    public init(sender: (any NativeAuthenticatedRequestSending)?, accountID: AccountID?) {
        self.sender = sender
        self.accountID = accountID
    }

    public func state(for id: String) -> State { cache[id] ?? .loading }

    /// Starts a fetch when nothing is cached or in flight. Safe to call from a
    /// row's `task`: a second call for the same id is a no-op.
    public func load(_ id: String) async {
        guard cache[id] == nil, !inFlight.contains(id) else { return }
        guard let sender, let accountID else {
            store(.failed, for: id)
            return
        }
        inFlight.insert(id)
        defer { inFlight.remove(id) }
        do {
            let response = try await sender.send(
                try NativeBearerRequest(path: "/api/attachments/\(id)"),
                for: accountID
            )
            guard (200...299).contains(response.statusCode), !response.body.isEmpty else {
                store(.failed, for: id)
                return
            }
            store(.loaded(response.body), for: id)
        } catch {
            store(.failed, for: id)
        }
    }

    /// Lets a caller that already has the bytes — a just-uploaded photo — seed
    /// the cache so the row never shows a placeholder for a picture the phone
    /// took a second ago.
    public func seed(_ data: Data, for id: String) {
        store(.loaded(data), for: id)
    }

    private func store(_ state: State, for id: String) {
        if cache[id] == nil { order.append(id) }
        cache[id] = state
        while order.count > Self.capacity, let oldest = order.first {
            order.removeFirst()
            cache[oldest] = nil
        }
    }
}
