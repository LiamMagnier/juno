import AppKit
import JunoCodeKit
import JunoDesignSystem
import SwiftUI

// MARK: - The pairing sheet

/// "Approve on your device to control this Mac remotely": Phone (a QR the
/// iPhone scans) or Computer (an address and a code a browser types), a quiet
/// two-minute countdown that renews itself, then "Paired with …".
///
/// Signature detail: the QR, drawn module-crisp on a white plate with the
/// Continuum on a small rounded plate at its centre, the one image on the
/// sheet. Everything else is words.
struct DesktopRemotePairingSheet: View {
    let model: DesktopRemotePairingModel
    let close: () -> Void

    @State private var copied: String?

    static let width: CGFloat = 460
    static let stageHeight: CGFloat = 300

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.bottom, JunoSpace.roomy)

            if showsSegments {
                JunoSegmented(
                    options: [
                        .init(RemotePairingKind.phone, "Phone", icon: .smartphone),
                        .init(RemotePairingKind.browser, "Computer", icon: .device),
                    ],
                    selection: Binding(get: { model.kind }, set: { model.select($0) }),
                    accessibilityLabel: "Pair a phone or a computer",
                    optionAccessibilityIdentifier: { "juno.desktop.pairing.kind.\($0.rawValue)" }
                )
                .padding(.bottom, JunoSpace.section)
            }

            stage
                .frame(maxWidth: .infinity)
                .frame(height: Self.stageHeight)

            footer
                .padding(.top, JunoSpace.roomy)
        }
        .padding(.horizontal, JunoSpace.section)
        .padding(.top, JunoSpace.section)
        .padding(.bottom, JunoSpace.roomy)
        .frame(width: Self.width)
        .background(Color.junoCanvas)
        .accessibilityIdentifier("juno.desktop.pairing.sheet")
    }

    /// Phone / Computer, while there is a code to choose between.
    private var showsSegments: Bool {
        switch model.phase {
        case .unregistered, .approved: false
        default: true
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(spacing: JunoSpace.snug) {
            Text("Approve on your device to control this Mac remotely")
                .junoType(JunoType.heading.weight(.semibold))
                .foregroundStyle(Color.junoForeground)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 300)
                .accessibilityAddTraits(.isHeader)
            Text(subtitle)
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: 360)
    }

    private var subtitle: String {
        switch model.phase {
        case .unregistered:
            return "Pairing needs this Mac to be signed in and listed on your account."
        case .approved:
            return "Remote control is on for this Mac."
        default:
            return model.kind == .phone
                ? "Scan with your iPhone's camera, then approve in Alevr."
                : "Open the address on another computer, then enter the code."
        }
    }

    // MARK: Stage

    @ViewBuilder
    private var stage: some View {
        switch model.phase {
        case .unregistered:
            DesktopPairingMessage(
                icon: .device,
                title: "Sign in and wait for this Mac to register",
                detail: "It registers within a minute of signing in. Then a phone or a browser can pair with it."
            )
        case .loading:
            if model.kind == .phone {
                DesktopPairingQRPlate(url: nil)
            } else {
                ProgressView()
                    .controlSize(.regular)
                    .accessibilityLabel("Making a pairing code")
            }
        case .showing(let offer):
            if offer.kind == .phone {
                DesktopPairingQRPlate(url: offer.url)
            } else {
                computer(offer)
            }
        case .approved(let name):
            DesktopPairingMessage(
                icon: .circleCheck,
                iconInk: Color.junoSuccessInk,
                title: "Paired with \(name)",
                detail: "It can start and steer Alevr Code on this Mac now. Remove it here any time."
            )
            .accessibilityIdentifier("juno.desktop.pairing.approved")
        case .denied:
            DesktopPairingMessage(
                icon: .circleX,
                title: "The request was declined",
                detail: "Nothing was paired. Show a new code to try again.",
                action: ("Show a New Code", { Task { await model.requestOffer() } })
            )
        case .failed(let message):
            DesktopPairingMessage(
                icon: .error,
                title: "No pairing code",
                detail: message,
                action: ("Try Again", { Task { await model.requestOffer() } })
            )
        }
    }

    private func computer(_ offer: RemotePairingOffer) -> some View {
        VStack(spacing: JunoSpace.section) {
            DesktopPairingCopyField(
                step: "Open this address",
                value: Self.displayAddress(offer.url),
                copyValue: offer.url,
                isCode: false,
                copied: $copied
            )
            if let code = offer.code {
                DesktopPairingCopyField(
                    step: "Enter this code",
                    value: code,
                    copyValue: code,
                    isCode: true,
                    copied: $copied
                )
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// `https://alevr.com/pair` reads as `alevr.com/pair`.
    static func displayAddress(_ url: String) -> String {
        url.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "")
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: JunoSpace.cozy) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                if let seconds = model.secondsLeft(at: model.clockIsPinned ? nil : context.date) {
                    Text("New code in \(DesktopRemotePairingModel.countdown(seconds))")
                        .junoType(.label)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoTertiaryInk)
                        .accessibilityLabel("The code renews in \(seconds) seconds")
                }
            }
            Spacer(minLength: 0)
            Button("Done", action: close)
                .buttonStyle(.junoGlass)
                .keyboardShortcut(.cancelAction)
                .frame(minHeight: 44)
                .contentShape(.rect)
                .accessibilityIdentifier("juno.desktop.pairing.done")
        }
    }
}

