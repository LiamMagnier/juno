import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// Global offline search across the synchronized encrypted account data.
///
/// **The field is ours, not `.searchable`'s.** It was
/// `.searchable(placement: .navigationBarDrawer(displayMode: .always))`, and from
/// iOS 26 that placement is ignored — the system decides where the field goes and
/// moved it to the bottom toolbar without asking. A field drawn here cannot be
/// relocated by a platform release, which is why it is hand-built.
///
/// It sits at the bottom on real Liquid Glass, in the same slot the composer
/// occupies on the chat screen: thumb height, and the two screens the app is
/// mostly used through put their one text field in the same place.
///
/// **Nothing is a `List`.** The results were `List` sections of `Button`s, and a
/// `Button` label inside a `List` takes the ambient tint — so with the accent
/// applied every title, every snippet and every timestamp came out coral. The
/// whole screen read as one enormous link. They are cards on the canvas now, with
/// ink titles and muted supporting text, like every other list in the app.
struct JunoMobileSearchView: View {
    @Bindable var model: NativeSearchModel<SQLiteAccountRepository>
    let open: (NativeSearchResult) -> Void
    /// Recently touched conversations, newest first. Shown before anything is
    /// typed, because an empty search screen that only says "search Juno" wastes
    /// the one moment the reader has not yet told you what they want.
    var recentConversations: [NativeConversation] = []
    var projects: [NativeProject] = []
    var openConversation: ((String) -> Void)?
    var openProject: ((String) -> Void)?

    @FocusState private var fieldFocused: Bool
    /// What is in the field, owned by the field.
    ///
    /// The store follows it rather than backing it. A `Binding` straight onto
    /// `model.query` made the field and the store two sources for one string —
    /// the clear button wrote to the store while the field read from it — and it
    /// ran the whole screen's invalidation from inside the text field's own edit
    /// callback, because the setter moves `phase`, `results` and the error line
    /// as well.
    @State private var draft = ""

