import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// **From your library** — attach a file the account has already shared.
///
/// The web's `LibraryPicker`, on a phone's terms. The mechanism is the same and
/// it is the interesting part: nothing is re-uploaded. `POST /api/library/attach`
/// clones each chosen row against the **same stored object**, and the clone —
/// unlinked, with no message of its own — is what the composer sends. The
/// original message keeps its file.
///
/// Rows rather than a thumbnail grid, matching the project files list this app
/// already has. A grid would need an authenticated image fetch per cell before
/// anything could be drawn, and a picker that is blank for a second is worse than
/// one that is legible immediately.
struct JunoMobileLibraryPicker: View {
    @Bindable var model: NativeLibraryModel
    /// How many more files this message can take. The picker enforces the
    /// composer's ceiling itself, so a selection can never be refused after the
    /// clone has already been made server-side.
    let remainingCapacity: Int
    let attach: ([NativeUploadedAttachment]) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            content
                .background(Color.junoCanvas)
                .navigationTitle("attachments.library")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("action.cancel") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        if model.isAttaching {
                            ProgressView()
                        } else {
                            Button("library.attach") { commit() }
                                .disabled(model.selection.isEmpty)
                                .accessibilityIdentifier("juno.mobile.library-attach")
                        }
                    }
                }
        }
        .presentationDetents([.large])
        .task {
            // Reloaded on every presentation, as the web does: the library grows
            // whenever any client sends a file, and a cached list is a list that
            // is missing what you just sent from your laptop.
            model.selection = []
            await model.refresh()
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.isLoading, model.items.isEmpty {
            JunoMobileQuietLoading()
        } else if model.items.isEmpty {
            ContentUnavailableView {
                Label("library.empty.title", systemImage: "books.vertical")
            } description: {
                Text("library.empty.description")
            } actions: {
                if model.lastErrorDescription != nil {
                    Button("action.retry") { Task { await model.refresh() } }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.junoAccent)
                }
            }
        } else {
            list
        }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                JunoMobileSegmented(
                    options: NativeLibraryModel.Filter.allCases.map {
                        .init($0, $0.title)
                    },
                    selection: $model.filter,
                    accessibilityLabel: String(localized: "library.filter")
                )

                if let error = model.lastErrorDescription {
                    JunoInlineError(message: error) {
                        Task { await model.refresh() }
                    }
                }

                Text(selectionLine)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Color.junoMutedForeground)

                JunoCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(
                            Array(model.visibleItems.enumerated()), id: \.element.id
                        ) { index, item in
                            if index > 0 { Divider().padding(.leading, 16) }
                            row(item)
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 28)
            .frame(maxWidth: 768)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await model.refresh() }
    }

    /// States the cap in words while it still matters and goes quiet once the
    /// selection is empty — a permanent "0 of 8 selected" is chrome, not help.
    private var selectionLine: String {
        guard !model.selection.isEmpty else {
            return String(localized: "library.pick")
        }
        return "\(model.selection.count) / \(remainingCapacity)"
    }

    private func row(_ item: NativeLibraryItem) -> some View {
        let selected = model.selection.contains(item.id)
        // Unselected rows go quiet at the ceiling rather than vanishing, so the
        // limit reads as a limit instead of as a list that stopped responding.
        let blocked = !selected && model.selection.count >= remainingCapacity
        return Button {
            model.toggle(item.id, limit: remainingCapacity)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: item.isImage ? "photo" : "doc.text")
                    .font(.system(size: 15))
                    .foregroundStyle(Color.junoMutedForeground)
                    .frame(width: 22)

                VStack(alignment: .leading, spacing: 3) {
                    Text(item.fileName)
                        .font(.system(size: 15, weight: .medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .foregroundStyle(.primary)
                    HStack(spacing: 5) {
                        Text(
                            ByteCountFormatter.string(
                                fromByteCount: Int64(item.size), countStyle: .file
                            )
                        )
                        Text("·")
                        Text(item.createdAt, style: .date)
                    }
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 18))
                    .foregroundStyle(
                        selected ? Color.junoAccent : Color.junoMutedForeground.opacity(0.3)
                    )
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(JunoSidebarPressStyle())
        .disabled(blocked)
        .opacity(blocked ? 0.45 : 1)
        .accessibilityLabel(item.fileName)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }

    private func commit() {
        Task {
            guard let attached = await model.attachSelection() else { return }
            attach(attached)
            dismiss()
        }
    }
}

extension View {
    /// Installs the library picker, if this shell has a library to pick from.
    ///
    /// A modifier rather than an inline `.sheet` because both chat surfaces — the
    /// draft and an open conversation — need it, and the two had already drifted
    /// once over exactly this kind of duplication.
    @ViewBuilder
    func junoLibraryPicker(
        isPresented: Binding<Bool>,
        libraryModel: NativeLibraryModel?,
        attachmentModel: NativeComposerAttachmentModel?
    ) -> some View {
        if let libraryModel, let attachmentModel {
            sheet(isPresented: isPresented) {
                JunoMobileLibraryPicker(
                    model: libraryModel,
                    remainingCapacity: max(
                        0,
                        NativeComposerAttachmentModel.maximumAttachments
                            - attachmentModel.attachments.count
                    ),
                    attach: { attachmentModel.adopt($0) }
                )
            }
        } else {
            self
        }
    }
}
