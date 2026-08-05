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
/// A grid of the files themselves, the same one the Library screen draws.
///
/// It used to be a list of rows: a `photo` or `doc.text` glyph, the filename, the
/// size. That asks the reader to recognise a screenshot they took last week by
/// its name, and nobody remembers `IMG_4821.HEIC`. The original reasoning was
/// that a grid needs an authenticated fetch per cell and "a picker that is blank
/// for a second is worse than one that is legible immediately" — which was true
/// when there was nothing to fetch *with*. There is now, the fetch is lazy and
/// cached, and a cell that has not loaded yet shows its own name and type rather
/// than nothing. So the objection is answered rather than overruled.
///
/// This is the Library's card, its press behaviour and its fallback, from
/// ``NativeFilePreviewTile`` — not a second look-alike. The two screens list the
/// same files and had already drifted into two designs once.
struct JunoMobileLibraryPicker: View {
    @Bindable var model: NativeLibraryModel
    /// How many more files this message can take. The picker enforces the
    /// composer's ceiling itself, so a selection can never be refused after the
    /// clone has already been made server-side.
    let remainingCapacity: Int
    let attach: ([NativeUploadedAttachment]) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var previews = NativeFilePreviewLoader()

    private let columns = [
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14),
    ]

    var body: some View {
        NavigationStack {
            content
                .junoScreenCanvas()
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
            LazyVStack(alignment: .leading, spacing: 14) {
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

                LazyVGrid(columns: columns, spacing: 14) {
                    ForEach(model.visibleItems) { item in
                        card(item)
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

    private func card(_ item: NativeLibraryItem) -> some View {
        let file = NativeFilePreviewRequest(item)
        let selected = model.selection.contains(item.id)
        // Unselected cards go quiet at the ceiling rather than vanishing, so the
        // limit reads as a limit instead of as a grid that stopped responding.
        let blocked = !selected && model.selection.count >= remainingCapacity
        return Button {
            model.toggle(item.id, limit: remainingCapacity)
        } label: {
            NativeFilePreviewTile(
                file: file,
                state: previews.state(for: item.id),
                cornerRadius: 26
            )
            .overlay {
                // The selection ring is a stroke over the picture, never a wash
                // across it: a coral tint over a photograph changes the
                // photograph, which is the one thing this grid exists to show.
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .strokeBorder(Color.junoAccent, lineWidth: 2)
                    .opacity(selected ? 1 : 0)
            }
            .overlay(alignment: .topTrailing) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(
                        selected ? Color.junoOnAccent : Color.white,
                        selected ? Color.junoAccent : Color.black.opacity(0.35)
                    )
                    .padding(10)
                    .shadow(color: .black.opacity(selected ? 0 : 0.25), radius: 2)
            }
        }
        .buttonStyle(NativeFilePreviewPressStyle())
        .disabled(blocked)
        .opacity(blocked ? 0.45 : 1)
        .accessibilityLabel("\(item.fileName), \(file.sizeLabel)")
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
        .task(id: item.id) {
            await previews.load(file) { await model.accessFile(id: item.id) }
        }
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