    var body: some View {
        // **The canvas is a constant first child, not a `.background`.**
        //
        // The field hangs off this view in a bottom inset, and the inset's host
        // used to be the bare `switch` on `phase`. Every phase change — and the
        // first keystroke causes one, idle → searching → ready — rebuilt that
        // host and took the text field's first responder with it: "quasar"
        // arrived as "q" and everything after the first letter went nowhere.
        // A stack with one unconditional subview gives the inset something
        // stable to hang from, and the branch change happens a level below it.
        ZStack {
            Color.junoCanvas.ignoresSafeArea()
            content
        }
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.inline)
        // Deliberately NOT an identifier on this whole view. It used to carry
        // `juno.mobile.search`, and an identifier on a container is inherited
        // by every descendant — so `juno.mobile.search-results` did not exist
        // at runtime and neither did anything else on the screen.
        .safeAreaInset(edge: .bottom) { field }
        // Seeded from the store, so coming back to a search that is still live
        // shows the query its results belong to rather than an empty field.
        .onAppear {
            draft = model.query
            fieldFocused = true
        }
        .onChange(of: draft) { _, text in model.setQuery(text) }
        // The store wins when something other than typing moves the query — a
        // re-run after a sync, or the model being stopped and restarted.
        .onChange(of: model.query) { _, query in
            if query != draft { draft = query }
        }
    }

    // MARK: - Field

    private var field: some View {
        HStack(spacing: JunoSpace.cozy) {
            JunoIconView(.search, size: 15)
                .foregroundStyle(Color.junoMutedForeground)
            TextField("Chats, messages, projects, files…", text: $draft)
                .junoFont(size: 16, relativeTo: .callout)
                .textFieldStyle(.plain)
                .foregroundStyle(Color.primary)
                .submitLabel(.search)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .focused($fieldFocused)
                .accessibilityIdentifier("juno.mobile.search-field")

            if !draft.isEmpty {
                // Clears the field and nothing else: the query reaches the store
                // through the same `onChange` every keystroke uses, so there is
                // one path from the field to the results rather than two that
                // can disagree.
                Button {
                    draft = ""
                    fieldFocused = true
                } label: {
                    JunoIconView(.close, size: 14)
                        .foregroundStyle(Color.junoMutedForeground)
                        // A glyph is not a touch target: the 16pt symbol was the
                        // whole of it, and a tap that missed by two points went
                        // to the field instead and cleared nothing.
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
                .accessibilityIdentifier("juno.mobile.search-clear")
            }
        }
        .padding(.leading, JunoSpace.regular)
        // 8 rather than 16 on this side, so the wider clear button lands the
        // glyph exactly where the bare glyph used to sit: the target grew
        // outwards into the capsule's own inset, and nothing moved.
        .padding(.trailing, JunoSpace.snug)
        .frame(height: 44)
        // Real Liquid Glass, in the same container the rest of the app's floating
        // chrome uses. `interactive` is what makes it respond to touch, and it
        // belongs here because the whole capsule is the field's hit area.
        .junoGlass(in: Capsule(style: .continuous), interactive: true)
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .junoGlassSearchContainer()
    }

    // MARK: - Content

    /// Results, or — before anything is typed — where the reader most likely
    /// wanted to go anyway.
    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle:
            recents
        case .searching where model.results.isEmpty:
            JunoMobileQuietLoading()
        case .failed:
            ContentUnavailableView {
                JunoIconLabel("Search unavailable", icon: .error, size: 28)
            } description: {
                Text(model.lastErrorDescription ?? "Try again.")
            } actions: {
                Button("Retry") { model.setQuery(model.query, debounced: false) }
                    .buttonStyle(.borderedProminent)
                .contentShape(.rect)
            }
        case .ready where visibleGroups.isEmpty:
            // Names the corpus, because "no results" and "not synced yet" are
            // indistinguishable to the reader and only one of them is their
            // problem to solve.
            ContentUnavailableView {
                JunoIconLabel(verbatim: "No results", icon: .search, size: 28)
            } description: {
                Text("Nothing synced to this device matches “\(model.query)”.")
            }
        default:
            results
        }
    }

    /// Memory is excluded on purpose. A saved fact is not a place you can go — the
    /// row opened Settings, two screens away from the search you were doing — and
    /// having every query surface Juno's notes about you made the results feel
    /// like they were about the wrong subject.
    private var visibleGroups: [(kind: NativeSearchResultKind, results: [NativeSearchResult])] {
        model.groupedResults.filter { $0.kind != .memory }
    }

    private var results: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: JunoSpace.section) {
                ForEach(visibleGroups, id: \.kind) { group in
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        JunoGroupLabel(text: sectionTitle(group.kind))
                        JunoCard(padding: 0) {
                            VStack(spacing: 0) {
                                ForEach(Array(group.results.enumerated()), id: \.element.id) {
                                    index, result in
                                    if index > 0 { Divider().padding(.leading, JunoSpace.region + JunoSpace.regular) }
                                    row(result)
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.snug)
            .padding(.bottom, JunoSpace.roomy)
            .frame(maxWidth: 768)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("juno.mobile.search-results")
    }

    private func row(_ result: NativeSearchResult) -> some View {
        Button { open(result) } label: {
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                JunoIconView(icon(result.kind), size: 14)
                    .foregroundStyle(Color.junoMutedForeground)
                    .frame(width: 20, height: 20)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 3) {
                    Text(result.title)
                        .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    if !result.snippet.isEmpty, result.snippet != result.title {
                        Text(result.snippet)
                            .junoFont(size: 13, relativeTo: .footnote)
                            .foregroundStyle(Color.junoMutedForeground)
                            .lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Text(result.updatedAt, style: .relative)
                    .junoFont(size: 12, relativeTo: .caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoMutedForeground)
                    .lineLimit(1)
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.cozy)
            .contentShape(Rectangle())
        }
        // `.plain` is the load-bearing part: without it the label inherits the
        // accent and the entire row turns coral.
        .buttonStyle(JunoSidebarPressStyle())
        .accessibilityHint("Opens \(sectionTitle(result.kind).lowercased())")
        .frame(minWidth: 44, minHeight: 44)
    }

    // MARK: - Recents

    /// What the screen shows before a query: the chats and projects the reader was
    /// last in. Search that demands input before showing anything makes the reader
    /// remember a title in order to find the thing whose title they forgot.
    @ViewBuilder
    private var recents: some View {
        if recentConversations.isEmpty && projects.isEmpty {
            ContentUnavailableView {
                JunoIconLabel(verbatim: "Search Juno", icon: .search, size: 28)
            } description: {
                Text("Chats, messages, projects and files — everything synced to this device, searchable offline.")
            }
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: JunoSpace.section) {
                    if !recentConversations.isEmpty {
                        VStack(alignment: .leading, spacing: JunoSpace.snug) {
                            JunoGroupLabel(text: "Recent chats")
                            JunoCard(padding: 0) {
                                VStack(spacing: 0) {
                                    ForEach(Array(recentConversations.prefix(6).enumerated()), id: \.element.id) {
                                        index, conversation in
                                        if index > 0 { Divider().padding(.leading, JunoSpace.region + JunoSpace.regular) }
                                        recentRow(
                                            title: conversation.title,
                                            date: conversation.lastMessageAt,
                                            icon: conversation.pinned ? .pin : .conversation,
                                            action: { openConversation?(conversation.id) }
                                        )
                                    }
                                }
                            }
                        }
                    }

                    if !projects.isEmpty {
                        VStack(alignment: .leading, spacing: JunoSpace.snug) {
                            JunoGroupLabel(text: "Projects")
                            JunoCard(padding: 0) {
                                VStack(spacing: 0) {
                                    ForEach(Array(projects.prefix(5).enumerated()), id: \.element.id) {
                                        index, project in
                                        if index > 0 { Divider().padding(.leading, JunoSpace.region + JunoSpace.regular) }
                                        recentRow(
                                            title: project.name,
                                            date: project.updatedAt,
                                            icon: project.starred ? .pin : .projects,
                                            action: { openProject?(project.id) }
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, JunoSpace.regular)
                .padding(.top, JunoSpace.snug)
                .padding(.bottom, JunoSpace.roomy)
                .frame(maxWidth: 768)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("juno.mobile.search-recents")
        }
    }

    private func recentRow(
        title: String,
        date: Date,
        icon: JunoIcon,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.cozy) {
                JunoIconView(icon, size: 14)
                    .foregroundStyle(Color.junoMutedForeground)
                    .frame(width: 20, height: 20)
                    .accessibilityHidden(true)
                Text(title)
                    .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(date, style: .relative)
                    .junoFont(size: 12, relativeTo: .caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoMutedForeground)
                    .lineLimit(1)
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.cozy)
            .contentShape(Rectangle())
        }
        .buttonStyle(JunoSidebarPressStyle())
        .accessibilityLabel(title)
        .frame(minWidth: 44, minHeight: 44)
    }

    // MARK: - Kinds

    private func sectionTitle(_ kind: NativeSearchResultKind) -> String {
        switch kind {
        case .conversation: "Chats"
        case .message: "Messages"
        case .project: "Projects"
        case .file: "Files"
        case .artifact: "Artifacts"
        case .memory: "Memory"
        }
    }

    private func icon(_ kind: NativeSearchResultKind) -> JunoIcon {
        switch kind {
        case .conversation: .conversation
        case .message: .conversation
        case .project: .projects
        case .file: .file
        case .artifact: .artifacts
        case .memory: .memory
        }
    }
}
