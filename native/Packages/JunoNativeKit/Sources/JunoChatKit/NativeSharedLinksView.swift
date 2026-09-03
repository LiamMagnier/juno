import JunoAuth
import JunoCore
import JunoDesignSystem
import SwiftUI

/// Every public link this account has handed out, and the way to take one back.
///
/// The list is the reason sharing is safe to offer at all. A link is live until it
/// is revoked, so an account that can create them and cannot see them has given
/// away documents it can no longer name. The view count is here for the same
/// reason — it is the only evidence a reader has that a link was used.
///
/// A share is a SNAPSHOT, which the rows state rather than imply: `snapshotAt` is
/// when the conversation was published, and turns added since are not in it.
public struct NativeSharedLinksView: View {
    private let client: NativeShareClient?
    private let accountID: AccountID?

    @State private var shares: [NativeShare] = []
    @State private var loading = true
    @State private var revoking: Set<String> = []
    @State private var errorDescription: String?

    public init(client: NativeShareClient?, accountID: AccountID?) {
        self.client = client
        self.accountID = accountID
    }

    public var body: some View {
        Group {
            if loading {
                ProgressView().controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if shares.isEmpty {
                ContentUnavailableView {
                    Label("No shared links", icon: .link, size: 28)
                } description: {
                    Text("Links you create from a conversation appear here until you revoke them.")
                }
            } else {
                List {
                    if let errorDescription {
                        Text(errorDescription)
                            .junoCaption()
                            .foregroundStyle(Color.junoDanger)
                    }
                    ForEach(shares) { share in
                        row(share)
                    }
                }
            }
        }
        .navigationTitle("Shared links")
        .task(id: accountID?.rawValue) { await load() }
        .refreshable { await load() }
    }

    private func row(_ share: NativeShare) -> some View {
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: 3) {
                Text(share.title ?? "Untitled conversation")
                    .junoFont(size: 14, relativeTo: .body, weight: .medium)
                    .lineLimit(2)
                Text(detail(for: share))
                    .junoFont(size: 11, relativeTo: .body, design: .monospaced)
                    .foregroundStyle(Color.junoMutedForeground)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: JunoSpace.snug)

            ShareLink(item: share.url) {
                JunoIconView(.share)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.junoMutedForeground)
            .accessibilityLabel("Share link again")

            Button {
                Task { await revoke(share) }
            } label: {
                if revoking.contains(share.id) {
                    ProgressView().controlSize(.small)
                } else {
                    JunoIconView(.trash)
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.junoDanger)
            .disabled(revoking.contains(share.id))
            .accessibilityLabel("Revoke link")
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    /// Views first, because it is the only line that changes after a link is made
    /// and the only one that answers "did anyone open this?".
    private func detail(for share: NativeShare) -> String {
        var parts = [share.views == 1 ? "1 view" : "\(share.views) views"]
        if let snapshot = share.snapshotAt {
            parts.append("snapshot \(snapshot.formatted(date: .abbreviated, time: .shortened))")
        }
        parts.append(share.url.host() ?? share.token)
        return parts.joined(separator: " · ")
    }

    private func load() async {
        guard let client, let accountID else {
            loading = false
            return
        }
        loading = true
        shares = await client.shares(for: accountID)
        loading = false
    }

    private func revoke(_ share: NativeShare) async {
        guard let client, let accountID else { return }
        revoking.insert(share.id)
        defer { revoking.remove(share.id) }
        do {
            try await client.revoke(shareID: share.id, for: accountID)
            // Removed locally rather than by refetching: the link is dead the
            // moment the server says so, and a reader watching a row they just
            // revoked should not see it linger through a round trip.
            shares.removeAll { $0.id == share.id }
            errorDescription = nil
        } catch {
            errorDescription = "Couldn’t revoke that link. It is still live."
        }
    }
}
