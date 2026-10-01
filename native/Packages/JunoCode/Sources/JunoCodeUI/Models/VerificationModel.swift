import Foundation
import Observation
import JunoCodeCore
import JunoCodeLocal

/// A session's verification state as the reader sees it: the recipe card that
/// asks once whether Juno's discovered checks should become this project's
/// (CODE_AGENT_SPEC §1.8). The recorded checks and the run report render from
/// the transcript (`StudioVerificationRows`, `StudioRunReport`).
///
/// Owned by Lane B (verification, self-review and report). `SessionController`
/// holds one per session, so a "Not now" in one session does not silence the
/// card in another.
@MainActor
@Observable
public final class VerificationModel {
    /// What the card asks about.
    public struct Proposal: Equatable, Sendable {
        public enum Kind: Equatable, Sendable {
            /// No `.juno/verify.json` yet: these are the checks Juno found.
            case discovered
            /// `.juno/verify.json` changed since it was accepted: these are its
            /// new contents, as read with this digest.
            case changed(digest: String)
        }

        public var recipe: VerifyRecipe
        public var kind: Kind

        public init(recipe: VerifyRecipe, kind: Kind) {
            self.recipe = recipe
            self.kind = kind
        }

        /// The exact rules "Run these without asking" would write.
        public var rules: [PermissionRule] { recipe.permissionRules }
    }

    /// The card to show, or nil.
    public private(set) var proposal: Proposal?
    /// The card's second, separately ticked option. Off until the reader
    /// ticks it, for every new card.
    public var runWithoutAsking = false
    /// What the last Accept did, in words, until the next card.
    public private(set) var confirmation: String?
    /// Why Accept failed, in words.
    public private(set) var problem: String?
    public private(set) var isSaving = false

    private let makeStore: @Sendable (URL) -> VerifyRecipeStore
    /// The cards the reader answered "Not now" to, by what they showed: not
    /// shown again in this session.
    private var dismissed: Set<String> = []
    /// The last state the transcript was checked in, so each change is looked
    /// at once.
    private var lastCheckedKey: String?
    /// Discovery's answer for this session, run at most once.
    private var discovered: VerifyRecipe?
    /// How far through the transcript `update` has read, and whether a file
    /// changed since the reader's latest message in what it read: the
    /// transcript grows by a line per output chunk, so it is read once.
    private var readThrough = 0
    private var changedSinceLatestMessage = false

    public init(makeStore: @escaping @Sendable (URL) -> VerifyRecipeStore = { VerifyRecipeStore(workspaceRoot: $0) }) {
        self.makeStore = makeStore
    }

    // MARK: - When to ask

    /// Looks at the session again: called as its transcript grows.
    ///
    /// The card appears on first need: the first run in a project without
    /// `.juno/verify.json` that changes a file, when discovery found checks.
    /// It also appears when `.juno/verify.json` exists but these bytes were
    /// never accepted, since its commands are not offered to the model until
    /// they are.
    public func update(workspaceRoot: URL?, events: [SessionEvent]) async {
        guard let workspaceRoot else {
            proposal = nil
            return
        }
        if events.count < readThrough {
            // Rewound or reloaded: read it again from the start.
            readThrough = 0
            changedSinceLatestMessage = false
        }
        for event in events[readThrough...] {
            switch event.payload {
            case .fileChanged: changedSinceLatestMessage = true
            case .userPrompt: changedSinceLatestMessage = false
            default: break
            }
        }
        readThrough = events.count
        let changedThisRun = changedSinceLatestMessage
        let store = makeStore(workspaceRoot)
        let file = store.file()
        let key = "\(workspaceRoot.path)|\(changedThisRun)|\(Self.fileKey(file))"
        guard key != lastCheckedKey else { return }
        lastCheckedKey = key
        switch file {
        case .missing:
            guard changedThisRun else { return }
            let recipe: VerifyRecipe
            if let discovered {
                recipe = discovered
            } else {
                recipe = await store.discover()
                discovered = recipe
            }
            guard !recipe.isEmpty else { return }
            show(Proposal(recipe: recipe, kind: .discovered))
        case let .present(recipe, digest, accepted):
            if accepted {
                proposal = nil
            } else {
                show(Proposal(recipe: recipe, kind: .changed(digest: digest)))
            }
        case .invalid:
            proposal = nil
        }
    }

    private static func fileKey(_ file: VerifyRecipeFile) -> String {
        switch file {
        case .missing: "missing"
        case let .present(_, digest, accepted): "\(digest)|\(accepted)"
        case let .invalid(_, digest): "invalid|\(digest)"
        }
    }

    /// Shows a card, unless the reader already said "Not now" to this one.
    func show(_ next: Proposal) {
        guard !dismissed.contains(Self.key(for: next)), next != proposal else { return }
        proposal = next
        runWithoutAsking = false
        problem = nil
        confirmation = nil
    }

    private static func key(for proposal: Proposal) -> String {
        switch proposal.kind {
        case .discovered:
            (try? proposal.recipe.encoded()).map { "d:" + Digests.sha256Hex($0) } ?? "d"
        case let .changed(digest):
            "c:" + digest
        }
    }

    // MARK: - The reader's answer

    /// "Use these checks".
    public func accept(workspaceRoot: URL?) async {
        guard let proposal, let workspaceRoot else { return }
        isSaving = true
        defer { isSaving = false }
        let store = makeStore(workspaceRoot)
        do {
            let acceptance: VerifyRecipeAcceptance?
            switch proposal.kind {
            case .discovered:
                acceptance = try store.accept(proposal.recipe, runWithoutAsking: runWithoutAsking, expectingNoFile: true)
            case let .changed(digest):
                acceptance = try store.acceptExisting(expectedDigest: digest, runWithoutAsking: runWithoutAsking)
            }
            guard let acceptance else {
                problem = ".juno/verify.json changed again while this was open. Look at the new version."
                self.proposal = nil
                lastCheckedKey = nil
                return
            }
            self.proposal = nil
            confirmation = Self.confirmation(for: acceptance, checks: proposal.recipe.checks.count)
            problem = nil
        } catch VerifyRecipeAcceptError.fileAppeared {
            problem = ".juno/verify.json appeared while this was open, so it was kept as it is. Look at its checks."
            self.proposal = nil
            lastCheckedKey = nil
        } catch {
            problem = "The checks could not be saved: \(error.localizedDescription)"
        }
    }

    /// "Not now": not asked again in this session.
    public func dismiss() {
        guard let proposal else { return }
        dismissed.insert(Self.key(for: proposal))
        self.proposal = nil
    }

    static func confirmation(for acceptance: VerifyRecipeAcceptance, checks: Int) -> String {
        var text = acceptance.wroteRecipe
            ? "Saved \(checks) check\(checks == 1 ? "" : "s") to .juno/verify.json."
            : "Using the checks in .juno/verify.json."
        if !acceptance.rulesAdded.isEmpty {
            text += " They run without asking in this repository."
        }
        return text
    }

    // MARK: - Previews and snapshots

    /// Shows `proposal` as if discovery had found it. For previews and
    /// snapshot tests; a live session reaches the card through `update`.
    public func preview(_ proposal: Proposal?, runWithoutAsking: Bool = false) {
        self.proposal = proposal
        self.runWithoutAsking = runWithoutAsking
    }
}
