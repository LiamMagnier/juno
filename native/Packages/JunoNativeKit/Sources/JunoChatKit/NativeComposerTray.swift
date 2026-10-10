import JunoDesignSystem
import SwiftUI

// MARK: - The composer tray (the web's `composer-tray.tsx`)
//
// A quiet grey shelf tucked under the composer card's lower edge, holding
// where a new chat goes and what it can reach:
//
//   [ Select project ⌄ ]  [ Apps ⌄ ]  [ Skills ⌄ ]                 [trailing]
//
// With an image, video or music model it is ONE line of that model's
// generation choices (`mediaParams` from the catalogue, the web's
// `media-params.ts`) and a compact Project control at the end:
//
//   [▭ 1:1 ⌄] [1K | 2K | 4K] [Auto quality ⌄] [1 image ⌄] … | [▣ ⌄]
//
// The shelf is a tone, not a card: no border, no shadow and no glass, so the
// composer stays the one elevated object. A line wider than the shelf scrolls
// sideways inside itself with soft edge fades; it never wraps and never clips
// a word. Every control opens the platform's own menu at the chip.
//
// EXTENSION POINT. `NativeComposerTray` takes a `leading` and a `trailing`
// slot (any views, drawn as tray items with `NativeComposerTrayPillStyle`).
// The Mac's "work in a local folder" control goes in `leading` on the chat
// line; see docs/native/composer-tray/STATUS.md.

/// The tray's geometry: the web's 28px pills on the Mac; on the phone the same
/// pills a little taller with 44pt targets that fill the shelf's line.
public enum NativeComposerTrayMetrics {
    #if os(iOS)
    /// The drawn pill.
    public static let pillHeight: CGFloat = 34
    /// The hit target: the whole line.
    public static let target: CGFloat = 44
    static let fontSize: CGFloat = 14
    #else
    public static let pillHeight: CGFloat = 28
    public static let target: CGFloat = 28
    static let fontSize: CGFloat = 13
    #endif
    /// How far the shelf tucks under the card, so no seam shows at its
    /// rounded corners.
    public static let tuck: CGFloat = JunoSpace.close
    /// The one inset on every visible side of the line.
    public static let inset: CGFloat = JunoSpace.tight
    /// In from the card's sides, as the web's 14px.
    public static let sideInset: CGFloat = JunoSpace.comfy
    /// Concentric with the pills inside: half a pill plus the inset.
    public static var cornerRadius: CGFloat { pillHeight / 2 + inset }
    /// The soft fade at an edge with more to scroll.
    public static let fade: CGFloat = JunoSpace.roomy
    /// The fully clear strip past a fade, at the very edge.
    public static let fadeTail: CGFloat = JunoSpace.tight
}

// MARK: - Shelf

/// The grey shelf the composer rests on. Place it directly under the card in a
/// zero-spacing stack: it pulls itself up by ``NativeComposerTrayMetrics/tuck``
/// and draws behind the card.
public struct NativeComposerTrayShelf<Content: View>: View {
    private let content: Content
    @Environment(\.colorScheme) private var colorScheme

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    private var shape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            bottomLeadingRadius: NativeComposerTrayMetrics.cornerRadius,
            bottomTrailingRadius: NativeComposerTrayMetrics.cornerRadius,
            style: .continuous
        )
    }

    public var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, NativeComposerTrayMetrics.inset)
            #if os(iOS)
            // The 44pt line fills the shelf; the pills inside sit centred.
            .padding(.top, NativeComposerTrayMetrics.tuck)
            .padding(.bottom, JunoSpace.micro)
            #else
            .padding(.top, NativeComposerTrayMetrics.tuck + NativeComposerTrayMetrics.inset)
            .padding(.bottom, NativeComposerTrayMetrics.inset)
            #endif
            .background {
                // The tone over the page's own ground: the web's foreground at
                // 3.5% (4.5% in dark) over --background.
                shape.fill(Color.junoCanvas)
                    .overlay(shape.fill(Color.junoForeground.opacity(colorScheme == .dark ? 0.045 : 0.035)))
            }
            .padding(.horizontal, NativeComposerTrayMetrics.sideInset)
            .padding(.top, -NativeComposerTrayMetrics.tuck)
            .zIndex(-1)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("juno.composer-tray")
    }
}

