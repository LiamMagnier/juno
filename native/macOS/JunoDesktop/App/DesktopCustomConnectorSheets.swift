import JunoChatKit
import JunoDesignSystem
import SwiftUI

// Bring your own MCP server, on the Mac: the add sheet, the manage sheet, a
// server's monogram and the dashed "Add an MCP server" tile that ends the
// Available grid. The web's `add-custom-connector-dialog.tsx`,
// `custom-connector-dialog.tsx` and `AddServerTile`, in the Mac's voice.

// MARK: - Add

/// "Add an MCP server": two steps in one fitted sheet that changes height
/// rather than jumping (the web's height-animating dialog shell).
///
/// 1. **Address.** Paste it, Check. Juno asks the server itself — is there an
///    MCP server, does it sign in with OAuth, can Juno register with it — and a
///    refusal is the server route's own sentence, verbatim.
/// 2. **Ready.** Its monogram and name (editable), where the reader will sign
///    in, and what happens after. Continue saves it and opens the sign-in page
///    in the browser; nothing is saved before that.
struct DesktopAddServerSheet: View {
    @Bindable var draft: NativeCustomConnectorDraft
    /// Called with the saved server once it exists: the caller opens its
    /// sign-in page and closes the sheet.
    let signIn: (NativeCustomConnector) -> Void
    let close: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var addressFocused: Bool

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let candidate = draft.candidate {
                ready(candidate)
                    .transition(stepTransition(forward: true))
            } else {
                address
                    .transition(stepTransition(forward: false))
            }
        }
        .padding(JunoSpace.section)
        .frame(width: DesktopServerSheetMetrics.addWidth, alignment: .topLeading)
        .fixedSize(horizontal: false, vertical: true)
        .animation(JunoMotion.reduced(JunoMotion.layout, when: reduceMotion), value: draft.step)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: draft.refusal)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: draft.isChecking)
        .junoSheetSurface(.fitted)
        .accessibilityIdentifier("juno.desktop.connections.add-server")
    }

    /// A cross-fade with the step's small lift — forward rises from below,
    /// Back settles from above — and only the fade under Reduce Motion.
    private func stepTransition(forward: Bool) -> AnyTransition {
        let lift = JunoMotion.shift(JunoMotion.riseDistance, reduceMotion: reduceMotion)
        return .asymmetric(
            insertion: .opacity.combined(with: .offset(y: forward ? lift : -lift)),
            removal: .opacity.animation(JunoMotion.exit)
        )
    }

    // MARK: Step 1

    private var address: some View {
        VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            DesktopServerSheetTitle(
                title: "Add an MCP server",
                lede: "Paste the server’s address. Juno checks it before anything is saved."
            )

            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                HStack(spacing: JunoSpace.snug) {
                    TextField("Server address", text: $draft.address, prompt: Text("https://mcp.example.com/mcp"))
                        .labelsHidden()
                        .junoFieldChrome(fill: Color.junoCard)
                        .font(.system(size: 13, design: .monospaced))
                        .autocorrectionDisabled()
                        .focused($addressFocused)
                        .disabled(draft.isChecking)
                        .onSubmit { Task { await draft.check() } }
                        .accessibilityLabel("Server address")
                        .accessibilityIdentifier("connections.add-server.address")
                    Button {
                        Task { await draft.check() }
                    } label: {
                        Text(draft.isChecking ? "Checking…" : "Check")
                            .frame(minWidth: 64)
                    }
                    .buttonStyle(.junoProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!draft.canCheck)
                    .contentShape(.rect)
                    .accessibilityIdentifier("connections.add-server.check")
                }

                // One line while a stranger's server answers: the address
                // itself, shimmering, so the wait names what it is waiting on.
                if draft.isChecking {
                    JunoShimmerText(
                        "Looking for a server at \(draft.checkingHost)…",
                        font: JunoType.caption.font(),
                        active: true
                    )
                    .lineLimit(1)
                    .transition(.junoInline)
                } else if let refusal = draft.refusal {
                    DesktopNoteBand(icon: .error, tone: Color.junoDestructiveInk) {
                        Text(refusal).textSelection(.enabled)
                    }
                    .transition(.junoInline)
                    .accessibilityIdentifier("connections.add-server.refusal")
                }
            }

            HStack(alignment: .bottom, spacing: JunoSpace.regular) {
                Text(
                    "Servers sign in with OAuth, so Juno never sees your password. Only add servers you trust: their tools can read and act on whatever you connect them to."
                )
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                Button("Cancel", role: .cancel, action: close)
                    .buttonStyle(.bordered)
                    .tint(nil)
                    .keyboardShortcut(.cancelAction)
                    .contentShape(.rect)
            }
        }
        .onAppear { addressFocused = true }
    }

    // MARK: Step 2

    private func ready(_ candidate: NativeCustomConnectorCandidate) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            DesktopServerSheetTitle(
                title: candidate.isExisting ? "Already added" : "Found it",
                lede: candidate.isExisting
                    ? "This server is already in your connections. Sign in again to reconnect it."
                    : "An MCP server that signs in with OAuth. Name it the way you’ll look for it."
            )

            HStack(spacing: JunoSpace.cozy) {
                DesktopServerMonogramWell(name: draft.name.isEmpty ? candidate.suggestedName : draft.name, settles: true)
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    TextField("Name", text: $draft.name)
                        .labelsHidden()
                        .textFieldStyle(.plain)
                        .junoType(JunoType.ui.weight(.semibold))
                        .disabled(draft.isCreating || candidate.isExisting)
                        .onSubmit { Task { await continueToSignIn() } }
                        .accessibilityLabel("Name")
                        .accessibilityIdentifier("connections.add-server.name")
                    Text(candidate.host)
                        .junoType(.monoSmall)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .padding(JunoSpace.cozy)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(Color.junoCard)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 1)
            )

            VStack(alignment: .leading, spacing: JunoSpace.close) {
                DesktopServerFact(icon: .key, index: 0) {
                    Text("You’ll sign in on ") + Text(candidate.authHost).fontWeight(.medium)
                        .foregroundColor(Color.junoForeground) + Text(" and approve Juno there.")
                }
                DesktopServerFact(icon: .sliders, index: 1) {
                    Text("Then choose which of its tools Juno may use.")
                }
                DesktopServerFact(icon: .shieldCheck, index: 2) {
                    Text("Juno asks before any tool that changes something, as it does for every app.")
                }
            }

            if let refusal = draft.refusal {
                DesktopNoteBand(icon: .error, tone: Color.junoDestructiveInk) {
                    Text(refusal).textSelection(.enabled)
                }
                .transition(.junoInline)
                .accessibilityIdentifier("connections.add-server.refusal")
            }

            HStack(spacing: JunoSpace.cozy) {
                Button {
                    draft.back()
                } label: {
                    Label {
                        Text("Back")
                    } icon: {
                        JunoIconView(.arrowLeft, size: 13)
                    }
                }
                .buttonStyle(.bordered)
                .tint(nil)
                .disabled(draft.isCreating)
                .contentShape(.rect)
                Spacer(minLength: 0)
                Button("Cancel", role: .cancel, action: close)
                    .buttonStyle(.bordered)
                    .tint(nil)
                    .keyboardShortcut(.cancelAction)
                    .disabled(draft.isCreating)
                    .contentShape(.rect)
                Button {
                    Task { await continueToSignIn() }
                } label: {
                    Text(draft.isCreating ? "Opening Sign-In…" : "Continue to Sign In")
                }
                .buttonStyle(.junoProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!draft.canContinue)
                .contentShape(.rect)
                .accessibilityIdentifier("connections.add-server.continue")
            }
        }
    }

    private func continueToSignIn() async {
        guard draft.canContinue, let connector = await draft.create() else { return }
        signIn(connector)
    }
}

