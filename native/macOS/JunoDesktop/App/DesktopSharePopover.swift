import AppKit
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import Observation
import SwiftUI

// MARK: - What is being shared

/// A chat, or an artifact (seam 7: the Artifacts page and the canvas dock
/// reach it at integration).
enum DesktopShareTarget: Equatable {
    case chat(String)
    case artifact(String)

    /// The web's words (`share-dialog.tsx`), verbatim.
    var title: String {
        switch self {
        case .chat: "Share this chat"
        case .artifact: "Share this artifact"
        }
    }

    var description: String {
        switch self {
        case .chat: "People with the link see the conversation up to now. New messages stay private."
        case .artifact: "People with the link see this artifact as it is now. Later edits stay private."
        }
    }
}

/// What the popover asks of the server: a link, and taking one back. A
/// protocol so the state machine can be driven by a stub. Main-actor bound,
/// as the state that calls it is.
@MainActor
protocol DesktopShareService {
    func create(_ target: DesktopShareTarget) async throws -> NativeShare
    func revoke(shareID: String) async throws
}

/// The live service, over `NativeShareClient`.
@MainActor
struct DesktopNativeShareService: DesktopShareService {
    let client: NativeShareClient
    let accountID: AccountID

    func create(_ target: DesktopShareTarget) async throws -> NativeShare {
        switch target {
        case .chat(let id): try await client.share(conversationID: id, for: accountID)
        case .artifact(let id): try await client.share(artifactID: id, for: accountID)
        }
    }

    func revoke(shareID: String) async throws {
        try await client.revoke(shareID: shareID, for: accountID)
    }
}

// MARK: - State

/// Where a Share stands (Phase 3 brief, B2). Held by the window, so the
/// toolbar's Share, the title menu's and row menus' Share… and a reply's
/// Share Chat… all present the one popover.
///
/// The web's five states: the link being made, a failure with Try Again, a
/// refusal in the server's words, the link itself, and a revoked link with
/// "Create a new link". Opening it makes the link — the route is idempotent
/// per target, so opening twice yields the same one — and nothing is put on
/// the pasteboard until the reader presses Copy.
@MainActor
@Observable
final class DesktopShareState {
    enum Phase: Equatable {
        case idle
        case loading
        case ready(NativeShare)
        case error
        /// The server's sentence, or the web's fallback.
        case blocked(String)
        case revoked
    }

    var isPresented = false
    private(set) var phase: Phase = .idle
    /// A revoke the server refused, said on the popover's own line when it
    /// sits in a sheet, where a toast would land on the window behind (§7.7).
    private(set) var revokeFailed = false
    private(set) var target: DesktopShareTarget?
    private(set) var isRevoking = false
    /// "Copied" for 1.5s after Copy.
    private(set) var copied = false

    private var service: (any DesktopShareService)?
    /// The link being made, awaitable by tests and snapshots.
    private(set) var createTask: Task<Void, Never>?
    private var attempt = 0
    private var copyReset: Task<Void, Never>?
    /// How long "Copied" stays, shortened by tests.
    var copiedDuration: Duration = .milliseconds(1500)

    /// The conversation the popover is about, when it is a chat's.
    ///
    /// A row's Share… opens its chat and shares it in the same gesture, and
    /// the window closes the popover when the selection moves. The window
    /// closes it only when the newly selected chat is *not* this one — see
    /// ``selectionClosesPopover(sharing:selected:)``.
    var conversationID: String? {
        if case .chat(let id) = target { return id }
        return nil
    }

    /// Whether moving the selection to `selected` should close a popover
    /// opened for `sharing`: always, unless the chat now selected is the one
    /// being shared.
    nonisolated static func selectionClosesPopover(sharing: String?, selected: String?) -> Bool {
        sharing != selected
    }

    /// Opens the popover on `target` and makes its link. A second start for
    /// the same target while one is being made changes nothing.
    func start(_ target: DesktopShareTarget, service: any DesktopShareService) {
        if self.target == target, phase == .loading {
            isPresented = true
            return
        }
        self.target = target
        self.service = service
        copied = false
        isRevoking = false
        revokeFailed = false
        isPresented = true
        createTask = Task { await create() }
    }

    /// Try Again, and Create a New Link.
    func retry() {
        createTask = Task { await create() }
    }

    /// Makes the link. A later start for another target owns the popover: an
    /// answer for the earlier one is dropped.
    func create() async {
        guard let target, let service else { return }
        attempt += 1
        let token = attempt
        phase = .loading
        do {
            let share = try await service.create(target)
            guard token == attempt, self.target == target else { return }
            phase = .ready(share)
        } catch NativeShareError.blocked(let reason) {
            guard token == attempt, self.target == target else { return }
            let sentence = reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            phase = .blocked(sentence.isEmpty ? "This can’t be shared." : sentence)
        } catch {
            guard token == attempt, self.target == target else { return }
            phase = .error
        }
    }

