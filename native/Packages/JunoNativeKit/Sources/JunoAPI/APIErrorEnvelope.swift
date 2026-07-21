import Foundation
import JunoCore

public enum APIErrorEnvelopeValidationError: Error, Equatable, Sendable {
    case invalidCode
    case invalidMessage
    case invalidRetryDelay
}

public struct APIErrorCode: Hashable, Codable, Sendable, CustomStringConvertible {
    public let rawValue: String

    public init(_ rawValue: String) throws {
        do {
            try BoundedValue.validateText(
                rawValue,
                field: "error.code",
                maximumUTF8Bytes: 128
            )
        } catch {
            throw APIErrorEnvelopeValidationError.invalidCode
        }
        self.rawValue = rawValue
    }

    public var description: String { rawValue }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        do {
            try self.init(value)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid API error code"
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct APIErrorEnvelope: Error, Codable, Equatable, Sendable {
    public struct Detail: Codable, Equatable, Sendable {
        public let code: APIErrorCode
        public let message: String
        public let requestID: RequestID
        public let retryable: Bool
        public let retryAfterMilliseconds: Int?

        enum CodingKeys: String, CodingKey {
            case code
            case message
            case requestID = "requestId"
            case retryable
            case retryAfterMilliseconds = "retryAfterMs"
        }

        public init(
            code: APIErrorCode,
            message: String,
            requestID: RequestID,
            retryable: Bool,
            retryAfterMilliseconds: Int? = nil
        ) throws {
            do {
                try BoundedValue.validateText(
                    message,
                    field: "error.message",
                    maximumUTF8Bytes: 8_192,
                    allowsNewlines: true
                )
            } catch {
                throw APIErrorEnvelopeValidationError.invalidMessage
            }
            if let retryAfterMilliseconds,
                !(0...86_400_000).contains(retryAfterMilliseconds)
            {
                throw APIErrorEnvelopeValidationError.invalidRetryDelay
            }
            self.code = code
            self.message = message
            self.requestID = requestID
            self.retryable = retryable
            self.retryAfterMilliseconds = retryAfterMilliseconds
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            do {
                try self.init(
                    code: container.decode(APIErrorCode.self, forKey: .code),
                    message: container.decode(String.self, forKey: .message),
                    requestID: container.decode(RequestID.self, forKey: .requestID),
                    retryable: container.decode(Bool.self, forKey: .retryable),
                    retryAfterMilliseconds: container.decodeIfPresent(
                        Int.self,
                        forKey: .retryAfterMilliseconds
                    )
                )
            } catch let error as DecodingError {
                throw error
            } catch {
                throw DecodingError.dataCorrupted(
                    .init(
                        codingPath: decoder.codingPath,
                        debugDescription: "Invalid API error detail: \(error)"
                    )
                )
            }
        }
    }

    public let error: Detail

    public init(error: Detail) {
        self.error = error
    }
}
