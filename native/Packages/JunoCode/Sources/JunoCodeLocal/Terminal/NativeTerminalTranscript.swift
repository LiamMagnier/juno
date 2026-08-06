import Foundation

/// A byte-bounded ring buffer retaining the newest terminal output.
public struct NativeTerminalTranscript: Equatable, Sendable {
    public let maximumBytes: Int
    private var storage = Data()

    public private(set) var didTruncate = false

    public init(maximumBytes: Int) {
        self.maximumBytes = max(0, maximumBytes)
    }

    public var byteCount: Int { storage.count }

    public var data: Data { storage }

    public var text: String {
        String(decoding: storage, as: UTF8.self)
    }

    public mutating func append(_ data: Data) {
        guard !data.isEmpty else { return }
        guard maximumBytes > 0 else {
            didTruncate = true
            storage.removeAll(keepingCapacity: false)
            return
        }

        if data.count >= maximumBytes {
            storage = Data(data.suffix(maximumBytes))
            didTruncate = true
            return
        }

        storage.append(data)
        if storage.count > maximumBytes {
            storage.removeFirst(storage.count - maximumBytes)
            didTruncate = true
        }
    }
}
