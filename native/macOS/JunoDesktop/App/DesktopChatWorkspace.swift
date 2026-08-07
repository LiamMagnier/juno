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
    /// Lets the root retire a one-shot production launch route after this view
    /// has actually applied it. The screenshot harness does not provide one.
    var consumeInitialDestination: (() -> Void)?
    /// A one-shot request made from the Code sidebar to start an ordinary Chat
    /// conversation that is not scoped to any local repository.
    var unscopedChatRequestID: UUID?
    let consumeUnscopedChatRequest: () -> Void
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
    /// Whether the Tasks inspector is up. The key is ``DesktopTasksScreen``'s own
    /// — scene storage is one value per key per scene, so the page's toolbar
    /// toggle and this window's `.inspector` are reading and writing the same
    /// flag, and the page keeps its default of showing.
    @SceneStorage("juno.desktop.tasks.inspector") private var tasksInspectorShown = true
    @State private var columnVisibility = NavigationSplitViewVisibility.all
    /// The Tasks page's selection and its pending presentations.
    ///
    /// Held by the window because the page and the inspector are now two views in
    /// two different columns of it, and `@State` cannot span them. See
    /// ``DesktopTasksSurface``.
    @State private var tasksSurface = DesktopTasksSurface()
    /// Set by Projects immediately before it opens a new draft. The composer
    /// consumes it once so an ordinary toolbar New Chat never inherits an old
    /// project's scope.
    @State private var draftProjectID: String?
    /// Optional text entered on a project overview before opening Chat. The
    /// composer consumes this once, so the project page never presents a fake
    /// prompt field.
    @State private var draftPrompt: String?
    @State private var sharing = false
    /// One line under the toolbar after a Share, so the copy is acknowledged.
    @State private var shareNotice: String?

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
                conversationModel: model,
                draftProjectID: $draftProjectID,
                draftPrompt: $draftPrompt
            )
            // The Tasks page reads its selection from here; the inspector below
            // writes it. One object, injected once, because the page is built by
            // `DesktopDestinationView` — which has nothing of its own to hand it.
            .environment(tasksSurface)
            .junoReadingCanvas()
            .navigationTitle("")
            .toolbar { detailToolbar }
        }
        // `.inspector` goes on the split view, **not** on the detail column, and
        // not on a page inside it either.
        //
        // Tasks and Artifacts each carried their own, presented from the content of
        // this window's detail column. That is precisely the placement
        // ``DesktopCodeWorkspace`` bisected to a hard crash: from a detail column
        // the inspector makes SwiftUI's `NSHostingView` call
        // `setNeedsUpdateConstraints:` from inside its own `updateConstraints`
        // while the window's constraint pass is already running for that display
        // cycle, AppKit throws from `-[NSWindow _postWindowNeedsUpdateConstraints]`
        // and the process takes SIGTRAP. Tasks defaulted its flag to *shown*, so
        // one click in the sidebar was the whole reproduction.
        //
        // Hoisted here there is one inspector for the window and the binding
        // decides which destination owns it. Artifacts' version history did not
        // come with it: it reads and writes the document's editing state — the
        // displayed version, the compare base, the diff being shown — so it is a
        // pane inside that page instead. ``DesktopArtifactsScreen`` says why.
        .inspector(isPresented: inspectorPresentation) { inspector }
        .focusedSceneValue(
            \.junoWorkspaceActions,
            DesktopWorkspaceActions(
                newItem: beginDraft,
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
                consumeInitialDestination?()
            }
            consumePendingUnscopedChatRequest()
        }
        .onChange(of: unscopedChatRequestID) { _, _ in
            consumePendingUnscopedChatRequest()
        }
        .onChange(of: columnVisibility) { _, visibility in
            storedColumnVisibility = visibility == .detailOnly ? "detailOnly" : "all"
        }
    }

    /// What the destination in force puts in the trailing column, or nil when it
    /// has nothing to put there.
    ///
    /// Tasks is the only destination that fills it. Artifacts keeps its version
    /// history as a pane inside its own page — ``DesktopArtifactsScreen`` says why
    /// — and the rest have nothing to inspect. The model is part of the answer
    /// rather than checked separately: an account whose scheduled-task service is
    /// unavailable gets the page's own explanation and no empty column beside it.
    private var inspectableTasks: NativeScheduledTaskModel? {
        guard currentDestination == .tasks else { return nil }
        return configuration.scheduledTaskModel
    }

    /// Whether the window's one inspector is up.
    ///
    /// The write is gated on the same condition as the read. A column dismissed
    /// while some other surface is showing must not be recorded as the reader
    /// hiding the *task* inspector, or Tasks would open closed next time for a
    /// reason that had nothing to do with it.
    private var inspectorPresentation: Binding<Bool> {
        Binding(
            get: { inspectableTasks != nil && tasksInspectorShown },
            set: { shown in
                guard inspectableTasks != nil else { return }
                tasksInspectorShown = shown
            }
        )
    }

    /// The trailing column's content, given the inspector's resize range once
    /// rather than per destination: a column whose width is redeclared as the
    /// reader moves through the sidebar is a column AppKit re-lays out on every
    /// navigation.
    private var inspector: some View {
        Group {
            if let inspectableTasks {
                DesktopTasksInspector(
                    model: inspectableTasks,
                    surface: tasksSurface,
                    openConversation: openConversation
                )
            }
        }
        .inspectorColumnWidth(
            min: JunoInspectorMetrics.minimum,
            ideal: JunoInspectorMetrics.ideal,
            max: JunoInspectorMetrics.maximum
        )
    }

    /// Opens a conversation some other surface points at — today, the chat a
    /// scheduled task writes its runs into.
    ///
    /// `DesktopDestinationView` performs the same navigation for the pages it
    /// builds, but the task inspector is no longer one of them: it hangs off this
    /// window's split view, above anything that view can reach.
    private func openConversation(_ id: String) {
        draftProjectID = nil
        draftPrompt = nil
        model.isDraftingNewConversation = false
        model.selectedConversationID = id
        destination.wrappedValue = .chat
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
        // **No product switch here.** It is the first thing in the sidebar now —
        // `DesktopSidebarProductHeader`, drawn identically by both columns.
        //
        // It was in the toolbar because the first sidebar version was a bare
        // `safeAreaInset` with nothing painted behind it, so scrolled rows slid
        // under the switch and on under the traffic lights. That failure was the
        // missing backing, not the placement, and the header fixes it there. What
        // the toolbar cost in exchange was real: `.principal` competes with the
        // window's own title for the centre of the bar, and a control that changes
        // what the *navigation* column lists is a strange thing to have to reach
        // for at the top of the *content* column. `.navigation` was never an
        // option — in a `NavigationSplitView` it lands in the sidebar's titlebar,
        // beside the traffic lights.
        //
        // Both windows still move together: the header is one view, so the switch
        // cannot sit in one place in Chat and another in Code.

        ToolbarItem(placement: .primaryAction) {
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

        // Only for a conversation that exists. A draft has nothing to publish,
        // and an item that is present but inert is worse than one that is absent.
        if configuration.shareClient != nil, model.selectedConversationID != nil {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await createShare() }
                } label: {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
                .disabled(sharing)
                .help("Create a public link to this conversation")
                .accessibilityIdentifier("Share")
            }
        }
    }

    /// Publishes the conversation and puts the link on the pasteboard.
    ///
    /// The Mac copies rather than opening a share sheet: a link is going into a
    /// message or a document the reader is already writing, and the pasteboard is
    /// one step where the sheet is three. The route is idempotent per
    /// conversation, so pressing Share twice yields the same link.
    private func createShare() async {
        guard let client = configuration.shareClient,
              let conversationID = model.selectedConversationID,
              case .signedIn(let session) = configuration.authModel.phase,
              !sharing
        else { return }
        sharing = true
        defer { sharing = false }
        do {
            let share = try await client.share(conversationID: conversationID, for: session.profile.id)
            JunoPasteboard.copy(share.url.absoluteString)
            shareNotice = "Link copied — anyone with it can read this conversation as it is now."
        } catch {
            shareNotice = "The conversation couldn’t be published. Try again in a moment."
        }
    }

    private func beginDraft() {
        draftProjectID = nil
        draftPrompt = nil
        storedDestination = DesktopDestination.chat.rawValue
        model.isDraftingNewConversation = true
        model.selectedConversationID = nil
        configuration.attachmentModel?.clear()
    }

    private func consumePendingUnscopedChatRequest() {
        guard unscopedChatRequestID != nil else { return }
        overrideDestination = nil
        beginDraft()
        consumeUnscopedChatRequest()
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
        .junoSidebarProductHeader(product: $product)
        // `safeAreaBar`, not `safeAreaInset`: the bar variant is what the
        // system's bottom scroll-edge effect is measured against, and that
        // effect is what lets the footer sit on a translucent column without an
        // opaque bar painted behind it.
        .safeAreaBar(edge: .bottom, spacing: 0) {
            accountFooter
        }
        .junoSidebarScrollEdge()
    }

    private func destinationRow(_ item: DesktopDestination) -> some View {
        // The ink is stated on the mark as well as on the label. A `Label` in a
        // `.sidebar` list resolves its icon slot against the system accent, and
        // an inherited `foregroundStyle` does not reach it — so every destination
        // glyph in this column drew coral no matter what the row said. The web
        // spends no accent here at all: one fill, one ink, resting on
        // `--sidebar-foreground` and lifting to `--foreground` when selected.
        let selected = selection == .destination(item)
        let ink = selected ? Color.primary : Color.junoSidebarForeground

        return Label {
            Text(item.label)
        } icon: {
            if let icon = item.junoIcon {
                JunoIconView(icon, size: 16)
                    .foregroundStyle(ink)
            } else {
                Image(systemName: item.symbol)
                    .foregroundStyle(ink)
            }
        }
        .foregroundStyle(ink)
        .animation(.easeOut(duration: 0.22), value: selected)
        .tag(DesktopSidebarItem.destination(item))
    }

    private func conversationRow(_ conversation: NativeConversation) -> some View {
        HStack(spacing: JunoSpace.tight) {
            if conversation.pinned {
                // Juno's own pin, not SF's, and the one place coral is spent in
                // this column. The web's sidebar is greyscale apart from exactly
                // two `fill-primary` marks — the pinned conversation and the
                // starred project — and the Code sidebar already draws this
                // concept as `JunoIconView(.pin)`. Two clients drawing the same
                // idea with two different glyphs is the drift this unifies.
                JunoIconView(.pin, size: 12)
                    .foregroundStyle(Color.junoAccent)
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

    /// The door to Design, a staged update, and then the account row — pinned to
    /// the bottom of the column by `safeAreaBar` rather than by being the last
    /// child of a `VStack`, so the list scrolls underneath them and they stay
    /// reachable.
    ///
    /// ``DesktopSidebarFooter`` is the same component Code's column pins, which
    /// is what stops the two from describing the same account — or the same
    /// waiting update — differently. No plan is passed: the quota meter needs a
    /// plan model this column does not read, and a meter drawn from nothing is a
    /// claim about spend that nobody made.
    ///
    /// Design sits *above* that block rather than inside it, which is the
    /// website's own arrangement: `app-sidebar.tsx` gives the row its own
    /// container and then a bordered block for the account. The footer component
    /// is about the account — who is signed in, what they have spent, what is
    /// waiting to install — and a navigation row is not one of those things.
    private var accountFooter: some View {
        VStack(spacing: 0) {
            DesktopSidebarDesignRow(isActive: destination == .design) {
                destination = .design
            }
            DesktopSidebarFooter(
                session: session,
                avatarModel: avatarModel,
                syncModel: syncModel,
                plan: nil,
                openUsage: { destination = .usage },
                openSettings: { destination = .settings }
            )
        }
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
    /// Juno Design — the canvas, and the list of what has been drawn on it.
    ///
    /// A destination and deliberately **not** a fourth ``DesktopProductMode``. A
    /// product owns the whole window: its own source list, its own toolbar, its
    /// own `NavigationSplitView`. Design has none of those, and the website
    /// learned this the expensive way — as a fourth segment it only routed away
    /// and left Home's sidebar standing, which is why `app-sidebar.tsx` now draws
    /// it as a row in the footer. It is also absent from ``sidebarCases`` for the
    /// same reason it is absent from the web's rail: the footer is where it goes.
    case design
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
        case .design: "Design"
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
        case .design: "pencil.tip"
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
        case .settings: .settings
        // Usage is the one destination the web draws with no glyph at all — the
        // user menu renders the quota itself, in the dot signature. Borrowing a
        // chart mark from another icon set to fill the hole would be native-only
        // drift, so this keeps the SF fallback until the signature earns a place
        // in the rail.
        case .usage: nil
        // Design's mark exists on the web — `AppIcons.design` is Lucide's
        // `pen-tool` — but `scripts/generate-native-icons.mjs` has never been
        // asked for it, so there is no `nav-design` asset to name here. Same
        // answer as Usage above, and for the same reason: the SF fallback until
        // the real mark is generated, rather than a near-miss from another set.
        case .design: nil
        }
    }
}

// The chat column's own sync dot lived here, drawn in `.green`/`.orange`/`.red`
// while Code's copy drew the same five states on Juno's status tokens. Both
// footers now pin `DesktopSidebarFooter`, and `DesktopSidebarSyncDot` is the
// palette that survived — see DesktopCodeAccountFooter.swift.

struct DesktopConversationView: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let attachmentModel: NativeComposerAttachmentModel?
    let profileName: String?
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    @Binding var draftProjectID: String?
    @Binding var draftPrompt: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var voiceSession: DesktopVoiceSession?
    /// Why a spoken conversation could not be opened. An alert rather than an
    /// inline banner because the reader pressed a button and nothing happened —
    /// the answer has to arrive where they are looking.
    @State private var voiceUnavailable: String?
    /// The artifact the canvas is showing, or nil when it is closed.
    ///
    /// Held **here**, not on the message row that mentions it. A docked column
    /// has to be a sibling of the transcript, and the row is one cell inside a
    /// `LazyVStack` that the scroll view is free to tear down — which is what
    /// made the sheet this replaces a presentation whose presenter could vanish
    /// underneath it. The row now only says "open this".
    @State private var openArtifact: DesktopChatArtifact?
    /// Everything the composer bloom is driven by. See ``DesktopChatAuraState``
    /// for why it cannot live inside the composer.
    @State private var aura = DesktopChatAuraState()
    /// The conversation column's own height, which is what the aura's `54vh` and
    /// `26vh` caps are measured against. Without it the bloom falls back to its
    /// absolute cap and is taller on a short window than the web ever draws it.
    @State private var columnHeight: CGFloat = 0

    var body: some View {
        // Clamped through `Color.clear.overlay { … }`, for the reason
        // ``JunoDetailPage`` spells out: a `ScrollView` propagates its content's
        // ideal height rather than absorbing it, so a long transcript reports an
        // ideal of "every message stacked" — and `NavigationSplitView` answers an
        // ideal it cannot meet by *growing the window's split view*. `Color.clear`
        // takes whatever height it is proposed and an overlay is sized by its
        // base, so the chat can never resize the window it lives in.
        Color.clear
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
                columnHeight = $0
            }
            .overlay { conversationContent }
            // The canvas closes when a conversation does. It belongs to the
            // thread it was opened from, and a panel that survived the switch
            // would be describing a reply that is no longer on screen.
            .onChange(of: model.selectedConversationID) { _, _ in
                openArtifact = nil
            }
            // The web's COEXISTENCE RULE, in the one shape this window has for
            // it: the canvas and a live call are both large right-hand claims on
            // the conversation column, and the call also lights the whole column
            // with its own field. Starting one dismisses the other.
            .onChange(of: voiceSession?.id) { _, started in
                guard started != nil, openArtifact != nil else { return }
                withAnimation(
                    JunoMotion.reduced(DesktopChatMotion.canvasExit, when: reduceMotion)
                ) {
                    openArtifact = nil
                }
            }
            .alert(
                "Voice is unavailable",
                isPresented: Binding(
                    get: { voiceUnavailable != nil },
                    set: { if !$0 { voiceUnavailable = nil } }
                ),
                presenting: voiceUnavailable
            ) { _ in
                Button("OK") { voiceUnavailable = nil }
            } message: { reason in
                Text(reason)
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
        // A live call takes the greeting's place even before a single word has
        // been said, which is the web's `hasMessages || voiceOpen`
        // (`chat-view.tsx`). Without it the most common way to start a call —
        // pressing the microphone on the home screen — is the one place the
        // spoken conversation could never be read, because a draft has no
        // message list to append it to.
        if model.selectedConversation == nil, voiceSession == nil {
            draftColumn
        } else {
            // The canvas is a **column**, not a presentation. It sits beside the
            // conversation exactly as the website's does, so the reply the
            // artifact came out of stays readable next to it — which is the whole
            // difference between docking and covering.
            DesktopArtifactDock(artifact: openArtifact, close: closeArtifact) {
                transcriptColumn
            }
        }
    }

    /// The home screen: greeting on its bloom, composer under it, fine print
    /// pinned to the foot.
    ///
    /// The disclaimer is a bottom inset rather than a third row of the stack —
    /// the web's own split (`justify-center` on the group, a `shrink-0`
    /// disclaimer at the bottom of the column). Two flexible `Spacer`s with
    /// different minimums approximated it and left the fine print floating a
    /// third of the way up a tall window. Pinning it also makes the two branches
    /// of this view agree, so it does not jump the moment a chat starts.
    private var draftColumn: some View {
        VStack(spacing: JunoSpace.section) {
            DesktopDraftGreeting(
                profileName: profileName,
                aura: aura,
                viewport: columnHeight > 0 ? columnHeight : nil
            )
            composer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            DesktopChatDisclaimer()
        }
        // The field behind the whole column — the conversation and the composer
        // both — scoped to it, so the sidebar is never washed by it.
        .junoVoiceField(voiceColumn)
    }

    /// The conversation and its composer.
    ///
    /// No in-content title strip. The conversation's title and its last-updated
    /// stamp are the window's `navigationTitle` and `navigationSubtitle`, which is
    /// where a Mac window says what it is showing. Repeating it in a bordered bar
    /// directly under the toolbar said the same thing twice and cost 42pt of the
    /// reading canvas.
    ///
    /// The composer is a *safe-area inset*, not the last row of a `VStack`, and
    /// that is what makes it glass. Stacked, it occupied its own band of canvas —
    /// a rectangle of `--background` with nothing behind it — so the glass had
    /// nothing to refract and read as a flat white pill. As an inset the
    /// transcript keeps the full height and scrolls *underneath* the composer, so
    /// messages pass behind it and the material finally has something to bend.
    ///
    /// The inset spans this column alone, which is why the canvas docks around it
    /// rather than inside it: the composer belongs to the conversation, and a
    /// composer stretched under an artifact would be offering to send into it.
    private var transcriptColumn: some View {
        DesktopTranscript(
            model: model,
            voiceMessages: voiceMessages,
            messageActions: configuration.messageActionsClient,
            followUpClient: configuration.followUpClient,
            draftPrompt: $draftPrompt,
            accountID: session.profile.id,
            syncModel: configuration.syncModel,
            openArtifact: open(artifact:)
        )
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                composer
                DesktopChatDisclaimer()
            }
            // The docked bloom — a third of the light, short enough to pool
            // around the capsule instead of washing up the transcript. Suppressed
            // during a call: the voice field below already lights this column,
            // and two lights under one capsule read as a bug. The web makes the
            // same swap.
            .background(alignment: .bottom) {
                if voiceSession == nil {
                    DesktopChatAuraLayer(
                        state: aura,
                        docked: true,
                        viewport: columnHeight > 0 ? columnHeight : nil
                    )
                }
            }
        }
        .junoVoiceField(voiceColumn)
    }

    private func open(artifact: NativeMessageContent.ArtifactReference) {
        withAnimation(JunoMotion.reduced(DesktopChatMotion.canvasEnter, when: reduceMotion)) {
            openArtifact = DesktopChatArtifact(reference: artifact)
        }
    }

    private func closeArtifact() {
        withAnimation(JunoMotion.reduced(DesktopChatMotion.canvasExit, when: reduceMotion)) {
            openArtifact = nil
        }
    }

    /// The spoken conversation as it is happening, as ordinary message rows.
    ///
    /// The web's `voiceMessages` (`chat-view.tsx`), reproduced: the live lines
    /// are appended after the persisted ones and rendered by the same row, with
    /// a line the recognizer is still rewriting marked as still arriving. They
    /// are **transient** — nothing here writes them anywhere. Hanging up is what
    /// files a conversation, from the controller's own record, and only the
    /// final lines (``DesktopVoiceDock``); a row built here that also persisted
    /// would file every half-heard hypothesis twice.
    private var voiceMessages: [NativeChatMessage] {
        guard let voiceSession else { return [] }
        // The closure's result type is spelled out: without it Swift infers the
        // non-optional `NativeChatMessage` from the trailing return and then
        // rejects the `nil` that drops a blank hypothesis.
        return voiceSession.controller.transcript.compactMap { line -> NativeChatMessage? in
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return NativeChatMessage(
                id: "voice-\(line.id.uuidString)",
                conversationID: model.selectedConversationID ?? "",
                clientID: nil,
                role: line.role == .assistant ? .assistant : .user,
                content: text,
                reasoning: nil,
                model: nil,
                createdAt: voiceSession.startedAt,
                revision: 0,
                isPending: !line.final
            )
        }
    }

    /// The live call, as the chat column needs it.
    ///
    /// Chat's routing, which is **not** the Projects screen's: the open
    /// conversation is passed down so the turns append to the thread the reader
    /// was already in, and the saved id is selected so a call started from a
    /// draft lands the reader in the conversation the server just created.
    private var voiceColumn: DesktopVoiceColumn? {
        guard let voiceSession else { return nil }
        return DesktopVoiceColumn(
            sessionID: voiceSession.id,
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

    /// Opens a spoken conversation.
    ///
    /// The guard used to `return` with nothing said, so on any shell missing
    /// either half the microphone button was a control that did nothing at all
    /// when pressed — indistinguishable from a broken app, and impossible to
    /// report. It now says which half is missing.
    private func startVoice(modelID: String) {
        guard let sender = configuration.requestSender else {
            voiceUnavailable = "Juno is not signed in, so it cannot start a voice conversation."
            return
        }
        guard configuration.voiceTranscriptClient != nil else {
            voiceUnavailable = "Voice is unavailable for this account."
            return
        }
        let started = DesktopVoiceSession(
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
        voiceSession = started
        // Dialled from here rather than from the dock's `task`. The dock lives
        // in the chat column now, so it can appear a second time over the same
        // session — and `start()` is legal from `ended`, which would make that
        // second appearance silently redial.
        Task { await started.controller.start() }
    }

    private var composer: some View {
        DesktopComposer(
            model: model,
            attachmentModel: attachmentModel,
            libraryModel: configuration.libraryModel,
            projectModel: configuration.projectModel,
            connectorModel: configuration.connectorModel,
            draftProjectID: $draftProjectID,
            draftPrompt: $draftPrompt,
            openVoiceMode: startVoice,
            aura: aura
        )
        // The dock only. The field this composer used to carry is now behind
        // the whole column — see ``conversationContent``.
        .junoVoiceDock(voiceColumn)
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
    /// The live spoken turns, if a call is running. Kept apart from
    /// `model.selectedMessages` rather than merged into the store: these belong
    /// to the call, not to the conversation, and a store that held them would
    /// have to decide when to take them out again.
    let voiceMessages: [NativeChatMessage]
    let messageActions: NativeMessageActionsClient?
    /// Suggests what to ask next, under a finished reply.
    let followUpClient: NativeFollowUpClient?
    /// Picking a suggestion seeds the composer through the same binding the
    /// sidebar's "start from this" already uses, rather than a second path into
    /// the same text field.
    @Binding var draftPrompt: String?
    let accountID: AccountID
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    /// Asks the conversation column to dock the canvas. A row cannot own that
    /// panel — see ``DesktopConversationView/openArtifact``.
    let openArtifact: (NativeMessageContent.ArtifactReference) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var actionError: String?
    @State private var speechPlayback = DesktopSpeechPlayback()
    /// The index from which rows rise in, so opening a conversation does not
    /// replay every entrance it ever had. See ``noteMessages(from:to:)``.
    @State private var animateFrom = Int.max
    /// The conversation whose count `animateFrom` was last seeded against.
    @State private var settledConversationID: String?

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
                    ForEach(Array(model.selectedMessages.enumerated()), id: \.element.id) {
                        index, message in
                        DesktopMessageRow(
                            message: message,
                            isVoice: false,
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
                                        NativeMessageContent.spoken(of: message.content)
                                    )
                                }
                            },
                            openArtifact: openArtifact
                        )
                            .modifier(DesktopMessageRise(rises: index >= animateFrom))
                            .id(message.id)
                    }

                    // The call, in the transcript it belongs to. Same rows, same
                    // reading column, appended after the persisted turns — the
                    // web's arrangement, and the reason it has no transcript
                    // pane: a spoken conversation is the conversation, not a
                    // second view of one.
                    ForEach(voiceMessages) { message in
                        DesktopMessageRow(
                            message: message,
                            isVoice: true,
                            modelDisplayName: nil,
                            isLastAssistant: false,
                            copy: {
                                copy(NativeMessageContent.plainText(of: message.content))
                            },
                            regenerate: nil,
                            branch: nil,
                            setFeedback: nil,
                            readAloud: nil,
                            // A spoken turn carries no artifact tag: it is a
                            // recognizer's line, not a written reply.
                            openArtifact: { _ in }
                        )
                        // A line the recognizer has not finalized is a
                        // hypothesis it is still rewriting several times a
                        // second, and it is frequently wrong. Dimmed, it reads
                        // as something being heard; at full strength it reads as
                        // something that was said.
                        .opacity(message.isPending ? 0.55 : 1)
                        .id(message.id)
                    }

                    if model.isGenerating, !model.researchActivity.isEmpty {
                        DesktopResearchActivity(items: model.researchActivity)
                    }

                    // Under the last reply, once it has settled. Inside the stack
                    // so it scrolls with the transcript rather than floating over
                    // it, and clamped to the reading column like everything else.
                    if let conversationID = model.selectedConversationID {
                        NativeFollowUpStrip(
                            conversationID: conversationID,
                            accountID: accountID,
                            client: followUpClient,
                            ready: !model.isGenerating
                                && model.selectedMessages.last?.role == .assistant,
                            onPick: { draftPrompt = $0 }
                        )
                        .frame(maxWidth: Self.readingWidth, alignment: .leading)
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
            // `initial: true` so a conversation opens at its latest turn even when
            // the messages were already in hand — which is the case every time the
            // canvas takes the whole column on a narrow window and gives it back.
            .onChange(of: model.selectedMessages, initial: true) { previous, current in
                noteMessages(from: previous.count, to: current.count)
                // Animated only when a turn actually arrived. The other two cases
                // are the transcript being drawn for the first time and a reply
                // growing token by token — travelling 180ms from a position the
                // reader never saw reads as the page moving on its own, and a
                // 180ms scroll restarted several times a second never arrives
                // anywhere. The same reasoning as the voice branch below.
                guard current.count != previous.count else {
                    proxy.scrollTo("transcript-bottom", anchor: .bottom)
                    return
                }
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo("transcript-bottom", anchor: .bottom)
                }
            }
            // Unanimated, unlike a sent message: a partial transcript lands
            // several times a second, and a 180ms scroll restarted that often
            // never arrives anywhere.
            .onChange(of: voiceMessages) { _, _ in
                proxy.scrollTo("transcript-bottom", anchor: .bottom)
            }
            .onChange(of: model.chatPhase) { _, _ in
                proxy.scrollTo("transcript-bottom", anchor: .bottom)
            }
        }
    }

    /// Decides which rows are new enough to rise in.
    ///
    /// The web seeds the same index at mount and calls it `animateFrom`
    /// (`message-list.tsx`) — it gets away with one line because its list mounts
    /// with the messages already in hand. A store that loads asynchronously does
    /// not: selecting a conversation sets the id first and the transcript arrives
    /// a moment later, so "everything that appeared since the last render" would
    /// mean the entire history every time a chat is opened.
    private func noteMessages(from previous: Int, to current: Int) {
        guard settledConversationID == model.selectedConversationID else {
            // A conversation that has only just been selected has not loaded yet,
            // so whatever arrives first is its history — however short — and
            // history must not replay. It is not recorded as settled until
            // something actually lands, or an empty first pass would count as the
            // load and the real one would animate.
            if current > 0 { settledConversationID = model.selectedConversationID }
            animateFrom = current
            return
        }
        // A send appends the reader's own turn and then the reply's placeholder,
        // one at a time. Anything larger is a block landing — a sync catching up,
        // a branch being read — and that is history again.
        animateFrom = current - previous > 2 ? current : previous
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

/// The web's `rise-in`, applied to a message that has just arrived.
///
/// `rises` is what keeps a scrolled history still. A `LazyVStack` builds a row
/// the moment it comes into view and destroys it again when it leaves, so a
/// transition driven by appearance alone replays for every old message the reader
/// scrolls back to — the row genuinely *is* appearing, it is simply not new. The
/// index gate answers the question appearance cannot.
private struct DesktopMessageRise: ViewModifier {
    let rises: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var risen: Bool

    /// A row that is not rising starts *already* risen rather than being set
    /// there by `onAppear`. Seeded the other way it spent its first frame at zero
    /// opacity, which on a lazily-built stack means every old message flickers as
    /// the reader scrolls back through the conversation.
    init(rises: Bool) {
        self.rises = rises
        _risen = State(initialValue: !rises)
    }

    func body(content: Content) -> some View {
        content
            .opacity(risen ? 1 : 0)
            .offset(y: risen ? 0 : DesktopChatMotion.riseDistance)
            .onAppear {
                guard rises, !reduceMotion else {
                    risen = true
                    return
                }
                withAnimation(DesktopChatMotion.riseIn) { risen = true }
            }
    }
}

private struct DesktopMessageRow: View {
    let message: NativeChatMessage
    /// Whether this is a spoken turn from a call that is still running.
    ///
    /// It suppresses the footer and the action row, as `isVoice` does on the web
    /// (`message-item.tsx`), and for the same reason: there is no row behind it
    /// yet. Regenerate, Branch and the feedback thumbs all address a message the
    /// server knows about, and this one exists only in the controller until the
    /// call is hung up and filed.
    let isVoice: Bool
    /// The model's human name, resolved from the account catalog by the caller.
    ///
    /// The footer used to render `message.model` directly, which is the canonical
    /// id — so the most-read surface in the product attributed answers to
    /// "anthropic:claude-sonnet-4-6". The id is a routing key, not a name.
    let modelDisplayName: String?
    let isLastAssistant: Bool
    let copy: () -> Void
    /// Nil where there is nothing on the server to regenerate — the same
    /// absence `branch` and `setFeedback` express, rather than a closure that
    /// does nothing.
    let regenerate: (() -> Void)?
    let branch: (() -> Void)?
    let setFeedback: ((NativeChatFeedback?) -> Void)?
    let readAloud: (() -> Void)?
    /// Hands an artifact up to the conversation column, which owns the canvas.
    /// This row only says which one — it cannot hold the panel, because a
    /// `LazyVStack` is free to tear the row down while the reader is still
    /// reading it.
    let openArtifact: (NativeMessageContent.ArtifactReference) -> Void
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

    /// The lines AIcss's viewport shows, or nil when the model sent no trace.
    ///
    /// A display chunking of what the provider sent — never a claim about where its
    /// steps were. See `JunoAIcssReasoningLines`.
    private var reasoningLines: [String]? {
        guard let reasoning = message.reasoning, !reasoning.isEmpty else { return nil }
        return JunoAIcssReasoningLines.lines(text: reasoning)
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
                // THE TRACE, in AIcss's viewport.
                //
                // This was a system `DisclosureGroup` over the whole reasoning
                // trace as one `Text`: a triangle labelled "Thought process" that,
                // opened, dropped an unbounded wall of prose into the transcript
                // and pushed the answer off screen. Nothing about it said how long
                // the run took, and while streaming it grew under the reader on
                // every delta. The viewport is bounded — 40pt slots clamped to two
                // lines, capped at 180pt, then masked — so the trace can now be
                // open by default while the answer is being written, which is when
                // it is worth anything.
                if let lines = reasoningLines, !lines.isEmpty {
                    JunoAIcssReasoningStream(
                        lines: lines,
                        streaming: message.isPending,
                        duration: nil,
                        showsHeader: !message.isPending
                    )
                    .frame(maxWidth: 520, alignment: .leading)
                }

                if let progress = message.mediaProgress {
                    // A generation in flight has no text to render — the picture
                    // is the answer, and it arrives whole in the `done` frame.
                    NativeMediaGenerationView(progress: progress)
                } else if message.content.isEmpty, message.isPending {
                    // The dot matrix and AIcss's shine, as on the phone and the
                    // web. This was a stock `ProgressView` spinner beside "Juno is
                    // working…" — a system control saying nothing of Juno's, next
                    // to a sentence that named the app rather than the work.
                    HStack(spacing: 10) {
                        JunoThinkingMatrix()
                            .foregroundStyle(Color.junoMutedForeground.opacity(0.65))
                        JunoAIcssThinkingLabel("Thinking about your request", size: 15)
                    }
                    .frame(minHeight: 22)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Thinking about your request")
                    .accessibilityAddTraits(.updatesFrequently)
                } else {
                    ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                        switch part {
                        case .text(let text):
                            // AIcss's caret rides the last paragraph while tokens
                            // are still arriving. Same signal as the phone's.
                            JunoLessonText(text, streaming: message.isPending)
                        case .artifact(let artifact):
                            DesktopInlineArtifactCard(
                                artifact: artifact,
                                open: artifact.streaming
                                    ? nil
                                    : { openArtifact(artifact) }
                            )
                        }
                    }
                }

                if !message.sources.isEmpty {
                    DesktopMessageSources(sources: message.sources)
                }

                if let footerLine, !isVoice {
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

                if !message.isPending, !isVoice {
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
                        if isLastAssistant, let regenerate {
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

/// An artifact referenced inline in an answer.
///
/// Built from the web's `artifact-inline-card.tsx`: a raised card, a glyph in its
/// own bordered tile, the title in the UI face, and everything else — the kind,
/// the language, the live status — on one monospaced metadata line. The chrome
/// stays quiet on purpose; on the web the artifact's *content* is the visual
/// event, which is also why the icon is not painted coral. Coral is spent on one
/// primary action per surface, and a card in a transcript is not it.
///
/// The card is a launcher and nothing more: it hands the artifact up and
/// ``DesktopArtifactCanvas`` docks beside the conversation. Names come from
/// ``DesktopArtifactKindLabel`` so the card and the panel it opens cannot
/// describe the same object differently.
private struct DesktopInlineArtifactCard: View {
    let artifact: NativeMessageContent.ArtifactReference
    let open: (() -> Void)?

    private var glyph: String {
        DesktopArtifactKindLabel.symbol(forWireKind: artifact.kind)
    }

    private var kindLabel: String {
        DesktopArtifactKindLabel.title(forWireKind: artifact.kind)
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

/// The live run's searches, in AIcss's Web Search block.
///
/// What that replaced: a card headed "Research in progress" over a coral bullet
/// per activity item, showing `detail ?? title` for every kind of event. Three
/// things were wrong with it. Coral is reserved for what is active or selected,
/// and every bullet wore it including the finished ones. Every event became a
/// row, so "Selected model" and "Reasoning mode enabled" sat in a list the reader
/// would take for search results. And the query the run was actually searching
/// for — the one thing that answers "what is it doing?" — was never distinguished
/// from anything else in the list.
///
/// Now the query leads and shimmers while the search is open, and only real
/// sources become rows.
private struct DesktopResearchActivity: View {
    let items: [NativeChatActivity]

    private var query: String? { NativeSearchActivity.query(in: items) }
    private var sites: [JunoAIcssSearchSite] { NativeSearchActivity.sites(in: items) }

    var body: some View {
        // Nothing to say is no card. Before the first search or visit lands there
        // is no query and no source, and an empty "Research in progress" card is a
        // claim that something is being shown.
        if query != nil || !sites.isEmpty {
            JunoAIcssWebSearch(
                query: query,
                sites: sites,
                settled: NativeSearchActivity.settled(in: items)
            )
            .padding(JunoSpace.cozy)
            .frame(maxWidth: .infinity, alignment: .leading)
            // A raised card, not a bare fill: without the hairline and the throw
            // this was a white rectangle on a warm field with no edge to it.
            .junoCard()
        }
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

struct DesktopComposer: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let attachmentModel: NativeComposerAttachmentModel?
    let libraryModel: NativeLibraryModel?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    let connectorModel: NativeConnectorModel?
    @Binding var draftProjectID: String?
    @Binding var draftPrompt: String?
    let openVoiceMode: (String) -> Void
    /// Locks this composer to a project and always starts a new conversation.
    /// Used by the project overview so it is the same composer as Chat, not a
    /// prompt-shaped imitation with fewer controls.
    var fixedProjectID: String? = nil
    /// Called after the first message is accepted, so an embedded project
    /// composer can move to the real transcript it just created.
    var didSendConversation: ((String) -> Void)? = nil
    /// The bloom this composer feeds, when the surface it is on has one.
    ///
    /// Optional because the project overview embeds this same composer in the
    /// middle of a page of other things — the website puts no aura there either,
    /// and a light under a card in a list would be claiming that card is the
    /// screen.
    var aura: DesktopChatAuraState? = nil

    @State private var prompt = ""
    @State private var selectedModelID = ""
    @State private var thinkingStopID = ""
    @State private var deepResearch = false
    @State private var webSearch = false
    @State private var canvasEnabled = false
    // @AppStorage rather than @State, unlike its neighbours: these two are
    // preferences that must survive a relaunch (the web keeps them in
    // localStorage, iOS in UserDefaults), where deepResearch above is
    // deliberately per-send and webSearch/canvas are per-view here already.
    @AppStorage("juno.desktop.composer.fast-mode") private var fastMode = false
    @AppStorage("juno.desktop.composer.pro-mode") private var proMode = false
    @State private var selectedProjectID: String?
    @State private var selectedConnectors: Set<String> = []
    @State private var showingFileImporter = false
    @State private var showingLibrary = false
    @State private var showingModelSelector = false
    @State private var showingThinking = false
    @State private var dictating = false
    @State private var importError: String?
    /// Set while a spoken turn is on the wire, so a second Return cannot send
    /// the same images twice.
    @State private var isSendingVoiceTurn = false
    /// Why the last spoken turn was refused, shown in the same notice row as the
    /// attachment errors because it is the same kind of news.
    @State private var voiceTurnError: String?
    /// Whether a very large draft has been opened back up for editing. The text
    /// is in `prompt` and sent in full either way — this only decides whether it
    /// is live in the text field. See ``NativePromptLimits``.
    @State private var draftExpanded = false
    @FocusState private var focused: Bool
    /// The call this composer is inside, published by ``junoVoiceDock(_:)``.
    /// Non-nil is what routes a send over the socket instead of to `/api/chat`.
    @Environment(\.junoVoiceCall) private var voiceCall

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
            && !isSendingVoiceTurn
            && (attachmentModel?.canSend ?? true)
    }

    // MARK: Voice mode

    /// Whether a call is running over this composer. While it is, the draft goes
    /// to the model that is speaking rather than to the chat route.
    private var voiceActive: Bool { voiceCall != nil }

    /// Past four images a turn, providers start answering about the first one
    /// and ignoring the rest. The relay enforces the same ceiling; this is here
    /// so the reader is stopped before they compose a fifth.
    private static let maximumVoiceImages = 4

    /// Whether the model on the other end of the call can see at all.
    ///
    /// Read from what the relay said in `session.ready` rather than from a list
    /// of providers kept here, which would be a second copy to drift. Nil while
    /// connecting reads as "no", so the attach row is not offered a beat before
    /// it can work.
    private var voiceCanSeeImages: Bool {
        voiceCall?.controller.capabilities?.videoInput == true
    }

    /// Whether another image can be staged for the call in progress.
    private var canAttachInVoice: Bool {
        voiceCanSeeImages
            && (attachmentModel?.attachments.count ?? 0) < Self.maximumVoiceImages
    }

    /// What the file importer will accept.
    ///
    /// Narrowed to images during a call, which is the Mac's version of the phone
    /// disabling its Files row: no realtime provider accepts a document, and this
    /// column has no separate Photos row to fall back on, so the one attach row
    /// has to become the image row rather than the refused one.
    private var importedContentTypes: [UTType] {
        voiceActive ? [.image] : [.item]
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

            if let message = voiceTurnError ?? importError
                ?? attachmentModel?.lastErrorDescription
            {
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
            allowedContentTypes: importedContentTypes,
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
            if let fixedProjectID {
                selectedProjectID = fixedProjectID
            }
            consumeDraftProject()
            consumeDraftPrompt()
            focused = true
            // Published here as well as from the `onChange` pair below, because a
            // composer that opens on the model it already had changes nothing —
            // and the bloom would sit on the accent until the reader happened to
            // pick something.
            publishAura()
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
        // A refusal that named the call is meaningless once the call is over.
        .onChange(of: voiceActive) { _, active in
            if !active { voiceTurnError = nil }
        }
        .onChange(of: model.modelCatalog) { _, _ in configureSelection() }
        .onChange(of: model.selectedConversationID) { _, selected in
            configureSelection()
            if let fixedProjectID {
                selectedProjectID = fixedProjectID
            } else {
                selectedProjectID = selected == nil
                    ? nil : model.selectedConversation?.projectId
            }
            if selected == nil {
                selectedConnectors = []
                canvasEnabled = false
            }
        }
        .onChange(of: draftProjectID) { _, _ in
            consumeDraftProject()
        }
        .onChange(of: draftPrompt) { _, _ in
            consumeDraftPrompt()
        }
        .onChange(of: selectedModelID) { _, _ in
            configureThinking()
            publishAura()
        }
        .onChange(of: thinkingStopID) { _, _ in publishAura() }
        .onChange(of: focused) { _, hasFocus in aura?.focused = hasFocus }
    }

    /// Hands the bloom its two derived inputs.
    ///
    /// `hasEffortControl` is the test of whether a slider is *actually on screen*
    /// — the composer's own gate a few lines up — and deliberately not "does this
    /// model reason". Eleven shipped models declare reasoning and expose no
    /// tiers, and Auto resolves the full ladder while showing no slider at all;
    /// either would leave the page burning at its dimmest with nothing on screen
    /// to explain why.
    private func publishAura() {
        guard let aura else { return }
        aura.providerID = selectedModel?.providerID ?? ""
        aura.think = JunoProviderGlow.auraThink(
            effort: reasoningEffort?.rawValue,
            hasEffortControl: thinkingScale?.isPresentable ?? false
        )
    }

    private func consumeDraftProject() {
        guard model.selectedConversationID == nil, let projectID = draftProjectID else {
            return
        }
        selectedProjectID = projectID
        draftProjectID = nil
    }

    private func consumeDraftPrompt() {
        guard model.selectedConversationID == nil,
            prompt.isEmpty,
            let seededPrompt = draftPrompt
        else { return }
        prompt = seededPrompt
        draftPrompt = nil
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

    /// What the "+" adds to a message, and the tools it arms.
    ///
    /// The marks are the website's own, not the nearest SF Symbol: `composer.tsx`
    /// draws Files with `FileUp`, Deep research with `Telescope`, Connectors with
    /// `Plug` — where this menu had reached for `paperclip`, `binoculars` and, for
    /// connectors, a chain `link` that neither of the other two clients uses. The
    /// checkmark on a chosen row stays an SF Symbol: a selection tick is the OS's
    /// mark, not Juno's.
    ///
    /// **None of them are currently drawn, and that is AppKit's decision, not a
    /// missing asset.** A SwiftUI `Menu` on this OS renders its rows title-only:
    /// measured here with a Juno mark, with an SF Symbol, and with
    /// `.labelStyle(.titleAndIcon)` forced on — all three produce a plain text
    /// menu, and the inline `Picker` in Juno Code's composer behaves the same way.
    /// So the SF Symbols this menu used to name were never visible either. They
    /// are stated correctly anyway: this is the row's identity, it is what the
    /// phone and the browser draw, and the day these menus carry images again is
    /// not the day to rediscover which glyph each row meant.
    private var addMenu: some View {
        Menu {
            Button {
                showingFileImporter = true
            } label: {
                // Named for what it can take. During a call the only thing this
                // socket carries is JPEG, so offering "files" would be offering
                // something the turn would then refuse.
                JunoIconLabel(
                    verbatim: voiceActive ? "Attach images" : "Attach files",
                    icon: .files,
                    size: 14
                )
            }
            .disabled(
                voiceActive
                    ? !canAttachInVoice
                    : !(attachmentModel?.hasCapacity ?? false)
            )

            Button {
                showingLibrary = true
            } label: {
                // Visible and disabled rather than removed, because "where did the
                // Library go" is a question worth answering in place. A library
                // pick is a clone whose bytes only ever existed on the server, and
                // there is no way to show one to a model over this socket.
                JunoIconLabel(
                    verbatim: voiceActive
                        ? "Choose from Library — chat only"
                        : "Choose from Library",
                    icon: .library,
                    size: 14
                )
            }
            .disabled(
                voiceActive
                    || libraryModel == nil
                    || !(attachmentModel?.hasCapacity ?? false)
            )

            // Said once, plainly, rather than left for the reader to infer from a
            // row that will not enable. `videoInput` is the relay's own answer, so
            // this names the providers that do have it.
            if voiceActive, !voiceCanSeeImages {
                Button {} label: {
                    Label(Self.noVisionMessage, systemImage: "eye.slash")
                }
                .disabled(true)
            }

            if fixedProjectID == nil, let projectModel {
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
                    JunoIconLabel(
                        verbatim: selectedProjectName ?? "Add to project",
                        icon: .projects,
                        size: 14
                    )
                }
                .disabled(model.selectedConversationID != nil)
            }

            Divider()

            Toggle(isOn: $deepResearch) {
                JunoIconLabel(verbatim: "Deep research", icon: .research, size: 14)
            }

            Toggle(isOn: $webSearch) {
                JunoIconLabel(verbatim: "Web search", icon: .web, size: 14)
            }
            .disabled(selectedModel?.supportsWebSearch != true)

            Toggle(isOn: $canvasEnabled) {
                JunoIconLabel(
                    verbatim: "Canvas & artifacts",
                    icon: .artifactsTool,
                    size: 14
                )
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
                    JunoIconLabel(
                        verbatim: selectedConnectors.isEmpty
                            ? "Connectors"
                            : "Connectors · \(selectedConnectors.count)",
                        icon: .connections,
                        size: 14
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
                .contentShape(.circle)
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
                let popover = JunoThinkingPopover(
                    scale: scale,
                    effort: thinkingEffortBinding(for: scale),
                    width: 268,
                    fastMode: $fastMode,
                    proMode: $proMode
                )
                // The height has to grow with the mode row; the panel cannot
                // measure itself (see JunoThinkingPanel's crash note), so the
                // caller states the sum.
                popover.frame(
                    width: 268,
                    height: 118 + (popover.showsModeToggles ? JunoThinkingMetrics.modeRowHeight : 0)
                )
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
    ///
    /// Every variant states a `Circle` content shape. SwiftUI hit-tests a button
    /// by what its label *draws*, not by the frame around it, and all three
    /// glyphs are small ink in a 36pt frame — the voice bars are five 2pt
    /// capsules, roughly 110pt² inside 1296pt², so nine tenths of the circle the
    /// reader aims at was dead. `Circle` rather than `.rect` because
    /// ``View/accentGlassAction(active:)`` draws a circle: claiming the corners
    /// would make the button react where it visibly is not.
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
                        .contentShape(.circle)
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
                        .contentShape(.circle)
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
                        .contentShape(.circle)
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
        // A live call takes the turn before the chat route ever sees it. Without
        // this the draft went to `/api/chat` and came back as a written exchange
        // the spoken conversation knew nothing about — two threads, from one
        // composer, with the reader watching the wrong one.
        if let voiceCall {
            sendVoiceTurn(voiceCall)
            return
        }
        // Past the guard that can still refuse the turn, and before the work —
        // the swell answers the keystroke, not the round trip. The web sets its
        // flag in exactly the same place inside `sendFromComposer`.
        aura?.fireSendSwell()
        let content = prompt
        let modelID = selectedModelID
        let effort = reasoningEffort
        let uploadedIDs = attachmentModel?.uploadedIDs ?? []
        let research = deepResearch
        let search = webSearch
        let canvas = canvasEnabled
        // Snapshotted with the others: the send is async, and reading the
        // @AppStorage values inside the task would pick up a toggle the reader
        // flipped after hitting send.
        let fast = fastMode
        let pro = proMode
        let connectors = Array(selectedConnectors.prefix(5))
        let projectID = selectedProjectID

        Task {
            let conversationID: String?
            if fixedProjectID == nil, let selected = model.selectedConversationID {
                conversationID = selected
            } else {
                model.isDraftingNewConversation = true
                conversationID = await model.createConversationResolvingID(
                    model: modelID,
                    projectID: fixedProjectID ?? projectID
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
                connectors: connectors,
                fastMode: fast,
                proMode: pro
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
            didSendConversation?(conversationID)
        }
    }

    /// Sends the draft — text and up to four images — through the live session
    /// rather than through the chat route.
    ///
    /// This is what makes keeping the composer on screen during a call worth
    /// anything. The turn goes over the socket the conversation is already on, so
    /// the model answers it out loud in context; the same draft through
    /// `/api/chat` produced a second, silent conversation instead.
    ///
    /// The encoding, the four-image ceiling, the relay's byte bound and the
    /// re-check that the socket has not been replaced underneath a slow encode
    /// all live in ``JunoRealtimeVoiceController/sendTurn(text:images:)``, which
    /// the phone calls too. Nothing here duplicates them — this only decides
    /// whether there is a turn worth handing over, and says why when there is not.
    private func sendVoiceTurn(_ call: DesktopVoiceColumn) {
        guard !isSendingVoiceTurn else { return }
        voiceTurnError = nil
        let controller = call.controller
        guard controller.phase == .live else {
            // A finished call and a slow one need different sentences: the way out
            // of the first is the dock's restart button, and the way out of the
            // second is waiting.
            voiceTurnError = switch controller.phase {
            case .ended, .error:
                "This voice session has ended. Restart it, or hang up to keep typing."
            default:
                "Voice is still connecting. Try again in a moment."
            }
            return
        }

        let staged = attachmentModel?.attachments ?? []
        guard staged.count <= Self.maximumVoiceImages else {
            voiceTurnError = "Voice mode accepts up to 4 images in one turn."
            return
        }
        // `previewData` is the payload the upload model already holds for an
        // image, which is why this needs no second read and no network. An
        // attachment without one is either a document or a library clone whose
        // bytes only ever existed on the server — neither can be shown to a model
        // over this socket, so the turn is refused rather than quietly sent
        // without them.
        //
        // The uploaded id rides along so the saved transcript can claim the same
        // attachment the model was shown; it is nil until the upload lands, and a
        // turn sent then still reaches the model — it is only the saved copy that
        // loses the picture.
        let images = staged.compactMap { attachment in
            attachment.previewData.map {
                JunoVoiceTurnImage(jpeg: $0, attachmentID: attachment.uploadedID)
            }
        }
        guard images.count == staged.count else {
            voiceTurnError =
                "Voice mode can send images only — remove the other attachments first."
            return
        }
        guard images.isEmpty || voiceCanSeeImages else {
            voiceTurnError = Self.noVisionMessage
            return
        }

        aura?.fireSendSwell()
        let text = prompt
        isSendingVoiceTurn = true
        Task {
            let accepted = await controller.sendTurn(text: text, images: images)
            isSendingVoiceTurn = false
            guard accepted else {
                // The controller re-reads the provider's capabilities after the
                // encode, so a turn with images can be refused there even though
                // it passed the check above — a provider switch mid-encode is
                // exactly that case.
                voiceTurnError = images.isEmpty
                    ? "Voice could not send that turn."
                    : Self.noVisionMessage
                return
            }
            prompt = ""
            draftExpanded = false
            attachmentModel?.clear()
        }
    }

    /// The web's own wording for a provider with no eyes, so both clients name
    /// the same three alternatives.
    private static let noVisionMessage =
        "This voice model can’t see images. Switch to OpenAI, Gemini or Qwen."

    private var connectedConnectors: [NativeConnector] {
        (connectorModel?.linked ?? []).filter(\.connected)
    }

    private var selectedProjectName: String? {
        guard let projectID = fixedProjectID ?? selectedProjectID else { return nil }
        return projectModel?.projects.first { $0.id == projectID }?.name
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
            // A call's ceiling is the relay's four, not the message route's ten.
            let ceiling = voiceActive
                ? Self.maximumVoiceImages
                : NativeComposerAttachmentModel.maximumAttachments
            for url in urls.prefix(ceiling) {
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

/// **Attach from Library** — a grid of the files themselves.
///
/// It used to be a `List` of rows: an SF Symbol, the filename, the size. That
/// asks the reader to recognise a screenshot by its name, which nobody can do.
/// The card, its fallback and its press behaviour are the shared
/// ``NativeFilePreviewTile`` — the same one the Library screen and the phone's
/// picker draw, so all three cannot drift into three designs again.
private struct DesktopLibraryPicker: View {
    @Bindable var model: NativeLibraryModel
    let capacity: Int
    let attach: () async -> Void
    let cancel: () -> Void

    @State private var previews = NativeFilePreviewLoader()

    private let columns = [GridItem(.adaptive(minimum: 132, maximum: 190), spacing: 14)]

    private func card(_ item: NativeLibraryItem) -> some View {
        let file = NativeFilePreviewRequest(item)
        let selected = model.selection.contains(item.id)
        // Unselected cards go quiet at the ceiling rather than vanishing, so the
        // limit reads as a limit instead of as a grid that stopped responding.
        let blocked = !selected && model.selection.count >= capacity
        return Button {
            model.toggle(item.id, limit: capacity)
        } label: {
            NativeFilePreviewTile(
                file: file,
                state: previews.state(for: item.id),
                cornerRadius: JunoRadius.panel
            )
            .overlay {
                // A stroke over the picture, never a wash across it: a coral
                // tint over a photograph changes the photograph, which is the
                // one thing this grid exists to show.
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                    .strokeBorder(Color.junoAccent, lineWidth: 2)
                    .opacity(selected ? 1 : 0)
            }
            .overlay(alignment: .topTrailing) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 16))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(
                        selected ? Color.junoOnAccent : Color.white,
                        selected ? Color.junoAccent : Color.black.opacity(0.35)
                    )
                    .padding(8)
                    .shadow(color: .black.opacity(selected ? 0 : 0.25), radius: 2)
            }
        }
        .buttonStyle(NativeFilePreviewPressStyle())
        .disabled(blocked)
        .opacity(blocked ? 0.45 : 1)
        .help(item.fileName)
        .accessibilityLabel("\(item.fileName), \(file.sizeLabel)")
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
        .task(id: item.id) {
            await previews.load(file) { await model.accessFile(id: item.id) }
        }
    }

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
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 14) {
                            ForEach(model.visibleItems) { item in
                                card(item)
                            }
                        }
                        .padding(18)
                    }
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
        // A fixed size, and deliberately **no ideal size**. A sheet that reports
        // an ideal has to be re-solved whenever its presenter's frame moves, and
        // when AppKit moves that frame inside an animation SwiftUI traps in
        // `SheetBridge.sheetSize(presentationID:presenterSize:currentSize:)` —
        // the crash a real .ips from this app pinned on the old voice sheet,
        // which was the other view in this file declaring one. Nothing here
        // needs to grow, so nothing here asks to.
        .frame(width: 740, height: 560)
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
