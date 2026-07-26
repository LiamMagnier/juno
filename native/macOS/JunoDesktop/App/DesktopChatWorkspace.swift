import AVFoundation
import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoVoiceKit
import SwiftUI
import UniformTypeIdentifiers

enum DesktopChatSelection {
    static func resolvedModelID(
        current: String,
        conversationModel: String,
        selectable: [NativeChatModelOption]
    ) -> String {
        if selectable.contains(where: { $0.id == current }) {
            return current
        }
        if selectable.contains(where: { $0.id == conversationModel }) {
            return conversationModel
        }
        return selectable.first?.id ?? conversationModel
    }
}

/// One selection value for the whole navigation column.
///
/// `List(selection:)` needs a single `Hashable` to drive native selection, and
/// getting that right is what buys the arrow-key navigation, type-select, focus
/// ring and focused/unfocused accent states that a stack of `Button`s cannot
/// have. The chat destination and the selected conversation used to be two
/// independent pieces of state, which is why the old column had to draw its own
/// highlight — nothing about it was a selection as far as the platform knew.
enum DesktopSidebarItem: Hashable {
    case destination(DesktopDestination)
    case conversation(String)
}

struct DesktopChatWorkspace: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    @Binding var product: DesktopProductMode
    /// Forces the window to open on a given destination, overriding the restored
    /// one exactly once.
    ///
    /// This exists for the screenshot harness. `capture-desktop.sh` passes
    /// `--juno-preview-tab artifacts` and names the resulting file
    /// `artifacts-light.png`, but nothing was reading that value below the
    /// product level — so every "surface" in the capture set was really the Chat
    /// window, and a reviewer looking at sixteen files was looking at two.
    /// Production passes nil and the restored destination wins as before.
    var initialDestination: DesktopDestination?
    @SceneStorage("juno.desktop.destination") private var storedDestination =
        DesktopDestination.chat.rawValue
    /// Holds the launch override until the reader navigates somewhere themselves.
    ///
    /// Writing `storedDestination` from `onAppear` was not enough: scene storage
    /// is restored asynchronously, so AppKit could hand the window its previous
    /// destination *after* the override had been written, and the harness landed
    /// on whichever surface was last open instead of the one it asked for.
    /// Reading the override ahead of storage sidesteps the race entirely.
    @State private var overrideDestination: DesktopDestination?
    /// Distinguishes "never seeded" from "seeded, then retired by a navigation",
    /// which a nil `overrideDestination` alone cannot.
    @State private var hasSeededOverride = false
    @SceneStorage("juno.desktop.columns") private var storedColumnVisibility = ""
    @State private var columnVisibility = NavigationSplitViewVisibility.all

    /// The destination in force: the launch override while it stands, otherwise
    /// whatever scene storage restored.
    private var currentDestination: DesktopDestination {
        overrideDestination
            ?? DesktopNavigationState.destination(fromStored: storedDestination)
    }

    private var destination: Binding<DesktopDestination> {
        Binding(
            get: { currentDestination },
            set: { value in
                // Any deliberate navigation retires the override — from here on
                // the window behaves exactly as it did before it existed.
                overrideDestination = nil
                storedDestination = value.rawValue
            }
        )
    }

    /// Projects the two underlying pieces of state into the column's single
    /// selection, and back. The rules themselves are in
    /// ``DesktopNavigationState`` so they can be tested; this only moves values.
    private var selection: Binding<DesktopSidebarItem?> {
        Binding(
            get: {
                DesktopNavigationState.selection(
                    destination: currentDestination,
                    selectedConversationID: model.selectedConversationID
                )
            },
            set: { item in
                let resolved = DesktopNavigationState.resolve(
                    selection: item,
                    current: (currentDestination, model.selectedConversationID)
                )
                overrideDestination = nil
                storedDestination = resolved.destination.rawValue
                model.selectedConversationID = resolved.conversationID
                model.isDraftingNewConversation = resolved.isDrafting
            }
        )
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            DesktopChatSidebar(
                model: model,
                syncModel: configuration.syncModel,
                avatarModel: configuration.avatarModel,
                session: session,
                product: $product,
                destination: destination,
                selection: selection
            )
            .junoSidebarColumn()
        } detail: {
            DesktopDestinationView(
                destination: destination,
                configuration: configuration,
                session: session,
                conversationModel: model
            )
            .junoReadingCanvas()
            .navigationTitle(windowTitle)
            .navigationSubtitle(windowSubtitle)
            .toolbar { detailToolbar }
        }
        .focusedSceneValue(
            \.junoWorkspaceActions,
            DesktopWorkspaceActions(
                newChat: beginDraft,
                openSearch: { destination.wrappedValue = .search },
                switchProduct: { product = $0 },
                currentProduct: product
            )
        )
        // Column visibility is restored by hand rather than through
        // `@SceneStorage` directly: `NavigationSplitViewVisibility` is not
        // `RawRepresentable`, so it cannot be stored, and a window that always
        // reopened with the sidebar showing lost the one piece of window layout
        // a user is most likely to have deliberately changed.
        .onAppear {
            if storedColumnVisibility == "detailOnly" {
                columnVisibility = .detailOnly
            }
            // Seeded once. `overrideDestination` is `@State`, so a later
            // re-appear (a mode switch, the window returning to the foreground)
            // finds it already set — or already retired by a navigation — and
            // cannot yank the reader back to the launch surface.
            if let initialDestination, overrideDestination == nil, !hasSeededOverride {
                hasSeededOverride = true
                overrideDestination = initialDestination
                model.selectedConversationID = nil
            }
        }
        .onChange(of: columnVisibility) { _, visibility in
            storedColumnVisibility = visibility == .detailOnly ? "detailOnly" : "all"
        }
    }

    private var windowTitle: String {
        DesktopNavigationState.windowTitle(
            destination: DesktopNavigationState.destination(fromStored: storedDestination),
            conversationTitle: model.selectedConversation?.title
        )
    }

    /// The subtitle carries provenance, never the model id.
    private var windowSubtitle: String {
        let current = DesktopNavigationState.destination(fromStored: storedDestination)
        guard current == .chat, let conversation = model.selectedConversation else {
            return ""
        }
        return conversation.updatedAt.formatted(date: .abbreviated, time: .shortened)
    }

    /// Every item is present in every state and disables rather than vanishing.
    ///
    /// A `ToolbarItem` that appears and disappears makes SwiftUI rebuild the
    /// AppKit toolbar underneath a live window, and that rebuild is what drove
    /// the split-view constraint loop this shell previously crashed in. Disabling
    /// is also better behaviour: the control keeps its position, so the pointer
    /// does not have to re-find it.
    @ToolbarContentBuilder
    private var detailToolbar: some ToolbarContent {
        // The product switch lives in the toolbar, not at the top of the sidebar.
        // As a `safeAreaInset` on the column it had no opaque backing, so a
        // scrolled source list slid its rows underneath the switch and under the
        // window's traffic lights. The toolbar is also where macOS puts a
        // top-level mode switch, and it stays reachable when the sidebar is
        // collapsed — which the sidebar version was not.
        ToolbarItem(placement: .navigation) {
            // No width here. The switcher owns its own metrics (see
            // `DesktopProductSwitcher`); a flat width imposed from the toolbar is
            // what squeezed the two labels against their segment edges and
            // stopped the control from growing with Dynamic Type. The trailing
            // padding is the toolbar's business, though: it separates the mode
            // switch from the New-chat button so the two do not read as one group.
            DesktopProductSwitcher(selection: $product)
                .padding(.trailing, JunoSpace.snug)
        }

        ToolbarItem(placement: .navigation) {
            Button {
                beginDraft()
            } label: {
                Label("New chat", systemImage: "square.and.pencil")
            }
            .help("Start a new chat (⌘N)")
            .accessibilityIdentifier("New chat")
        }

        ToolbarItem(placement: .primaryAction) {
            Button {
                destination.wrappedValue = .search
            } label: {
                Label("Search", systemImage: "magnifyingglass")
            }
            .help("Search chats, projects and files (⌘⇧F)")
            .accessibilityIdentifier("Search")
        }
    }

    private func beginDraft() {
        storedDestination = DesktopDestination.chat.rawValue
        model.isDraftingNewConversation = true
        model.selectedConversationID = nil
        configuration.attachmentModel?.clear()
    }
}