    /// Copy: the link on the pasteboard, and "Copied" for 1.5s.
    func copy(to pasteboard: (String) -> Void = JunoPasteboard.copy) {
        guard case .ready(let share) = phase else { return }
        pasteboard(share.url.absoluteString)
        copied = true
        copyReset?.cancel()
        let duration = copiedDuration
        copyReset = Task { [weak self] in
            try? await Task.sleep(for: duration)
            guard !Task.isCancelled else { return }
            self?.copied = false
        }
    }

    /// Revoke Link. The outcome is said in the window's toast host, as the
    /// web says it: the popover is not a sheet, but its failure is about the
    /// whole link, not one row in it.
    func revoke(notify: (JunoToast) -> Void) async {
        guard case .ready(let share) = phase, let service, !isRevoking else { return }
        isRevoking = true
        revokeFailed = false
        defer { isRevoking = false }
        do {
            try await service.revoke(shareID: share.id)
            guard case .ready(let current) = phase, current.id == share.id else { return }
            copied = false
            phase = .revoked
            notify(.success("Link revoked. It no longer works."))
        } catch {
            revokeFailed = true
            notify(.error("Couldn’t revoke the link."))
        }
    }

    /// Closes the popover; the next open starts fresh.
    func close() {
        isPresented = false
    }
}

// MARK: - The popover

/// The Share popover (Phase 3 brief, B2; spec §7.3, register P3-16): the
/// web's dialog, in a toolbar-anchored popover, with the system's More… for
/// the share sheet.
///
/// **An explicit frame** in every state (crash rule 2), one constant per
/// state so no state hangs a blank half-popover under its words (register
/// #174): ready 360 × 204, loading and error 176, revoked 180, blocked 132.
/// **The signature detail** is the Copy button turning to a check and
/// "Copied": the one moment the popover changes under the pointer, and the
/// acknowledgement the old silent copy never gave.
struct DesktopSharePopover: View {
    @Bindable var state: DesktopShareState
    /// In a sheet (an artifact's Share…), where toasts are never shown: a
    /// revoke's outcome is said on the popover's own lines instead.
    var presentsInSheet = false

    @Environment(\.junoToast) private var toast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The widest state, for a caller that sizes around the popover.
    static let size = CGSize(width: 360, height: 204)

