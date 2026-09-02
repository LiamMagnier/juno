import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The ⌘K palette: one field, a ranked list, Return to run.
///
/// It is a floating surface — the one kind of chrome that may be glass — laid
/// over the window rather than a sheet, because a sheet slides and the palette
/// has to be *there* before the reader's second keystroke. It searches whatever
/// items the window hands it (see ``CodePaletteItem``) and reports the choice
/// back; it holds no state of its own beyond the query and the highlight.
public struct CodeCommandPaletteView: View {
    private let items: [CodePaletteItem]
    private let perform: (CodePaletteItem) -> Void
    private let dismiss: () -> Void

    @State private var query = ""
    @State private var highlighted = 0
    @FocusState private var fieldFocused: Bool

    public init(
        items: [CodePaletteItem],
        perform: @escaping (CodePaletteItem) -> Void,
        dismiss: @escaping () -> Void
    ) {
        self.items = items
        self.perform = perform
        self.dismiss = dismiss
    }

    private var sections: [(kind: CodePaletteItem.Kind, items: [CodePaletteItem])] {
        CodePaletteSearch.sections(items, query: query)
    }

    private var flat: [CodePaletteItem] { sections.flatMap(\.items) }

    public var body: some View {
        VStack(spacing: 0) {
            searchField
            Divider().overlay(Color.junoSeparator)
            list
        }
        .frame(width: 560)
        .frame(maxHeight: 440)
        .background(Color.junoRaised, in: RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 0.5)
        )
        .shadow(color: Color.junoCardShadow, radius: 24, y: 12)
        .onAppear { fieldFocused = true }
        .onChange(of: query) { _, _ in highlighted = 0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Command palette")
        .accessibilityIdentifier("juno.code.command-palette")
    }

    private var searchField: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(.search, size: 15)
                .junoSecondaryInk()
                .accessibilityHidden(true)
            TextField("Search sessions, projects, commands…", text: $query)
                .textFieldStyle(.plain)
                .font(.title3)
                .focused($fieldFocused)
                .onKeyPress(.downArrow) { move(1); return .handled }
                .onKeyPress(.upArrow) { move(-1); return .handled }
                .onKeyPress(.return) { choose(); return .handled }
                .onKeyPress(.escape) { dismiss(); return .handled }
                .accessibilityIdentifier("juno.code.command-palette.field")
            Text("esc")
                .junoFont(size: 10, relativeTo: .caption2, weight: .medium, design: .rounded)
                .junoMetaInk()
                .padding(.horizontal, JunoSpace.tight)
                .padding(.vertical, 2)
                .background(Color.junoMuted, in: RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous))
                .accessibilityHidden(true)
        }
        .padding(.horizontal, JunoSpace.regular)
        .frame(height: 52)
    }

    /// The sections with each row's position in the flat, arrow-key order.
    private var indexedSections: [(kind: CodePaletteItem.Kind, rows: [(index: Int, item: CodePaletteItem)])] {
        var offset = 0
        return sections.map { section in
            let rows = section.items.enumerated().map { (offset + $0.offset, $0.element) }
            offset += section.items.count
            return (section.kind, rows)
        }
    }

    @ViewBuilder
    private var list: some View {
        if flat.isEmpty {
            Text("Nothing matches “\(query)”")
                .junoCaption()
                .frame(maxWidth: .infinity, minHeight: 88)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(indexedSections, id: \.kind) { section in
                            Text(section.kind.sectionTitle)
                                .junoSidebarSection()
                                .padding(.horizontal, JunoSpace.regular)
                                .padding(.top, JunoSpace.cozy)
                                .padding(.bottom, JunoSpace.hairline)
                            ForEach(section.rows, id: \.item.id) { row in
                                self.row(row.item, index: row.index)
                                    .id(row.item.id)
                            }
                        }
                    }
                    .padding(.bottom, JunoSpace.snug)
                }
                .onChange(of: highlighted) { _, index in
                    guard flat.indices.contains(index) else { return }
                    proxy.scrollTo(flat[index].id, anchor: .center)
                }
            }
        }
    }

    private func row(_ item: CodePaletteItem, index: Int) -> some View {
        let isHighlighted = index == highlighted
        return Button {
            perform(item)
        } label: {
            HStack(spacing: JunoSpace.cozy) {
                JunoIconView(item.icon, size: 15)
                    .foregroundStyle(isHighlighted ? Color.junoForeground : Color.junoMutedForeground)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.title)
                        .junoRowLabel()
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let subtitle = item.subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .junoCaption()
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: JunoSpace.snug)
                if let shortcut = item.shortcut {
                    Text(shortcut)
                        .junoFont(size: 11, relativeTo: .caption2, weight: .medium, design: .rounded)
                        .junoMetaInk()
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .frame(minWidth: 44, minHeight: 44)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                    .fill(isHighlighted ? Color.junoSidebarSelection : Color.clear)
                    .padding(.horizontal, JunoSpace.snug)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            if hovering { highlighted = index }
        }
        .accessibilityAddTraits(isHighlighted ? .isSelected : [])
        .accessibilityIdentifier("juno.code.command-palette.item.\(item.id)")
    }

    private func move(_ delta: Int) {
        let count = flat.count
        guard count > 0 else { return }
        highlighted = ((highlighted + delta) % count + count) % count
    }

    private func choose() {
        guard flat.indices.contains(highlighted) else { return }
        perform(flat[highlighted])
    }
}