/// The navigation column, as a real macOS source list.
///
/// Everything visual here is the platform's: `List(selection:)` in `.sidebar`
/// style draws the selection, the hover state, the section headers and the row
/// metrics, and it is what makes the column keyboard-navigable. The column
/// paints **no background** — a sidebar is a vibrant region on macOS, and the
/// opaque fill this view used to apply is the exact failure ``JunoSurfaces``
/// documents: it turned a vibrant source list into a grey slab.
private struct DesktopChatSidebar: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    let avatarModel: NativeAvatarModel?
    let session: NativeAuthenticatedSession
    @Binding var product: DesktopProductMode
    @Binding var destination: DesktopDestination
    @Binding var selection: DesktopSidebarItem?

    /// The recency sections, with the archive bucket dropped.
    ///
    /// Juno has no archive on the desktop any more: archiving a chat only ever
    /// produced a second place for it to hide, so the row's one destructive action
    /// is now Delete. `NativeConversationGrouping` is shared with the phone app and
    /// still emits an `.archived` bucket for conversations the web archived, so it
    /// is filtered here rather than removed there.
    private var groups: [NativeConversationGroup] {
        NativeConversationGrouping.groups(for: model.conversations, now: Date())
            .filter { $0.bucket != .archived }
    }

    var body: some View {
        List(selection: $selection) {
            Section {
                ForEach(DesktopDestination.sidebarCases) { item in
                    destinationRow(item)
                }
            }

            ForEach(groups) { group in
                Section(group.bucket.desktopTitle) {
                    ForEach(group.conversations) { conversation in
                        conversationRow(conversation)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        // The selection is still the platform's — only its colour is Juno's.
        .junoSidebarSelectionTint()
        .safeAreaInset(edge: .bottom, spacing: 0) {
            accountFooter
        }
    }

    private func destinationRow(_ item: DesktopDestination) -> some View {
        Label {
            Text(item.label)
        } icon: {
            if let icon = item.junoIcon {
                JunoIconView(icon, size: 16)
            } else {
                Image(systemName: item.symbol)
            }
        }
        .junoSidebarRowInk()
        .tag(DesktopSidebarItem.destination(item))
    }

    private func conversationRow(_ conversation: NativeConversation) -> some View {
        HStack(spacing: JunoSpace.tight) {
            if conversation.pinned {
                Image(systemName: "pin.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Pinned")
            }
            Text(conversation.title)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: JunoSpace.hairline)
            if conversation.isPending {
                ProgressView()
                    .controlSize(.mini)
                    .accessibilityLabel("Sending")
            }
        }
        .junoSidebarRowInk()
        .tag(DesktopSidebarItem.conversation(conversation.id))
        .contextMenu {
            Button(conversation.pinned ? "Unpin" : "Pin") {
                Task {
                    await model.setPinned(
                        id: conversation.id,
                        pinned: !conversation.pinned
                    )
                }
            }
            Divider()
            // One destructive action, and it really deletes: `deleteConversation`
            // enqueues `conversation.delete`, not an archive flag. There is no
            // Archive/Restore pair any more — a chat the reader is done with
            // should leave, not move to a drawer they have to remember exists.
            Button("Delete", role: .destructive) {
                Task { await model.deleteConversation(id: conversation.id) }
            }
        }
    }

    /// The account row, pinned to the bottom of the column by
    /// `safeAreaInset` rather than by being the last child of a `VStack`, so the
    /// list scrolls underneath it and the row stays reachable.
    private var accountFooter: some View {
        Button {
            destination = .settings
        } label: {
            HStack(spacing: JunoSpace.cozy) {
                ZStack(alignment: .bottomTrailing) {
                    JunoAvatar(
                        imageData: avatarModel?.imageData,
                        imageURL: session.profile.imageURL,
                        name: session.profile.name ?? session.profile.email,
                        size: 26
                    )
                    DesktopSyncIndicator(syncModel: syncModel)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.profile.name ?? "Juno account")
                        .font(.callout)
                        .lineLimit(1)
                    Text(session.profile.email)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: JunoSpace.hairline)
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(JunoSpace.snug)
        .help("Account and settings")
        .accessibilityIdentifier("Account and settings")
    }
}

enum DesktopDestination: String, CaseIterable, Identifiable {
    case chat
    case search
    case projects
    case library
    case artifacts
    case connections
    case tasks
    case usage
    case settings

    var id: Self { self }

    static let sidebarCases: [Self] = [
        .library, .artifacts, .connections, .projects, .tasks, .usage,
    ]

    var label: String {
        switch self {
        case .chat: "Chat"
        case .search: "Search"
        case .projects: "Projects"
        case .library: "Library"
        case .artifacts: "Artifacts"
        case .connections: "Connections"
        case .tasks: "Tasks"
        case .usage: "Usage"
        case .settings: "Settings"
        }
    }

    var symbol: String {
        switch self {
        case .chat: "bubble.left.and.bubble.right"
        case .search: "magnifyingglass"
        case .projects: "folder"
        case .library: "books.vertical"
        case .artifacts: "square.stack.3d.up"
        case .connections: "link"
        case .tasks: "clock"
        case .usage: "chart.line.uptrend.xyaxis"
        case .settings: "gearshape"
        }
    }

    var junoIcon: JunoIcon? {
        switch self {
        case .chat: .home
        case .search: .search
        case .projects: .projects
        case .library: .library
        case .artifacts: .artifacts
        case .connections: .connections
        case .tasks: .tasks
        // No Juno-drawn glyph for Usage yet, so it falls back to the SF Symbol
        // rather than borrowing another destination's mark.
        case .usage, .settings: nil
        }
    }
}

private struct DesktopSyncIndicator: View {
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .help(label)
            .accessibilityLabel(label)
    }

    private var label: String {
        switch syncModel?.phase {
        case .live: "Synced"
        case .synchronizing: "Synchronizing"
        case .offline: "Offline — local changes are queued"
        case .failed: "Synchronization failed"
        case .idle, .none: "Sync idle"
        }
    }

    private var color: Color {
        switch syncModel?.phase {
        case .live: .green
        case .synchronizing: .orange
        case .offline: .secondary
        case .failed: .red
        case .idle, .none: .secondary
        }
    }
}

struct DesktopConversationView: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let attachmentModel: NativeComposerAttachmentModel?
    let profileName: String?
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    @State private var voiceSession: DesktopVoiceSession?

    var body: some View {
        // Clamped through `Color.clear.overlay { … }`, for the reason
        // ``JunoDetailPage`` spells out: a `ScrollView` propagates its content's
        // ideal height rather than absorbing it, so a long transcript reports an
        // ideal of "every message stacked" — and `NavigationSplitView` answers an
        // ideal it cannot meet by *growing the window's split view*. `Color.clear`
        // takes whatever height it is proposed and an overlay is sized by its
        // base, so the chat can never resize the window it lives in.
        Color.clear
            .overlay { conversationContent }
            .sheet(item: $voiceSession) { voiceSession in
                voiceSheet(voiceSession)
            }
    }

    /// The transcript (or the draft greeting) and the composer.
    ///
    /// Paints **no background**. The detail column applies `junoReadingCanvas()`
    /// once, at the window level; painting the canvas a second time here is what
    /// flattened the window into one cream field and boxed the composer in a
    /// rectangle of its own.
    @ViewBuilder
    private var conversationContent: some View {
        Group {
            if model.selectedConversation == nil {
                // Greeting and composer are one centred group; the fine print is
                // pinned to the foot of the page rather than carried along under
                // the composer. That is the web's own split (`chat-view.tsx`):
                // `justify-center` on the group, a `shrink-0` disclaimer at the
                // bottom of the column. Two flexible `Spacer`s with different
                // minimums approximated it and left the disclaimer floating a
                // third of the way up on a tall window.
                //
                // Pinning it as a bottom inset also makes the two branches of this
                // view agree: the transcript pins its chrome the same way, so the
                // disclaimer does not jump vertically the moment a chat starts.
                VStack(spacing: JunoSpace.section) {
                    DesktopDraftGreeting(profileName: profileName)
                    composer
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    DesktopChatDisclaimer()
                }
            } else {
                // No in-content title strip. The conversation's title and its
                // last-updated stamp are the window's `navigationTitle` and
                // `navigationSubtitle`, which is where a Mac window says what it
                // is showing. Repeating it in a bordered bar directly underneath
                // the toolbar said the same thing twice and cost 42pt of the
                // reading canvas.
                //
                // The composer is a *safe-area inset*, not the last row of a
                // `VStack`, and that is what makes it glass. Stacked, it occupied
                // its own band of canvas — a rectangle of `--background` with
                // nothing behind it — so the glass had nothing to refract and read
                // as a flat white pill. As an inset the transcript keeps the full
                // height and scrolls *underneath* the composer, so messages pass
                // behind it and the material finally has something to bend.
                DesktopTranscript(
                    model: model,
                    messageActions: configuration.messageActionsClient,
                    accountID: session.profile.id,
                    syncModel: configuration.syncModel
                )
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    VStack(spacing: 0) {
                        composer
                        DesktopChatDisclaimer()
                    }
                }
            }
        }
    }

    private func voiceSheet(_ voiceSession: DesktopVoiceSession) -> some View {
        DesktopVoiceView(
            controller: voiceSession.controller,
            saveTranscript: { sessionID, turns in
                guard let client = configuration.voiceTranscriptClient else {
                    throw DesktopVoiceError.unavailable
                }
                let saved = try await client.save(
                    sessionID: sessionID,
                    conversationID: voiceSession.conversationID,
                    modelID: voiceSession.modelID,
                    projectID: voiceSession.projectID,
                    connectors: [],
                    turns: turns,
                    for: session.profile.id
                )
                await configuration.syncModel?.refresh()
                await model.reload()
                model.isDraftingNewConversation = false
                model.selectedConversationID = saved.conversationID
                return saved.conversationID
            },
            close: { self.voiceSession = nil }
        )
    }

    private func startVoice(modelID: String) {
        guard let sender = configuration.requestSender,
            configuration.voiceTranscriptClient != nil
        else { return }
        voiceSession = DesktopVoiceSession(
            controller: JunoRealtimeVoiceController(
                authorization: JunoDesktopVoiceAuthorization(
                    sender: sender,
                    accountID: session.profile.id
                )
            ),
            modelID: modelID,
            conversationID: model.selectedConversationID,
            projectID: model.selectedConversation?.projectId
        )
    }

    private var composer: some View {
        DesktopComposer(
            model: model,
            attachmentModel: attachmentModel,
            libraryModel: configuration.libraryModel,
            projectModel: configuration.projectModel,
            connectorModel: configuration.connectorModel,
            openVoiceMode: startVoice
        )
    }
}

