import Foundation
import JunoAPI
import JunoAuth
import JunoCore

public protocol NativeAuthenticatedRequestSending: Sendable {
    func send(
        _ request: NativeBearerRequest,
        for accountID: AccountID
    ) async throws -> HTTPResponse
}

extension NativeAuthRuntime: NativeAuthenticatedRequestSending {}

public enum NativeBootstrapError: Error, Equatable, LocalizedError, Sendable {
    case server(statusCode: Int, code: String?)
    case malformedResponse
    case accountMismatch
    case contractVersionMismatch(expected: String, received: String)
    case invalidCursor(String)
    case invalidModelManifestVersion

    public var errorDescription: String? {
        switch self {
        case .server(let statusCode, let code):
            "Juno could not load your account (\(code ?? String(statusCode)))."
        case .malformedResponse:
            "Juno returned an invalid account bootstrap response."
        case .accountMismatch:
            "The Juno bootstrap belongs to another account."
        case .contractVersionMismatch:
            "This version of Juno is not compatible with the server."
        case .invalidCursor:
            "Juno returned an invalid synchronization cursor."
        case .invalidModelManifestVersion:
            "Juno returned an invalid model catalog version."
        }
    }
}

public struct NativeBootstrapCheckpoint: Equatable, Sendable {
    public let profile: NativeAccountProfile
    public let currentChangeCursor: String
    public let compactionFloorCursor: String
    public let modelManifestVersion: String
    public let minimumClientVersions: [String: String]

    public init(
        profile: NativeAccountProfile,
        currentChangeCursor: String,
        compactionFloorCursor: String,
        modelManifestVersion: String,
        minimumClientVersions: [String: String]
    ) {
        self.profile = profile
        self.currentChangeCursor = currentChangeCursor
        self.compactionFloorCursor = compactionFloorCursor
        self.modelManifestVersion = modelManifestVersion
        self.minimumClientVersions = minimumClientVersions
    }
}

public struct NativeBootstrapClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func fetch(for accountID: AccountID) async throws
        -> NativeBootstrapCheckpoint
    {
        let response = try await sender.send(
            NativeBearerRequest(path: "/api/v1/bootstrap"),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            let code = try? JSONDecoder().decode(
                NativeAPIErrorEnvelope.self,
                from: response.body
            ).error.code
            throw NativeBootstrapError.server(
                statusCode: response.statusCode,
                code: code
            )
        }

        let wire: BootstrapWireResponse
        do {
            wire = try JSONDecoder().decode(
                BootstrapWireResponse.self,
                from: response.body
            )
        } catch {
            throw NativeBootstrapError.malformedResponse
        }

        guard wire.contractVersion == JunoNativeContract.version else {
            throw NativeBootstrapError.contractVersionMismatch(
                expected: JunoNativeContract.version,
                received: wire.contractVersion
            )
        }
        let profileAccountID: AccountID
        do {
            profileAccountID = try AccountID(wire.profile.id)
        } catch {
            throw NativeBootstrapError.malformedResponse
        }
        guard profileAccountID == accountID else {
            throw NativeBootstrapError.accountMismatch
        }
        try validateCursor(wire.currentChangeCursor)
        try validateCursor(wire.compactionFloorCursor)

        let manifestVersion = wire.modelManifestVersion.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        guard (1...128).contains(manifestVersion.utf8.count),
            !manifestVersion.unicodeScalars.contains(where: {
                CharacterSet.controlCharacters.contains($0)
            })
        else {
            throw NativeBootstrapError.invalidModelManifestVersion
        }

        return NativeBootstrapCheckpoint(
            profile: NativeAccountProfile(
                id: profileAccountID,
                name: wire.profile.name,
                email: wire.profile.email,
                imageURL: wire.profile.image.flatMap(URL.init(string:))
            ),
            currentChangeCursor: wire.currentChangeCursor,
            compactionFloorCursor: wire.compactionFloorCursor,
            modelManifestVersion: manifestVersion,
            minimumClientVersions: wire.minimumClientVersions
        )
    }

    private func validateCursor(_ cursor: String) throws {
        guard cursor == "0" || (
            cursor.first != "0"
                && cursor.utf8.allSatisfy { (48...57).contains($0) }
                && Int64(cursor) != nil
        ) else {
            throw NativeBootstrapError.invalidCursor(cursor)
        }
    }
}

private struct BootstrapWireResponse: Decodable {
    struct Profile: Decodable {
        let id: String
        let name: String?
        let email: String
        let image: String?
    }

    let profile: Profile
    let currentChangeCursor: String
    let compactionFloorCursor: String
    let modelManifestVersion: String
    let contractVersion: String
    let minimumClientVersions: [String: String]
}
