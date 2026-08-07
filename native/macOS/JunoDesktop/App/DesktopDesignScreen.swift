import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

// MARK: - Presets

/// The sizes a new design can start at.
///
/// The four the website offers, with the same names and the same numbers —
/// `src/app/(app)/design/page.tsx` lists them and `src/app/api/design/route.ts`
/// turns each into a frame. The raw values are the wire enum that route parses,
/// so renaming one here silently starts every design at 375×812 (the route's
/// default) rather than failing; ``DesktopDesignLauncherTests`` pins them.
///
/// Named for what is being designed rather than for the numbers, because the
/// choice a person is making is "a phone screen", not "812 points tall". The
/// numbers are still printed under the name — they are what tells a designer
/// this is the *device* size and not a canvas they will have to resize.
enum DesktopDesignPreset: String, CaseIterable, Identifiable {
    case phone
    case tablet
    case desktop
    case square

    var id: Self { self }

    var label: String {
        switch self {
        case .phone: "Phone"
        case .tablet: "Tablet"
        case .desktop: "Desktop"
        case .square: "Square"
        }
    }

    /// The frame the route actually creates. Duplicated from the server on
    /// purpose: this is a *label*, and a label that says 375 × 812 while the
    /// route builds something else is worse than no label at all — which is why
    /// the numbers are asserted against the route's own table in the tests.
    var size: CGSize {
        switch self {
        case .phone: CGSize(width: 375, height: 812)
        case .tablet: CGSize(width: 834, height: 1_194)
        case .desktop: CGSize(width: 1_440, height: 900)
        case .square: CGSize(width: 1_080, height: 1_080)
        }
    }

    /// "375 × 812", with the multiplication sign the web uses rather than an "x".
    var detail: String {
        "\(Int(size.width)) × \(Int(size.height))"
    }
}

// MARK: - Starting a design

enum DesktopDesignStartError: LocalizedError {
    case unavailable
    case malformedResponse
    case server(statusCode: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "Juno is not signed in to a backend that can start a design."
        case .malformedResponse:
            "Juno started the design but could not read where it went."
        case .server(_, let message):
            message
        }
    }
}

/// `POST /api/design` — the one route that starts a design from nothing.
///
/// The same route the website's launcher posts to, and deliberately not a
/// native shortcut around it: the route creates the conversation that owns the
/// artifact, expands the frame through the same authoring pass a model's design
/// goes through, and writes version 1. A client that built the `DesignDocument`
/// here and saved it as an artifact would produce a design that is subtly not
/// the same kind of object as every other one — and would have to be kept in
/// step with `expandAuthoredDesign` by hand, forever.
///
/// It rides ``NativeAuthenticatedRequestSending``, which is the app's only
/// authenticated transport — the same one ``NativeArtifactAPIClient`` and
/// ``JunoDesktopVoiceAuthorization`` use. Nothing here reaches for URLSession or
/// for the Keychain.
struct DesktopDesignStartClient: Sendable {
    let sender: any NativeAuthenticatedRequestSending

    /// - Returns: the new artifact's identifier. The route also answers with the
    ///   conversation it made and the web URL to send a browser to; neither is
    ///   useful to a Mac window that opens the document in place.
    func startDesign(
        preset: DesktopDesignPreset,
        title: String,
        for accountID: AccountID
    ) async throws -> String {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/design",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(
                    StartRequestWire(title: title, preset: preset.rawValue)
                )
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw DesktopDesignStartError.server(
                statusCode: response.statusCode,
                message: Self.serverMessage(response.body)
                    ?? Self.fallbackMessage(statusCode: response.statusCode)
            )
        }
        guard let decoded = try? JSONDecoder().decode(
            StartResponseWire.self,
            from: response.body
        ), !decoded.artifactId.isEmpty else {
            throw DesktopDesignStartError.malformedResponse
        }
        return decoded.artifactId
    }

    /// The route's own sentence when it has one. `403` in particular is a real
    /// answer — "your plan does not include the canvas" — and replacing it with a
    /// generic failure would tell a free-tier reader that Juno is broken rather
    /// than that the canvas is not on their plan.
    private static func serverMessage(_ body: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return nil }
        if let message = object["error"] as? String, !message.isEmpty { return message }
        if let message = object["message"] as? String, !message.isEmpty { return message }
        return nil
    }

    private static func fallbackMessage(statusCode: Int) -> String {
        switch statusCode {
        case 401: "Sign in again to start a design."
        case 403: "The canvas is not included in this account's plan."
        case 404: "This Juno server is too old to start a design."
        case 429: "Juno is busy. Wait a moment and try again."
        default: "Juno could not start a design."
        }
    }

    private struct StartRequestWire: Encodable {
        let title: String
        let preset: String
    }

    private struct StartResponseWire: Decodable {
        let artifactId: String
    }
}