/// The home greeting, laid out the way the web lays it out.
///
/// The web's `grid-cols-[1fr_auto_1fr]` (`empty-state.tsx`) is not incidental:
/// only the middle cell carries text, so the phrase sits on the column's **true**
/// horizontal centre and the mark flanks it without moving it. An `HStack` of
/// mark + text centres the *pair* instead, which pushes the greeting left of
/// centre by half the mark — and the composer directly beneath it is centred, so
/// the two read as misaligned. Reproduced here with two equally-flexible outer
/// cells, which is what `1fr … 1fr` means.
///
/// The serif is real Newsreader, not a fallback: the faces are copied into the
/// app bundle's `Resources` and `ATSApplicationFontsPath` is `.`, so
/// ``JunoSerif/isBundled`` resolves the PostScript names and `greeting(compact:)`
/// returns the custom face. Nothing here should ask for `Font.custom("Newsreader")`
/// — that family name resolves nothing and falls back to the system sans in
/// silence.
private struct DesktopDraftGreeting: View {
    let profileName: String?

    /// The web's `sm:h-[1.83rem]` mark, at the root font size the site ships.
    private static let markSize: CGFloat = 29

    private var firstName: String? {
        JunoGreeting.firstName(from: profileName)
    }

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            // The mark's cell: flexible, contents end-aligned, so the mark hugs
            // the phrase from the left exactly as `justify-end pr-[0.38em]` does.
            JunoMark(size: Self.markSize)
                .padding(.trailing, JunoSpace.regular)
                .frame(maxWidth: .infinity, alignment: .trailing)

            Text(greeting)
                .font(JunoSerif.greeting(compact: false))
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            // The web's mirror column. `Color.clear` has no intrinsic size, so it
            // can only ever absorb slack — it cannot report a height back up and
            // therefore cannot influence the detail column that contains it.
            Color.clear
                .frame(maxWidth: .infinity)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, JunoSpace.region)
        .accessibilityElement(children: .combine)
    }

    private var greeting: AttributedString {
        let phrase = JunoGreeting.phrase(
            forHour: Calendar.current.component(.hour, from: Date())
        )
        var text = AttributedString(firstName == nil ? phrase : "\(phrase), ")
        if let firstName {
            var name = AttributedString(firstName)
            name.font = JunoSerif.greetingName(compact: false)
            name.foregroundColor = Color.junoAccent
            text.append(name)
        }
        return text
    }
}


private struct DesktopChatDisclaimer: View {
    var body: some View {
        Text("Juno can be wrong — worth a second look on anything that matters.")
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .padding(.vertical, 7)
            .accessibilityHidden(true)
    }
}

private struct DesktopTranscript: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let messageActions: NativeMessageActionsClient?
    let accountID: AccountID
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    @State private var actionError: String?
    @State private var speechPlayback = DesktopSpeechPlayback()

    /// The web's `max-w-3xl` reading column.
    static let readingWidth: CGFloat = 768

    private var lastAssistantMessageID: String? {
        model.selectedMessages.last(where: { $0.role == .assistant })?.id
    }

    /// The account catalog's name for a canonical model id.
    ///
    /// Falls back to the id when the catalog has no entry, which happens for a
    /// model the account has since lost access to. Showing the id there is
    /// honest — the answer really did come from something this account can no
    /// longer name — and is better than attributing it to nothing.
    private func displayName(forModelID id: String) -> String {
        model.model(withID: id)?.displayName ?? id
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // The web's reading column, metric for metric: `max-w-3xl`
                // (768pt) at `space-y-6` (24pt) — see `message-list.tsx`. The
                // numbers this replaces were freehand and read slightly airier
                // than the site at the same window width.
                LazyVStack(alignment: .leading, spacing: JunoSpace.section) {
                    ForEach(model.selectedMessages) { message in
                        DesktopMessageRow(
                            message: message,
                            modelDisplayName: message.model.map(displayName(forModelID:)),
                            isLastAssistant: message.id == lastAssistantMessageID,
                            copy: {
                                copy(NativeMessageContent.plainText(of: message.content))
                            },
                            regenerate: {
                                guard let conversationID = model.selectedConversationID else {
                                    return
                                }
                                model.retryLastMessage(conversationID: conversationID)
                            },
                            branch: messageActions.map { _ in
                                { branch(from: message) }
                            },
                            setFeedback: messageActions.map { _ in
                                { feedback in
                                    setFeedback(feedback, for: message)
                                }
                            },
                            readAloud: messageActions.map { _ in
                                {
                                    readAloud(
                                        NativeMessageContent.plainText(of: message.content)
                                    )
                                }
                            }
                        )
                            .id(message.id)
                    }

                    if model.isGenerating, !model.researchActivity.isEmpty {
                        DesktopResearchActivity(items: model.researchActivity)
                    }

                    if let error = model.chatErrorDescription {
                        DesktopChatError(
                            message: error,
                            canRetry: model.canRetrySelectedConversation,
                            retry: {
                                guard let id = model.selectedConversationID else { return }
                                model.retryLastMessage(conversationID: id)
                            }
                        )
                    }

                    if let actionError {
                        DesktopChatError(
                            message: actionError,
                            canRetry: false,
                            retry: {}
                        )
                    }

                    Color.clear
                        .frame(height: 1)
                        .id("transcript-bottom")
                }
                .frame(maxWidth: DesktopTranscript.readingWidth)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, JunoSpace.region)
                .padding(.vertical, JunoSpace.section)
            }
            .onChange(of: model.selectedMessages) { _, _ in
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo("transcript-bottom", anchor: .bottom)
                }
            }
            .onChange(of: model.chatPhase) { _, _ in
                proxy.scrollTo("transcript-bottom", anchor: .bottom)
            }
        }
    }

    private func copy(_ content: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(content, forType: .string)
    }

    private func setFeedback(
        _ feedback: NativeChatFeedback?,
        for message: NativeChatMessage
    ) {
        guard let messageActions else { return }
        let previous = message.feedback
        model.applyFeedback(
            feedback,
            messageID: message.id,
            conversationID: message.conversationID
        )
        actionError = nil
        Task {
            do {
                try await messageActions.setFeedback(
                    messageID: message.id,
                    feedback: feedback.map {
                        $0 == .up ? .up : .down
                    },
                    for: accountID
                )
            } catch {
                model.applyFeedback(
                    previous,
                    messageID: message.id,
                    conversationID: message.conversationID
                )
                actionError = error.localizedDescription
            }
        }
    }

    private func branch(from message: NativeChatMessage) {
        guard let messageActions else { return }
        actionError = nil
        Task {
            do {
                let id = try await messageActions.branch(
                    conversationID: message.conversationID,
                    atMessageID: message.id,
                    for: accountID
                )
                await syncModel?.refresh()
                await model.reload()
                model.isDraftingNewConversation = false
                model.selectedConversationID = id
            } catch {
                actionError = error.localizedDescription
            }
        }
    }

    private func readAloud(_ content: String) {
        guard let messageActions else { return }
        actionError = nil
        Task {
            do {
                let audio = try await messageActions.speech(
                    text: content,
                    voiceID: nil,
                    for: accountID
                )
                try speechPlayback.play(audio: audio, fallbackText: content)
            } catch {
                actionError = error.localizedDescription
            }
        }
    }
}

private struct DesktopMessageRow: View {
    let message: NativeChatMessage
    /// The model's human name, resolved from the account catalog by the caller.
    ///
    /// The footer used to render `message.model` directly, which is the canonical
    /// id — so the most-read surface in the product attributed answers to
    /// "anthropic:claude-sonnet-4-6". The id is a routing key, not a name.
    let modelDisplayName: String?
    let isLastAssistant: Bool
    let copy: () -> Void
    let regenerate: () -> Void
    let branch: (() -> Void)?
    let setFeedback: ((NativeChatFeedback?) -> Void)?
    let readAloud: (() -> Void)?
    @State private var reasoningExpanded = false
    @State private var inlineArtifact: DesktopInlineArtifact?
    /// Whether a long prompt is showing in full. Collapsed is the resting state,
    /// as it is on the web.
    @State private var promptExpanded = false

