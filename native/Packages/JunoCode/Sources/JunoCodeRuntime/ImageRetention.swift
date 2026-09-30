import Foundation

/// When images in the model history become text.
///
/// A screenshot or attachment used to be rewritten to a placeholder as soon
/// as one model turn had seen it. Rewriting an earlier message changes the
/// prefix every later request starts with, so in a vision or Computer Use
/// session each step restarted the prompt cache from the first image and
/// dropped every replayed thinking block after it. Images now stay as they
/// were sent until the history is rewritten anyway — at compaction — or until
/// they would push a request past what providers accept, and then many go at
/// once, so the cache breaks once rather than on every step.
///
/// Images the model has not answered yet — the trailing run of tool results
/// or the prompt it is about to read — are never rewritten.
enum ImageRetention {
    /// A rough stand-in for an image's weight in the context, in the bytes
    /// the compaction guard counts: about two thousand tokens, which is what
    /// a full-size screenshot costs on the providers Juno uses.
    static let contextBytesPerImage = 8 * 1_024

    /// Every image in `messages` older than the unanswered tail, as text.
    static func redactingAnswered(_ messages: [ModelMessage]) -> [ModelMessage] {
        let tail = unansweredTailStart(messages)
        return messages.enumerated().map { index, message in
            index < tail ? message.persistenceSafe : message
        }
    }

    /// `messages` with the oldest answered images rewritten when the history
    /// holds more than `maximumImages` images or `maximumBytes` of image data,
    /// down to half of each so the next rewrite is many steps away; or nil
    /// when it is within both.
    static func withinBudget(
        _ messages: [ModelMessage],
        maximumImages: Int,
        maximumBytes: Int
    ) -> [ModelMessage]? {
        var count = 0
        var bytes = 0
        for message in messages {
            for image in message.images {
                count += 1
                bytes += image.data.count
            }
        }
        guard count > maximumImages || bytes > maximumBytes else { return nil }

        let tail = unansweredTailStart(messages)
        var result = messages
        for index in result.indices where index < tail {
            guard count > maximumImages / 2 || bytes > maximumBytes / 2 else { break }
            let images = result[index].images
            guard !images.isEmpty else { continue }
            count -= images.count
            bytes -= images.reduce(0) { $0 + $1.data.count }
            result[index] = result[index].persistenceSafe
        }
        return result == messages ? nil : result
    }

    /// Where the messages the model has not replied to begin: after the last
    /// thing the model wrote.
    static func unansweredTailStart(_ messages: [ModelMessage]) -> Int {
        guard let last = messages.lastIndex(where: \.isAssistantSide) else { return 0 }
        return last + 1
    }
}

extension ModelMessage {
    /// The images this message carries to the model.
    var images: [ModelImage] {
        switch self {
        case let .userWithImages(_, images), let .toolResultWithImages(_, _, _, images):
            images
        default:
            []
        }
    }
}