/// The QR on a white plate (dark modules on white in both appearances, so any
/// camera reads it), the Continuum on a small rounded plate at its centre.
struct DesktopPairingQRPlate: View {
    /// Nil while the offer is on its way: the plate holds its place.
    let url: String?

    static let plate: CGFloat = 248
    static let code: CGFloat = 212
    static let logoPlate: CGFloat = 50

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(Color.white)
                .overlay(
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .strokeBorder(Color.black.opacity(0.08), lineWidth: 1)
                )
                .shadow(color: Color.black.opacity(0.10), radius: 18, y: 8)
            if let url, let image = DesktopPairingQR.image(for: url) {
                Image(decorative: image, scale: 1)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: Self.code, height: Self.code)
                    .accessibilityLabel("Pairing code to scan with your iPhone")
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.white)
                    .frame(width: Self.logoPlate, height: Self.logoPlate)
                    .shadow(color: Color.black.opacity(0.12), radius: 3, y: 1)
                JunoMark(size: 30)
                    .foregroundStyle(Color.black)
            } else {
                ProgressView()
                    .controlSize(.regular)
                    .colorScheme(.light)
                    .accessibilityLabel("Making a pairing code")
            }
        }
        .frame(width: Self.plate, height: Self.plate)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.desktop.pairing.qr")
    }
}

/// One step of the Computer tab: what to do, the value large, and Copy.
private struct DesktopPairingCopyField: View {
    let step: String
    let value: String
    let copyValue: String
    let isCode: Bool
    @Binding var copied: String?

    var body: some View {
        VStack(spacing: JunoSpace.snug) {
            Text(step)
                .junoType(.label)
                .foregroundStyle(Color.junoSecondaryInk)
            HStack(spacing: JunoSpace.cozy) {
                Group {
                    if isCode {
                        Text(value)
                            .junoFont(size: 30, relativeTo: .title, weight: .semibold, design: .monospaced)
                            .tracking(3)
                    } else {
                        Text(value)
                            .junoType(JunoType.title.weight(.semibold))
                    }
                }
                .foregroundStyle(Color.junoForeground)
                .textSelection(.enabled)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(maxWidth: .infinity, alignment: .leading)

                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(copyValue, forType: .string)
                    copied = copyValue
                } label: {
                    JunoIconView(copied == copyValue ? .check : .copy, size: 15)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help(isCode ? "Copy the code" : "Copy the address")
                .accessibilityLabel(isCode ? "Copy the code" : "Copy the address")
            }
            .padding(.leading, JunoSpace.roomy)
            .padding(.trailing, JunoSpace.snug)
            .frame(width: 340, alignment: .leading)
            .frame(minHeight: 64)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .fill(Color.junoCard)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
        }
        .accessibilityElement(children: .contain)
    }
}

/// A settled state in the stage: a mark, one line, one sentence, maybe one action.
private struct DesktopPairingMessage: View {
    let icon: JunoIcon
    var iconInk: Color = Color.junoSecondaryInk
    let title: String
    let detail: String
    var action: (String, () -> Void)?

