import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// **Attach from Library** — a grid of the files themselves.
///
/// It used to be a `List` of rows: an SF Symbol, the filename, the size. That
/// asks the reader to recognise a screenshot by its name, which nobody can do.
/// The card, its fallback and its press behaviour are the shared
/// ``NativeFilePreviewTile`` — the same one the Library screen and the phone's
/// picker draw, so all three cannot drift into three designs again.
struct DesktopLibraryPicker: View {
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
                cornerRadius: JunoRadius.well
            )
            .overlay {
                // A stroke over the picture, never a wash across it: a coral
                // tint over a photograph changes the photograph, which is the
                // one thing this grid exists to show.
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .strokeBorder(Color.junoAccent, lineWidth: 2)
                    .opacity(selected ? 1 : 0)
            }
            .overlay(alignment: .topTrailing) {
                JunoIconView(selected ? .circleCheck : .circle, size: 16)
                    .foregroundStyle(selected ? Color.junoAccent : Color.white)
                    .padding(8)
                    .shadow(color: .black.opacity(selected ? 0 : 0.25), radius: 2)
            }
            .contentShape(.rect)
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
                        .junoSecondaryInk()
                }
                Spacer()
                // The glass-knob switcher, not `Picker(.segmented)`. This
                // header is content inside a sheet, and `NSSegmentedControl`
                // draws its pre-Tahoe slab there — hard dividers, a knob whose
                // radius does not match its track — which is exactly the weight
                // ``DesktopSegmented`` exists to replace everywhere else in the
                // app. The control sizes itself to its labels, so the fixed
                // 220pt frame the picker needed goes with it.
                DesktopSegmented(
                    options: NativeLibraryModel.Filter.allCases.map {
                        .init($0, $0.title)
                    },
                    selection: $model.filter,
                    accessibilityLabel: "Filter"
                )
            }
            .padding(18)
            .background(.bar)
            .overlay(alignment: .bottom) { Divider() }

            Group {
                if model.isLoading && model.items.isEmpty {
                    ProgressView("Loading Library…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if model.visibleItems.isEmpty {
                    JunoEmptyState(
                        title: "No matching files",
                        message: "Files and images you share in conversations appear here.",
                        icon: .library
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
                        .foregroundStyle(Color.junoDanger)
                        .lineLimit(2)
                } else {
                    Text("\(model.selection.count) of \(capacity) selected")
                        .font(.caption)
                        .junoSecondaryInk()
                }
                Spacer()
                Button("Cancel", action: cancel)
                    .contentShape(.rect)
                Button {
                    Task { await attach() }
                } label: {
                    if model.isAttaching {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Attach")
                            .contentShape(.rect)
                    }
                }
                // Untinted, `.borderedProminent` fills with the system accent —
                // system blue beside the coral selection stroke this same grid
                // draws two dozen points away.
                .buttonStyle(.borderedProminent)
                .tint(Color.junoAccent)
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
        // Sheet contract: the warm ground inside the content, the platter left to
        // the system. `.fitted` rather than `.form` precisely because the frame
        // above is deliberate — see the note on it.
        .junoSheetSurface(.fitted)
        .task {
            model.selection = []
            await model.refresh()
        }
    }
}
