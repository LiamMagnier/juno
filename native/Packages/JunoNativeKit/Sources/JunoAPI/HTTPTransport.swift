import Foundation

public protocol HTTPTransport: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
}

public struct BoundedHTTPClient: Sendable {
    public let origin: APIOrigin
    public let limits: HTTPMessageLimits

    private let transport: any HTTPTransport
    private let validator: HTTPMessageValidator

    public init(
        origin: APIOrigin,
        limits: HTTPMessageLimits = .standard,
        transport: any HTTPTransport
    ) {
        self.origin = origin
        self.limits = limits
        self.transport = transport
        validator = HTTPMessageValidator(origin: origin, limits: limits)
    }

    public func makeRequest(
        path: String,
        method: HTTPMethod,
        queryItems: [URLQueryItem] = [],
        headers: HTTPHeaders = HTTPHeaders(),
        body: Data? = nil
    ) throws -> HTTPRequest {
        let request = HTTPRequest(
            url: try origin.endpoint(path: path, queryItems: queryItems),
            method: method,
            headers: headers,
            body: body
        )
        try validator.validate(request)
        return request
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        try validator.validate(request)
        let response = try await transport.send(request)
        try validator.validate(response)
        return response
    }
}

public enum URLSessionTransportError: Error, Equatable, Sendable {
    case invalidConfiguration
    case invalidResponse
    case requestBodyTooLarge(maximumBytes: Int)
    case responseBodyTooLarge(maximumBytes: Int)
    case invalidHeaders
}

/// An ephemeral, cookie-free transport that rejects redirects and stops reading at its byte cap.
public final class URLSessionHTTPTransport: HTTPTransport, @unchecked Sendable {
    private let maximumRequestBodyBytes: Int
    private let maximumResponseBodyBytes: Int
    private let session: URLSession
    private let redirectDelegate = RedirectRejectingTaskDelegate()

    public init(
        maximumRequestBodyBytes: Int = HTTPMessageLimits.standard.maximumRequestBodyBytes,
        maximumResponseBodyBytes: Int = HTTPMessageLimits.standard.maximumResponseBodyBytes,
        requestTimeout: TimeInterval = 60
    ) throws {
        guard maximumRequestBodyBytes >= 0, maximumResponseBodyBytes > 0,
            requestTimeout.isFinite, requestTimeout > 0
        else {
            throw URLSessionTransportError.invalidConfiguration
        }
        self.maximumRequestBodyBytes = maximumRequestBodyBytes
        self.maximumResponseBodyBytes = maximumResponseBodyBytes

        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = requestTimeout
        configuration.timeoutIntervalForResource = requestTimeout
        session = URLSession(configuration: configuration)
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard request.body?.count ?? 0 <= maximumRequestBodyBytes else {
            throw URLSessionTransportError.requestBodyTooLarge(
                maximumBytes: maximumRequestBodyBytes
            )
        }

        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method.rawValue
        urlRequest.httpBody = request.body
        for (name, value) in request.headers.allFields {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }

        let (bytes, response) = try await session.bytes(
            for: urlRequest,
            delegate: redirectDelegate
        )
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLSessionTransportError.invalidResponse
        }

        if let expectedLength = Self.contentLength(from: httpResponse),
            expectedLength > maximumResponseBodyBytes
        {
            throw URLSessionTransportError.responseBodyTooLarge(
                maximumBytes: maximumResponseBodyBytes
            )
        }

        var body = Data()
        if let expectedLength = Self.contentLength(from: httpResponse) {
            body.reserveCapacity(min(expectedLength, maximumResponseBodyBytes))
        }
        for try await byte in bytes {
            guard body.count < maximumResponseBodyBytes else {
                throw URLSessionTransportError.responseBodyTooLarge(
                    maximumBytes: maximumResponseBodyBytes
                )
            }
            body.append(byte)
        }

        var rawHeaders: [String: String] = [:]
        for (name, value) in httpResponse.allHeaderFields {
            rawHeaders[String(describing: name)] = String(describing: value)
        }
        guard let headers = try? HTTPHeaders(rawHeaders) else {
            throw URLSessionTransportError.invalidHeaders
        }
        return HTTPResponse(
            statusCode: httpResponse.statusCode,
            headers: headers,
            body: body
        )
    }

    private static func contentLength(from response: HTTPURLResponse) -> Int? {
        guard let value = response.value(forHTTPHeaderField: "Content-Length"),
            let result = Int(value), result >= 0
        else {
            return nil
        }
        return result
    }
}

private final class RedirectRejectingTaskDelegate: NSObject, URLSessionTaskDelegate,
    @unchecked Sendable
{
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
