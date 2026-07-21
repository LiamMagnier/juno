import Foundation

public enum HTTPValidationError: Error, Equatable, Sendable {
    case insecureScheme
    case missingHost
    case credentialsInURL
    case originContainsPath
    case originContainsQueryOrFragment
    case invalidEndpointPath
    case crossOriginRequest
    case requestBodyTooLarge(maximumBytes: Int)
    case responseBodyTooLarge(maximumBytes: Int)
    case tooManyHeaders(maximum: Int)
    case headersTooLarge(maximumBytes: Int)
    case invalidStatusCode(Int)
    case redirectRejected(statusCode: Int)
    case invalidLimitConfiguration
}

public struct HTTPMessageLimits: Equatable, Sendable {
    public static let standard = HTTPMessageLimits(
        validatedRequestBodyBytes: 10 * 1_024 * 1_024,
        responseBodyBytes: 20 * 1_024 * 1_024,
        headerCount: 64,
        headerBytes: 64 * 1_024
    )

    public let maximumRequestBodyBytes: Int
    public let maximumResponseBodyBytes: Int
    public let maximumHeaderCount: Int
    public let maximumHeaderBytes: Int

    public init(
        maximumRequestBodyBytes: Int,
        maximumResponseBodyBytes: Int,
        maximumHeaderCount: Int,
        maximumHeaderBytes: Int
    ) throws {
        guard maximumRequestBodyBytes >= 0, maximumResponseBodyBytes > 0,
            maximumHeaderCount > 0, maximumHeaderBytes > 0
        else {
            throw HTTPValidationError.invalidLimitConfiguration
        }
        self.init(
            validatedRequestBodyBytes: maximumRequestBodyBytes,
            responseBodyBytes: maximumResponseBodyBytes,
            headerCount: maximumHeaderCount,
            headerBytes: maximumHeaderBytes
        )
    }

    private init(
        validatedRequestBodyBytes: Int,
        responseBodyBytes: Int,
        headerCount: Int,
        headerBytes: Int
    ) {
        maximumRequestBodyBytes = validatedRequestBodyBytes
        maximumResponseBodyBytes = responseBodyBytes
        maximumHeaderCount = headerCount
        maximumHeaderBytes = headerBytes
    }
}

public struct APIOrigin: Equatable, Sendable {
    public let baseURL: URL

    private let normalizedHost: String
    private let normalizedPort: Int

    public init(_ baseURL: URL) throws {
        guard let components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw HTTPValidationError.missingHost
        }
        guard components.scheme?.lowercased() == "https" else {
            throw HTTPValidationError.insecureScheme
        }
        guard let host = components.host?.lowercased(), !host.isEmpty else {
            throw HTTPValidationError.missingHost
        }
        guard components.user == nil, components.password == nil else {
            throw HTTPValidationError.credentialsInURL
        }
        guard components.path.isEmpty || components.path == "/" else {
            throw HTTPValidationError.originContainsPath
        }
        guard components.query == nil, components.fragment == nil else {
            throw HTTPValidationError.originContainsQueryOrFragment
        }

        var canonical = URLComponents()
        canonical.scheme = "https"
        canonical.host = host
        if let port = components.port, port != 443 {
            canonical.port = port
        }
        canonical.path = "/"
        guard let canonicalURL = canonical.url else {
            throw HTTPValidationError.missingHost
        }

        self.baseURL = canonicalURL
        normalizedHost = host
        normalizedPort = components.port ?? 443
    }

    public func endpoint(
        path: String,
        queryItems: [URLQueryItem] = []
    ) throws -> URL {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\\"),
            !path.contains("?"), !path.contains("#")
        else {
            throw HTTPValidationError.invalidEndpointPath
        }

        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !segments.contains("."), !segments.contains("..") else {
            throw HTTPValidationError.invalidEndpointPath
        }

        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.path = path
        components?.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let result = components?.url else {
            throw HTTPValidationError.invalidEndpointPath
        }
        return result
    }

    public func validate(_ url: URL) throws {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw HTTPValidationError.crossOriginRequest
        }
        guard components.user == nil, components.password == nil else {
            throw HTTPValidationError.credentialsInURL
        }
        guard components.scheme?.lowercased() == "https",
            components.host?.lowercased() == normalizedHost,
            (components.port ?? 443) == normalizedPort
        else {
            throw HTTPValidationError.crossOriginRequest
        }
        guard components.fragment == nil else {
            throw HTTPValidationError.crossOriginRequest
        }
    }
}

public struct HTTPMessageValidator: Sendable {
    public let origin: APIOrigin
    public let limits: HTTPMessageLimits

    public init(origin: APIOrigin, limits: HTTPMessageLimits = .standard) {
        self.origin = origin
        self.limits = limits
    }

    public func validate(_ request: HTTPRequest) throws {
        try origin.validate(request.url)
        if request.body?.count ?? 0 > limits.maximumRequestBodyBytes {
            throw HTTPValidationError.requestBodyTooLarge(
                maximumBytes: limits.maximumRequestBodyBytes
            )
        }
        try validate(headers: request.headers)
    }

    public func validate(_ response: HTTPResponse) throws {
        guard (100...599).contains(response.statusCode) else {
            throw HTTPValidationError.invalidStatusCode(response.statusCode)
        }
        if (300...399).contains(response.statusCode), response.statusCode != 304 {
            throw HTTPValidationError.redirectRejected(statusCode: response.statusCode)
        }
        if response.body.count > limits.maximumResponseBodyBytes {
            throw HTTPValidationError.responseBodyTooLarge(
                maximumBytes: limits.maximumResponseBodyBytes
            )
        }
        try validate(headers: response.headers)
    }

    private func validate(headers: HTTPHeaders) throws {
        guard headers.count <= limits.maximumHeaderCount else {
            throw HTTPValidationError.tooManyHeaders(maximum: limits.maximumHeaderCount)
        }
        let byteCount = headers.allFields.reduce(into: 0) { count, field in
            count += field.key.utf8.count + field.value.utf8.count + 4
        }
        guard byteCount <= limits.maximumHeaderBytes else {
            throw HTTPValidationError.headersTooLarge(maximumBytes: limits.maximumHeaderBytes)
        }
    }
}