// MARK: - The screen

/// Juno Design on the Mac: the sizes a design can start at, and the designs
/// there already are.
///
/// **What was missing was a door, not an editor.** The Mac has drawn design
/// documents properly for a while — ``DesktopDesignSurface`` decodes one and
/// hosts the bundled editor, reached from the artifacts library and from a
/// design in a conversation. What there was no way to do was *start* one, or see
/// the ones you had without hunting for them among every other artifact. That is
/// the whole of this screen, and it is why it is a launcher with an editor behind
/// it rather than a second design view: the same complaint the website's own
/// `design/page.tsx` opens with, answered the same way.
///
/// **Not a product mode.** Chat, Code and Work each own a whole window — their
/// own source list, their own toolbar, their own `NavigationSplitView` — and
/// Design owns none of that. On the web it is a destination in the sidebar
/// footer for exactly that reason, and the Mac's ``DesktopProductMode`` stays
/// three cases wide. This is a page inside a product's detail column, opened
/// from ``DesktopSidebarDesignRow``.
///
/// **One page, two states, the artifacts library's own shape.** A library and
/// then the document, swapped in place rather than pushed, because this view is
/// the content of a detail column and a second navigation stack inside one is a
/// column the window does not know it has. ``DesktopArtifactsScreen`` settled
/// that shape; this follows it so the two pages behave the same way when a
/// reader moves between them.
struct DesktopDesignScreen: View {
    @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>
    /// The account the design is started for.
    let accountID: AccountID
    /// The authenticated transport, or nil in a build with no backend composed.
    /// The presets are then disabled and say why, rather than failing on click.
    let requestSender: (any NativeAuthenticatedRequestSending)?
    /// Pulled after a design is created, because the new row exists on the server
    /// and nowhere on this Mac until synchronisation fetches it. See ``start(_:)``.
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?

    /// The design on screen, or nil while the launcher is showing.
    ///
    /// This screen's own state rather than `model.selectedArtifactID`: that
    /// property is what the artifacts library has open, and borrowing it would
    /// mean opening a design here silently re-pointed a page in another
    /// destination — including to a document its Back button would then return
    /// from into a library the reader never opened.
    @State private var openDesignID: String?
    /// `nil` while the editor is clean. The first accepted transaction stamps it,
    /// which is what makes Save honest about whether there is anything to save.
    @State private var draft: String?
    /// The preset whose request is in flight. Also the disabled flag for the
    /// other three: two designs started by a double-click is the one mistake this
    /// grid can make.
    @State private var starting: DesktopDesignPreset?
    @State private var startErrorDescription: String?
    @State private var deleteTarget: NativeArtifact?
    /// Bumped to re-read the document from storage. ``DesktopDesignSurface``
    /// reads its body once and treats the editor as the authority afterwards, so
    /// discarding an edit has to say so out loud or the canvas carries on drawing
    /// the very edit that was just discarded.
    @State private var designReloadToken = UUID()

    private var designs: [NativeArtifact] {
        model.artifacts.filter { $0.kind.isDesignDocument }
    }

    private var openDesign: NativeArtifact? {
        guard let openDesignID else { return nil }
        return model.artifacts.first { $0.id == openDesignID }
    }

    private var storedContent: String? { openDesign?.currentContent }

    private var isDirty: Bool {
        guard let draft, let storedContent else { return false }
        return draft != storedContent
    }

