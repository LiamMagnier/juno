import JunoDesignSystem
import SwiftUI

/// The sidebar header shared by Chat and Code.
///
/// Both modes open with the same region — Juno mark, then the mode switcher on
/// the same horizontal grid as the rows below — so switching modes changes the
/// list underneath a fixed header rather than replacing the whole sidebar. The
/// rejected build had the switcher in its own banded strip with a divider,
/// which read as something bolted on above the sidebar rather than part of it.
struct JunoMacSidebarHeader: View {
    @Binding var mode: JunoMacProductMode

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.tight) {
                Image(systemName: "circle.hexagongrid.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.junoAccent)
                    .accessibilityHidden(true)
                Text("Juno")
                    .font(.system(.subheadline, design: .default, weight: .semibold))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.tight)

            JunoMacModeSwitcher(mode: $mode)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.top, JunoSpace.snug)
        .padding(.bottom, JunoSpace.cozy)
        // No background: the system's sidebar material shows through, which is
        // what makes a macOS source list look native instead of like a slab.
    }
}

/// A navigation row in either sidebar.
///
/// The icon's colour is **stated**, never inherited. Letting
/// `Label(_:systemImage:)` pick up the sidebar's implicit accent tint is what
/// made every row coral in light mode and made the icons vanish entirely in
/// dark mode. Navigation is secondary; coral is reserved for actions.
struct JunoMacNavigationRow: View {
    let title: LocalizedStringKey
    let systemImage: String
    var isAccented = false

    var body: some View {
        Label {
            Text(title).junoRowLabel()
        } icon: {
            Image(systemName: systemImage)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(isAccented ? Color.junoAccent : Color.secondary)
                .frame(width: 16)
        }
        .labelStyle(.titleAndIcon)
    }
}

/// The account / sync / settings strip at the bottom of the sidebar.
///
/// Designed as a region with its own separator and grid rather than three
/// controls pushed apart by a `Spacer()` on a `.bar`, which is what the
/// rejected build did.
struct JunoMacSidebarFooter<Trailing: View>: View {
    let accountName: String
    let openSettings: () -> Void
    let signOut: () -> Void
    @ViewBuilder let trailing: Trailing

    var body: some View {
        VStack(spacing: 0) {
            Divider().overlay(Color.junoSeparator)
            HStack(spacing: JunoSpace.snug) {
                Menu {
                    Button("navigation.settings", action: openSettings)
                    Divider()
                    Button("auth.sign-out", role: .destructive, action: signOut)
                } label: {
                    HStack(spacing: JunoSpace.tight) {
                        Image(systemName: "person.crop.circle.fill")
                            .font(.system(size: 15))
                            .foregroundStyle(.secondary)
                        Text(accountName)
                            .font(.system(.caption, weight: .medium))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .accessibilityIdentifier("juno.mac.account-menu")

                Spacer(minLength: JunoSpace.hairline)
                trailing
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
        }
    }
}

/// A compact icon button for sidebar and toolbar chrome.
///
/// Built from `Label` + `.iconOnly` so VoiceOver gets a name; a bare `Image`
/// reaches it unnamed and leaks the SF Symbol id as the accessibility
/// identifier.
struct JunoMacIconButton: View {
    let title: LocalizedStringKey
    let systemImage: String
    var tint: Color = .secondary
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .labelStyle(.iconOnly)
                .font(.system(size: 12, weight: .medium))
                .frame(width: 20, height: 20)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(tint)
        .help(Text(title))
    }
}