// MARK: - Pill

/// A tray item: icon, words, chevron, in the tray's pill language — a quiet
/// fill under the pointer, deeper while pressed, a 0.97 dip.
public struct NativeComposerTrayPillStyle: ButtonStyle {
    var isOn: Bool

    public init(isOn: Bool = false) {
        self.isOn = isOn
    }

    public func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration, isOn: isOn)
    }

    private struct Face: View {
        let configuration: ButtonStyleConfiguration
        let isOn: Bool
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var hovered = false

        var body: some View {
            configuration.label
                .junoFont(size: NativeComposerTrayMetrics.fontSize, relativeTo: .subheadline)
                .monospacedDigit()
                .lineLimit(1)
                .foregroundStyle(Color.junoForeground.opacity(hovered || configuration.isPressed || isOn ? 1 : 0.78))
                .padding(.leading, JunoSpace.close)
                .padding(.trailing, JunoSpace.snug)
                .frame(height: NativeComposerTrayMetrics.pillHeight)
                .background(
                    Capsule().fill(Color.junoForeground.opacity(
                        configuration.isPressed ? 0.085 : (hovered || isOn) ? 0.055 : 0
                    ))
                )
                .frame(minHeight: NativeComposerTrayMetrics.target)
                .contentShape(.rect)
                .scaleEffect(configuration.isPressed ? JunoMotion.scaleFrom(0.97, reduceMotion: reduceMotion) : 1)
                .opacity(isEnabled ? 1 : 0.5)
                .onHover { hovered = $0 }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
                .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion), value: configuration.isPressed)
        }
    }
}

/// The chevron every menu chip ends on.
struct NativeTrayChevron: View {
    var body: some View {
        JunoIconView(.chevronDown, size: 12)
            .foregroundStyle(Color.junoSecondaryInk)
            .accessibilityHidden(true)
    }
}

/// A chip that opens a menu: the platform's own menu, at the chip.
struct NativeTrayMenu<Label: View, Content: View>: View {
    let accessibilityLabel: String
    let identifier: String
    @ViewBuilder let content: () -> Content
    @ViewBuilder let label: () -> Label

    var body: some View {
        Menu {
            content()
        } label: {
            HStack(spacing: JunoSpace.tight) {
                label()
                NativeTrayChevron()
            }
        }
        .menuStyle(.button)
        .buttonStyle(NativeComposerTrayPillStyle())
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(accessibilityLabel)
        .accessibilityIdentifier(identifier)
        #if os(macOS)
        .help(accessibilityLabel)
        #endif
    }
}

/// The hairline between a media line and its Project control. It stands a
/// pill's own trailing inset clear of both neighbours (the line's 2pt gap plus
/// 6pt here = 8pt), so the last choice's chevron — or the scrolling line's
/// fade over it — never runs into the rule.
struct NativeTrayRule: View {
    var body: some View {
        Rectangle()
            .fill(Color.junoForeground.opacity(0.1))
            .frame(width: 1, height: JunoSpace.regular)
            .padding(.horizontal, JunoSpace.tight)
            .accessibilityHidden(true)
    }
}

// MARK: - Capsule segmented (iOS Calendar's day/week/month)

/// One capsule track with a raised capsule thumb that glides to the chosen
/// segment: Resolution "1K | 2K | 4K", "Vocals | Instrumental", "MP3 | WAV".
/// A value the current combination rules out is quieter but stays pickable;
/// picking it moves what blocked it, and its label says so.
struct NativeTraySegmented: View {
    struct Segment: Identifiable {
        let value: NativeMediaParamValue
        let label: String
        let note: String?
        let conflict: Bool
        var id: NativeMediaParamValue { value }
    }