    var body: some View {
        // `Color.clear.overlay`, for the reason ``JunoDetailPage`` spells out: a
        // detail column that reports its content's ideal height resizes the
        // window's AppKit split view rather than being clipped by it, and the
        // editor below is a full-bleed web host with no opinion about how tall it
        // ought to be.
        Color.clear
            .overlay {
                if let design = openDesign {
                    document(design)
                } else {
                    launcher
                }
            }
            // A design that was deleted — here, on the phone, or on the web —
            // leaves the reader looking at an editor with nothing behind it.
            // Falling back to the launcher is the only honest state.
            .onChange(of: openDesign == nil) { _, gone in
                if gone { closeDesign() }
            }
            .onAppear { closeDesign() }
            .alert("Delete design?", isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            )) {
                Button("Cancel", role: .cancel) { deleteTarget = nil }
                Button("Delete", role: .destructive) {
                    guard let target = deleteTarget else { return }
                    deleteTarget = nil
                    Task { await delete(target) }
                }
            } message: {
                Text("Every version of this design and its history will be removed.")
            }
            .accessibilityIdentifier("juno.desktop.design")
    }

    // MARK: - Launcher

    private var launcher: some View {
        VStack(spacing: 0) {
            launcherHeader
            Divider()
            launcherContent
        }
    }

    private var launcherHeader: some View {
        VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            HStack(alignment: .bottom, spacing: JunoSpace.section) {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    Text("Design")
                        .junoPageHeading()
                    Text(
                        "Draw it yourself, or ask Juno. Either way it opens as an editable document you can restyle and hand to Juno Code."
                    )
                    .junoRowLabel()
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: JunoSpace.roomy)

                if !designs.isEmpty {
                    Text(designs.count == 1 ? "1 design" : "\(designs.count) designs")
                        .junoCaption()
                        .monospacedDigit()
                        .accessibilityIdentifier("juno.desktop.design.count")
                }
            }

            // Starting a design is the primary action, so it is the first thing
            // on the page rather than a button hiding above a list — the same
            // call the website's launcher makes, for the same reason.
            presetGrid

            if let notice {
                DesktopDesignNotice(message: notice)
            }
        }
        .padding(.horizontal, JunoSpace.region)
        .padding(.top, JunoSpace.section)
        .padding(.bottom, JunoSpace.roomy)
        .frame(maxWidth: DesktopDesignMetrics.pageWidth)
        .frame(maxWidth: .infinity)
    }

    /// The one line under the presets: why the last start failed, or — before any
    /// click at all — why they are disabled.
    ///
    /// The second half is not decoration. Four greyed-out tiles with a working
    /// list of designs underneath them is a page that looks broken, and the reason
    /// cannot be a tooltip: macOS does not show `help` on a disabled control, so a
    /// reader hovering the thing they cannot use is told nothing.
    private var notice: String? {
        if let startErrorDescription { return startErrorDescription }
        guard requestSender == nil else { return nil }
        return DesktopDesignStartError.unavailable.localizedDescription
    }

    private var presetGrid: some View {
        LazyVGrid(
            columns: [
                GridItem(
                    .adaptive(
                        minimum: DesktopDesignMetrics.presetMinimum,
                        maximum: DesktopDesignMetrics.presetMaximum
                    ),
                    spacing: JunoSpace.cozy,
                    alignment: .topLeading
                )
            ],
            alignment: .leading,
            spacing: JunoSpace.cozy
        ) {
            ForEach(DesktopDesignPreset.allCases) { preset in
                DesktopDesignPresetTile(
                    preset: preset,
                    isStarting: starting == preset,
                    isDisabled: starting != nil || requestSender == nil,
                    start: { Task { await start(preset) } }
                )
            }
        }
        .accessibilityIdentifier("juno.desktop.design.presets")
    }

    @ViewBuilder
    private var launcherContent: some View {
        if designs.isEmpty {
            JunoEmptyState(
                title: "No designs yet",
                message: "Pick a size above to start one, or ask Juno in any chat to design a screen.",
                symbol: "square.on.square.dashed"
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    // The website's own label for this list, in the mono caption
                    // it uses for one: a heading over a set of rows, not a
                    // section title competing with the page's.
                    Text("Recent")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                    ForEach(designs) { design in
                        DesktopDesignRow(design: design, open: { open(design.id) }) {
                            requestDelete(design)
                        }
                    }
                }
                .padding(.horizontal, JunoSpace.region)
                .padding(.vertical, JunoSpace.section)
                .frame(maxWidth: DesktopDesignMetrics.pageWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
            .accessibilityIdentifier("juno.desktop.design.recent")
        }
    }

    // MARK: - The open design

    /// One design, in the editor the rest of the app already opens.
    ///
    /// ``DesktopDesignSurface`` and nothing else: it decodes the stored
    /// `DesignDocument` natively before the bundled editor ever sees it, so a
    /// body written by a newer build of Juno is refused with a reason instead of
    /// rendering as an empty canvas indistinguishable from a document whose
    /// contents were lost. Writing a second design view here is precisely how the
    /// artifacts library ended up dumping design JSON while the chat canvas
    /// showed the real thing.
    ///
    /// Editable, because there is a stored row behind it and an edit therefore
    /// has somewhere to go: each accepted transaction is re-encoded into
    /// ``draft`` and committed through `saveArtifact`, the same write path every
    /// other artifact kind uses. No version is manufactured per drag.
    private func document(_ design: NativeArtifact) -> some View {
        VStack(spacing: 0) {
            documentCommandBar(design)
            Divider()
            DesktopDesignSurface(
                content: draft ?? storedContent ?? "",
                readOnly: false,
                onEdit: { draft = $0 }
            )
            // Keyed on the document and on the discard token only. Saving bumps
            // `currentVersion`, so keying on the version number would reload the
            // bundle after every ⌘S and throw away the reader's pan, zoom and
            // selection — the identity ``DesktopArtifactsScreen`` arrived at
            // after exactly that.
            .id("\(design.id)#\(designReloadToken)")
        }
        .accessibilityIdentifier("juno.desktop.design.document")
    }

    /// Commands belong to the open document rather than to the window's title
    /// bar, which is shared with whichever product is hosting this page.
    private func documentCommandBar(_ design: NativeArtifact) -> some View {
        HStack(spacing: JunoSpace.snug) {
            Button {
                closeDesign()
            } label: {
                Label("All designs", systemImage: "chevron.left")
            }
            .buttonStyle(.plain)
            .contentShape(.rect)
            .help("Back to your designs")
            .accessibilityLabel("All designs")
            .accessibilityIdentifier("juno.desktop.design.back")

            Divider()
                .frame(height: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(design.title.isEmpty ? "Untitled design" : design.title)
                    .font(.headline)
                    .lineLimit(1)
                Text(subtitle(design))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: JunoSpace.cozy)

            Button("Discard") {
                draft = nil
                designReloadToken = UUID()
            }
            .disabled(!isDirty)
            .help("Throw away every change since the last save and re-open the stored design")
            .accessibilityIdentifier("juno.desktop.design.discard")

            Button("Save") {
                Task { await save(design) }
            }
            .disabled(!isDirty || model.isMutating)
            .keyboardShortcut("s", modifiers: .command)
            .help("Save your edit as a new version (⌘S)")
            .accessibilityIdentifier("juno.desktop.design.save")

            Menu {
                Button("Delete design", role: .destructive) {
                    requestDelete(design)
                }
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 28, height: 28)
            }
            .menuStyle(.borderlessButton)
            .help("Delete this design")
            .accessibilityLabel("Design actions")
            .accessibilityIdentifier("juno.desktop.design.actions")
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
    }

    private func subtitle(_ design: NativeArtifact) -> String {
        var parts: [String] = []
        if design.currentVersion > 1 { parts.append("v\(design.currentVersion)") }
        parts.append("Updated \(design.updatedAt.formatted(.relative(presentation: .named)))")
        if isDirty { parts.append("Unsaved changes") }
        if let error = model.lastErrorDescription { parts.append(error) }
        return parts.joined(separator: " · ")
    }

    // MARK: - Actions

    private func open(_ id: String) {
        draft = nil
        designReloadToken = UUID()
        openDesignID = id
    }

    private func closeDesign() {
        openDesignID = nil
        draft = nil
    }

    private func requestDelete(_ design: NativeArtifact) {
        deleteTarget = design
    }

    private func delete(_ design: NativeArtifact) async {
        await model.deleteArtifact(id: design.id)
        guard model.lastErrorDescription == nil else { return }
        if openDesignID == design.id { closeDesign() }
    }

    /// Start a design, then open it.
    ///
    /// Three awaits, and each one is load-bearing. The route creates the row on
    /// the *server*; this Mac's artifact list is projected from its own encrypted
    /// database, so without the pull in the middle the new design would not exist
    /// here until the next background synchronisation landed — which is anywhere
    /// from immediately to thirty seconds, and reads as a button that did
    /// nothing. `NativeArtifactModel.performMutation` does the same three steps
    /// in the same order for the same reason.
    private func start(_ preset: DesktopDesignPreset) async {
        guard let requestSender else {
            startErrorDescription = DesktopDesignStartError.unavailable.localizedDescription
            return
        }
        guard starting == nil else { return }
        starting = preset
        startErrorDescription = nil
        defer { starting = nil }

        do {
            let id = try await DesktopDesignStartClient(sender: requestSender)
                .startDesign(preset: preset, title: "Untitled design", for: accountID)
            await syncModel?.refresh()
            await model.reload()
            guard model.artifacts.contains(where: { $0.id == id }) else {
                // The design exists — the route answered with its identifier —
                // but this Mac has not been given it yet. Saying so is better
                // than opening an editor onto an empty string, and the launcher
                // behind this notice will list it the moment sync catches up.
                startErrorDescription =
                    "Juno started the design. It will appear here as soon as this Mac finishes syncing."
                return
            }
            open(id)
        } catch {
            startErrorDescription = NativeFailureMessage.presentable(error)
        }
    }

    /// A stale write is not a failure to hide: the model reloads the newer
    /// version and reports it, so the draft is kept and a second Save — now based
    /// on the version that actually exists — is the recovery.
    private func save(_ design: NativeArtifact) async {
        guard let draft else { return }
        await model.saveArtifact(id: design.id, content: draft)
        guard model.lastErrorDescription == nil else { return }
        self.draft = nil
    }
}