    var body: some View {
        VStack(spacing: JunoSpace.cozy) {
            JunoIconView(icon, size: 36)
                .foregroundStyle(iconInk)
                .padding(.bottom, JunoSpace.tight)
            Text(title)
                .junoType(JunoType.bodyLarge.weight(.semibold))
                .foregroundStyle(Color.junoForeground)
                .multilineTextAlignment(.center)
            Text(detail)
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 320)
            if let action {
                Button(action.0, action: action.1)
                    .buttonStyle(.junoGlass)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                    .padding(.top, JunoSpace.snug)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Paired devices

/// The phones and browsers this Mac approved, each with Remove (asks first).
struct DesktopRemotePairedDeviceList: View {
    let model: DesktopRemotePairingModel

    @State private var confirming: RemotePair?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.pairs.isEmpty {
                Text(model.pairsLoaded ? "No devices paired yet." : "Loading paired devices…")
                    .junoType(.label)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .padding(.vertical, JunoSpace.snug)
            } else {
                ForEach(Array(model.pairs.enumerated()), id: \.element.id) { index, pair in
                    if index > 0 { Divider() }
                    row(pair)
                }
            }
            if let error = model.pairsError {
                Text(error)
                    .junoType(.label)
                    .foregroundStyle(Color.junoDestructiveInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, JunoSpace.tight)
            }
        }
        .confirmationDialog(
            "Remove \(confirming?.name ?? "this device")?",
            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            titleVisibility: .visible,
            presenting: confirming
        ) { pair in
            Button("Remove", role: .destructive) { Task { await model.remove(pair) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("It loses access to this Mac at once. Pair it again any time.")
        }
    }

    private func row(_ pair: RemotePair) -> some View {
        HStack(spacing: JunoSpace.cozy) {
            JunoIconView(pair.kind == .phone ? .smartphone : .device, size: 18)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 32, height: 32)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .fill(Color.junoForeground.opacity(0.05))
                )
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text(pair.name)
                    .junoType(.ui)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                Text(DesktopRemotePairingModel.subtitle(for: pair, now: model.now()))
                    .junoType(.label)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
            }
            Spacer(minLength: JunoSpace.cozy)
            DesktopOutlineButton(title: model.removingPairID == pair.id ? "Removing…" : "Remove", destructive: true) {
                confirming = pair
            }
            .disabled(model.removingPairID != nil)
            .accessibilityIdentifier("juno.desktop.pairing.remove.\(pair.id)")
        }
        .frame(minHeight: 52)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - The switch

/// "Control this Mac remotely" in Settings › Connections: the Remote hosting
/// consent (``DesktopCodeHostModel/servesQueuedTasks``, the one the Code
/// settings tile also binds), "Pair a device…", and the paired devices.
struct DesktopRemoteControlSection: View {
    let host: DesktopCodeHostModel?

    var body: some View {
        if let host {
            Section {
                DesktopRemoteControlRows(host: host, layout: .form)
            } header: {
                DesktopSettingsGroupHeader(
                    title: "Control this Mac remotely",
                    note: "Drive Alevr Code on this Mac from your iPhone or another computer you approve."
                )
            }
        }
    }
}

/// The switch, Pair a device… and the list, for a Settings form or the Code
/// settings tile. Turning the switch on opens the pairing sheet.
struct DesktopRemoteControlRows: View {
    enum Layout { case form, tile }

    let host: DesktopCodeHostModel
    let layout: Layout

    @State private var pairing: DesktopRemotePairingModel?
    @State private var showsSheet = false

    var body: some View {
        // The task and the sheet hang off the switch, the one row always
        // present: on a Group they would be copied onto every row.
        switchRow
            .task(id: host.deviceID) {
            let model = DesktopRemotePairingModel(service: host.pairingService)
            pairing = model
            await model.refreshPairs()
        }
        .sheet(isPresented: $showsSheet, onDismiss: {
            pairing?.stop()
            Task { await pairing?.refreshPairs() }
        }) {
            if let pairing {
                DesktopRemotePairingSheet(model: pairing, close: { showsSheet = false })
                    .onAppear {
                        pairing.onApproved = { showsSheet = false }
                        pairing.start()
                    }
                    .onDisappear { pairing.stop() }
            }
        }
        if host.servesQueuedTasks {
            if layout == .tile { Divider() }
            pairRow
            if let pairing {
                DesktopRemotePairedDeviceList(model: pairing)
            }
        }
    }

    private var isOn: Binding<Bool> {
        Binding(
            get: { host.servesQueuedTasks },
            set: { on in
                host.servesQueuedTasks = on
                if on { showsSheet = true }
            }
        )
    }

    @ViewBuilder
    private var switchRow: some View {
        switch layout {
        case .form:
            DesktopSettingToggleRow(
                title: "Control this Mac remotely",
                description: "Your paired iPhone or browser can start, steer and approve Alevr Code sessions here, "
                    + "in the folders you share. Off stops every remote connection at once.",
                isOn: isOn,
                identifier: "juno.desktop.settings.remote-control"
            )
        case .tile:
            Toggle(isOn: isOn) {
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text("Control this Mac remotely")
                        .junoRowLabel()
                    Text(
                        "Lets your paired iPhone and browsers start and steer Alevr Code sessions that run here, "
                            + "in the workspaces you have shared. Off, this Mac stays visible but runs nothing sent to it."
                    )
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .toggleStyle(.switch)
            .tint(Color.junoAccent)
            .accessibilityIdentifier("juno.desktop.settings.remote-host-enabled")
        }
    }

    @ViewBuilder
    private var pairRow: some View {
        let button = DesktopOutlineButton(title: "Pair a Device…", icon: .link) { showsSheet = true }
            .accessibilityIdentifier("juno.desktop.settings.remote-control.pair")
        switch layout {
        case .form:
            DesktopSettingRow(
                title: "Paired devices",
                description: "Each can control this Mac until you remove it."
            ) { button }
        case .tile:
            HStack {
                Text("Paired devices")
                    .junoRowLabel()
                Spacer(minLength: 0)
                button
            }
        }
    }
}
