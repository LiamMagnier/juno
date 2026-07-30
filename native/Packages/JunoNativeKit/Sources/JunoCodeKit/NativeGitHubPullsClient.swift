import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// One pull request Juno Code opened.
public struct NativeGitHubPull: Identifiable, Equatable, Sendable {
    /// `owner/name#number` — unique across repositories, which the number alone
    /// is not.
    public var id: String { "\(repo)#\(number)" }

    public let repo: String
    public let number: Int
    public let title: String
    public let url: URL
    public let isDraft: Bool
    public let state: String
    public let updatedAt: Date?
    /// The branch the PR is from, when GitHub reported one.
    public let headRef: String?

    public init(
        repo: String,
        number: Int,
        title: String,
        url: URL,
        isDraft: Bool,
        state: String,
        updatedAt: Date?,
        headRef: String?
    ) {
        self.repo = repo
        self.number = number
        self.title = title
        self.url = url
        self.isDraft = isDraft
        self.state = state
        self.updatedAt = updatedAt
        self.headRef = headRef
    }
}

/// Why the list is empty, when it is.
///
/// "No pull requests" and "GitHub is not connected" look identical as an empty
/// list and mean completely different things — one is nothing to do, the other is
/// a setup step. The route distinguishes them and so does this.
public enum NativePullsUnavailable: Error, Equatable, Sendable {
    case notConnected
    case failed(String)
}

/// The pull requests Juno Code has opened, from `GET /api/code/github/pulls`.
///
/// The server owns the GitHub call entirely — it holds the connection's token,
/// runs the GraphQL search and normalises the result — so this asks and renders.
/// No GitHub credential ever reaches a client, which is the reason the route
/// exists rather than the apps talking to GitHub directly.
public struct NativeGitHubPullsClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func pulls(for accountID: AccountID) async -> Result<[NativeGitHubPull], NativePullsUnavailable> {
        guard
            let request = try? NativeBearerRequest(
                path: "/api/code/github/pulls",
                method: .get,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            let response = try? await sender.send(request, for: accountID)
        else {
            return .failure(.failed("Couldn’t reach Juno."))
        }

        // 428 is the route's own "connect GitHub first". Treating it as a plain
        // failure would put a network error in front of a reader whose only
        // problem is that they have not linked an account yet.
        if response.statusCode == 428 || response.statusCode == 412 {
            return .failure(.notConnected)
        }
        guard (200...299).contains(response.statusCode) else {
            if let envelope = try? JSONDecoder().decode(ErrorWire.self, from: response.body),
               let message = envelope.error, !message.isEmpty {
                return .failure(.failed(message))
            }
            return .failure(.failed("Couldn’t load pull requests."))
        }
        guard let wire = try? JSONDecoder().decode(ResponseWire.self, from: response.body) else {
            return .failure(.failed("Couldn’t read the response."))
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()

        return .success(
            wire.pulls.compactMap { item in
                guard let url = URL(string: item.url) else { return nil }
                let updated = item.updatedAt.flatMap {
                    formatter.date(from: $0) ?? plain.date(from: $0)
                }
                return NativeGitHubPull(
                    repo: item.repo,
                    number: item.number,
                    title: item.title.isEmpty ? "#\(item.number)" : item.title,
                    url: url,
                    isDraft: item.draft ?? false,
                    state: item.state ?? "OPEN",
                    updatedAt: updated,
                    headRef: item.headRef
                )
            }
        )
    }
}

private struct ResponseWire: Decodable {
    struct Item: Decodable {
        let repo: String
        let number: Int
        let title: String
        let url: String
        let draft: Bool?
        let state: String?
        let updatedAt: String?
        let headRef: String?
    }

    let pulls: [Item]

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        pulls = ((try? container.decodeIfPresent([Item].self, forKey: .pulls)) ?? nil) ?? []
    }

    private enum CodingKeys: String, CodingKey { case pulls }
}

private struct ErrorWire: Decodable {
    let error: String?
}