// MARK: - Preset tile

/// One size, as the shape it makes.
///
/// The rectangle is drawn to the preset's own aspect ratio rather than being a
/// generic "+" in a box. It is the one part of this choice that cannot be
/// misread: "Tablet · 834 × 1194" takes a moment to picture, and a portrait
/// rectangle beside a landscape one takes none.
private struct DesktopDesignPresetTile: View {
    let preset: DesktopDesignPreset
    let isStarting: Bool
    let isDisabled: Bool
    let start: () -> Void

    @State private var isHovering = false

    /// The proportional frame, fitted into a fixed box so four tiles of four
    /// aspect ratios still line their text up on one baseline.
    private var markSize: CGSize {
        let box = DesktopDesignMetrics.presetMark
        let scale = min(box / preset.size.width, box / preset.size.height)
        return CGSize(
            width: max(6, preset.size.width * scale),
            height: max(6, preset.size.height * scale)
        )
    }

    var body: some View {
        Button(action: start) {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                ZStack {
                    // On `secondary` rather than on `junoBorder`. The border token
                    // is a hairline meant to *separate* two surfaces, and at 1.5pt
                    // over a raised card the phone's 12pt-wide frame all but
                    // disappeared — the one part of the tile that has to be
                    // readable at a glance was the one part you had to look for.
                    RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                        .strokeBorder(
                            isHovering && !isDisabled ? Color.junoAccent : Color.secondary,
                            lineWidth: 1.5
                        )
                        .frame(width: markSize.width, height: markSize.height)
                    if isStarting {
                        ProgressView().controlSize(.small)
                    }
                }
                .frame(
                    width: DesktopDesignMetrics.presetMark,
                    height: DesktopDesignMetrics.presetMark
                )
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 1) {
                    Text(preset.label)
                        .junoRowLabel()
                        .fontWeight(.medium)
                    Text(preset.detail)
                        .junoCaption()
                        .monospacedDigit()
                }
            }
            .padding(JunoSpace.cozy)
            .frame(maxWidth: .infinity, alignment: .leading)
            .junoCard(cornerRadius: JunoRadius.panel)
            // The whole tile is the target, not just its text. A card a reader
            // has to hit the label of is a card that feels broken.
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled && !isStarting ? 0.55 : 1)
        .onHover { isHovering = $0 }
        .animation(JunoMotion.fast, value: isHovering)
        .help("Start a \(preset.label.lowercased()) design at \(preset.detail)")
        .accessibilityLabel("New \(preset.label) design, \(preset.detail)")
        .accessibilityIdentifier("juno.desktop.design.preset.\(preset.rawValue)")
    }
}

