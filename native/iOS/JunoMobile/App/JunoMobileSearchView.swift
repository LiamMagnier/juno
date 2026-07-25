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

    var body: some View {
        content
            .background(Color.junoCanvas)
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            // Deliberately NOT an identifier on this whole view. It used to carry
            // `juno.mobile.search`, and an identifier on a container is inherited
            // by every descendant — so `juno.mobile.search-results` did not exist
            // at runtime and neither did anything else on the screen.
            .safeAreaInset(edge: .bottom) { field }
            .onAppear { fieldFocused = true }
    }

    // MARK: - Field

    private var field: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 15))
                .foregroundStyle(Color.junoMutedForeground)
            TextField(
                "Chats, messages, projects, files…",
                text: Binding(get: { model.query }, set: { model.setQuery($0) })
            )
            .font(.system(size: 16))
            .textFieldStyle(.plain)
            .foregroundStyle(Color.primary)
            .submitLabel(.search)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .focused($fieldFocused)
            .accessibilityIdentifier("juno.mobile.search-field")

            if !model.query.isEmpty {
                Button {
                    model.setQuery("", debounced: false)
                    fieldFocused = true
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Color.junoMutedForeground.opacity(0.7))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
                .accessibilityIdentifier("juno.mobile.search-clear")
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 44)
        // Real Liquid Glass, in the same container the rest of the app's floating
        // chrome uses. `interactive` is what makes it respond to touch, and it
        // belongs here because the whole capsule is the field's hit area.
        .junoGlass(in: Capsule(style: .continuous), interactive: true)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
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
                Label("Search unavailable", systemImage: "exclamationmark.triangle")
            } description: {
                Text(model.lastErrorDescription ?? "Try again.")
            } actions: {
                Button("Retry") { model.setQuery(model.query, debounced: false) }
                    .buttonStyle(.borderedProminent)
            }
        case .ready where visibleGroups.isEmpty:
            // Names the corpus, because "no results" and "not synced yet" are
            // indistinguishable to the reader and only one of them is their
            // problem to solve.
            ContentUnavailableView(
                "No results",
                systemImage: "magnifyingglass",
                description: Text("Nothing synced to this device matches “\(model.query)”.")
            )
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
            LazyVStack(alignment: .leading, spacing: 18) {
                ForEach(visibleGroups, id: \.kind) { group in
                    VStack(alignment: .leading, spacing: 8) {
                        JunoGroupLabel(text: sectionTitle(group.kind))
                        JunoCard(padding: 0) {
                            VStack(spacing: 0) {
                                ForEach(Array(group.results.enumerated()), id: \.element.id) {
                                    index, result in
                                    if index > 0 { Divider().padding(.leading, 48) }
                                    row(result)
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 20)
            .frame(maxWidth: 768)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("juno.mobile.search-results")
    }

    private func row(_ result: NativeSearchResult) -> some View {
        Button { open(result) } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon(result.kind))
                    .font(.system(size: 14))
                    .foregroundStyle(Color.junoMutedForeground)
                    .frame(width: 20, height: 20)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 3) {
                    Text(result.title)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    if !result.snippet.isEmpty, result.snippet != result.title {
                        Text(result.snippet)
                            .font(.system(size: 13))
                            .foregroundStyle(Color.junoMutedForeground)
                            .lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Text(result.updatedAt, style: .relative)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Color.junoMutedForeground.opacity(0.7))
                    .lineLimit(1)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        // `.plain` is the load-bearing part: without it the label inherits the
        // accent and the entire row turns coral.
        .buttonStyle(JunoSidebarPressStyle())
        .accessibilityHint("Opens \(sectionTitle(result.kind).lowercased())")
    }

    // MARK: - Recents

    /// What the screen shows before a query: the chats and projects the reader was
    /// last in. Search that demands input before showing anything makes the reader
    /// remember a title in order to find the thing whose title they forgot.
    @ViewBuilder
    private var recents: some View {
        if recentConversations.isEmpty && projects.isEmpty {
            ContentUnavailableView(
                "Search Juno",
                systemImage: "magnifyingglass",
                description: Text("Chats, messages, projects and files — everything synced to this device, searchable offline.")
            )
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if !recentConversations.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            JunoGroupLabel(text: "Recent chats")
                            JunoCard(padding: 0) {
                                VStack(spacing: 0) {
                                    ForEach(Array(recentConversations.prefix(6).enumerated()), id: \.element.id) {
                                        index, conversation in
                                        if index > 0 { Divider().padding(.leading, 48) }
                                        recentRow(
                                            title: conversation.title,
                                            date: conversation.lastMessageAt,
                                            glyph: conversation.pinned
                                                ? "pin.fill" : "bubble.left.and.bubble.right",
                                            action: { openConversation?(conversation.id) }
                                        )
                                    }
                                }
                            }
                        }
                    }

                    if !projects.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            JunoGroupLabel(text: "Projects")
                            JunoCard(padding: 0) {
                                VStack(spacing: 0) {
                                    ForEach(Array(projects.prefix(5).enumerated()), id: \.element.id) {
                                        index, project in
                                        if index > 0 { Divider().padding(.leading, 48) }
                                        recentRow(
                                            title: project.name,
                                            date: project.updatedAt,
                                            glyph: project.starred ? "star.fill" : "folder",
                                            action: { openProject?(project.id) }
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 20)
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
        glyph: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: glyph)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.junoMutedForeground)
                    .frame(width: 20, height: 20)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(date, style: .relative)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Color.junoMutedForeground.opacity(0.7))
                    .lineLimit(1)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(JunoSidebarPressStyle())
        .accessibilityLabel(title)
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

    private func icon(_ kind: NativeSearchResultKind) -> String {
        switch kind {
        case .conversation: "bubble.left.and.bubble.right"
        case .message: "text.bubble"
        case .project: "folder"
        case .file: "doc"
        case .artifact: "square.stack.3d.up"
        case .memory: "brain.head.profile"
        }
    }
}