    let label: String
    let segments: [Segment]
    let selection: NativeMediaParamValue?
    let pick: (NativeMediaParamValue) -> Void
    let identifier: String

    @Namespace private var thumb
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.colorScheme) private var colorScheme

    private static let pad: CGFloat = JunoSpace.micro
    #if os(iOS)
    // A phone's line is narrow: segments sit a little closer so a music
    // model's "Vocals | Instrumental" and "MP3 | WAV" fit without scrolling.
    private static let segmentPadding: CGFloat = JunoSpace.snug
    #else
    private static let segmentPadding: CGFloat = JunoSpace.close
    #endif

    var body: some View {
        HStack(spacing: 0) {
            ForEach(segments) { segment in
                let on = segment.value == selection
                Button {
                    guard !on else { return }
                    withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                        pick(segment.value)
                    }
                } label: {
                    Text(segment.label)
                        .junoFont(size: NativeComposerTrayMetrics.fontSize, relativeTo: .subheadline, weight: on ? .medium : .regular)
                        .monospacedDigit()
                        .lineLimit(1)
                        .fixedSize()
                        .foregroundStyle(
                            on ? Color.junoForeground
                                : Color.junoForeground.opacity(segment.conflict ? 0.42 : 0.68)
                        )
                        .padding(.horizontal, Self.segmentPadding)
                        .frame(height: NativeComposerTrayMetrics.pillHeight - Self.pad * 2)
                        .background {
                            if on {
                                // The raised card in light; in dark a lifted
                                // tone, since the card is darker than the track.
                                Capsule()
                                    .fill(colorScheme == .dark ? Color.junoForeground.opacity(0.17) : Color.junoCard)
                                    .shadow(color: Color.black.opacity(0.08), radius: 1.5, y: 0.5)
                                    .matchedGeometryEffect(id: "thumb", in: thumb)
                            }
                        }
                        .frame(minHeight: NativeComposerTrayMetrics.target)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(segment.note.map { "\(segment.label). \($0)" } ?? segment.label)
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("\(identifier).\(segment.value)")
                #if os(macOS)
                .help(segment.note ?? "")
                #endif
            }
        }
        .padding(.horizontal, Self.pad)
        .background {
            Capsule()
                .fill(Color.junoForeground.opacity(0.06))
                .frame(height: NativeComposerTrayMetrics.pillHeight)
        }
        .opacity(isEnabled ? 1 : 0.5)
        .fixedSize()
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - The generation line (the web's `ComposerMediaParams`)

/// A media model's generation choices as one line of tray controls, in the
/// web's order, each the control the web draws: the aspect ratio's frame
/// glyph, capsule segments for two or three values, menus for longer lists, a
/// length popover, the sound pill, and plain facts.
public struct NativeMediaParamsLine: View {
    private let schema: NativeMediaParamSchema
    private let params: NativeMediaParams
    private let set: (String, NativeMediaParamValue) -> Void

    public init(
        schema: NativeMediaParamSchema,
        params: NativeMediaParams,
        set: @escaping (String, NativeMediaParamValue) -> Void
    ) {
        self.schema = schema
        self.params = params
        self.set = set
    }

    private var kindLabel: String {
        switch schema.kind {
        case "video": "Video settings"
        case "audio": "Music settings"
        default: "Image settings"
        }
    }

    public var body: some View {
        HStack(spacing: JunoSpace.micro) {
            ForEach(schema.controls(params)) { control in
                view(for: control)
            }
            ForEach(schema.facts, id: \.self) { fact in
                Text(fact)
                    .junoFont(size: NativeComposerTrayMetrics.fontSize, relativeTo: .subheadline)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.horizontal, JunoSpace.snug)
                    .frame(minHeight: NativeComposerTrayMetrics.target)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(kindLabel)
        .accessibilityIdentifier("juno.composer-tray.media")
    }

    @ViewBuilder
    private func view(for control: NativeMediaParamControlState) -> some View {
        let id = "juno.composer-tray.\(control.key)"
        switch control.option.control {
        case .aspect:
            NativeTrayChoiceMenu(control: control, identifier: id, pick: { set(control.key, $0) }) {
                NativeTrayAspectGlyph(value: control.value)
            }
        case .segmented:
            segmented(control, identifier: id)
        case .toggle where control.key == "instrumental":
            NativeTraySegmented(
                label: "Vocals",
                segments: [
                    .init(value: .bool(false), label: "Vocals", note: nil, conflict: false),
                    .init(value: .bool(true), label: "Instrumental", note: nil, conflict: false),
                ],
                selection: control.value,
                pick: { set(control.key, $0) },
                identifier: id
            )
        case .toggle:
            NativeTraySoundPill(control: control, identifier: id) { set(control.key, $0) }
        case .slider:
            NativeTrayLengthControl(schema: schema, control: control, identifier: id) { set(control.key, $0) }
        case .menu where control.choices.count == 2:
            // A two-way choice reads better side by side than behind a menu (MP3 | WAV).
            segmented(control, identifier: id)
        case .menu:
            NativeTrayChoiceMenu(control: control, identifier: id, pick: { set(control.key, $0) }) {
                EmptyView()
            }
        }
    }

    private func segmented(_ control: NativeMediaParamControlState, identifier: String) -> some View {
        NativeTraySegmented(
            label: control.option.label,
            segments: control.choices.map {
                .init(
                    value: $0.value,
                    label: $0.label,
                    note: $0.conflict ? ($0.consequence ?? $0.detail) : $0.detail,
                    conflict: $0.conflict
                )
            },
            selection: control.value,
            pick: { set(control.key, $0) },
            identifier: identifier
        )
    }
}

/// A ratio drawn as a small hairline frame, the web's `AspectGlyph`; a dashed
/// square for Auto.
struct NativeTrayAspectGlyph: View {
    let value: NativeMediaParamValue?
    private static let size: CGFloat = 13

    var body: some View {
        ZStack {
            if let box = nativeAspectBox(value, size: Double(Self.size)) {
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .strokeBorder(Color.junoForeground.opacity(0.7), lineWidth: 1.2)
                    .frame(width: max(box.width, 4), height: max(box.height, 4))
            } else {
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .strokeBorder(Color.junoForeground.opacity(0.7), style: StrokeStyle(lineWidth: 1.2, dash: [2, 2]))
                    .frame(width: Self.size * 0.8, height: Self.size * 0.8)
            }
        }
        .frame(width: Self.size, height: Self.size)
        .accessibilityHidden(true)
    }
}

/// Aspect ratio, quality, count, background, format: the closed chip says the
/// value; the menu lists every value with the current one checked, and a
/// value the combination rules out says what picking it would move.
struct NativeTrayChoiceMenu<Glyph: View>: View {
    let control: NativeMediaParamControlState
    let identifier: String
    let pick: (NativeMediaParamValue) -> Void
    @ViewBuilder let glyph: () -> Glyph

    private var choices: [NativeMediaParamChoiceState] {
        guard control.key == "aspect" else { return control.choices }
        // Auto first (it is not a shape), then tall to square to wide.
        return control.choices.sorted { lhs, rhs in
            let l = nativeAspectBox(lhs.value, size: 1000).map { $0.width / $0.height }
            let r = nativeAspectBox(rhs.value, size: 1000).map { $0.width / $0.height }
            switch (l, r) {
            case (nil, nil): return false
            case (nil, _): return true
            case (_, nil): return false
            case let (l?, r?): return l < r
            }
        }
    }

    /// "3 images" rather than "3" in the count's menu.
    private func words(_ choice: NativeMediaParamChoiceState) -> String {
        guard control.key == "count" else { return choice.label }
        return NativeMediaParamSchema(kind: "", options: [control.option]).chip(control.option, choice.value)
    }

    private func note(_ choice: NativeMediaParamChoiceState) -> String? {
        if choice.conflict, let consequence = choice.consequence { return consequence }
        if control.key == "aspect", choice.value != .auto { return choice.value.description }
        return choice.detail
    }

    var body: some View {
        NativeTrayMenu(
            accessibilityLabel: "\(control.option.label): \(control.chip)",
            identifier: identifier
        ) {
            Picker(
                control.option.label,
                selection: Binding(get: { control.value ?? .auto }, set: { pick($0) })
            ) {
                ForEach(choices) { choice in
                    #if os(iOS)
                    VStack {
                        Text(words(choice))
                        if let note = note(choice) { Text(note) }
                    }
                    .tag(choice.value)
                    #else
                    Text(note(choice).map { "\(words(choice))   \($0)" } ?? words(choice))
                        .tag(choice.value)
                    #endif
                }
            }
            .pickerStyle(.inline)
        } label: {
            glyph()
            Text(control.chip)
        }
    }
}

/// Sound on or off: one pill, the speaker struck through when off.
struct NativeTraySoundPill: View {
    let control: NativeMediaParamControlState
    let identifier: String
    let pick: (NativeMediaParamValue) -> Void

    private var on: Bool { control.value?.boolValue == true }

    var body: some View {
        Button {
            pick(.bool(!on))
        } label: {
            HStack(spacing: JunoSpace.tight) {
                JunoIconView(on ? .volume : .volumeX, size: 15)
                    .foregroundStyle(on ? Color.junoForeground : Color.junoSecondaryInk)
                Text(control.option.label)
                    .foregroundStyle(on ? Color.junoForeground : Color.junoSecondaryInk)
            }
        }
        .buttonStyle(NativeComposerTrayPillStyle(isOn: on))
        .fixedSize()
        .accessibilityLabel(control.option.label)
        .accessibilityValue(on ? "On" : "Off")
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}

/// A length the provider takes in a range (Grok, Seedance, MiniMax): the chip
/// says "8s" or "Auto length"; a popover holds a slider and, where the model
/// can choose, Auto.
struct NativeTrayLengthControl: View {
    let schema: NativeMediaParamSchema
    let control: NativeMediaParamControlState
    let identifier: String
    let pick: (NativeMediaParamValue) -> Void

    @State private var open = false

    private var range: NativeMediaParamRange? { control.option.range }
    private var isAuto: Bool { control.value == .auto }
    private var seconds: Double { control.value?.numberValue ?? range?.min ?? 0 }

    var body: some View {
        Button {
            open = true
        } label: {
            HStack(spacing: JunoSpace.tight) {
                JunoIconView(.timer, size: 15)
                    .foregroundStyle(Color.junoSecondaryInk)
                Text(control.chip)
                NativeTrayChevron()
            }
        }
        .buttonStyle(NativeComposerTrayPillStyle(isOn: open))
        .fixedSize()
        .accessibilityLabel("\(control.option.label): \(control.chip)")
        .accessibilityIdentifier(identifier)
        .popover(isPresented: $open, arrowEdge: .top) {
            panel
                #if os(iOS)
                .presentationCompactAdaptation(.popover)
                #endif
        }
    }

    @ViewBuilder
    private var panel: some View {
        if let range {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                HStack(alignment: .firstTextBaseline) {
                    Text(control.option.label)
                        .junoFont(size: 13, relativeTo: .subheadline, weight: .medium)
                        .foregroundStyle(Color.junoSecondaryInk)
                    Spacer(minLength: JunoSpace.cozy)
                    Text(isAuto ? (range.auto ?? "Auto") : "\(Int(seconds))s")
                        .junoFont(size: 22, relativeTo: .title3, weight: .medium)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoForeground)
                }
                Slider(
                    value: Binding(get: { seconds }, set: { pick(.number(($0 / range.step).rounded() * range.step)) }),
                    in: range.min...range.max,
                    step: range.step
                )
                .tint(Color.junoForeground)
                .opacity(isAuto ? 0.45 : 1)
                HStack {
                    Text("\(Int(range.min))s")
                    Spacer()
                    Text("\(Int(range.max))s")
                }
                .junoFont(size: 11, relativeTo: .caption)
                .monospacedDigit()
                .foregroundStyle(Color.junoSecondaryInk)
                if let auto = range.auto {
                    NativeTraySegmented(
                        label: control.option.label,
                        segments: [
                            .init(value: .auto, label: auto, note: "The model picks the length", conflict: false),
                            .init(value: .number(isAuto ? (schema.option(control.key)?.range?.min ?? 5) : seconds), label: "Set length", note: nil, conflict: false),
                        ],
                        selection: isAuto ? .auto : .number(seconds),
                        pick: { pick($0 == .auto ? .auto : .number(max(range.min, min(range.max, $0.numberValue ?? range.min)))) },
                        identifier: "\(identifier).auto"
                    )
                }
            }
            .padding(JunoSpace.regular)
            .frame(width: 280)
        }
    }
}

// MARK: - The chat line (the web's Project · Apps · Skills)

/// One project in the tray's Project menu.
public struct NativeComposerTrayProject: Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// Where a new chat goes: the projects store's list, the current pick, and
/// what picking does. `create` adds "New project…" when present.
public struct NativeComposerTrayProjects {
    public var items: [NativeComposerTrayProject]
    public var selectedID: String?
    public var select: (String?) -> Void
    public var create: (() -> Void)?

    public init(
        items: [NativeComposerTrayProject],
        selectedID: String?,
        select: @escaping (String?) -> Void,
        create: (() -> Void)? = nil
    ) {
        self.items = items
        self.selectedID = selectedID
        self.select = select
        self.create = create
    }

    var selectedName: String? { items.first { $0.id == selectedID }?.name }
}

/// The apps this chat can reach: the connected connectors, the ones switched
/// on for the next message, and the switch.
public struct NativeComposerTrayApps {
    public var connectors: [NativeConnector]
    public var enabled: Set<String>
    public var toggle: (String) -> Void
    public var manage: (() -> Void)?
    public var isLoading: Bool

    public init(
        connectors: [NativeConnector],
        enabled: Set<String>,
        toggle: @escaping (String) -> Void,
        manage: (() -> Void)? = nil,
        isLoading: Bool = false
    ) {
        self.connectors = connectors
        self.enabled = enabled
        self.toggle = toggle
        self.manage = manage
        self.isLoading = isLoading
    }
}

/// One skill the tray can arm for the next message.
public struct NativeComposerTraySkill: Identifiable, Hashable, Sendable {
    public let slug: String
    public let name: String
    public var id: String { slug }
    public init(slug: String, name: String) {
        self.slug = slug
        self.name = name
    }
}

public struct NativeComposerTraySkills {
    public var items: [NativeComposerTraySkill]
    public var armed: String?
    public var arm: (String?) -> Void
    public var browse: (() -> Void)?
    public var isLoading: Bool

    public init(
        items: [NativeComposerTraySkill],
        armed: String?,
        arm: @escaping (String?) -> Void,
        browse: (() -> Void)? = nil,
        isLoading: Bool = false
    ) {
        self.items = items
        self.armed = armed
        self.arm = arm
        self.browse = browse
        self.isLoading = isLoading
    }
}

/// A media model's line: the model, its schema and the tray's current choices.
public struct NativeComposerTrayMedia {
    public var schema: NativeMediaParamSchema
    public var params: NativeMediaParams
    public var set: (String, NativeMediaParamValue) -> Void

    public init(
        schema: NativeMediaParamSchema,
        params: NativeMediaParams,
        set: @escaping (String, NativeMediaParamValue) -> Void
    ) {
        self.schema = schema
        self.params = params
        self.set = set
    }
}

// MARK: - The tray

/// The composer tray, Mac and iPhone: the chat line (Project · Apps · Skills)
/// for a chat model, or the generation line and a compact Project for an
/// image, video or music model.
///
/// `leading` and `trailing` are the extension slots: other features add their
/// own tray items there (the Mac's local-folder control in `leading`), styled
/// with ``NativeComposerTrayPillStyle``, and the tray keeps its one line.
public struct NativeComposerTray<Leading: View, Trailing: View>: View {
    private let projects: NativeComposerTrayProjects?
    private let apps: NativeComposerTrayApps?
    private let skills: NativeComposerTraySkills?
    private let media: NativeComposerTrayMedia?
    private let leading: Leading
    private let trailing: Trailing

    public init(
        projects: NativeComposerTrayProjects?,
        apps: NativeComposerTrayApps? = nil,
        skills: NativeComposerTraySkills? = nil,
        media: NativeComposerTrayMedia? = nil,
        @ViewBuilder leading: () -> Leading = { EmptyView() },
        @ViewBuilder trailing: () -> Trailing = { EmptyView() }
    ) {
        self.projects = projects
        self.apps = apps
        self.skills = skills
        self.media = media
        self.leading = leading()
        self.trailing = trailing()
    }

    public var body: some View {
        NativeComposerTrayShelf {
            if let media, !media.schema.isEmpty {
                mediaLine(media)
            } else {
                chatLine
            }
        }
    }

    // A media model: ONE line. Its choices first, then where the chat goes as
    // a compact control; Apps and Skills step away (they say nothing about a
    // picture or a song).
    private func mediaLine(_ media: NativeComposerTrayMedia) -> some View {
        HStack(spacing: JunoSpace.micro) {
            NativeTrayScrollingLine {
                HStack(spacing: JunoSpace.micro) {
                    leading
                    NativeMediaParamsLine(schema: media.schema, params: media.params, set: media.set)
                }
            }
            if let projects {
                NativeTrayRule()
                projectMenu(projects, compact: true)
            }
            trailing
        }
    }

    private var chatLine: some View {
        NativeTrayFittingLine {
            leading
            if let projects { projectMenu(projects, compact: false) }
            if let apps { appsMenu(apps) }
            if let skills { skillsMenu(skills) }
        } trailing: {
            trailing
        }
    }

    // MARK: Project

    private func projectMenu(_ projects: NativeComposerTrayProjects, compact: Bool) -> some View {
        let name = projects.selectedName
        return NativeTrayMenu(
            accessibilityLabel: name.map { "Project: \($0)" } ?? "Select project",
            identifier: "juno.composer-tray.project"
        ) {
            Picker(
                "Project",
                selection: Binding(get: { projects.selectedID ?? "" }, set: { projects.select($0.isEmpty ? nil : $0) })
            ) {
                Text("No project").tag("")
                ForEach(projects.items) { project in
                    Text(project.name).tag(project.id)
                }
            }
            .pickerStyle(.inline)
            if let create = projects.create {
                Divider()
                Button("New project…", action: create)
            }
        } label: {
            JunoIconView(.projects, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
            if !compact || NativeComposerTrayMetrics.showsCompactProjectWord {
                Text(name ?? (compact ? "Project" : "Select project"))
                    .truncationMode(.tail)
                    .frame(maxWidth: compact ? 120 : 200, alignment: .leading)
                    .fixedSize(horizontal: name == nil, vertical: false)
            }
        }
    }

    // MARK: Apps

    private func appsMenu(_ apps: NativeComposerTrayApps) -> some View {
        let on = apps.connectors.filter { apps.enabled.contains($0.id) }
        return NativeTrayMenu(
            accessibilityLabel: on.isEmpty ? "Apps" : "Apps, \(on.count) on",
            identifier: "juno.composer-tray.apps"
        ) {
            if apps.connectors.isEmpty {
                Text(apps.isLoading ? "Loading apps…" : "No apps connected")
            } else {
                Section("Use in this chat") {
                    ForEach(apps.connectors) { connector in
                        Toggle(
                            connector.label,
                            isOn: Binding(get: { apps.enabled.contains(connector.id) }, set: { _ in apps.toggle(connector.id) })
                        )
                    }
                }
            }
            if let manage = apps.manage {
                Divider()
                Button(apps.connectors.isEmpty ? "Connect apps…" : "Manage apps…", action: manage)
            }
        } label: {
            if on.isEmpty {
                JunoIconView(.connections, size: 16)
                    .foregroundStyle(Color.junoSecondaryInk)
            } else {
                HStack(spacing: -JunoSpace.micro) {
                    ForEach(on.prefix(3)) { connector in
                        JunoConnectorMark(connectorID: connector.id, connectorName: connector.label, logoURL: connector.logoURL, size: 15)
                            .padding(1)
                            .background(Circle().fill(Color.junoCard))
                    }
                }
            }
            Text("Apps")
        }
    }

    // MARK: Skills

    private func skillsMenu(_ skills: NativeComposerTraySkills) -> some View {
        let armed = skills.items.first { $0.slug == skills.armed }
        return NativeTrayMenu(
            accessibilityLabel: armed.map { "Skill: \($0.name)" } ?? "Skills",
            identifier: "juno.composer-tray.skills"
        ) {
            if skills.items.isEmpty {
                Text(skills.isLoading ? "Loading skills…" : "No skills yet")
            } else {
                Picker(
                    "Use a skill",
                    selection: Binding(get: { skills.armed ?? "" }, set: { skills.arm($0.isEmpty ? nil : $0) })
                ) {
                    Text("None").tag("")
                    ForEach(skills.items) { skill in
                        Text(skill.name).tag(skill.slug)
                    }
                }
                .pickerStyle(.inline)
            }
            if let browse = skills.browse {
                Divider()
                Button("Browse skills…", action: browse)
            }
        } label: {
            JunoIconView(.skills, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
            Text(armed?.name ?? "Skills")
                .truncationMode(.tail)
                .frame(maxWidth: 160, alignment: .leading)
                .fixedSize(horizontal: armed == nil, vertical: false)
        }
    }
}

extension NativeComposerTrayMetrics {
    /// The media line's Project control keeps its word on the Mac; on the
    /// phone it is the folder mark alone, so the choices have the room.
    static var showsCompactProjectWord: Bool {
        #if os(iOS)
        false
        #else
        true
        #endif
    }
}

// MARK: - Lines that never wrap

/// A line wider than its room scrolls sideways inside itself; each edge fades
/// only while there is more that way, so a line that fits is never dimmed.
struct NativeTrayScrollingLine<Content: View>: View {
    @ViewBuilder let content: () -> Content
    @State private var fades = Fades()

    struct Fades: Equatable {
        var leading = false
        var trailing = false
    }

    var body: some View {
        ScrollView(.horizontal) {
            content()
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .onScrollGeometryChange(for: Fades.self) { geometry in
            let offset = geometry.contentOffset.x + geometry.contentInsets.leading
            let more = geometry.contentSize.width - geometry.containerSize.width - offset
            return Fades(leading: offset > 1, trailing: more > 1)
        } action: { _, next in
            fades = next
        }
        .mask {
            // Each fade ends in a short fully clear tail, so a clipped glyph
            // dissolves well short of the edge and never meets whatever sits
            // past it (the media line's rule before Project).
            HStack(spacing: 0) {
                Color.clear.frame(width: fades.leading ? NativeComposerTrayMetrics.fadeTail : 0)
                LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                    .frame(width: fades.leading ? NativeComposerTrayMetrics.fade : 0)
                Rectangle()
                LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: fades.trailing ? NativeComposerTrayMetrics.fade : 0)
                Color.clear.frame(width: fades.trailing ? NativeComposerTrayMetrics.fadeTail : 0)
            }
        }
    }
}

/// The chat line: its items and the trailing slot pushed to the end when they
/// fit; when they do not (a long project name on a phone), the same items in
/// one scrolling line.
struct NativeTrayFittingLine<Items: View, Trailing: View>: View {
    @ViewBuilder let items: () -> Items
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: JunoSpace.micro) {
                items()
                Spacer(minLength: JunoSpace.snug)
                trailing()
            }
            NativeTrayScrollingLine {
                HStack(spacing: JunoSpace.micro) {
                    items()
                    trailing()
                }
            }
        }
    }
}