// MARK: - Recent row

/// A design in the Recent list.
///
/// A row rather than a thumbnail card, which is the one place this page
/// deliberately departs from the artifacts library. Drawing a design's real
/// contents means booting the bundled editor — a `WKWebView` and a JavaScript
/// load — once per tile, which the library refuses for the same reason and
/// answers with a mark instead. A list of rows is the honest shape for a set of
/// documents whose covers cannot be drawn.
private struct DesktopDesignRow: View {
    let design: NativeArtifact
    let open: () -> Void
    let delete: () -> Void

    @State private var isHovering = false

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Button(action: open) {
                HStack(spacing: JunoSpace.cozy) {
                    Image(systemName: "pencil.tip")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.junoAccent)
                        .frame(width: 34, height: 34)
                        .background(
                            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                                .fill(Color.junoAccent.opacity(0.12))
                        )
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 1) {
                        Text(design.title.isEmpty ? "Untitled design" : design.title)
                            .junoRowLabel()
                            .fontWeight(.medium)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Text(meta)
                            .junoCaption()
                            .monospacedDigit()
                            .lineLimit(1)
                    }

                    Spacer(minLength: JunoSpace.snug)

                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)

            Menu {
                Button("Delete design", role: .destructive, action: delete)
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 28, height: 28)
            }
            .menuStyle(.borderlessButton)
            .help("Delete this design")
            .accessibilityLabel("Actions for \(design.title.isEmpty ? "Untitled design" : design.title)")
            .accessibilityIdentifier("juno.desktop.design.row.actions.\(design.id)")
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoCard(cornerRadius: JunoRadius.panel)
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(
                    isHovering ? Color.junoAccent.opacity(0.4) : .clear,
                    lineWidth: 1
                )
        )
        .onHover { isHovering = $0 }
        .animation(JunoMotion.fast, value: isHovering)
        .help(design.conversationTitle)
        .accessibilityIdentifier("juno.desktop.design.row.\(design.id)")
    }

    private var meta: String {
        var parts: [String] = []
        if design.currentVersion > 1 { parts.append("v\(design.currentVersion)") }
        parts.append(design.updatedAt.formatted(.relative(presentation: .named)))
        return parts.joined(separator: " · ")
    }
}