    private var displayContent: String {
        message.sources.isEmpty
            ? message.content
            : NativeMessageContent.strippingTrailingSourcesSection(message.content)
    }

    private var parts: [NativeMessageContent.Part] {
        NativeMessageContent.parts(of: displayContent)
    }

    private var plainText: String {
        NativeMessageContent.plainText(of: message.content)
    }

    /// `rounded-2xl rounded-br-md`: one clipped corner on the trailing-bottom
    /// edge. Uniform corners make a card; the notch is what makes it a remark.
    private static let bubbleShape = UnevenRoundedRectangle(
        topLeadingRadius: JunoCornerRadius.message,
        bottomLeadingRadius: JunoCornerRadius.message,
        bottomTrailingRadius: JunoRadius.control,
        topTrailingRadius: JunoCornerRadius.message,
        style: .continuous
    )

    /// Which model wrote this, what it cost, and whether it is still arriving —
    /// one line, in the web's monospaced metadata voice.
    ///
    /// Joined here rather than laid out as three `Text`s in an `HStack`: the web
    /// writes a single `font-mono` string with "·" separators, and three floating
    /// fragments under every answer is three things to read instead of one.
    private var footerLine: String? {
        // Not named `parts`: that is already this row's *content* parts, and one
        // shadowing the other in a file this long is a trap for the next reader.
        var fields: [String] = []
        if let modelDisplayName {
            fields.append(modelDisplayName)
        }
        if let cost = message.costUSD {
            fields.append(cost.formatted(.currency(code: "USD")))
        }
        if message.isPending {
            fields.append("Streaming")
        }
        return fields.isEmpty ? nil : fields.joined(separator: " · ")
    }

    /// Whether this prompt is long enough to open collapsed. The rule and the
    /// numbers are the website's — see ``NativePromptLimits``.
    private var isLongPrompt: Bool {
        message.role == .user && NativePromptLimits.isLongMessage(plainText)
    }

    /// The bubble proper.
    ///
    /// A long prompt — a pasted system prompt, a curriculum, a stack trace — is
    /// clipped to ``NativePromptLimits/collapsedMessageHeight`` with a fade off
    /// its bottom edge, so the answer the reader came back for is not pushed a
    /// screen down by the thing they already know they wrote. The text itself is
    /// untouched: Copy and VoiceOver read the whole message either way.
    private var userBubble: some View {
        Text(plainText)
            .textSelection(.enabled)
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.snug)
            .frame(
                maxHeight: isLongPrompt && !promptExpanded
                    ? NativePromptLimits.collapsedMessageHeight : nil,
                alignment: .top
            )
            .clipped()
            .overlay(alignment: .bottom) {
                if isLongPrompt, !promptExpanded {
                    // The web's `bg-gradient-to-t from-secondary` — the bubble's
                    // own fill dissolving upward, which is what says "clipped"
                    // rather than "ended".
                    LinearGradient(
                        colors: [Color.junoMuted, Color.junoMuted.opacity(0)],
                        startPoint: .bottom,
                        endPoint: .top
                    )
                    .frame(height: 64)
                    .allowsHitTesting(false)
                }
            }
            // The web's bubble is a *raised* surface, not a tint:
            // `bg-secondary` **plus** `border-border/50` and
            // `--shadow-soft`. With the fill alone it read as a
            // slightly darker patch of the same cream field — the
            // flatness this redesign exists to remove — because
            // `--muted` and `--background` are barely a step apart.
            // Hand-rolled rather than `junoCard()` only because the
            // shape is uneven; the tokens are the card's own.
            .background(Self.bubbleShape.fill(Color.junoMuted))
            .overlay(
                Self.bubbleShape
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
            .shadow(
                color: .junoCardShadow,
                radius: JunoElevation.cardBlur,
                y: JunoElevation.cardOffsetY
            )
    }

    /// "Show more · 22 lines", in the web's monospaced metadata voice. The size
    /// is sampled off the head of the message, never counted across the whole of
    /// a multi-megabyte paste.
    private var expandControl: some View {
        Button {
            withAnimation(JunoMotion.standard) { promptExpanded.toggle() }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: promptExpanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                Text(
                    promptExpanded
                        ? "Show less"
                        : "Show more · \(NativePromptLimits.collapsedSummary(for: plainText))"
                )
                .font(.caption.monospaced())
            }
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("juno.desktop.chat.message-expand")
    }

    var body: some View {
        Group {
            switch message.role {
            case .user:
                HStack {
                    Spacer(minLength: 90)
                    VStack(alignment: .trailing, spacing: JunoSpace.hairline) {
                        userBubble
                        if isLongPrompt { expandControl }
                    }
                }

            case .assistant:
                VStack(alignment: .leading, spacing: 14) {
                if let reasoning = message.reasoning, !reasoning.isEmpty {
                    DisclosureGroup("Thought process", isExpanded: $reasoningExpanded) {
                        Text(reasoning)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .padding(.top, 8)
                    }
                    .font(.caption.weight(.medium))
                    .tint(.secondary)
                }

                if message.content.isEmpty, message.isPending {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Juno is working…")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                        switch part {
                        case .text(let text):
                            JunoMarkdownText(text)
                        case .artifact(let artifact):
                            DesktopInlineArtifactCard(
                                artifact: artifact,
                                open: artifact.streaming
                                    ? nil
                                    : {
                                        inlineArtifact = DesktopInlineArtifact(
                                            reference: artifact
                                        )
                                    }
                            )
                        }
                    }
                }

                if !message.sources.isEmpty {
                    DesktopMessageSources(sources: message.sources)
                }

                if let footerLine {
                    Text(footerLine)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                }

                if let error = message.errorDescription {
                    Text(error)
                        .font(.callout)
                        // The status ramp, not `.red`: `junoDanger` is tuned for
                        // contrast against both the warm canvas and the raised
                        // surfaces, and it lifts rather than saturates in dark.
                        .foregroundStyle(Color.junoDanger)
                        .textSelection(.enabled)
                }

                if !message.isPending {
                    HStack(spacing: 4) {
                        messageAction(
                            "Copy",
                            symbol: "doc.on.doc",
                            action: copy
                        )
                        if let readAloud {
                            messageAction(
                                "Read aloud",
                                symbol: "speaker.wave.2",
                                action: readAloud
                            )
                        }
                        if let branch {
                            messageAction(
                                "Branch from here",
                                symbol: "arrow.triangle.branch",
                                action: branch
                            )
                        }
                        if isLastAssistant {
                            messageAction(
                                "Regenerate",
                                symbol: "arrow.clockwise",
                                action: regenerate
                            )
                        }
                        if let setFeedback {
                            Spacer()
                            messageAction(
                                "Good response",
                                symbol: message.feedback == .up
                                    ? "hand.thumbsup.fill" : "hand.thumbsup",
                                active: message.feedback == .up
                            ) {
                                setFeedback(message.feedback == .up ? nil : .up)
                            }
                            messageAction(
                                "Bad response",
                                symbol: message.feedback == .down
                                    ? "hand.thumbsdown.fill" : "hand.thumbsdown",
                                active: message.feedback == .down
                            ) {
                                setFeedback(message.feedback == .down ? nil : .down)
                            }
                        }
                    }
                    .foregroundStyle(.secondary)
                }
                }

            case .system, .tool:
                Text(message.content)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .sheet(item: $inlineArtifact) { artifact in
            DesktopInlineArtifactView(
                artifact: artifact,
                close: { inlineArtifact = nil }
            )
        }
    }

    private func messageAction(
        _ label: String,
        symbol: String,
        active: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .frame(width: 22, height: 22)
                .foregroundStyle(active ? Color.junoAccent : Color.secondary)
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
    }
}

private struct DesktopInlineArtifact: Identifiable {
    let reference: NativeMessageContent.ArtifactReference
    var id: String { reference.id }

    var kind: NativeArtifactKind {
        NativeArtifactKind(rawValue: reference.kind.uppercased()) ?? .code
    }
}

/// An artifact referenced inline in an answer.
///
/// Built from the web's `artifact-inline-card.tsx`: a raised card, a glyph in its
/// own bordered tile, the title in the UI face, and everything else — the kind,
/// the language, the live status — on one monospaced metadata line. The chrome
/// stays quiet on purpose; on the web the artifact's *content* is the visual
/// event, which is also why the icon is not painted coral. Coral is spent on one
/// primary action per surface, and a card in a transcript is not it.
private struct DesktopInlineArtifactCard: View {
    let artifact: NativeMessageContent.ArtifactReference
    let open: (() -> Void)?

