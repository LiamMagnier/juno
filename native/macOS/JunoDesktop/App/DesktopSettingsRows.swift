import JunoDesignSystem
import SwiftUI

// MARK: - Save status

/// Where one row's write stands: the web's `SaveState`
/// (`src/components/settings/save-status.tsx`).
enum DesktopSaveState: Equatable, Sendable {
    case idle
    case saving
    case saved
    case failed
}

/// Every row's save status in one Settings window, keyed by the row.
///
/// The web's `useSaveStates`: nothing while a write is in flight, then "Saved"
/// for 1.8s or "Not saved" for 5s, and a newer write to the same row always
/// wins over an older one that answers late (the sequence number).
@MainActor
@Observable
final class DesktopSaveStates {
    static let savedHold: Duration = .milliseconds(1800)
    static let failedHold: Duration = .seconds(5)

    private(set) var states: [String: DesktopSaveState] = [:]
    @ObservationIgnored private var sequence: [String: Int] = [:]
    @ObservationIgnored private var timers: [String: Task<Void, Never>] = [:]
    private let savedHold: Duration
    private let failedHold: Duration

    init(savedHold: Duration = DesktopSaveStates.savedHold, failedHold: Duration = DesktopSaveStates.failedHold) {
        self.savedHold = savedHold
        self.failedHold = failedHold
    }

    func status(_ key: String) -> DesktopSaveState {
        states[key] ?? .idle
    }

    /// Runs `write` and shows its outcome beside the row. Returns whether it
    /// succeeded.
    @discardableResult
    func track(_ key: String, _ write: () async -> Bool) async -> Bool {
        let seq = (sequence[key] ?? 0) + 1
        sequence[key] = seq
        timers[key]?.cancel()
        states[key] = .saving
        let ok = await write()
        guard sequence[key] == seq else { return ok }
        settle(key, seq: seq, ok: ok)
        return ok
    }

    /// Shows an outcome that was decided elsewhere (a device-only preference
    /// is saved the moment it is set).
    func mark(_ key: String, ok: Bool) {
        let seq = (sequence[key] ?? 0) + 1
        sequence[key] = seq
        timers[key]?.cancel()
        settle(key, seq: seq, ok: ok)
    }

    private func settle(_ key: String, seq: Int, ok: Bool) {
        states[key] = ok ? .saved : .failed
        AccessibilityNotification.Announcement(ok ? "Saved" : "Not saved").post()
        let hold = ok ? savedHold : failedHold
        timers[key] = Task { [weak self] in
            try? await Task.sleep(for: hold)
            guard !Task.isCancelled, let self, self.sequence[key] == seq else { return }
            self.states[key] = .idle
        }
    }
}

/// "Saved" or "Not saved" beside a row's label, fading in on `fast` and out on
/// `exit`; nothing at rest or while saving.
struct DesktopSaveStatus: View {
    let state: DesktopSaveState

    var body: some View {
        ZStack(alignment: .leading) {
            if state == .saved {
                HStack(spacing: JunoSpace.hairline) {
                    JunoIconView(.circleCheck, size: 13)
                        .foregroundStyle(Color.junoSuccessInk)
                    Text("Saved")
                        .foregroundStyle(Color.junoSecondaryInk)
                }
                .transition(Self.fade)
            } else if state == .failed {
                HStack(spacing: JunoSpace.hairline) {
                    JunoIconView(.error, size: 13)
                    Text("Not saved")
                }
                .foregroundStyle(Color.junoDestructiveInk)
                .transition(Self.fade)
            }
        }
        .junoType(.label.weight(.regular))
        .animation(JunoMotion.fast, value: state)
        // The window announces the outcome once, from ``DesktopSaveStates``.
        .accessibilityHidden(true)
    }

    private static var fade: AnyTransition {
        .asymmetric(
            insertion: .opacity.animation(JunoMotion.fast),
            removal: .opacity.animation(JunoMotion.exit)
        )
    }
}

// MARK: - Rows

/// The ink of a row's label.
enum DesktopSettingTone {
    case normal
    case destructive
}

/// A row's label: the name at 13pt medium with its save status beside it,
/// then one line of explanation at 12pt in the secondary ink (§C1).
struct DesktopSettingLabel: View {
    let title: String
    var description: String?
    var status: DesktopSaveState?
    var tone: DesktopSettingTone = .normal

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.micro) {
            HStack(spacing: JunoSpace.snug) {
                Text(title)
                    .junoType(JunoType.ui.weight(.medium))
                    .foregroundStyle(tone == .destructive ? Color.junoDestructiveInk : Color.junoForeground)
                if let status {
                    DesktopSaveStatus(state: status)
                }
            }
            if let description, !description.isEmpty {
                Text(description)
                    .junoType(JunoType.label.weight(.regular))
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, JunoSpace.micro)
        .accessibilityElement(children: .combine)
    }
}

/// One setting: the label on the left, its control trailing (`LabeledContent`
/// in the grouped form).
struct DesktopSettingRow<Control: View>: View {
    let title: String
    var description: String?
    var status: DesktopSaveState?
    var tone: DesktopSettingTone = .normal
    @ViewBuilder var control: Control

    var body: some View {
        LabeledContent {
            control
        } label: {
            DesktopSettingLabel(title: title, description: description, status: status, tone: tone)
        }
    }
}

extension DesktopSettingRow where Control == EmptyView {
    /// A row that only says something: no control.
    init(title: String, description: String? = nil, tone: DesktopSettingTone = .normal) {
        self.title = title
        self.description = description
        self.status = nil
        self.tone = tone
        self.control = EmptyView()
    }
}