// MARK: - Notice

/// Why a design could not be started, said where the reader clicked.
///
/// Inline under the presets rather than an alert: the answer is often "the
/// canvas is not on your plan", which is information about the row of buttons
/// directly above it and not an interruption to dismiss.
private struct DesktopDesignNotice: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            JunoIconView(.error, size: 13)
                .foregroundStyle(Color.junoCaution)
                .accessibilityHidden(true)
            Text(message)
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .fill(Color.junoCaution.opacity(0.1))
        )
        .transition(.opacity)
        .accessibilityIdentifier("juno.desktop.design.notice")
    }
}

// MARK: - Metrics

private enum DesktopDesignMetrics {
    /// Narrower than the artifacts library's 1152, and deliberately.
    ///
    /// That page is a *grid* and fills its width with cards; this one is a
    /// heading, a sentence and a single column of rows. At 1152 the Recent rows
    /// came out as metre-wide slabs with a title at one end and a chevron at the
    /// other, and the subtitle ran to a measure nobody reads a sentence at. The
    /// web caps the same page at `max-w-3xl`; this is that, in points, with the
    /// room a Mac window has.
    static let pageWidth: CGFloat = 880
    /// Four tiles across at the width a detail column usually opens at, and two
    /// when the window is halved — never one, which would make a row of sizes
    /// read as a stack of unrelated buttons.
    static let presetMinimum: CGFloat = 132
    static let presetMaximum: CGFloat = 220
    /// The box the proportional frame is fitted into.
    static let presetMark: CGFloat = 26
}