    /// The web's `ICONS` map, in SF Symbols. Falls through to the code glyph for
    /// a kind this client does not know, which is honest: an artifact of an
    /// unrecognised kind is still source.
    private var glyph: String {
        switch artifact.kind.uppercased() {
        case "HTML": "globe"
        case "REACT": "curlybraces.square"
        case "SVG": "square.on.circle"
        case "MERMAID": "flowchart"
        case "MARKDOWN": "doc.text"
        default: "chevron.left.forwardslash.chevron.right"
        }
    }

    /// The kind, spelled the way the product spells it.
    ///
    /// Not `kind.capitalized`: the wire value is upper-case, so that produced
    /// "Html", "Svg" and "React" — the first two are wrong as words and all three
    /// were the card's most prominent metadata. Unknown kinds fall back to the
    /// wire value untouched, which is honest rather than title-cased nonsense.
    private var kindLabel: String {
        switch artifact.kind.uppercased() {
        case "HTML": "HTML"
        case "REACT": "React"
        case "CODE": "Code"
        case "SVG": "SVG"
        case "MARKDOWN": "Markdown"
        case "MERMAID": "Diagram"
        default: artifact.kind
        }
    }

    /// The web's mono line: the kind, then the language when the model named one.
    /// "Writing" replaces both while the source is still arriving.
    private var metadata: String {
        if artifact.streaming { return "Writing" }
        guard let language = artifact.language, !language.isEmpty else {
            return kindLabel
        }
        return "\(kindLabel) · \(language.uppercased())"
    }

    var body: some View {
        Button {
            open?()
        } label: {
            HStack(spacing: JunoSpace.cozy) {
                // The web's `size-8` tile. The glyph needs a surface of its own or
                // it reads as punctuation in front of the title. Fill only, no
                // second hairline: this is nested inside a card that already has
                // one, which is the distinction `junoPanel` draws against
                // `junoCard`.
                Image(systemName: glyph)
                    .font(.callout)
                    .foregroundStyle(
                        artifact.streaming ? Color.junoAccent : Color.secondary
                    )
                    .frame(width: 32, height: 32)
                    .background(
                        RoundedRectangle(
                            cornerRadius: JunoCornerRadius.compactControl,
                            style: .continuous
                        )
                        .fill(Color.junoMuted)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(artifact.title.isEmpty ? "Untitled artifact" : artifact.title)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    Text(metadata)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: JunoSpace.snug)

                if artifact.streaming {
                    // Juno's own dot matrix, which is what the web animates while
                    // an artifact writes — not a spinner, which says "blocked".
                    JunoThinkingMatrix(dot: 3, spacing: 2)
                        .foregroundStyle(.secondary)
                } else if open != nil {
                    Label("Open", systemImage: "arrow.up.right")
                        .labelStyle(.titleAndIcon)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
            }
            .padding(JunoSpace.cozy)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(open == nil)
        .junoCard(cornerRadius: JunoCornerRadius.card)
        .accessibilityLabel(
            artifact.streaming
                ? "Writing artifact \(artifact.title)"
                : "Open artifact \(artifact.title), \(metadata)"
        )
    }
}

private struct DesktopInlineArtifactView: View {
    let artifact: DesktopInlineArtifact
    let close: () -> Void
    @State private var mode = NativeArtifactDisplayMode.preview

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(artifact.reference.title)
                        .font(.title2.weight(.semibold))
                    Text("From this conversation")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if artifact.kind.supportsRenderedPreview {
                    Picker("View", selection: $mode) {
                        Text("Preview").tag(NativeArtifactDisplayMode.preview)
                        Text("Source").tag(NativeArtifactDisplayMode.source)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 180)
                }
                ShareLink(item: artifact.reference.content) {
                    Image(systemName: "square.and.arrow.up")
                }
                Button(action: close) {
                    Image(systemName: "xmark")
                }
            }
            .padding(16)
            .background(.bar)
            .overlay(alignment: .bottom) { Divider() }

            NativeArtifactPreview(
                kind: artifact.kind,
                content: artifact.reference.content,
                mode: mode
            )
            // Padding inside the greedy frame: reversed, this asks the parent
            // for "everything plus 32", which a split view resolves by oversizing.
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 760, minHeight: 560)
        .background(Color.junoCanvas)
    }
}

@MainActor
private final class DesktopSpeechPlayback {
    private let synthesizer = AVSpeechSynthesizer()
    private var audioPlayer: AVAudioPlayer?

    func play(audio: Data?, fallbackText: String) throws {
        synthesizer.stopSpeaking(at: .immediate)
        audioPlayer?.stop()
        audioPlayer = nil
        if let audio {
            let player = try AVAudioPlayer(data: audio)
            player.prepareToPlay()
            player.play()
            audioPlayer = player
        } else {
            synthesizer.speak(AVSpeechUtterance(string: fallbackText))
        }
    }
}