/// A switch row: the web's `Switch` beside its label, coral when on.
struct DesktopSettingToggleRow: View {
    let title: String
    var description: String?
    var status: DesktopSaveState?
    @Binding var isOn: Bool
    var isEnabled = true
    var identifier: String?

    var body: some View {
        DesktopSettingRow(title: title, description: description, status: status) {
            Toggle(title, isOn: $isOn)
                .labelsHidden()
                .toggleStyle(.switch)
                .tint(Color.junoAccent)
                .disabled(!isEnabled)
                .accessibilityLabel(title)
                .accessibilityIdentifier(identifier ?? "juno.desktop.settings.\(title)")
        }
    }
}

/// A group's header: the title at 13pt semibold and its note at 12pt in the
/// secondary ink, with an optional trailing control (the web's `aside`). A
/// group with neither has no header at all.
struct DesktopSettingsGroupHeader<Aside: View>: View {
    var title: String?
    var note: String?
    @ViewBuilder var aside: Aside

    var body: some View {
        HStack(alignment: .bottom, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                if let title {
                    Text(title)
                        .junoType(JunoType.ui.weight(.semibold))
                        .foregroundStyle(Color.junoForeground)
                        .accessibilityAddTraits(.isHeader)
                }
                if let note {
                    Text(note)
                        .junoType(JunoType.label.weight(.regular))
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            aside
        }
        .textCase(nil)
    }
}

extension DesktopSettingsGroupHeader where Aside == EmptyView {
    init(title: String? = nil, note: String? = nil) {
        self.title = title
        self.note = note
        self.aside = EmptyView()
    }
}

/// A quiet sentence standing in for a list's rows: "Nothing pinned yet.",
/// "Nothing shared yet. …".
struct DesktopSettingsNote: View {
    let text: String
    var tone: Tone = .quiet

    enum Tone {
        case quiet
        case warning
        case error
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
            switch tone {
            case .quiet:
                EmptyView()
            case .warning:
                JunoIconView(.warning, size: 13).foregroundStyle(Color.junoWarningInk)
            case .error:
                JunoIconView(.error, size: 13).foregroundStyle(Color.junoDestructiveInk)
            }
            Text(text)
                .junoType(.ui)
                .foregroundStyle(ink)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.vertical, JunoSpace.tight)
    }

    private var ink: Color {
        switch tone {
        case .quiet: .junoSecondaryInk
        case .warning: .junoWarningInk
        case .error: .junoDestructiveInk
        }
    }
}

/// A row-shaped placeholder at a settings row's own pitch, breathing on the
/// skeleton loop (still under Reduce Motion).
struct DesktopSettingRowSkeleton: View {
    var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                JunoSkeleton(height: 11, width: 132)
                JunoSkeleton(height: 9, width: 220)
            }
            Spacer(minLength: 0)
            JunoSkeleton(height: 18, width: 44, cornerRadius: 9)
        }
        .padding(.vertical, JunoSpace.tight)
        .accessibilityHidden(true)
    }
}

/// An outline button: `.bordered` with no tint, so it is never a second
/// coral control (§C1).
struct DesktopOutlineButton: View {
    let title: String
    var icon: JunoIcon?
    /// A delete: the label in the destructive ink, never a red fill (§0.4).
    var destructive = false
    let action: () -> Void

    /// Stated ink overrides `.bordered`'s disabled dimming, so a disabled
    /// button drew at full ink beside the enabled ones; the dimming is put
    /// back by hand.
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            Group {
                if let icon {
                    Label {
                        Text(title)
                    } icon: {
                        JunoIconView(icon, size: 13)
                    }
                } else {
                    Text(title)
                }
            }
            .foregroundStyle(destructive ? Color.junoDestructiveInk : Color.junoForeground)
            .opacity(isEnabled ? 1 : 0.4)
        }
        .buttonStyle(.bordered)
        .tint(nil)
        .contentShape(.rect)
    }
}

// MARK: - Menu rows

extension String {
    /// The web's sentence-case option label in the Mac's Title Case for a menu
    /// row (§C1): "Ask for important actions" → "Ask for Important Actions".
    /// Short joining words stay lower case unless they lead or end the label.
    var desktopMenuTitle: String {
        let small: Set<String> = ["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to", "with"]
        let words = split(separator: " ", omittingEmptySubsequences: false)
        return words.enumerated().map { index, word -> String in
            let lower = word.lowercased()
            if index > 0, index < words.count - 1, small.contains(lower) { return lower }
            guard let first = word.first else { return String(word) }
            return first.uppercased() + word.dropFirst()
        }
        .joined(separator: " ")
    }
}

// MARK: - Fields

extension View {
    /// The Juno field on content (the task card's "Change it" recipe): a plain
    /// text field at 13pt in a 28pt well at the field radius, the secondary
    /// fill and a 1pt hairline. Never `.roundedBorder`, which draws a pure
    /// black well in dark on the warm card and the system's small radius.
    /// `fill` is the well; a sheet whose other fields sit on the card passes
    /// `Color.junoCard` so its fields match.
    func junoFieldChrome(fill: Color = Color.junoSecondary) -> some View {
        textFieldStyle(.plain)
            .junoFont(size: 13, relativeTo: .callout)
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, 5)
            .frame(minHeight: 28)
            .background(fill, in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 1)
            )
    }
}