/// One of the Ready step's three facts: a quiet glyph and a caption, arriving
/// one after another on first reveal only.
private struct DesktopServerFact: View {
    let icon: JunoIcon
    let index: Int
    @ViewBuilder let text: () -> Text

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.close) {
            JunoIconView(icon, size: 13)
                .foregroundStyle(Color.junoSecondaryInk)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                .accessibilityHidden(true)
            text()
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
        .modifier(DesktopServerArrival(index: index + 1, active: true))
    }
}

// MARK: - Manage

/// One added server, managed (the web's `CustomConnectorDialog`): its name,
/// whether Juno is signed in, and the tools Juno may use, one switch each.
///
/// Tools are split by what they do, not alphabetically, because that is the
/// decision being made: **Reads** run without a word, **Changes things** wait
/// for approval in the chat — the broker's rule for every connector, restated
/// so a switch reads as "allowed at all", not "allowed unasked".
struct DesktopManageServerSheet: View {
    @Bindable var editor: NativeCustomConnectorEditor
    /// Opens the server's sign-in page in the browser (and closes this).
    let signIn: (String) -> Void
    let close: () -> Void

    @State private var draftName = ""
    @State private var confirmingRemove = false
    /// A failed save or refresh, said once under the list — the manage sheet's
    /// stand-in for the web's toast, which would land behind the sheet here.
    @State private var notice: String?
    /// The tool rows deal in once, the first time a list appears; a refresh
    /// or a toggle never replays it.
    @State private var dealtTools = false
    @FocusState private var nameFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let connector = editor.connector {
                header(connector)
                Divider()
                content(connector)
                Divider()
                footer(connector)
            } else {
                loading
            }
        }
        .frame(width: DesktopServerSheetMetrics.manageWidth)
        .fixedSize(horizontal: false, vertical: true)
        .animation(JunoMotion.reduced(JunoMotion.layout, when: reduceMotion), value: editor.connector?.connected)
        .animation(JunoMotion.reduced(JunoMotion.layout, when: reduceMotion), value: editor.connector?.tools == nil)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: notice)
        .junoSheetSurface(.fitted)
        .task {
            if editor.connector == nil { await editor.load() }
            draftName = editor.connector?.name ?? ""
        }
        .onChange(of: editor.connector?.name) { _, name in
            if !nameFocused, let name { draftName = name }
        }
        .onChange(of: nameFocused) { _, focused in
            if !focused { commitName() }
        }
        .accessibilityIdentifier("juno.desktop.connections.manage-server")
    }

    // MARK: Loading

    @ViewBuilder
    private var loading: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            if let error = editor.loadError {
                DesktopNoteBand(icon: .error, tone: Color.junoDestructiveInk) { Text(error) }
                HStack {
                    Spacer()
                    Button("Close", action: close)
                        .buttonStyle(.bordered)
                        .tint(nil)
                        .keyboardShortcut(.cancelAction)
                }
            } else {
                HStack(spacing: JunoSpace.cozy) {
                    JunoSkeleton(height: 40, width: 40, cornerRadius: JunoRadius.field)
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        JunoSkeleton(height: 14, width: 160)
                        JunoSkeleton(height: 10, width: 220)
                    }
                }
                JunoSkeleton(height: 96, cornerRadius: JunoRadius.card)
            }
        }
        .padding(JunoSpace.section)
        .accessibilityElement()
        .accessibilityLabel(editor.loadError ?? "Loading server")
    }

    // MARK: Header

    private func header(_ connector: NativeCustomConnector) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(spacing: JunoSpace.cozy) {
                DesktopServerMonogramWell(name: draftName.isEmpty ? connector.name : draftName, settles: false)
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    // The name as a quiet field: it reads as the title and
                    // edits in place; Return or leaving it saves.
                    TextField("Name", text: $draftName)
                        .labelsHidden()
                        .textFieldStyle(.plain)
                        .junoType(.heading)
                        .focused($nameFocused)
                        .onSubmit { commitName() }
                        .onChange(of: draftName) { _, value in
                            if value.count > NativeCustomConnectorDraft.nameLimit {
                                draftName = String(value.prefix(NativeCustomConnectorDraft.nameLimit))
                            }
                        }
                        .help("Rename this server")
                        .accessibilityLabel("Name")
                        .accessibilityIdentifier("connections.manage-server.name")
                    Text(connector.host)
                        .junoType(.monoSmall)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
            }
            if let description = connector.description, !description.isEmpty {
                Text(description)
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(JunoSpace.section)
        .padding(.bottom, -JunoSpace.hairline)
    }

    private func commitName() {
        let value = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let current = editor.connector?.name else { return }
        guard !value.isEmpty else {
            draftName = current
            return
        }
        guard value != current else { return }
        Task {
            if let failure = await editor.rename(value) {
                notice = failure
                draftName = editor.connector?.name ?? current
            }
        }
    }

    // MARK: Body

    @ViewBuilder
    private func content(_ connector: NativeCustomConnector) -> some View {
        Group {
            if !connector.connected {
                VStack(alignment: .leading, spacing: JunoSpace.regular) {
                    DesktopNoteBand(icon: .info) {
                        Text("Juno isn’t signed in to this server, so its tools aren’t available.")
                    } action: {
                        Button {
                            signIn(connector.id)
                        } label: {
                            Label {
                                Text("Sign In")
                            } icon: {
                                JunoIconView(.key, size: 13)
                            }
                        }
                        .buttonStyle(.junoProminent)
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("connections.manage-server.sign-in")
                    }
                }
                .padding(JunoSpace.section)
                .transition(.opacity)
            } else {
                tools(connector)
                    .transition(.opacity)
            }
        }
    }

    private func tools(_ connector: NativeCustomConnector) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: JunoSpace.snug) {
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    Text("Tools")
                        .junoType(JunoType.ui.weight(.semibold))
                        .foregroundStyle(Color.junoForeground)
                        .accessibilityAddTraits(.isHeader)
                    Text(toolsLine(connector))
                        .junoType(.caption)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                        .contentTransition(.numericText())
                }
                Spacer(minLength: 0)
                if editor.isRefreshing {
                    // The glyph gives way to the system's spinner while the
                    // server answers, at the button's own 28pt.
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 28, height: 28)
                        .transition(.opacity)
                } else {
                    DesktopQuietIconButton(icon: .refresh, label: "Refresh tools", help: "Ask the server for its tools again") {
                        Task {
                            if let failure = await editor.refreshTools(), editor.connector?.tools != nil {
                                notice = failure
                            }
                        }
                    }
                    .transition(.opacity)
                    .accessibilityIdentifier("connections.manage-server.refresh")
                }
            }
            .padding(.horizontal, JunoSpace.section)
            .padding(.top, JunoSpace.regular)
            .padding(.bottom, JunoSpace.cozy)

            ScrollView {
                toolList(connector)
                    .padding(.horizontal, JunoSpace.section)
                    .padding(.bottom, JunoSpace.regular)
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: DesktopServerSheetMetrics.toolListMaximumHeight)
            .fixedSize(horizontal: false, vertical: true)

            if let notice {
                DesktopNoteBand(icon: .error, tone: Color.junoDestructiveInk) { Text(notice) }
                    .padding(.horizontal, JunoSpace.section)
                    .padding(.bottom, JunoSpace.regular)
                    .transition(.junoInline)
            }
        }
    }

    private func toolsLine(_ connector: NativeCustomConnector) -> String {
        guard let tools = connector.tools else {
            return editor.isRefreshing ? "Asking the server…" : "Not listed yet"
        }
        return "\(connector.enabledCount) of \(tools.count) on"
    }

    @ViewBuilder
    private func toolList(_ connector: NativeCustomConnector) -> some View {
        if connector.tools == nil {
            if let error = editor.toolsError, !editor.isRefreshing {
                DesktopNoteBand(icon: .error, tone: Color.junoDestructiveInk) { Text(error) }
            } else {
                VStack(spacing: JunoSpace.snug) {
                    ForEach(0..<3, id: \.self) { _ in
                        JunoSkeleton(height: 44, cornerRadius: JunoRadius.field)
                    }
                }
                .accessibilityHidden(true)
            }
        } else if connector.tools?.isEmpty == true {
            Text("This server offers no tools.")
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(maxWidth: .infinity)
                .padding(.vertical, JunoSpace.section)
        } else {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                toolGroup(
                    "Reads", note: "Juno uses these as needed.", connector.reads, connector: connector, offset: 0
                )
                toolGroup(
                    "Changes things", note: "Juno asks you in the chat before each use.", connector.changes,
                    connector: connector, offset: connector.reads.count
                )
            }
            .onAppear {
                // After this frame's rows have taken their first reveal.
                Task { @MainActor in dealtTools = true }
            }
        }
    }

    @ViewBuilder
    private func toolGroup(
        _ title: String,
        note: String,
        _ tools: [NativeCustomConnectorTool],
        connector: NativeCustomConnector,
        offset: Int
    ) -> some View {
        if !tools.isEmpty {
            let allOn = tools.allSatisfy(connector.isEnabled)
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    VStack(alignment: .leading, spacing: JunoSpace.micro) {
                        Text(title)
                            .junoType(JunoType.caption.weight(.semibold))
                            .foregroundStyle(Color.junoForeground)
                            .accessibilityAddTraits(.isHeader)
                        Text(note)
                            .junoType(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                    Spacer(minLength: 0)
                    Button(allOn ? "Turn All Off" : "Turn All On") {
                        setTools(tools.map(\.name), enabled: !allOn)
                    }
                    .buttonStyle(DesktopUnderlineLinkStyle(ink: Color.junoSecondaryInk))
                    .accessibilityLabel("\(allOn ? "Turn off" : "Turn on") every tool in \(title)")
                }
                DesktopListCard {
                    ForEach(Array(tools.enumerated()), id: \.element.id) { index, tool in
                        if index > 0 { DesktopRowDivider() }
                        toolRow(tool, on: connector.isEnabled(tool))
                            .modifier(DesktopServerArrival(index: index + offset, active: !dealtTools))
                    }
                }
            }
        }
    }

    private func toolRow(_ tool: NativeCustomConnectorTool, on: Bool) -> some View {
        HStack(alignment: .center, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Group {
                    if tool.title?.isEmpty == false {
                        Text(tool.displayName).junoType(.ui)
                    } else {
                        Text(tool.name).junoType(.mono)
                    }
                }
                .foregroundStyle(Color.junoForeground)
                .lineLimit(1)
                .truncationMode(.tail)
                if let description = tool.description, !description.isEmpty {
                    Text(description)
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // A tool that is off steps back rather than disappearing.
            .opacity(on ? 1 : 0.55)
            .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: on)
            Toggle(
                "Let Juno use \(tool.displayName)",
                isOn: Binding(get: { on }, set: { setTools([tool.name], enabled: $0) })
            )
            .labelsHidden()
            .toggleStyle(.switch)
            .controlSize(.small)
            .tint(Color.junoAccent)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .accessibilityElement(children: .combine)
    }

    private func setTools(_ names: [String], enabled: Bool) {
        Task {
            if let failure = await editor.setTools(names, enabled: enabled) { notice = failure }
        }
    }

    // MARK: Footer

    private func footer(_ connector: NativeCustomConnector) -> some View {
        ZStack {
            if confirmingRemove {
                HStack(spacing: JunoSpace.cozy) {
                    Text("Remove it and sign out?")
                        .junoType(.ui)
                        .foregroundStyle(Color.junoForeground)
                    Spacer(minLength: 0)
                    Button("Keep") { confirmingRemove = false }
                        .buttonStyle(.bordered)
                        .tint(nil)
                        .keyboardShortcut(.cancelAction)
                        .disabled(editor.isRemoving)
                    DesktopOutlineButton(title: editor.isRemoving ? "Removing…" : "Remove", destructive: true) {
                        Task {
                            if let failure = await editor.remove() {
                                notice = failure
                                confirmingRemove = false
                            } else {
                                close()
                            }
                        }
                    }
                    .disabled(editor.isRemoving)
                    .accessibilityIdentifier("connections.manage-server.remove-confirm")
                }
                .transition(.junoOverlay)
            } else {
                HStack(spacing: JunoSpace.cozy) {
                    DesktopOutlineButton(title: "Remove Server", icon: .trash, destructive: true) {
                        confirmingRemove = true
                    }
                    .accessibilityIdentifier("connections.manage-server.remove")
                    if connector.connected {
                        DesktopOutlineButton(title: editor.isSigningOut ? "Signing Out…" : "Sign Out", icon: .logOut) {
                            Task {
                                if let failure = await editor.signOut() { notice = failure }
                            }
                        }
                        .disabled(editor.isSigningOut)
                        .help("Juno forgets its sign-in. The server and your tool choices stay.")
                        .accessibilityIdentifier("connections.manage-server.sign-out")
                    }
                    Spacer(minLength: 0)
                    Button("Done", action: close)
                        .buttonStyle(.bordered)
                        .tint(nil)
                        .keyboardShortcut(connector.connected ? .defaultAction : .cancelAction)
                }
                .transition(.junoOverlay)
            }
        }
        .padding(.horizontal, JunoSpace.section)
        .padding(.vertical, JunoSpace.regular)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: confirmingRemove)
    }
}

