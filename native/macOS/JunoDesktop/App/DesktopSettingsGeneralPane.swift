import AppKit
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// Settings › General (`sections/general.tsx`): Appearance — theme, accent and
/// text size — then the Mac's own About. Interface language is not offered on
/// the Mac until it ships a string catalogue (decision 19, P3-5).
///
/// Signature detail: the accent swatches, custom colour included, recolour the
/// window while the reader is still choosing.
struct DesktopSettingsGeneralPane: View {
    let context: DesktopSettingsContext

    @State private var updater = DesktopUpdateModel.shared
    @State private var showingDiagnostics = false
    @Environment(\.openWindow) private var openWindow
    @AppStorage(DesktopTextSize.storageKey) private var storedTextSize = DesktopTextSize.default.rawValue

    var body: some View {
        DesktopSettingsRecordForm(context: context) { settings in
            Section {
                themeRow(settings)
                accentRow(settings)
                textSizeRow
            } header: {
                DesktopSettingsGroupHeader(
                    title: "Appearance",
                    note: "Theme and accent follow your account. Text size is set for this device."
                )
            }

            Section {
                DesktopSettingRow(
                    title: "Alevr for Mac",
                    description: updateStatus
                ) {
                    if case .ready = updater.phase {
                        Button("Restart to Update") { updater.installAndRelaunch() }
                            .buttonStyle(.junoProminent)
                            .frame(minWidth: 28, minHeight: 28)
                            .contentShape(.rect)
                            .accessibilityIdentifier("juno.desktop.settings.check-updates")
                    } else {
                        DesktopOutlineButton(title: "Check for Updates…") { openUpdates() }
                            .accessibilityIdentifier("juno.desktop.settings.check-updates")
                    }
                }
                DesktopSettingRow(
                    title: "Diagnostics",
                    description: "What this Mac has synced, what is queued, and what failed."
                ) {
                    DesktopOutlineButton(title: "Diagnostics…") { showingDiagnostics = true }
                        .accessibilityIdentifier("juno.desktop.settings.diagnostics")
                }
            } header: {
                DesktopSettingsGroupHeader(title: "About")
            }
        }
        .sheet(isPresented: $showingDiagnostics) {
            DesktopSettingsDiagnosticsSheet(context: context)
        }
    }

    // MARK: Theme

    private func themeRow(_ settings: NativeAccountSettings) -> some View {
        DesktopSettingRow(title: "Theme", status: context.saves.status("theme")) {
            // The platform's own segmented control, words only, as System
            // Settings draws a three-way choice.
            Picker(
                "Theme",
                selection: Binding(
                    get: { settings.theme },
                    set: { theme in
                        guard theme != settings.theme else { return }
                        context.save("theme", NativeSettingsPatch(theme: theme))
                    }
                )
            ) {
                Text("Light").tag(NativeThemePreference.light)
                Text("Dark").tag(NativeThemePreference.dark)
                Text("System").tag(NativeThemePreference.system)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .accessibilityIdentifier("juno.desktop.settings.theme")
        }
    }

    // MARK: Accent

    private func accentRow(_ settings: NativeAccountSettings) -> some View {
        DesktopSettingRow(
            title: "Accent color",
            description: "Buttons, selection and focus.",
            status: context.saves.status("accent")
        ) {
            DesktopAccentPicker(
                stored: settings.accent,
                select: { accent in
                    guard accent != settings.accent else { return }
                    context.save("accent", NativeSettingsPatch(accent: accent))
                }
            )
        }
    }

    // MARK: Text size

    private var textSize: DesktopTextSize { DesktopTextSize(stored: storedTextSize) }

    private var textSizeRow: some View {
        DesktopSettingRow(
            title: "Text size",
            description: "Scales the whole interface on this device.",
            status: context.saves.status("fontSize")
        ) {
            HStack(alignment: .center, spacing: JunoSpace.snug) {
                Text("A")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .accessibilityHidden(true)
                DesktopTickSlider(
                    value: Binding(
                        get: { textSize.step },
                        set: { storedTextSize = DesktopTextSize(step: $0).rawValue }
                    ),
                    steps: DesktopTextSize.allCases.count,
                    accessibilityLabel: "Text size",
                    accessibilityValue: "\(textSize.px) points",
                    committed: { context.saves.mark("fontSize", ok: true) }
                )
                .frame(width: DesktopSettingsMetrics.sliderWidth)
                .accessibilityIdentifier("juno.desktop.settings.text-size")
                Text("A")
                    .junoType(.bodyLarge)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .accessibilityHidden(true)
                Text("\(textSize.px) pt")
                    .junoType(.ui)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: DesktopSettingsMetrics.valueWidth, alignment: .trailing)
                    .accessibilityHidden(true)
            }
        }
    }

    // MARK: About

    /// The build, then where the updater stands, in plain words: a version
    /// in the mono, never a pill.
    private var updateStatus: String {
        let version = "Version \(JunoBuildInfo.current.displayVersion)."
        let status: String = switch updater.phase {
        case .idle: "Alevr checks for updates every ten minutes while it is open."
        case .checking: "Checking for updates…"
        case .current: "Up to date."
        case .downloading(let version, let fraction):
            if let fraction {
                "Downloading \(version), \(Int((fraction * 100).rounded()))%."
            } else {
                "Downloading \(version)…"
            }
        case .ready(let version): "Alevr \(version) is downloaded and verified."
        case .failed(let message): message
        case .unsupported(let reason): reason
        }
        return "\(version) \(status)"
    }

