import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// Small pieces every Code v2 surface shares (DESIGN §3, §5): marks, step
// glyphs, keycaps, the footer's text controls and the two quiet button
// shapes. Text and glyph shape carry state; there are no pills and no dots.

// MARK: - Clock

public extension EnvironmentValues {
    /// "Now" for elapsed times. Nil is the wall clock; snapshots pin it so a
    /// running row reads the same every render.
    @Entry var codeV2Now: Date? = nil
}

// MARK: - Marks

enum CodeV2Marks {
    /// The provider-mark id for an instance: the Continuum for Alevr, the
    /// lab's mark for a subscription or a key.
    static func markID(instance: CodeV2.ProviderInstance) -> String {
        switch instance.kind {
        case .alevr: return "alevr"
        case .byok:
            return instance.id.split(separator: ":").last.flatMap { CodeV2.ByokProvider(rawValue: String($0)) }?.markID ?? "key"
        default:
            return CodeV2KnownSubscription.allCases.first { $0.instanceId == instance.id }?.markID
                ?? instance.label.lowercased()
        }
    }

    /// The mark for a model: the lab in its id ("openai:gpt-6.1"), else the
    /// instance's own.
    static func markID(model: String, instanceId: String) -> String {
        if let colon = model.firstIndex(of: ":") { return String(model[..<colon]) }
        switch CodeV2.instanceKind(of: instanceId) {
        case .claudeAgent: return "anthropic"
        case .codex: return "openai"
        default:
            if let known = CodeV2KnownSubscription.allCases.first(where: { $0.instanceId == instanceId }) { return known.markID }
            if instanceId.hasPrefix("byok:") { return String(instanceId.dropFirst(5)) }
            return "alevr"
        }
    }
}

/// A provider or lab mark in its own artwork (never a lab colour applied by
/// us), dimmed to half ink for an instance that is installed but not
/// connected (DESIGN §5.8).
struct CodeV2Mark: View {
    let id: String
    var name: String = ""
    var size: CGFloat = 16
    var dimmed = false

    var body: some View {
        Group {
            if id == "key" {
                JunoIconView(.key, size: size)
                    .foregroundStyle(Studio.Ink.secondary)
            } else {
                JunoProviderMark(providerID: id, providerName: name.isEmpty ? id : name, size: size)
            }
        }
        .opacity(dimmed ? 0.5 : 1)
    }
}

// MARK: - Step glyphs

extension CodeV2StepRow.Glyph {
    var icon: JunoIcon {
        switch self {
        case .reasoning: .conversation
        case .plan: .listChecks
        case .edit: .pencil
        case .terminal: .terminal
        case .search: .fileSearch
        case .web: .web
        case .approval: .hand
        case .interrupt: .circleStop
        case .notice: .info
        case .error: .circleX
        case .compaction: .layers
        case .handoff: .arrowLeftRight
        case .question: .circleHelp
        case .file: .file
        case .message: .message
        }
    }
}

/// The glyph slot of a row: the step's mark at rest, the spinner while it
/// runs, the coral hand while it waits on the reader.
struct CodeV2StateGlyph: View {
    enum State { case done, running, waiting, failed, closed, pending }
    let state: State
    var icon: JunoIcon = .check
    var size: CGFloat = 16

    var body: some View {
        Group {
            switch state {
            case .running:
                StudioSpinner(color: Studio.Ink.secondary, lineWidth: 1.4)
                    .frame(width: size - 3, height: size - 3)
            case .waiting:
                JunoIconView(.hand, size: size).foregroundStyle(Studio.Signal.edge)
            case .failed:
                JunoIconView(.circleX, size: size).foregroundStyle(Studio.Ink.danger)
            case .done:
                JunoIconView(icon, size: size).foregroundStyle(icon == .check ? Studio.Ink.success : Studio.Ink.secondary)
            case .closed:
                JunoIconView(.check, size: size).foregroundStyle(Studio.Ink.tertiary)
            case .pending:
                JunoIconView(.circleDashed, size: size).foregroundStyle(Studio.Ink.tertiary)
            }
        }
        .frame(width: size + 4, height: size + 4)
    }
}

// MARK: - Keycap