// MARK: - Parts

private enum DesktopServerSheetMetrics {
    static let addWidth: CGFloat = 480
    static let manageWidth: CGFloat = 520
    /// About eight tool rows before the list scrolls: the sheet stays a sheet
    /// on a server that offers forty tools.
    static let toolListMaximumHeight: CGFloat = 420
}

/// A sheet's title and the sentence under it — the skill sheets' pair.
private struct DesktopServerSheetTitle: View {
    let title: String
    let lede: String

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(title)
                .junoType(.heading)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            Text(lede)
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A custom server's mark: its monogram on the connector well, in place of a
/// brand mark it does not have. The letter follows the name as it is edited.
struct DesktopServerMonogramWell: View {
    let name: String
    /// Lands with a small settle — the one moment in the add flow that is
    /// about the server rather than the form.
    var settles = false
    var side: CGFloat = 40

    @State private var settled = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Text(NativeCustomConnectorPath.monogram(name))
            .font(.system(size: side * 0.42, weight: .semibold, design: .rounded))
            .foregroundStyle(Color.junoForeground)
            .contentTransition(.opacity)
            .frame(width: side, height: side)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .fill(Color.junoCanvasWarm)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .strokeBorder(Color.junoBorder)
            )
            .scaleEffect(settles && !settled ? JunoMotion.scaleFrom(0.85, reduceMotion: reduceMotion) : 1)
            .opacity(settles && !settled ? 0 : 1)
            .onAppear {
                guard settles else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion)) { settled = true }
            }
            .accessibilityHidden(true)
    }
}