    static func size(for phase: DesktopShareState.Phase) -> CGSize {
        switch phase {
        case .ready: CGSize(width: 360, height: 204)
        case .idle, .loading, .error: CGSize(width: 360, height: 176)
        case .revoked: CGSize(width: 360, height: 180)
        case .blocked: CGSize(width: 360, height: 132)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            let target = state.target ?? .chat("")
            Text(target.title)
                .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            Text(target.description)
                .junoFont(size: 12, relativeTo: .footnote)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, JunoSpace.tight)
            content
                .padding(.top, JunoSpace.cozy)
                .frame(maxHeight: .infinity, alignment: .top)
                .transition(.opacity)
        }
        .padding(12)
        .frame(
            width: Self.size(for: state.phase).width,
            height: Self.size(for: state.phase).height,
            alignment: .topLeading
        )
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: state.phase)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.desktop.share-popover")
    }

    @ViewBuilder
    private var content: some View {
        switch state.phase {
        case .idle, .loading:
            loading
        case .error:
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                statusLine(
                    icon: .error,
                    text: "Couldn’t create the link. Please try again.",
                    ink: Color.junoDestructiveInk
                )
                Button("Try Again") { state.retry() }
                    .buttonStyle(.junoGlass)
                    .tint(nil)
                    .contentShape(.rect)
            }
            .accessibilityElement(children: .contain)
        case .blocked(let reason):
            statusLine(icon: .error, text: reason, ink: Color.junoDestructiveInk)
        case .revoked:
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                statusLine(
                    icon: .unlink,
                    text: "The link was revoked. Anyone opening it now sees nothing.",
                    ink: Color.junoSecondaryInk
                )
                Button {
                    state.retry()
                } label: {
                    Label { Text("Create a New Link") } icon: { JunoIconView(.link, size: 14) }
                }
                .buttonStyle(.junoProminent)
                .contentShape(.rect)
            }
        case .ready(let share):
            ready(share)
        }
    }

    /// A field-shaped skeleton and a button-shaped one, then the caption's.
    private var loading: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(spacing: JunoSpace.snug) {
                JunoSkeleton(height: 32, cornerRadius: JunoRadius.field)
                JunoSkeleton(height: 32, width: 84, cornerRadius: JunoRadius.control)
            }
            JunoSkeleton(height: 12, width: 192, cornerRadius: JunoRadius.micro)
        }
        .accessibilityElement()
        .accessibilityLabel("Creating the link")
    }

    private func ready(_ share: NativeShare) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.snug) {
                DesktopShareLinkField(url: share.url.absoluteString)
                Button {
                    state.copy()
                    AccessibilityNotification.Announcement("Copied").post()
                } label: {
                    HStack(spacing: JunoSpace.tight) {
                        ZStack {
                            JunoIconView(.copy, size: 14)
                                .opacity(state.copied ? 0 : 1)
                                .scaleEffect(state.copied ? JunoMotion.scaleFrom(0.6, reduceMotion: reduceMotion) : 1)
                            JunoIconView(.check, size: 14)
                                .opacity(state.copied ? 1 : 0)
                                .scaleEffect(state.copied ? 1 : JunoMotion.scaleFrom(0.6, reduceMotion: reduceMotion))
                        }
                        .accessibilityHidden(true)
                        Text(state.copied ? "Copied" : "Copy")
                    }
                    .frame(minWidth: 64)
                }
                .buttonStyle(.junoProminent)
                .controlSize(.large)
                // The field's height at the control radius, not a capsule.
                .buttonBorderShape(.roundedRectangle(radius: JunoRadius.control))
                .contentShape(.rect)
                .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion, tier: .tint), value: state.copied)
                .accessibilityLabel(state.copied ? "Copied" : "Copy link")
            }
            HStack(spacing: JunoSpace.snug) {
                Text(Self.caption(for: share))
                    .junoFont(size: 11, relativeTo: .caption2)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                Spacer(minLength: JunoSpace.snug)
                Button {
                    let inSheet = presentsInSheet
                    Task { await state.revoke(notify: { if !inSheet { toast($0) } }) }
                } label: {
                    Text(state.isRevoking ? "Revoking…" : "Revoke Link")
                        .junoFont(size: 12, relativeTo: .footnote, weight: .medium)
                        .foregroundStyle(Color.junoDestructiveInk)
                        .frame(minHeight: 28)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .disabled(state.isRevoking)
                .accessibilityIdentifier("juno.desktop.share-popover.revoke")
            }
            if presentsInSheet, state.revokeFailed {
                statusLine(icon: .error, text: "Couldn’t revoke the link.", ink: Color.junoDestructiveInk)
            }
            Spacer(minLength: 0)
            ShareLink(item: share.url) {
                Label {
                    Text("More…")
                } icon: {
                    JunoIconView(.share, size: 14)
                }
                .junoFont(size: 12, relativeTo: .footnote)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(minHeight: 28)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help("Share the link another way")
        }
    }

    private func statusLine(icon: JunoIcon, text: String, ink: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            JunoIconView(icon, size: 14)
                .foregroundStyle(ink)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
                .accessibilityHidden(true)
            Text(text)
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    /// "Snapshot · Sep 22, 2026 · 14 views" — the web's caption, in SF
    /// tabular (register #40) rather than its mono.
    static func caption(for share: NativeShare, locale: Locale = .current) -> String {
        var parts = ["Snapshot"]
        if let date = share.snapshotAt ?? share.createdAt {
            parts.append(date.formatted(.dateTime.month(.abbreviated).day().year().locale(locale)))
        }
        parts.append("\(share.views) \(share.views == 1 ? "view" : "views")")
        return parts.joined(separator: " · ")
    }
}

/// The link, read-only: a 32pt field under the `--input` hairline at the
/// field radius, the URL in 12pt mono, selected whole when it takes focus.
private struct DesktopShareLinkField: View {
    let url: String

    @FocusState private var focused: Bool

    var body: some View {
        TextField("Share link", text: .constant(url))
            .textFieldStyle(.plain)
            .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
            .foregroundStyle(Color.junoForeground)
            .lineLimit(1)
            .truncationMode(.middle)
            .focused($focused)
            .padding(.horizontal, JunoSpace.close)
            .frame(maxWidth: .infinity, minHeight: 32, maxHeight: 32)
            .overlay {
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(focused ? Color.junoRing : Color.junoInput, lineWidth: 1)
            }
            .onChange(of: focused) { _, isFocused in
                guard isFocused else { return }
                // Selected on focus, as the web's `onFocus` select does.
                DispatchQueue.main.async {
                    NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil)
                }
            }
            .accessibilityLabel("Share link")
    }
}

// MARK: - In a sheet

/// An artifact's Share… (Phase 3 seam 7): the popover's content in a sheet,
/// with the Done a sheet needs. A popover closes on an outside click and a
/// sheet does not, so without it the reader had no way out but Esc, and the
/// web's dialog has its close button. Explicit frames per state, as the
/// popover's.
struct DesktopShareSheet: View {
    @Bindable var state: DesktopShareState

    static let footerHeight: CGFloat = 52

    var body: some View {
        let size = DesktopSharePopover.size(for: state.phase)
        VStack(spacing: 0) {
            DesktopSharePopover(state: state, presentsInSheet: true)
            Divider()
            HStack {
                Spacer(minLength: 0)
                Button("Done") { state.close() }
                    .buttonStyle(.junoGlass)
                    .tint(nil)
                    .keyboardShortcut(.cancelAction)
                    .contentShape(.rect)
                    .accessibilityIdentifier("juno.desktop.share-sheet.done")
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: Self.footerHeight)
        }
        .frame(width: size.width, height: size.height + Self.footerHeight)
        .presentationSizing(.fitted)
    }
}