// MARK: - The door

/// The way into Design, at the bottom of every navigation column.
///
/// **Where the web put it, and why.** `app-sidebar.tsx` draws exactly this row
/// in its own block above the account row — not as a fourth mode segment, and
/// not among the destinations at the top. A mode owns the whole column (its nav
/// rows, its list, its collapsed rail) and Design has none of that; as a fourth
/// segment it only routed away and left Home's column standing. It is a
/// destination, so it lives with the account row at the bottom.
///
/// **One row, three columns.** Chat, Code and Work each compose their own
/// footer — Code stacks a workspace notice above the account block, Work has no
/// account block at all — so the shared thing is this row rather than a shared
/// footer. Its anatomy is ``DesktopSidebarAccountRow``'s to the point: the same
/// insets, the same ``JunoRadius/row`` hover shape, the same
/// `Color.junoSidebarSelection` fill, so the two read as one footer instead of
/// as a button sitting on top of one.
///
/// **The mark is an SF Symbol, and that is a known gap.** The website draws
/// Lucide's `pen-tool` here (`AppIcons.design`), and ``JunoIcon`` has no case for
/// it because the asset generator has never been asked for one. This is the same
/// state `DesktopDestination.usage` is in and it is handled the same way — the
/// system glyph until the Juno mark is generated — rather than borrowing a
/// near-miss from another set, which is the drift ``JunoIcon`` exists to prevent.
///
/// `pencil.tip` and not `pencil.and.outline`, `pencil.and.ruler` or
/// `square.and.pencil`, and each rejection was made by rendering all four at this
/// row's 15pt rather than by reading their names. The first draws a pencil across
/// an *ellipse* and reads as a prohibition sign; the second's ruler hatching turns
/// to noise; the third is already this window's New Chat toolbar button. A nib is
/// one clean shape at 15pt and is the thing Lucide's pen-tool is a drawing of.
struct DesktopSidebarDesignRow: View {
    /// Whether the Design page is the one on screen. The web's `NavRow` takes the
    /// same flag and lifts its ink for it; a footer row that never shows it is
    /// open is a row a reader clicks twice.
    var isActive = false
    let open: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: JunoSpace.cozy) {
                Image(systemName: "pencil.tip")
                    .font(.system(size: 15))
                    // Stated on the mark, not inherited. A glyph in a sidebar row
                    // resolves against the system accent unless it is told
                    // otherwise, which is how this column used to draw coral it
                    // was never asked for.
                    .foregroundStyle(ink)
                    .frame(width: 26, height: 26)
                    .accessibilityHidden(true)

                Text("Design")
                    .font(.callout)
                    .foregroundStyle(ink)
                    .lineLimit(1)

                Spacer(minLength: JunoSpace.hairline)
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                    .fill(fill)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .animation(JunoMotion.standard, value: isHovering)
        .animation(JunoMotion.standard, value: isActive)
        // The footer's own inset, so this row hangs on the same left edge as the
        // account row underneath it rather than half a gutter to its left.
        .padding(.horizontal, JunoSpace.snug)
        .padding(.top, JunoSpace.snug)
        .help("Start a design, or open one you already have")
        .accessibilityLabel("Design")
        .accessibilityAddTraits(isActive ? [.isSelected] : [])
        .accessibilityIdentifier("juno.desktop.design-row")
    }

    private var ink: Color { isActive ? .primary : .junoSidebarForeground }

    private var fill: Color {
        isActive || isHovering ? Color.junoSidebarSelection : .clear
    }
}