/// The answer's bibliography, as the web writes it: a pill that reports how many
/// sources backed the reply and expands into the cited list.
///
/// The flat "Sources" heading with every link permanently open that this replaces
/// was the loudest thing under a long answer, and it grew without limit — a deep
/// research reply cites dozens. The web collapses it deliberately: the inline
/// citations are what a reader follows mid-sentence, and this is the bibliography
/// they open afterwards. Both the pill and the expanded list are raised surfaces,
/// so they read as objects sitting on the canvas rather than as more text printed
/// onto it.
private struct DesktopMessageSources: View {
    let sources: [NativeChatSource]
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            pill
            if expanded {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                        if index > 0 {
                            Divider().padding(.leading, JunoSpace.region)
                        }
                        row(source, index: index + 1)
                    }
                }
                .junoCard()
                // The web's `max-w-xl`: a citation list is scanned down its left
                // edge, so it stops well short of the reading column's width.
                .frame(maxWidth: 576, alignment: .leading)
                .transition(.opacity)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var pill: some View {
        Button {
            withAnimation(JunoMotion.standard) { expanded.toggle() }
        } label: {
            HStack(spacing: JunoSpace.tight) {
                // The web stacks each site's favicon here. This client fetches no
                // remote images for a transcript, so it says the same thing with
                // one glyph rather than inventing placeholder logos.
                Image(systemName: "globe")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("Sources")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Color.primary)
                Text(sources.count.formatted())
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(expanded ? 180 : 0))
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.tight)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        // The radius exceeds half the pill's height, so it resolves to a capsule —
        // which is what makes it read as a control rather than as a small card,
        // exactly as the web's `rounded-full` pill does.
        .junoCard(cornerRadius: JunoCornerRadius.message)
        .accessibilityLabel("Sources, \(sources.count)")
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
    }

    private func row(_ source: NativeChatSource, index: Int) -> some View {
        Link(destination: source.url) {
            HStack(spacing: JunoSpace.cozy) {
                // Numbered to match the inline `[n]` citations in the answer
                // above, so the two read as one numbering.
                Text(index.formatted())
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
                    .frame(minWidth: JunoSpace.regular, alignment: .trailing)

                VStack(alignment: .leading, spacing: 1) {
                    Text(source.title.isEmpty ? host(of: source.url) : source.title)
                        .font(.callout)
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    Text(host(of: source.url))
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: JunoSpace.snug)

                Image(systemName: "arrow.up.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help(source.url.absoluteString)
    }

    /// The web's `hostOf`: the bare host, without the `www.` that carries no
    /// information and pushes the part a reader recognises off the line.
    private func host(of url: URL) -> String {
        guard let host = url.host() else { return url.absoluteString }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}

private struct DesktopResearchActivity: View {
    let items: [NativeChatActivity]

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Label("Research in progress", systemImage: "globe")
                .font(.caption.weight(.semibold))
            ForEach(items) { item in
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                    Circle()
                        .fill(Color.junoAccent)
                        .frame(width: 5, height: 5)
                    Text(item.detail ?? item.title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        // A raised card, not a bare fill: without the hairline and the throw this
        // was a white rectangle on a warm field with no edge to it.
        .junoCard()
    }
}

private struct DesktopChatError: View {
    let message: String
    let canRetry: Bool
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Color.junoDanger)
            Text(message)
                .font(.callout)
                .textSelection(.enabled)
            Spacer(minLength: JunoSpace.snug)
            if canRetry {
                Button("Retry", action: retry)
            }
        }
        .padding(JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The card treatment plus a danger-coloured glyph, rather than a red wash
        // behind the text. A tinted fill needs an opacity nobody owns and it drops
        // the contrast of the very message the reader has to act on; the glyph and
        // the status ramp carry the meaning without touching legibility.
        .junoCard()
    }
}

private struct DesktopComposer: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let attachmentModel: NativeComposerAttachmentModel?
    let libraryModel: NativeLibraryModel?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    let connectorModel: NativeConnectorModel?
    let openVoiceMode: (String) -> Void

    @State private var prompt = ""
    @State private var selectedModelID = ""
    @State private var thinkingStopID = ""
    @State private var deepResearch = false
    @State private var webSearch = false
    @State private var canvasEnabled = false
    @State private var selectedProjectID: String?
    @State private var selectedConnectors: Set<String> = []
    @State private var showingFileImporter = false
    @State private var showingLibrary = false
    @State private var showingModelSelector = false
    @State private var showingThinking = false
    @State private var dictating = false
    @State private var importError: String?
    /// Whether a very large draft has been opened back up for editing. The text
    /// is in `prompt` and sent in full either way — this only decides whether it
    /// is live in the text field. See ``NativePromptLimits``.
    @State private var draftExpanded = false
    @FocusState private var focused: Bool

    private var selectedModel: NativeChatModelOption? {
        model.model(withID: selectedModelID)
    }

    private var thinkingScale: NativeThinkingScale? {
        selectedModel.map(NativeThinkingScale.init(model:))
    }

    private var reasoningEffort: NativeReasoningEffort? {
        thinkingScale?.stops.first { $0.id == thinkingStopID }?.effort
    }

    private var canSend: Bool {
        // Text *or* attachments, as the web has it: a message that is nothing
        // but the file you attached is a message. Requiring text here is what
        // made "Attach as file" leave a draft that could not be sent.
        (!prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !(attachmentModel?.attachments.isEmpty ?? true))
            && !selectedModelID.isEmpty
            && !model.isGenerating
            && (attachmentModel?.canSend ?? true)
    }

    // MARK: Long drafts

    /// Whether the draft is long enough that sending it as a file is worth
    /// offering. An offer, never a rule — see ``NativePromptLimits``.
    private var isLongDraft: Bool {
        canAttachDraft && NativePromptLimits.isLongDraft(prompt)
    }

    /// Past this the draft leaves the text field entirely and shows as a card.
    /// Tens of thousands of characters in an auto-sizing `TextField` re-measure
    /// on every keystroke, and the composer stops accepting input long before
    /// the reader gets to Send.
    private var showsCollapsedDraft: Bool {
        NativePromptLimits.isHugeDraft(prompt) && !draftExpanded
    }

    private var canAttachDraft: Bool {
        attachmentModel?.hasCapacity ?? false
    }

    /// Sends the draft as `prompt.txt` instead of as message text.
    ///
    /// The web's `attachAsFile`, ported: same file name, same MIME type, and the
    /// same clearing of the draft afterwards, so a prompt attached here and one
    /// attached in the browser arrive at the model as the same message.
    private func attachDraftAsFile() {
        let content = prompt
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let attachmentModel
        else { return }
        attachmentModel.add(
            data: Data(content.utf8),
            fileName: NativePromptLimits.attachedPromptFileName,
            mimeType: NativePromptLimits.attachedPromptMimeType,
            conversationID: model.selectedConversationID,
            isImage: false
        )
        prompt = ""
        draftExpanded = false
    }

    var body: some View {
        // One glass container for the whole composer. The bar and the send
        // button are both glass; without a shared container each samples the
        // canvas independently and they seam where they meet instead of
        // refracting one sample and blending as they approach.
        JunoDesktopGlass(spacing: JunoSpace.snug) {
            composerContent
        }
    }

    private var composerContent: some View {
        VStack(spacing: 10) {
            if let attachmentModel, !attachmentModel.attachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(attachmentModel.attachments) { attachment in
                            DesktopAttachmentChip(
                                attachment: attachment,
                                remove: { attachmentModel.remove(attachment.id) },
                                retry: {
                                    attachmentModel.retry(
                                        attachment.id,
                                        conversationID: model.selectedConversationID
                                    )
                                }
                            )
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }

            if let message = importError ?? attachmentModel?.lastErrorDescription {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if dictating {
                DesktopDictation(
                    onCancel: {
                        withAnimation(JunoMotion.fast) {
                            dictating = false
                        }
                        focused = true
                    },
                    onStop: { transcript in
                        appendDictated(transcript)
                        withAnimation(JunoMotion.fast) {
                            dictating = false
                        }
                        focused = true
                    },
                    onSend: { transcript in
                        appendDictated(transcript)
                        withAnimation(JunoMotion.fast) {
                            dictating = false
                        }
                        Task {
                            await Task.yield()
                            send()
                        }
                    }
                )
                .transition(.opacity)
            } else {
                if showsCollapsedDraft {
                    collapsedDraftCard
                        .transition(.opacity)
                } else {
                TextField("Message Juno", text: $prompt, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .font(.body)
                    .focused($focused)
                    .padding(.horizontal, 8)
                    .padding(.top, 4)
                    .accessibilityIdentifier("Message Juno")
                    // Return sends; Shift-Return breaks the line.
                    //
                    // This is what every chat surface does, including Juno's own
                    // web composer, and it is why the send button below carries no
                    // keyboard shortcut of its own — an accelerator on the button
                    // would fight this handler for the same key. A vertical
                    // `TextField` inserts a newline on Return by default, so the
                    // key has to be intercepted rather than merely bound.
                    .onKeyPress(.return, phases: .down) { press in
                        // Shift-Return falls through to the field's own newline.
                        if press.modifiers.contains(.shift) { return .ignored }
                        if canSend {
                            send()
                            return .handled
                        }
                        // Swallowed rather than ignored: with an empty prompt, or
                        // while a turn is still streaming, Return must not quietly
                        // grow the box instead of doing what the user asked.
                        return .handled
                    }

                    if isLongDraft {
                        attachAsFileOffer
                    }
                }

                HStack(spacing: 6) {
                    addMenu

                    Rectangle()
                        .fill(Color.junoHairline)
                        .frame(width: 1, height: 19)
                        .padding(.horizontal, 2)

                    modelControl

                    if let scale = thinkingScale, scale.isPresentable {
                        thinkingControl(scale)
                    }

                    Spacer(minLength: 8)

                    if JunoSpeechService.isSupported, !model.isGenerating {
                        dictateButton
                        Rectangle()
                            .fill(Color.junoHairline)
                            .frame(width: 1, height: 20)
                            .padding(.horizontal, 1)
                            .accessibilityHidden(true)
                    }

                    primaryAction
                }
            }
        }
        .padding(JunoSpace.snug)
        .frame(maxWidth: 720)
        // Real Liquid Glass, and nothing drawn on top of it. The previous
        // treatment stroked a hairline border over the glass, which flattened
        // the rim's light scatter — the thing that makes glass read as having
        // thickness — back into a translucent rounded rectangle.
        .junoFloatingChrome(cornerRadius: JunoCornerRadius.composer)
        .padding(.horizontal, JunoSpace.roomy)
        .padding(.bottom, JunoSpace.tight)
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true,
            onCompletion: importFiles
        )
        .sheet(isPresented: $showingLibrary) {
            if let libraryModel, let attachmentModel {
                DesktopLibraryPicker(
                    model: libraryModel,
                    capacity: max(
                        0,
                        NativeComposerAttachmentModel.maximumAttachments
                            - attachmentModel.attachments.count
                    ),
                    attach: {
                        if let uploaded = await libraryModel.attachSelection() {
                            attachmentModel.adopt(uploaded)
                            showingLibrary = false
                        }
                    },
                    cancel: {
                        libraryModel.selection = []
                        showingLibrary = false
                    }
                )
            }
        }
        .onAppear {
            configureSelection()
            focused = true
        }
        // Every transient presentation is torn down with the composer.
        //
        // A `.popover` whose anchor leaves the hierarchy while still presented
        // makes SwiftUI's `PopoverBridge` call `showRelativeToRect:` against a
        // window that is already being ordered — `addChildWindow:` →
        // `_doOrderWindow:` → an uncaught `NSRemoteView` exception and SIGTRAP.
        // Opening the model selector and then clicking a different sidebar row
        // reproduces it: the click destroys the composer that owns the anchor.
        .onDisappear {
            showingModelSelector = false
            showingThinking = false
            showingLibrary = false
            showingFileImporter = false
        }
        .animation(JunoMotion.fast, value: showsCollapsedDraft)
        // Once the draft is back under the inline ceiling, forget that it was
        // ever expanded — otherwise the *next* huge paste would land straight in
        // the text field, which is the state this card exists to avoid.
        .onChange(of: prompt) { _, text in
            if !NativePromptLimits.isHugeDraft(text) { draftExpanded = false }
        }
        .onChange(of: model.modelCatalog) { _, _ in configureSelection() }
        .onChange(of: model.selectedConversationID) { _, selected in
            configureSelection()
            selectedProjectID = selected == nil
                ? nil : model.selectedConversation?.projectId
            if selected == nil {
                selectedConnectors = []
                canvasEnabled = false
            }
        }
        .onChange(of: selectedModelID) { _, _ in configureThinking() }
    }

    /// The quiet offer under a long draft: "That's a long one — send it as a
    /// file to keep the chat tidy?" One line and one button, exactly as the web
    /// puts it, and it never touches the draft unless the button is used.
    private var attachAsFileOffer: some View {
        HStack(spacing: JunoSpace.snug) {
            Text("That's a long one — send it as a file to keep the chat tidy?")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: JunoSpace.tight)
            Button(action: attachDraftAsFile) {
                Label("Attach as file", systemImage: "doc.badge.arrow.up")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityIdentifier("juno.desktop.chat.attach-draft")
        }
        .padding(.horizontal, 8)
        .transition(.opacity)
    }

    /// What a very large paste looks like in the composer: a card standing for
    /// the draft, not the draft itself.
    ///
    /// The text is untouched — it is still in `prompt`, and Send still sends all
    /// of it. What has gone is the live `TextField`, which was re-measuring the
    /// whole passage on every keystroke. "Edit" puts it back for a reader who
    /// really does want to work inside a 40,000-character prompt.
    private var collapsedDraftCard: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Long message ready to send")
                        .font(.callout.weight(.medium))
                    Text("\(prompt.count.formatted(.number)) characters · sent in full · Return to send")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                    Text(prompt.prefix(240) + (prompt.count > 240 ? "…" : ""))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .padding(.top, 2)
                }
                Spacer(minLength: 0)
                Button {
                    prompt = ""
                    draftExpanded = false
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .help("Clear this message")
                .accessibilityLabel("Clear this message")
            }

            HStack(spacing: JunoSpace.snug) {
                Button {
                    draftExpanded = true
                    focused = true
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
                .accessibilityIdentifier("juno.desktop.chat.expand-draft")

                if canAttachDraft {
                    Button(action: attachDraftAsFile) {
                        Label("Attach as file", systemImage: "doc.badge.arrow.up")
                    }
                    .accessibilityIdentifier("juno.desktop.chat.attach-draft")
                }
                Spacer(minLength: 0)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(JunoSpace.snug)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoCornerRadius.control, style: .continuous)
                .fill(Color.junoMuted.opacity(0.6))
        )
        // Return sends from here too: the card *is* the draft, and a reader who
        // has just pasted should not have to find the button with the mouse.
        .onKeyPress(.return, phases: .down) { press in
            if press.modifiers.contains(.shift) { return .ignored }
            if canSend { send() }
            return .handled
        }
        .accessibilityIdentifier("juno.desktop.chat.collapsed-draft")
    }

    private var addMenu: some View {
        Menu {
            Button {
                showingFileImporter = true
            } label: {
                Label("Attach files", systemImage: "paperclip")
            }
            .disabled(!(attachmentModel?.hasCapacity ?? false))

            Button {
                showingLibrary = true
            } label: {
                Label("Choose from Library", systemImage: "books.vertical")
            }
            .disabled(
                libraryModel == nil || !(attachmentModel?.hasCapacity ?? false)
            )

            if let projectModel {
                Menu {
                    selectionMenuButton(
                        title: "No project",
                        selected: selectedProjectID == nil
                    ) {
                        selectedProjectID = nil
                    }
                    Divider()
                    ForEach(projectModel.projects) { project in
                        selectionMenuButton(
                            title: project.name,
                            selected: selectedProjectID == project.id
                        ) {
                            selectedProjectID = project.id
                        }
                    }
                } label: {
                    Label(
                        selectedProjectName ?? "Add to project",
                        systemImage: "folder"
                    )
                }
                .disabled(model.selectedConversationID != nil)
            }

            Divider()

            Toggle(isOn: $deepResearch) {
                Label("Deep research", systemImage: "binoculars")
            }

            Toggle(isOn: $webSearch) {
                Label("Web search", systemImage: "globe")
            }
            .disabled(selectedModel?.supportsWebSearch != true)

            Toggle(isOn: $canvasEnabled) {
                Label("Canvas & artifacts", systemImage: "rectangle.on.rectangle")
            }

            if connectorModel != nil {
                Menu {
                    if connectedConnectors.isEmpty {
                        Text("No connected apps")
                    } else {
                        ForEach(connectedConnectors) { connector in
                            selectionMenuButton(
                                title: connector.label,
                                selected: selectedConnectors.contains(connector.id)
                            ) {
                                toggleConnector(connector.id)
                            }
                            .disabled(
                                !selectedConnectors.contains(connector.id)
                                    && selectedConnectors.count >= 5
                            )
                        }
                    }
                } label: {
                    Label(
                        selectedConnectors.isEmpty
                            ? "Connectors"
                            : "Connectors · \(selectedConnectors.count)",
                        systemImage: "link"
                    )
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.primary)
                .frame(width: 34, height: 34)
                .overlay(alignment: .topTrailing) {
                    if deepResearch || !selectedConnectors.isEmpty {
                        Circle()
                            .fill(Color.junoAccent)
                            .stroke(Color.junoSurface, lineWidth: 1.5)
                            .frame(width: 8, height: 8)
                            .offset(x: 1, y: -1)
                    }
                }
                .frame(width: 40, height: 44)
                .contentShape(.rect)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Add files, tools, projects, or connected apps")
        .accessibilityLabel("Add")
    }

    private var modelControl: some View {
        Button {
            showingModelSelector = true
        } label: {
            HStack(spacing: 6) {
                JunoProviderMark(
                    providerID: selectedModel?.providerID ?? "juno",
                    providerName: selectedModel?.providerName ?? "Juno",
                    size: 14
                )
                Text(selectedModel?.displayName ?? "Choose model")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.secondary)
            }
            .padding(.horizontal, 10)
            .frame(height: 34)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .fixedSize(horizontal: true, vertical: false)
        .help("Choose model")
        .accessibilityLabel("Model")
        .accessibilityValue(selectedModel?.displayName ?? "Not selected")
        .accessibilityIdentifier("juno.desktop.chat-model")
        .popover(
            isPresented: $showingModelSelector,
            attachmentAnchor: .rect(.bounds),
            arrowEdge: .bottom
        ) {
            // The shared selector, not a Chat-local copy of it. `JunoModelSelector`
            // superseded the app's own `DesktopModelSelector` when the control
            // moved down to JunoDesignSystem so Juno Code could use it too; Chat
            // was still calling the old one, which is how the two windows ended
            // up with two implementations of the same picker to keep in step.
            // `junoDescriptor` is the manifest row projected onto the
            // presentation-neutral type the shared view takes, so nothing the
            // server publishes is lost in the move.
            JunoModelSelector(
                models: model.modelCatalog.map(\.junoDescriptor),
                selectedModelID: selectedModelID,
                select: { descriptor in
                    selectedModelID = descriptor.id
                    showingModelSelector = false
                }
            )
        }
    }

    @ViewBuilder
    private func thinkingControl(_ scale: NativeThinkingScale) -> some View {
        if scale.isAutomatic {
            Text("Auto")
                .junoMono()
                .foregroundStyle(Color.secondary)
                .padding(.horizontal, 9)
                .frame(height: 34)
                .accessibilityLabel("Thinking")
                .accessibilityValue("Automatic")
        } else {
            Button {
                showingThinking = true
            } label: {
                HStack(spacing: 5) {
                    Text(currentThinkingLabel(in: scale))
                        .junoMono()
                        .lineLimit(1)
                    Image(systemName: "chevron.up")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.secondary)
                }
                .foregroundStyle(Color.primary)
                .padding(.horizontal, 9)
                .frame(height: 34)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .fixedSize()
            .accessibilityLabel("Thinking")
            .accessibilityValue(currentThinkingLabel(in: scale))
            .accessibilityIdentifier("juno.desktop.chat-thinking")
            .popover(
                isPresented: $showingThinking,
                attachmentAnchor: .rect(.bounds),
                arrowEdge: .bottom
            ) {
                JunoThinkingPopover(
                    scale: scale,
                    effort: thinkingEffortBinding(for: scale),
                    width: 268
                )
                .frame(width: 268, height: 118)
            }
        }
    }

    private var dictateButton: some View {
        Button {
            focused = false
            withAnimation(JunoMotion.fast) {
                dictating = true
            }
        } label: {
            Image(systemName: "mic")
                .font(.body)
                .foregroundStyle(Color.primary.opacity(0.76))
                .frame(width: 34, height: 34)
                .frame(width: 40, height: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Dictate")
        .accessibilityLabel("Dictate")
        .accessibilityIdentifier("juno.desktop.chat-dictate")
    }

    @ViewBuilder
    /// The composer's single morphing action: stop while generating, voice on an
    /// empty prompt, send otherwise.
    ///
    /// Two fixes over the flat version this replaces. It is real interactive
    /// Liquid Glass tinted with the accent, so it belongs to the composer's glass
    /// container instead of sitting on it as an opaque tile. And the glyph uses
    /// ``Color/junoOnAccent`` rather than a hardcoded white: the accent is an
    /// account setting, and white on the amber and sage accents fails contrast —
    /// which is the entire reason the design system carries an on-accent token.
    private var primaryAction: some View {
        Group {
            if model.isGenerating {
                Button {
                    model.stopGeneration()
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.caption.weight(.bold))
                        .frame(width: 36, height: 36)
                        .foregroundStyle(Color.junoOnAccent)
                }
                .accentGlassAction(active: true)
                .help("Stop generating")
                .accessibilityLabel("Stop generating")
            } else if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                attachmentModel?.attachments.isEmpty ?? true
            {
                // Voice takes the slot exactly when Send has nothing to do. A
                // staged attachment is something to send, so it keeps Send.
                Button {
                    openVoiceMode(selectedModelID)
                } label: {
                    DesktopVoiceGlyph()
                        .frame(width: 36, height: 36)
                        .foregroundStyle(Color.junoOnAccent)
                }
                .accentGlassAction(active: !selectedModelID.isEmpty)
                .disabled(selectedModelID.isEmpty)
                .help("Start a voice conversation")
                .accessibilityIdentifier("Start voice conversation")
                .accessibilityLabel("Start voice conversation")
            } else {
                Button {
                    send()
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.callout.weight(.bold))
                        .frame(width: 36, height: 36)
                        .foregroundStyle(
                            canSend ? Color.junoOnAccent : Color.secondary
                        )
                }
                .accentGlassAction(active: canSend)
                .disabled(!canSend)
                .help("Send message")
                .accessibilityIdentifier("Send message")
                .accessibilityLabel("Send message")
            }
        }
    }

    private func thinkingEffortBinding(
        for scale: NativeThinkingScale
    ) -> Binding<NativeReasoningEffort?> {
        Binding(
            get: { reasoningEffort },
            set: { effort in
                thinkingStopID = scale.stops.first { $0.effort == effort }?.id
                    ?? scale.defaultStop?.id
                    ?? ""
            }
        )
    }

    private func currentThinkingLabel(in scale: NativeThinkingScale) -> String {
        scale.stops.first { $0.id == thinkingStopID }?.label ?? "Off"
    }

    private func selectionMenuButton(
        title: String,
        selected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            if selected {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }

    private func configureSelection() {
        selectedModelID = DesktopChatSelection.resolvedModelID(
            current: selectedModelID,
            conversationModel: model.selectedConversation?.model ?? "",
            selectable: model.selectableModels
        )
        configureThinking()
    }

    private func configureThinking() {
        guard let scale = thinkingScale else {
            thinkingStopID = ""
            return
        }
        if scale.stops.contains(where: { $0.id == thinkingStopID }) {
            return
        }
        thinkingStopID = scale.defaultStop?.id ?? ""
        if selectedModel?.supportsWebSearch != true {
            webSearch = false
        }
    }

    private func send() {
        guard canSend else { return }
        let content = prompt
        let modelID = selectedModelID
        let effort = reasoningEffort
        let uploadedIDs = attachmentModel?.uploadedIDs ?? []
        let research = deepResearch
        let search = webSearch
        let canvas = canvasEnabled
        let connectors = Array(selectedConnectors.prefix(5))
        let projectID = selectedProjectID

        Task {
            let conversationID: String?
            if let selected = model.selectedConversationID {
                conversationID = selected
            } else {
                model.isDraftingNewConversation = true
                conversationID = await model.createConversationResolvingID(
                    model: modelID,
                    projectID: projectID
                )
            }

            guard let conversationID else { return }
            let sent = model.sendMessage(
                conversationID: conversationID,
                prompt: content,
                modelID: modelID,
                reasoningEffort: effort,
                attachmentIDs: uploadedIDs,
                deepResearch: research,
                webSearch: search,
                canvasEnabled: canvas ? true : nil,
                connectors: connectors
            )
            guard sent else { return }
            prompt = ""
            draftExpanded = false
            attachmentModel?.clear()
            deepResearch = false
            canvasEnabled = false
            Task {
                await model.generateTitleIfNeeded(conversationID: conversationID)
            }
        }
    }

    private var connectedConnectors: [NativeConnector] {
        (connectorModel?.linked ?? []).filter(\.connected)
    }

    private var selectedProjectName: String? {
        guard let selectedProjectID else { return nil }
        return projectModel?.projects.first { $0.id == selectedProjectID }?.name
    }

    private func toggleConnector(_ id: String) {
        if selectedConnectors.contains(id) {
            selectedConnectors.remove(id)
        } else if selectedConnectors.count < 5 {
            selectedConnectors.insert(id)
        }
    }

    private func appendDictated(_ transcript: String) {
        let dictated = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !dictated.isEmpty else { return }
        let current = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        prompt = current.isEmpty ? dictated : "\(current) \(dictated)"
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            importError = error.localizedDescription
        case .success(let urls):
            importError = nil
            for url in urls.prefix(NativeComposerAttachmentModel.maximumAttachments) {
                let granted = url.startAccessingSecurityScopedResource()
                defer {
                    if granted { url.stopAccessingSecurityScopedResource() }
                }
                do {
                    let values = try url.resourceValues(forKeys: [.contentTypeKey])
                    let contentType = values.contentType
                    let data = try Data(contentsOf: url)
                    attachmentModel?.add(
                        data: data,
                        fileName: url.lastPathComponent,
                        mimeType: contentType?.preferredMIMEType
                            ?? "application/octet-stream",
                        conversationID: model.selectedConversationID,
                        isImage: contentType?.conforms(to: .image) == true
                    )
                } catch {
                    importError = "Could not attach \(url.lastPathComponent): \(error.localizedDescription)"
                }
            }
        }
    }
}

private struct DesktopVoiceGlyph: View {
    private let heights: [CGFloat] = [7, 13, 18, 11, 6]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(heights.enumerated()), id: \.offset) { _, height in
                Capsule()
                    .fill(Color.white)
                    .frame(width: 2, height: height)
            }
        }
        .accessibilityHidden(true)
    }
}