    /// Software Update, checking on the way in unless a check or a download
    /// is already running.
    private func openUpdates() {
        switch updater.phase {
        case .checking, .downloading: break
        default: updater.checkNow()
        }
        openWindow(id: JunoDesktopWindow.softwareUpdateID)
    }
}

// MARK: - Accent picker

/// The six accents as 24pt swatches with a check on the chosen one, then the
/// custom colour in a swatch-shaped well (the web's `CustomPickerButton`).
///
/// The custom well previews the colour on the whole window while the colour
/// panel is dragged and saves it once the reader stops, as the web previews on
/// `input` and saves on `change`.
struct DesktopAccentPicker: View {
    let stored: String
    let select: (String) -> Void

    static let defaultCustom = "#ea580c"

    @State private var custom = Color(hex: DesktopAccentPicker.defaultCustom)
    @State private var commit: Task<Void, Never>?

    private var storedCustom: JunoCustomAccent? { JunoCustomAccent(hex: stored) }

    var body: some View {
        HStack(spacing: JunoSpace.close) {
            ForEach(JunoAccent.allCases) { accent in
                DesktopAccentSwatch(
                    fill: AnyShapeStyle(accent.color),
                    ink: accent.onAccent,
                    label: accent.displayName,
                    isSelected: storedCustom == nil && JunoAccent(setting: stored) == accent,
                    select: { select(accent.rawValue) }
                )
            }
            customWell
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Accent color")
        .accessibilityIdentifier("juno.desktop.settings.accent")
        .onAppear {
            if let storedCustom { custom = Color(hex: storedCustom.hex) }
        }
    }

    private var customWell: some View {
        let selected = storedCustom != nil
        return ZStack {
            DesktopAccentSwatch(
                fill: selected
                    ? AnyShapeStyle(storedCustom?.color ?? .junoAccent)
                    : AnyShapeStyle(AngularGradient(
                        colors: [.junoAccent, .junoSource, .junoSuccessInk, .junoWarning, .junoAccent],
                        center: .center
                    )),
                ink: selected ? (storedCustom?.onAccent ?? .white) : Color.junoCanvas,
                label: "Custom accent color",
                isSelected: selected,
                glyph: selected ? .check : .plus,
                select: {}
            )
            .allowsHitTesting(false)
            // The system colour well, invisible and exactly over the swatch:
            // a click opens the colour panel, and the swatch is what shows.
            ColorPicker("Custom accent color", selection: $custom, supportsOpacity: false)
                .labelsHidden()
                .frame(width: DesktopSettingsMetrics.swatchSize + 4, height: DesktopSettingsMetrics.swatchSize + 4)
                .clipShape(Circle())
                .opacity(0.02)
                .help("Custom accent color")
                .accessibilityLabel("Custom accent color")
        }
        .frame(width: 28, height: 28)
        .contentShape(Circle())
        .onChange(of: custom) { _, color in
            guard let hex = color.junoHex, hex != stored else { return }
            JunoAccentSelection.shared.apply(setting: hex)
            commit?.cancel()
            commit = Task {
                try? await Task.sleep(for: .milliseconds(700))
                guard !Task.isCancelled else { return }
                select(hex)
            }
        }
    }
}

/// One accent, as the colour itself: a check on the chosen one, and a ring
/// under the pointer.
struct DesktopAccentSwatch: View {
    let fill: AnyShapeStyle
    let ink: Color
    let label: String
    let isSelected: Bool
    var glyph: JunoIcon = .check
    let select: () -> Void

    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var ringStrength: Double {
        if isSelected { return 0.85 }
        return isHovering ? 0.3 : 0
    }

    var body: some View {
        Button(action: select) {
            Circle()
                .fill(fill)
                .frame(width: DesktopSettingsMetrics.swatchSize, height: DesktopSettingsMetrics.swatchSize)
                .overlay {
                    if isSelected || glyph != .check {
                        JunoIconView(glyph, size: 12)
                            .foregroundStyle(ink)
                    }
                }
                .overlay {
                    Circle()
                        .strokeBorder(Color.junoForeground.opacity(ringStrength), lineWidth: 2)
                        .padding(-3)
                }
                .frame(width: 28, height: 28)
                .contentShape(Circle())
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: isHovering)
        }
        .buttonStyle(.junoPress)
        .onHover { isHovering = $0 }
        .help(label)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

extension Color {
    /// `#rrggbb` in sRGB, for storing a colour the reader picked.
    var junoHex: String? {
        guard let rgb = NSColor(self).usingColorSpace(.sRGB) else { return nil }
        let r = Int((rgb.redComponent * 255).rounded())
        let g = Int((rgb.greenComponent * 255).rounded())
        let b = Int((rgb.blueComponent * 255).rounded())
        return String(format: "#%02x%02x%02x", r, g, b)
    }

    /// A colour from `#rrggbb`; black when the string is not one.
    init(hex: String) {
        let value = UInt32(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

// MARK: - Diagnostics

/// What this Mac has synced, queued and failed — moved here from Data &
/// privacy — as a system sheet with an explicit frame.
struct DesktopSettingsDiagnosticsSheet: View {
    let context: DesktopSettingsContext
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            NativeDiagnosticsView(
                syncModel: context.services.syncModel,
                outbox: context.services.outbox,
                accountID: StorageAccountID(context.accountID.rawValue)
            )
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .contentShape(.rect)
            }
            .padding(JunoSpace.regular)
        }
        .frame(width: 560, height: 520)
        .presentationSizing(.form)
    }
}
