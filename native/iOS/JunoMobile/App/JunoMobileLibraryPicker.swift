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

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 3), count: 3)

    var body: some View {
        NavigationStack {
            content
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
                Label("library.empty.title", systemImage: "photo.on.rectangle")
            } description: {
                Text("library.empty.description")
            } actions: {
                if model.lastErrorDescription != nil {
                    Button("action.retry") { Task { await model.refresh() } }
                        .contentShape(.rect)
                        .buttonStyle(.bordered)
                }
            }
        } else {
            list
        }
    }

    /// The system photo picker's shape: a segmented filter, then a tight
    /// three-column grid of thumbnails with small corners and the system's
    /// checkmark badge on what is selected.
    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                Picker("library.filter", selection: $model.filter) {
                    ForEach(NativeLibraryModel.Filter.allCases, id: \.self) { filter in
                        Text(filter.title).tag(filter)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(.horizontal, JunoSpace.regular)

                if let error = model.lastErrorDescription {
                    HStack(spacing: JunoSpace.cozy) {
                        Image(systemName: "exclamationmark.triangle")
                            .foregroundStyle(.secondary)
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                        Button("action.retry") { Task { await model.refresh() } }
                            .contentShape(.rect)
                            .font(.subheadline)
                    }
                    .padding(.horizontal, JunoSpace.regular)
                }

                Text(selectionLine)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, JunoSpace.regular)

                LazyVGrid(columns: columns, spacing: 3) {
                    ForEach(model.visibleItems) { item in
                        card(item)
                    }
                }
            }
            .padding(.top, JunoSpace.snug)
            .padding(.bottom, JunoSpace.section)
            .frame(maxWidth: 768)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await model.refresh() }
    }

    /// States the cap in words while it still matters and goes quiet once the
    /// selection is empty.
    private var selectionLine: String {
        guard !model.selection.isEmpty else {
            return String(localized: "library.pick")
        }
        return "\(model.selection.count) of \(remainingCapacity) selected"
    }

    private func card(_ item: NativeLibraryItem) -> some View {
        let file = NativeFilePreviewRequest(item)
        let selected = model.selection.contains(item.id)
        // Unselected cells go quiet at the ceiling rather than vanishing.
        let blocked = !selected && model.selection.count >= remainingCapacity
        return Button {
            model.toggle(item.id, limit: remainingCapacity)
        } label: {
            Color(.secondarySystemFill)
                .aspectRatio(1, contentMode: .fit)
                .overlay { thumbnail(file, state: previews.state(for: item.id)) }
                .clipShape(.rect(cornerRadius: 6, style: .continuous))
                .overlay(alignment: .bottomTrailing) {
                    if selected {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.title3)
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(.white, .tint)
                            .padding(6)
                    }
                }
                .contentShape(.rect)
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

    /// The picture, or — for a file with none — its type and name, the way the
    /// Files app draws a document it cannot preview.
    @ViewBuilder
    private func thumbnail(_ file: NativeFilePreviewRequest, state: NativeFilePreviewLoader.State) -> some View {
        switch state {
        case .ready(let image):
            Image(decorative: image, scale: 1)
                .resizable()
                .scaledToFill()
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: file.isImage ? .center : .top)
        case .loading:
            EmptyView()
        case .unavailable:
            VStack(spacing: 6) {
                Image(systemName: file.isImage ? "photo" : "doc.text")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                Text(file.fileName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .truncationMode(.middle)
            }
            .padding(8)
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
