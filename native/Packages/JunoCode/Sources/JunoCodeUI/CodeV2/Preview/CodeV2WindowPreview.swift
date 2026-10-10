import SwiftUI
import JunoDesignSystem

/// The Code window as offscreen snapshots see it: the floating Liquid Glass
/// sidebar (drawn in its Reduce Transparency recipe, as everything glass is
/// offscreen), the unified toolbar with the title and its items, the detail
/// column and, when open, the inspector. The system draws the real window;
/// this stand-in exists so a whole-window picture can be compared with the
/// Codex and Claude desktop references at the same size.
struct CodeV2WindowPreview<Detail: View, Inspector: View>: View {
    var title: String
    var subtitle: String?
    var sessions: [CodeSidebarSession] = CodeV2Fixtures.sidebarSessions
    var selected: String?
    var inspectorOpen: Bool
    var inspectorWidth: CGFloat = 480
    @ViewBuilder var detail: () -> Detail
    @ViewBuilder var inspector: () -> Inspector

    var body: some View {
        HStack(spacing: 0) {
            sidebar
                .frame(width: 260)
                .padding(8)
            VStack(spacing: 0) {
                toolbar
                detail()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if inspectorOpen {
                Rectangle().fill(Studio.Surface.hairline).frame(width: 1)
                VStack(spacing: 0) {
                    Color.clear.frame(height: 12)
                    inspector()
                }
                .frame(width: inspectorWidth)
                .background(Studio.Surface.canvas)
            }
        }
        .background(Studio.Surface.canvas)
    }

    // MARK: Sidebar

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                ForEach(0..<3, id: \.self) { _ in
                    Circle().fill(Color.primary.opacity(0.14)).frame(width: 12, height: 12)
                }
                Spacer()
                JunoIconView(.panelLeft, size: 15).foregroundStyle(Color.junoSidebarInk)
            }
            .padding(.horizontal, 12)
            .frame(height: 44)
            CodeSidebarHeader(projectTitle: "All projects", search: {}, newSession: {}) { EmptyView() }
                .padding(.horizontal, 6)
            VStack(spacing: 0) {
                ForEach(sessions) { session in
                    CodeSidebarSessionRow(session: session, now: CodeV2Fixtures.now)
                        .junoFont(size: 13, relativeTo: .body)
                        .padding(.trailing, 8)
                        .frame(height: 32)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(session.id == selected ? Color.junoSidebarSelection : Color.clear)
                        )
                }
                CodeSidebarFold(title: "Archived", count: 12, isOpen: .constant(false))
                    .padding(.trailing, 8)
                    .padding(.top, 6)
            }
            .padding(.horizontal, 8)
            .padding(.top, 6)
            Spacer(minLength: 0)
            HStack(spacing: 10) {
                Circle().fill(Studio.Surface.selected)
                    .overlay(Text("M").studioType(.smallMedium).foregroundStyle(Studio.Ink.primary))
                    .frame(width: 22, height: 22)
                Text("Maya Okafor").junoFont(size: 13, relativeTo: .body).foregroundStyle(Color.junoSidebarInk)
                Spacer()
                JunoIconView(.settings, size: 15).foregroundStyle(Color.junoSidebarInk)
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
        }
        .frame(maxHeight: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.junoSidebar)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Studio.Surface.hairline)
        )
    }

    // MARK: Toolbar

    private var toolbar: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 0) {
                Text(title).studioType(.textMedium).foregroundStyle(Studio.Ink.primary).lineLimit(1)
                if let subtitle {
                    Text(subtitle).studioType(.small).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 12)
            JunoProductOrbit(active: .code) { _ in }
                .fixedSize()
            Spacer(minLength: 12)
            HStack(spacing: 2) {
                toolbarIcon(.terminal, on: false)
                toolbarIcon(.panelRight, on: inspectorOpen)
                toolbarIcon(.ellipsis, on: false)
            }
            .padding(.horizontal, 4)
            .frame(height: 36)
            .background(Capsule().fill(Studio.Surface.raised))
            .overlay(Capsule().strokeBorder(Studio.Surface.hairline))
        }
        .padding(.leading, 20)
        .padding(.trailing, 12)
        .frame(height: 52)
    }

    private func toolbarIcon(_ icon: JunoIcon, on: Bool) -> some View {
        JunoIconView(icon, size: 16, weight: on ? .fill : .regular)
            .foregroundStyle(on ? Studio.Ink.primary : Studio.Ink.secondary)
            .frame(width: 34, height: 28)
    }
}