/// A row's first reveal: a fade and a 6pt rise, 30ms apart for the first
/// eight and the rest with the eighth; nothing when `active` is false (a row
/// added by a refresh arrives as it is), and no stagger under Reduce Motion.
private struct DesktopServerArrival: ViewModifier {
    let index: Int
    let active: Bool
    @State private var arrived = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .opacity(arrived || !active ? 1 : 0)
            .offset(y: arrived || !active ? 0 : JunoMotion.shift(JunoMotion.riseDistance, reduceMotion: reduceMotion))
            .onAppear {
                guard active, !arrived else { return }
                let delay = reduceMotion ? 0 : Double(min(index, 8)) * 0.03
                withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion)?.delay(delay)) {
                    arrived = true
                }
            }
    }
}

/// "Add an MCP server": a tile-sized door at the end of Available. Dashed at
/// rest — a place for something, not a thing — and the one tile on the page
/// that is itself a target, so it alone answers the pointer: the hairline
/// firms up, the well lifts a step and the plus turns a quarter.
struct DesktopAddServerTile: View {
    let minimumHeight: CGFloat
    let action: () -> Void

    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                JunoIconView(.plus, size: 18)
                    .foregroundStyle(isHovering ? Color.junoForeground : Color.junoSecondaryInk)
                    .rotationEffect(.degrees(isHovering && !reduceMotion ? 90 : 0))
                    .frame(width: 40, height: 40)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                            .fill(Color.junoCanvasWarm)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                            .strokeBorder(Color.junoBorder)
                    )
                    .offset(y: isHovering ? -JunoMotion.shift(2, reduceMotion: reduceMotion) : 0)
                Spacer(minLength: 0)
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    Text("Add an MCP server")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(Color.junoForeground)
                    Text("Bring your own tools: any MCP server that signs in with OAuth.")
                        .junoCaption()
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(JunoSpace.regular)
            .frame(maxWidth: .infinity, minHeight: minimumHeight, alignment: .topLeading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(isHovering ? Color.junoHover : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(
                        isHovering ? Color.junoForeground.opacity(0.25) : Color.junoBorder,
                        style: StrokeStyle(lineWidth: 1, dash: isHovering ? [] : [5, 4])
                    )
            )
            .contentShape(.rect(cornerRadius: JunoRadius.card))
        }
        .buttonStyle(.junoPress)
        .onHover { hovering in
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
                isHovering = hovering
            }
        }
        .help("Add a remote MCP server by its address")
        .accessibilityLabel("Add an MCP server")
        .accessibilityIdentifier("connections.add-server-tile")
    }
}
