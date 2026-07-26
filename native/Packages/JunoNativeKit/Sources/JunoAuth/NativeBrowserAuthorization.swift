import Foundation
import JunoAPI
import JunoCore

public enum NativeBrowserAuthorizationError: Error, Equatable, LocalizedError,
    Sendable
{
    case invalidInstallationIdentifier
    case invalidRedirectURI
    case invalidCallback
    case malformedAuthorizationCode
    case malformedStoredInstallationIdentifier

    public var errorDescription: String? {
        switch self {
        case .invalidInstallationIdentifier,
            .malformedStoredInstallationIdentifier:
            "The secure device identifier is invalid."
        case .invalidRedirectURI:
            "The Juno sign-in callback is not configured correctly."
        case .invalidCallback, .malformedAuthorizationCode:
            "The browser returned an invalid sign-in response."
        }
    }
}

public struct NativeAuthorizationAttempt: Sendable {
    public let authorizationURL: URL
    public let callbackScheme: String

    let state: OAuthCorrelationValue
    let nonce: OAuthCorrelationValue
    let verifier: PKCECodeVerifier
    let installationID: InstallationID
    let redirectURI: String

    init(
        authorizationURL: URL,
        callbackScheme: String,
        state: OAuthCorrelationValue,
        nonce: OAuthCorrelationValue,
        verifier: PKCECodeVerifier,
        installationID: InstallationID,
        redirectURI: String
    ) {
        self.authorizationURL = authorizationURL
        self.callbackScheme = callbackScheme
        self.state = state
        self.nonce = nonce
        self.verifier = verifier
        self.installationID = installationID
        self.redirectURI = redirectURI
    }
}

public struct NativeAuthorizationPlanner: Sendable {
    private let origin: APIOrigin
    private let generator: PKCEGenerator
    private let redirectURI: URL

    public init(
        origin: APIOrigin,
        generator: PKCEGenerator = PKCEGenerator()
    ) throws {
        guard let redirectURI = URL(string: JunoNativeContract.canonicalRedirectURI),
            redirectURI.scheme == "com.liammagnier.juno",
            redirectURI.host == "auth",
            redirectURI.path == "/callback",
            redirectURI.query == nil,
            redirectURI.fragment == nil
        else {
            throw NativeBrowserAuthorizationError.invalidRedirectURI
        }
        self.origin = origin
        self.generator = generator
        self.redirectURI = redirectURI
    }

    public func makeAttempt(
        installationID: InstallationID
    ) throws -> NativeAuthorizationAttempt {
        guard Self.isValidInstallationID(installationID.rawValue) else {
            throw NativeBrowserAuthorizationError.invalidInstallationIdentifier
        }
        let pair = try generator.makePair()
        let state = try generator.makeCorrelationValue()
        let nonce = try generator.makeCorrelationValue()
        let authorizationURL = try origin.endpoint(
            path: "/app-auth",
            queryItems: [
                URLQueryItem(name: "state", value: state.value),
                URLQueryItem(name: "nonce", value: nonce.value),
                URLQueryItem(name: "code_challenge", value: pair.challenge.value),
                URLQueryItem(name: "code_challenge_method", value: "S256"),
                URLQueryItem(name: "redirect_uri", value: redirectURI.absoluteString),
                URLQueryItem(name: "installation_id", value: installationID.rawValue),
            ]
        )
        return NativeAuthorizationAttempt(
            authorizationURL: authorizationURL,
            callbackScheme: redirectURI.scheme ?? "",
            state: state,
            nonce: nonce,
            verifier: pair.verifier,
            installationID: installationID,
            redirectURI: redirectURI.absoluteString
        )
    }

    public func authorizationCode(
        from callbackURL: URL,
        for attempt: NativeAuthorizationAttempt
    ) throws -> String {
        guard callbackURL.scheme?.lowercased() == attempt.callbackScheme,
            callbackURL.host?.lowercased() == "auth",
            callbackURL.path == "/callback",
            callbackURL.port == nil,
            callbackURL.user == nil,
            callbackURL.password == nil,
            callbackURL.fragment == nil,
            let components = URLComponents(
                url: callbackURL,
                resolvingAgainstBaseURL: false
            ),
            let queryItems = components.queryItems,
            let returnedState = Self.uniqueValue(named: "state", in: queryItems),
            let returnedNonce = Self.uniqueValue(named: "nonce", in: queryItems),
            returnedState == attempt.state.value,
            returnedNonce == attempt.nonce.value,
            let code = Self.uniqueValue(named: "code", in: queryItems)
        else {
            throw NativeBrowserAuthorizationError.invalidCallback
        }
        guard (1...512).contains(code.utf8.count),
            code.utf8.allSatisfy(Self.isBase64URLByte)
        else {
            throw NativeBrowserAuthorizationError.malformedAuthorizationCode
        }
        return code
    }

    private static func uniqueValue(
        named name: String,
        in queryItems: [URLQueryItem]
    ) -> String? {
        let values = queryItems.filter { $0.name == name }.compactMap(\.value)
        return values.count == 1 ? values[0] : nil
    }

    static func isValidInstallationID(_ value: String) -> Bool {
        (16...200).contains(value.utf8.count) && value.utf8.allSatisfy { byte in
            switch byte {
            case 48...57, 65...90, 97...122, 45, 46, 58, 95:
                true
            default:
                false
            }
        }
    }

    private static func isBase64URLByte(_ byte: UInt8) -> Bool {
        switch byte {
        case 48...57, 65...90, 97...122, 45, 95:
            true
        default:
            false
        }
    }
}

public actor KeychainInstallationIDStore {
    private static let item = SecurityKeychainItem(
        service: "com.liammagnier.juno.auth.installation",
        account: "current"
    )

    private let securityClient: any SecurityKeychainClient
    private let generator: PKCEGenerator

    public init(
        securityClient: any SecurityKeychainClient = SystemSecurityKeychainClient(),
        generator: PKCEGenerator = PKCEGenerator()
    ) {
        self.securityClient = securityClient
        self.generator = generator
    }

    public func loadOrCreate() throws -> InstallationID {
        if let data = try securityClient.read(Self.item) {
            guard let rawValue = String(data: data, encoding: .utf8),
                NativeAuthorizationPlanner.isValidInstallationID(rawValue),
                let installationID = try? InstallationID(rawValue)
            else {
                throw NativeBrowserAuthorizationError
                    .malformedStoredInstallationIdentifier
            }
            return installationID
        }

        let rawValue = try generator.makeCorrelationValue().value
        guard NativeAuthorizationPlanner.isValidInstallationID(rawValue) else {
            throw NativeBrowserAuthorizationError.invalidInstallationIdentifier
        }
        let installationID = try InstallationID(rawValue)
        if try securityClient.insertIfAbsent(Data(rawValue.utf8), for: Self.item) {
            return installationID
        }
        guard let stored = try securityClient.read(Self.item),
            let storedValue = String(data: stored, encoding: .utf8),
            NativeAuthorizationPlanner.isValidInstallationID(storedValue)
        else {
            throw NativeBrowserAuthorizationError
                .malformedStoredInstallationIdentifier
        }
        return try InstallationID(storedValue)
    }
}
