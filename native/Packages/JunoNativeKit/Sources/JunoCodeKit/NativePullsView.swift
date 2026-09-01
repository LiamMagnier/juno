import JunoAuth
import JunoCore
import JunoDesignSystem
import SwiftUI

/// The pull requests Juno Code opened from your sessions.
///
/// Shared by both apps: the list is the same nine fields on either platform, and
/// the only thing a Mac would do differently is sit in a sidebar destination
/// rather than a navigation stack — which is the caller's business, not this
/// view's.
///
/// The empty states are the substance here. A list with nothing in it can mean
/// three different things, and collapsing them into one blank page is how a
/// reader ends up waiting for PRs that were never going to arrive because GitHub
/// was never connected.
public struct NativePullsView: View {
    private let client: NativeGitHubPullsClient?
    private let accountID: AccountID?
    /// Opens the app's connected-accounts screen. Nil where the caller has none
    /// to offer, in which case the empty state explains without a button.
    private let openConnections: (() -> Void)?

    @State private var pulls: [NativeGitHubPull] = []
    @State private var unavailable: NativePullsUnavailable?
    @State private var loading = true

    public init(
        client: NativeGitHubPullsClient?,
        accountID: AccountID?,
        openConnections: (() -> Void)? = nil
    ) {
        self.client = client
        self.accountID = accountID
        self.openConnections = openConnections
    }

    public var body: some View {
        Group {
            if loading {
                ProgressView().controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if case .notConnected = unavailable {
                ContentUnavailableView {
                    JunoIconLabel("GitHub isn’t connected", systemImage: "point.3.connected.trianglepath.dotted")
                } description: {
                    Text("Connect GitHub to see the pull requests Juno Code opens from your sessions.")
                } actions: {
                    if let openConnections {
                        Button("Open Connections", action: openConnections)
                            .buttonStyle(.borderedProminent)
                            .contentShape(.rect)
                            .frame(minHeight: 44)
                    }
                }
            } else if case .failed(let message) = unavailable {
                ContentUnavailableView {
                    JunoIconLabel("Couldn’t load pull requests", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try again") { Task { await load() } }
                        .buttonStyle(.bordered)
                        .contentShape(.rect)
                        .frame(minHeight: 44)
                }
            } else if pulls.isEmpty {
                ContentUnavailableView(
                    "No pull requests",
                    systemImage: "arrow.trianglehead.pull",
                    description: Text("Pull requests Juno Code opens from your sessions appear here.")
                )
            } else {
                list
            }
        }
        .navigationTitle("Pull requests")
        .task(id: accountID?.rawValue) { await load() }
        .refreshable { await load() }
    }

    private var list: some View {
        List(pulls) { pull in
            Link(destination: pull.url) {
                HStack(alignment: .top, spacing: JunoSpace.cozy) {
                    // Colour AND glyph, so draft is legible without either one:
                    // an open PR is a filled arrow, a draft is a hollow one.
                    JunoIconView(systemImage: pull.isDraft ? "arrow.trianglehead.pull" : "arrow.trianglehead.merge")
                        .junoFont(size: 14, relativeTo: .body, weight: .medium)
                        .foregroundStyle(pull.isDraft ? Color.junoMutedForeground : Color.junoSuccess)
                        .frame(width: 20)
                        .padding(.top, 1)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(pull.title)
                            .junoFont(size: 14, relativeTo: .body, weight: .medium)
                            .foregroundStyle(Color.primary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        Text(subtitle(for: pull))
                            .junoFont(size: 11, relativeTo: .body, design: .monospaced)
                            .foregroundStyle(Color.junoMutedForeground)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }

                    Spacer(minLength: JunoSpace.snug)

                    if let updated = pull.updatedAt {
                        Text(updated, format: .relative(presentation: .numeric, unitsStyle: .narrow))
                            .junoFont(size: 11, relativeTo: .body, design: .monospaced)
                            .foregroundStyle(Color.junoMutedForeground.opacity(0.8))
                            .lineLimit(1)
                    }
                }
                .padding(.vertical, 4)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(accessibilityLabel(for: pull))
        }
    }

    /// `owner/repo #12 · branch · draft` — the repo first, because a reader with
    /// several projects is scanning for the project before the number.
    private func subtitle(for pull: NativeGitHubPull) -> String {
        [
            pull.repo,
            "#\(pull.number)",
            pull.headRef,
            pull.isDraft ? "draft" : nil,
        ]
        .compactMap { $0 }
        .joined(separator: " · ")
    }

    private func accessibilityLabel(for pull: NativeGitHubPull) -> String {
        [
            pull.isDraft ? "Draft pull request" : "Pull request",
            pull.title,
            "in \(pull.repo), number \(pull.number)",
        ]
        .joined(separator: ", ")
    }

    private func load() async {
        guard let client, let accountID else {
            loading = false
            unavailable = .failed("Sign in to see your pull requests.")
            return
        }
        loading = true
        switch await client.pulls(for: accountID) {
        case .success(let items):
            pulls = items
            unavailable = nil
        case .failure(let reason):
            pulls = []
            unavailable = reason
        }
        loading = false
    }
}