/// A keyboard hint: the only rounded tag on screen, and an input hint, not a
/// status.
struct CodeV2Keycap: View {
    let keys: String
    var body: some View {
        Text(keys)
            .junoFont(size: 11, relativeTo: .caption2)
            .foregroundStyle(Studio.Ink.secondary)
            .padding(.horizontal, 5)
            .frame(minHeight: 18)
            .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Studio.Surface.muted))
            .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(Studio.Surface.hairline))
            .accessibilityHidden(true)
    }
}

// MARK: - Counts

/// "+118 −24" in the diff inks, tabular.
struct CodeV2DiffCounts: View {
    let additions: Int
    let deletions: Int
    var font: Font = Studio.Font.metaDigits

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            Text("+\(additions)").foregroundStyle(Studio.Ink.added)
            Text("−\(deletions)").foregroundStyle(Studio.Ink.removed)
        }
        .font(font)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(additions) added, \(deletions) removed")
    }
}

// MARK: - Buttons

/// The composer footer's text control (DESIGN §5.6): no fill at rest, the
/// hover fill on hover, the hover fill and full ink while its popover is
/// open. Never a chip.
struct CodeV2FooterButtonStyle: ButtonStyle {
    var isOpen = false
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Studio.Font.label)
            .foregroundStyle(
                !isEnabled ? Studio.Ink.tertiary : (isOpen || hovering ? Studio.Ink.primary : Studio.Ink.secondary)
            )
            .padding(.horizontal, JunoSpace.snug)
            .frame(minWidth: 28, minHeight: Studio.Metrics.control)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                    .fill(configuration.isPressed || isOpen || hovering ? Studio.Surface.hover : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous))
            .onHover { hovering = $0 }
            .animation(JunoMotion.fast, value: hovering)
    }
}

/// An outlined action ("Review", "Accept", "Allow for this session").
struct CodeV2OutlineButtonStyle: ButtonStyle {
    var compact = false
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? Studio.Font.meta : Studio.Font.label)
            .foregroundStyle(isEnabled ? Studio.Ink.primary : Studio.Ink.tertiary)
            .padding(.horizontal, compact ? JunoSpace.snug : JunoSpace.cozy)
            .frame(minWidth: 28, minHeight: compact ? 26 : Studio.Metrics.control)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                    .fill(configuration.isPressed ? Studio.Surface.selected : (hovering ? Studio.Surface.hover : Studio.Surface.raised))
            )
            .overlay(RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous).strokeBorder(Studio.Surface.hairline))
            .contentShape(RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous))
            .onHover { hovering = $0 }
            .animation(JunoMotion.fast, value: hovering)
    }
}

/// The one ink action on a surface ("Allow once", "Commit…").
struct CodeV2InkButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Studio.Font.label)
            .foregroundStyle(isEnabled ? Studio.Surface.canvas : Studio.Ink.tertiary)
            .padding(.horizontal, JunoSpace.cozy)
            .frame(minWidth: 28, minHeight: Studio.Metrics.control)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                    .fill(isEnabled ? Studio.Ink.primary : Studio.Surface.muted)
            )
            .opacity(configuration.isPressed ? 0.85 : 1)
            .contentShape(RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous))
            .animation(JunoMotion.press, value: configuration.isPressed)
    }
}

// MARK: - Popover chrome

/// A popover section heading: 12, regular, muted. No eyebrows.
struct CodeV2SectionHeading: View {
    let title: String
    var body: some View {
        Text(title)
            .font(Studio.Font.meta)
            .foregroundStyle(Studio.Ink.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.top, JunoSpace.snug)
            .padding(.bottom, JunoSpace.tight)
    }
}

/// A 3pt meter: ink fill on a hairline track (plan windows, the context
/// card). Never coloured by itself; the caller passes the signal only past
/// the warning line.
struct CodeV2Meter: View {
    let fraction: Double
    var tint: Color = Studio.Ink.primary
    var width: CGFloat? = nil

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().strokeBorder(Studio.Surface.hairline, lineWidth: 1)
                Capsule().fill(tint)
                    .frame(width: max(3, proxy.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(width: width, height: 3)
        .accessibilityElement()
        .accessibilityValue("\(Int((fraction * 100).rounded())) percent")
    }
}