private struct DesktopLibraryPicker: View {
    @Bindable var model: NativeLibraryModel
    let capacity: Int
    let attach: () async -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Attach from Library")
                        .font(.title2.weight(.semibold))
                    Text("Choose files already shared with Juno.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Picker("Filter", selection: $model.filter) {
                    ForEach(NativeLibraryModel.Filter.allCases) { filter in
                        Text(filter.title).tag(filter)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 220)
            }
            .padding(18)
            .background(.bar)
            .overlay(alignment: .bottom) { Divider() }

            Group {
                if model.isLoading && model.items.isEmpty {
                    ProgressView("Loading Library…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if model.visibleItems.isEmpty {
                    ContentUnavailableView(
                        "No matching files",
                        systemImage: "books.vertical",
                        description: Text(
                            "Files and images you share in conversations appear here."
                        )
                    )
                } else {
                    List(model.visibleItems) { item in
                        Button {
                            model.toggle(item.id, limit: capacity)
                        } label: {
                            HStack(spacing: 12) {
                                Image(
                                    systemName: item.isImage
                                        ? "photo" : "doc"
                                )
                                .foregroundStyle(Color.junoAccent)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item.fileName)
                                        .lineLimit(1)
                                    Text(
                                        ByteCountFormatter.string(
                                            fromByteCount: Int64(item.size),
                                            countStyle: .file
                                        )
                                    )
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(
                                    systemName: model.selection.contains(item.id)
                                        ? "checkmark.circle.fill" : "circle"
                                )
                                .foregroundStyle(
                                    model.selection.contains(item.id)
                                        ? Color.junoAccent : Color.secondary
                                )
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                    .listStyle(.inset)
                }
            }
            .frame(minHeight: 360)

            HStack {
                if let error = model.lastErrorDescription {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                } else {
                    Text("\(model.selection.count) of \(capacity) selected")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Cancel", action: cancel)
                Button {
                    Task { await attach() }
                } label: {
                    if model.isAttaching {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Attach")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.selection.isEmpty || model.isAttaching)
            }
            .padding(16)
            .background(.bar)
            .overlay(alignment: .top) { Divider() }
        }
        .frame(minWidth: 680, idealWidth: 740, minHeight: 520)
        .task {
            model.selection = []
            await model.refresh()
        }
    }
}

private struct DesktopAttachmentChip: View {
    let attachment: NativeComposerAttachment
    let remove: () -> Void
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 7) {
            stateIcon
            Text(attachment.fileName)
                .font(.caption)
                .lineLimit(1)
            if case .failed(_, let retryable) = attachment.state, retryable {
                Button("Retry", action: retry)
                    .buttonStyle(.plain)
                    .font(.caption.weight(.medium))
            }
            Button(action: remove) {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(attachment.fileName)")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            Capsule(style: .continuous)
                .fill(Color.junoMuted)
        )
        .help(failureMessage ?? attachment.fileName)
    }

    @ViewBuilder
    private var stateIcon: some View {
        switch attachment.state {
        case .preparing, .uploading:
            ProgressView()
                .controlSize(.mini)
        case .uploaded:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.red)
        }
    }

    private var failureMessage: String? {
        guard case .failed(let message, _) = attachment.state else { return nil }
        return message
    }
}

private extension NativeConversationBucket {
    var desktopTitle: String {
        switch self {
        case .pinned: "Pinned"
        case .today: "Today"
        case .yesterday: "Yesterday"
        case .previous7Days: "Previous 7 days"
        case .previous30Days: "Previous 30 days"
        case .older: "Older"
        // Unreachable on the desktop: `DesktopChatSidebar.groups` drops the
        // archive bucket. The case stays because the bucket is shared with the
        // phone app and the switch has to be exhaustive.
        case .archived: "Archived"
        }
    }
}
