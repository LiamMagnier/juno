import JunoChatKit
#if DEBUG
import JunoPreviewSupport
#endif
import JunoDesignSystem
import SwiftUI

/// The composer's `+` and the menu it opens.
///
/// **The website's menu, section for section.** What this replaces was a flat
/// run of four attachment rows and a project submenu — the *sources* half of the
/// web's menu with the *tools* half missing entirely. Deep research was fully
/// plumbed through `NativeChatGenerationRequest` and had no switch anywhere in
/// the app; web search, canvas, memory and per-chat connectors had neither. The
/// shape here is now the web's:
///
/// - **Add** — Camera, Photos, Files, From your library.
/// - **Create a canvas**, and the conversation's project.
/// - **Tools** — Deep research, Web search, Canvas & artifacts, Memory, and the
///   apps this chat may act through.
///
/// **No Intelligence row.** It was a `Toggle` that wrote the *same*
/// `reasoningEffort` the Thinking chip beside the `+` already owns — two controls
/// for one value, one of them a brain glyph in a list of attachment sources. The
/// chip states the actual level rather than an on/off, so it strictly dominates;
/// the row and the `JunoComposerIntelligence` rules behind it are gone.
///
/// **A real `Menu`, not a card.** What that in turn replaced was a hand-built
/// panel inside a clear `fullScreenCover`: our own rounded rectangle, our own
/// blur, our own row highlighting, our own unfold spring — and, because a cover
/// is a presentation, the keyboard went away every time it opened. A `Menu` is
/// the system component for exactly this: it anchors itself to the button, it
/// opens over the keyboard without dismissing it, it cannot be clipped by the
/// composer or the scroll view above it, and from OS 26 it arrives in the
/// platform's own Liquid Glass. Every pixel of its chrome is Apple's — including
/// the section rules, which is why the three groups here cost no drawing code.
///
/// The one thing the system is *told* rather than left to decide is the running
/// order: `.menuOrder(.fixed)` reads the rows top-to-bottom as they are written
/// here. Left on `.automatic`, a menu anchored to a control this close to the
/// bottom of the screen orders itself from the anchor outwards, which puts
/// Camera last and Tools first.
struct JunoMobileComposerActions: View {
    let projects: [NativeProject]
    let selectedProjectID: String?
    /// False in a draft: there is no conversation to file into a project yet.
    var canPickProject: Bool = true
    /// False once the message is holding the maximum number of attachments.
    var canAttach: Bool = true
    /// Whether the reader can reach the app's connected apps from here.
    var canOpenPlugins: Bool = true
    /// The composer's glass namespace, so the `+` morphs with its siblings.
    var glassNamespace: Namespace.ID? = nil
    /// The per-message tools. See ``JunoMobileComposerTools`` for why three of
    /// these are sticky and one is not.
    @Bindable var tools: JunoMobileComposerTools
    /// Whether the selected model can search the web at all. The server refuses
    /// the flag on a model without the capability, so the row says so rather
    /// than offering a switch that silently does nothing.
    var modelSupportsWebSearch: Bool = true
    /// Account-level, unlike everything else in Tools — this is the same switch
    /// as Settings › Memory, surfaced where the web surfaces it.
    var memoryEnabled: Bool = true
    /// `@MainActor @Sendable` because it is called from inside a `Binding`'s
    /// setter, whose accessors are `@Sendable` in the iOS 26 SDK — a plain
    /// closure there "may introduce data races" under Swift 6. The toggle is
    /// driven on the main actor, so stating that is accurate rather than a
    /// widening.
    var setMemoryEnabled: (@MainActor @Sendable (Bool) -> Void)?
    /// The account's connected apps, already filtered to the connected ones.
    var connectors: [NativeConnector] = []
    let setProject: (String?) async -> Void
    /// Opens one attachment surface. Focus and presentation are the composer's
    /// to arrange — this view only says which one was chosen.
    let open: (JunoAttachmentSurface) -> Void
    /// Opens the library picker, which stages files the account already shared.
    var openLibrary: (() -> Void)?
    /// Seeds the draft with an artifact request, as the web's `startCanvas` does.
    var startCanvas: (() -> Void)?
    let openPlugins: () -> Void
    /// Opens Orbit — the agents. Nil hides the row.
    var openOrbit: (() -> Void)? = nil
    /// The selected model's name, for the menu's Model row.
    var modelName: String = ""
    /// Opens the model picker. Nil hides the row (the voice menu has none).
    var chooseModel: (() -> Void)? = nil
    /// The selected model's thinking ladder, for the Flash and Pro switches.
    var thinkingScale: NativeThinkingScale? = nil

    @State private var presented = false
    @State private var pickHaptic = JunoMobileHapticTrigger()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // The ChatGPT "+": a Liquid Glass popover that grows up out of the
        // button — the system popover, which on OS 26 *is* glass and morphs
        // out of its source, kept compact on the phone rather than adapting
        // into a sheet. Attach first (Camera, Photos, Files — the rows the
        // thumb wants most), then the tools a turn can use, then what the turn
        // runs on. Camera and Photos close it and open the composer's inline
        // surfaces in its place, over the keyboard, rather than pushing a sheet.
        Button {
            presented = true
        } label: {
            plus
        }
        .buttonStyle(.junoQuietPress)
        .popover(isPresented: $presented, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
            panel
                .presentationCompactAdaptation(.popover)
        }
        .junoHaptic(JunoMobileHaptic.selection, trigger: pickHaptic)
        .accessibilityLabel(
            tools.isArmed ? Text("attachments.add.armed") : Text("attachments.add")
        )
        .accessibilityIdentifier("juno.mobile.chat-plus")
        .task { await applyPreviewFlags() }
        .contentShape(.rect)
    }

    /// The popover's rows. Plain rows — glyph, label, a check when a tool is
    /// on — at ChatGPT's size, with the rarer choices one level down in a
    /// native menu so the first screen stays short.
    private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            row("attachments.camera", icon: .camera, enabled: canAttach) { open(.camera) }
            row("attachments.photos", icon: .photos, enabled: canAttach) { open(.photos) }
            row("attachments.files", icon: .attach, enabled: canAttach) { open(.files) }
            if let openLibrary {
                row("attachments.library", icon: .library, enabled: canAttach, action: openLibrary)
            }

            divider

            row("composer.deep-research", icon: .research, checked: tools.deepResearch) {
                tools.deepResearch.toggle()
            }
            if modelSupportsWebSearch {
                row("composer.web-search", icon: .web, checked: tools.webSearch) {
                    tools.webSearch.toggle()
                }
            }
            if connectors.isEmpty {
                row("Apps", icon: .connections, enabled: canOpenPlugins, action: openPlugins)
            } else {
                menuRow(connectorLabel, icon: .connections) { connectorRows }
            }
            if let openOrbit {
                row("Orbit", icon: .agents, action: openOrbit)
            }

            divider

            if let chooseModel {
                row("Model", icon: .models, detail: JunoMobileModelControl.shortName(modelName), action: chooseModel)
                    .accessibilityIdentifier("juno.mobile.composer-model")
            }
            menuRow(String(localized: "More"), icon: .ellipsis) { moreRows }
                .accessibilityIdentifier("juno.mobile.composer-tools")
        }
        .padding(.vertical, 8)
        .frame(width: 272)
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.junoHairline)
            .frame(height: 1)
            .padding(.horizontal, 20)
            .padding(.vertical, 6)
            .accessibilityHidden(true)
    }

    private func row(
        _ title: LocalizedStringKey,
        icon: JunoIcon,
        detail: String? = nil,
        checked: Bool? = nil,
        enabled: Bool = true,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            pickHaptic.fire()
            // A toggle stays open so a second tool can be armed; anything
            // that goes somewhere closes the popover first.
            if checked == nil { presented = false }
            action()
        } label: {
            HStack(spacing: 14) {
                // Each glyph on a small round ground, as ChatGPT's "+" rows
                // are drawn — the glass popover's one texture.
                JunoIconView(icon, size: 17)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Color.junoMuted))
                Text(title)
                    .junoFont(size: 17, relativeTo: .body)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let detail, !detail.isEmpty {
                    Text(verbatim: detail)
                        .junoFont(size: 15, relativeTo: .subheadline)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                }
                if checked == true {
                    JunoIconView(.check, size: 14)
                        .foregroundStyle(Color.junoAccent)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .foregroundStyle(Color.junoForeground)
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity, minHeight: 50, alignment: .leading)
            .contentShape(Rectangle())
            .animation(JunoMotion.reduced(JunoMotion.chatControl, when: reduceMotion, tier: .tint), value: checked)
        }
        .buttonStyle(.junoQuietPress)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .accessibilityAddTraits(checked == true ? .isSelected : [])
    }

    private func menuRow<Content: View>(
        _ title: String,
        icon: JunoIcon,
        @ViewBuilder content: () -> Content
    ) -> some View {
        Menu {
            content()
        } label: {
            HStack(spacing: 14) {
                // Each glyph on a small round ground, as ChatGPT's "+" rows
                // are drawn — the glass popover's one texture.
                JunoIconView(icon, size: 17)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Color.junoMuted))
                Text(verbatim: title)
                    .junoFont(size: 17, relativeTo: .body)
                    .lineLimit(1)
                Spacer(minLength: 8)
                JunoIconView(.chevronRight, size: 12)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            .foregroundStyle(Color.junoForeground)
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity, minHeight: 50, alignment: .leading)
            .contentShape(Rectangle())
        }
        .menuOrder(.fixed)
        .tint(Color.primary)
    }

    @ViewBuilder
    private var connectorRows: some View {
        ForEach(connectors) { connector in
            let on = tools.isConnectorEnabled(connector.id)
            Toggle(
                isOn: Binding(get: { on }, set: { _ in tools.toggleConnector(connector.id) })
            ) {
                Text(connector.label)
            }
            .disabled(!on && !tools.canAddConnector)
        }
        Divider()
        Button {
            presented = false
            openPlugins()
        } label: {
            Label("composer.manage-connections", image: JunoIcon.connections.assetName(.regular))
                .contentShape(.rect)
        }
        .disabled(!canOpenPlugins)
    }

    /// Flash and Pro (where the model has them), the project, and the standing
    /// preferences — on by default and rarely touched.
    @ViewBuilder
    private var moreRows: some View {
        if thinkingScale?.fastModeRateMultiplier != nil {
            Toggle(isOn: $tools.fastMode) { Label("Flash", image: JunoIcon.work.assetName(.regular)) }
        }
        if thinkingScale?.supportsProMode == true {
            Toggle(isOn: $tools.proMode) { Label("Pro", image: JunoIcon.sparkles.assetName(.regular)) }
        }
        if canPickProject {
            projectMenu
        }
        if let startCanvas {
            Button {
                presented = false
                startCanvas()
            } label: {
                Label("composer.create-canvas", image: JunoIcon.copy.assetName(.regular))
                    .contentShape(.rect)
            }
        }
        Toggle(isOn: $tools.canvas) {
            Label("composer.canvas", image: JunoIcon.copy.assetName(.regular))
        }
        if !modelSupportsWebSearch {
            Label("composer.web-search.unsupported", image: JunoIcon.web.assetName(.regular))
        }
        if let setMemoryEnabled {
            Toggle(
                isOn: Binding(get: { memoryEnabled }, set: { setMemoryEnabled($0) })
            ) {
                JunoIconLabel("composer.memory", icon: .memory)
            }
        }
    }

    private var toolsMenu: some View {
        Menu {
            toolsRows
        } label: {
            JunoIconLabel(verbatim: toolsLabel, icon: .sliders)
        }
        .accessibilityIdentifier("juno.mobile.composer-tools")
        .contentShape(.rect)
    }

    /// "Tools" alone, or "Tools · 3". Counted the web's way — rows that are
    /// **on**, not rows that exist — and each term repeats its own row's gate, so
    /// a row that is not rendered cannot be counted.
    private var toolsLabel: String {
        let noun = String(localized: "composer.tools")
        let active = (tools.deepResearch ? 1 : 0)
            + (modelSupportsWebSearch && tools.webSearch ? 1 : 0)
            + (tools.canvas ? 1 : 0)
            + (setMemoryEnabled != nil && memoryEnabled ? 1 : 0)
            + (tools.connectors.isEmpty ? 0 : 1)
        return active == 0 ? noun : "\(noun) · \(active)"
    }

    /// The rows inside it.
    ///
    /// `Toggle` rather than a `Button` with a hand-drawn checkmark: inside a
    /// menu the system renders a toggle as a row that carries its own on-state,
    /// announces itself to VoiceOver as a switch, and keeps the menu open when
    /// it is flipped — which is what lets someone arm research and turn web
    /// search off in one visit instead of four taps and three re-opens.
    @ViewBuilder
    private var toolsRows: some View {
        Toggle(isOn: $tools.deepResearch) {
            JunoIconLabel("composer.deep-research", icon: .research)
        }

        if modelSupportsWebSearch {
            Toggle(isOn: $tools.webSearch) {
                JunoIconLabel("composer.web-search", icon: .web)
            }
        } else {
            // Not a disabled toggle: a switch that cannot move still looks like
            // a setting, and the reason it cannot move is the useful part.
            JunoIconLabel("composer.web-search.unsupported", icon: .web)
                .foregroundStyle(.secondary)
        }

        Toggle(isOn: $tools.canvas) {
            JunoIconLabel("composer.canvas", icon: .artifactsTool)
        }

        if let setMemoryEnabled {
            Toggle(
                // Called through a closure literal rather than passed as the
                // setter itself, and this is the whole of the iOS CI crash.
                //
                // `Binding.init(set:)` takes an `@isolated(any) @Sendable
                // (Value) -> Void`, and `Value` is generic, so it is lowered to
                // `@in_guaranteed`. Handing it an already-`@MainActor` function
                // *value* therefore needs a thunk that both erases the isolation
                // and boxes the `Bool` — `$sSbScA_pSgIeAghyg_SbIeAghn_TR`, the
                // symbol every one of these crash reports names. A closure
                // literal is `@_inheritActorContext`, so it carries the main
                // actor natively and no such thunk is emitted at all.
                //
                // Verified by symbol, not by hope: that thunk is present in the
                // app's object files with `set: setMemoryEnabled` and absent
                // with the literal.
                isOn: Binding(get: { memoryEnabled }, set: { setMemoryEnabled($0) })
            ) {
                JunoIconLabel("composer.memory", icon: .memory)
            }
        }

        connectorMenu
    }

    /// The apps this one chat may act through.
    ///
    /// A nested menu, and a *capped* one: five, the web's `MAX_CHAT_CONNECTORS`.
    /// Past the cap the unselected rows go disabled rather than disappearing, so
    /// the limit is visible as a limit instead of as a list that stopped
    /// responding.
    @ViewBuilder
    private var connectorMenu: some View {
        if connectors.isEmpty {
            Button(action: openPlugins) {
                JunoIconLabel("composer.connect-an-app", icon: .connections)
            }
            .disabled(!canOpenPlugins)
            .contentShape(.rect)
        } else {
            Menu {
                ForEach(connectors) { connector in
                    let on = tools.isConnectorEnabled(connector.id)
                    Toggle(
                        isOn: Binding(
                            get: { on },
                            set: { _ in tools.toggleConnector(connector.id) }
                        )
                    ) {
                        // The service's real mark, as the web's rows carry. A
                        // list of bare names is the one place someone has to
                        // *read* to find Gmail, when they already know what its
                        // logo looks like — and ``JunoConnectorMark`` exists
                        // precisely because generic glyphs standing in for
                        // brands is a tell.
                        Label {
                            Text(connector.label)
                        } icon: {
                            JunoConnectorMark(
                                connectorID: connector.id,
                                connectorName: connector.label,
                                logoURL: connector.logoURL,
                                size: 16
                            )
                        }
                    }
                    .disabled(!on && !tools.canAddConnector)
                }
                Divider()
                Button(action: openPlugins) {
                    // A plug, not a gear. Managing connections is a product
                    // destination and the web draws it with the same mark as
                    // the submenu it sits in; a third glyph for one concept was
                    // the reader's problem, not a distinction.
                    JunoIconLabel("composer.manage-connections", icon: .connections)
                }
                .disabled(!canOpenPlugins)
            } label: {
                JunoIconLabel(verbatim: connectorLabel, icon: .connections)
            }
            .accessibilityIdentifier("juno.mobile.composer-connectors")
            .contentShape(.rect)
        }
    }

    /// Composed rather than pluralised: "Connectors · 2" needs one translatable
    /// noun and a number, where "2 apps on" needs a plural rule per language for
    /// a count that is capped at five.
    private var connectorLabel: String {
        let noun = String(localized: "composer.connectors")
        return tools.connectors.isEmpty ? noun : "\(noun) · \(tools.connectors.count)"
    }

    /// The button itself: a 34pt glass circle inside a 40×44 hit rectangle, with
    /// one addition — a coral dot when something the reader would be surprised by
    /// is armed for the next message.
    ///
    /// The web draws the same dot for research, and the rule for what earns one
    /// is the interesting half: **not** "any tool is on". Web search and canvas
    /// default to on, so a dot for those would be lit permanently and would mean
    /// nothing. It marks a turn that is about to cost real time and money, or one
    /// that can reach outside Juno. See ``JunoMobileComposerTools/isArmed``.
    ///
    /// `contentShape` is load-bearing. Without it SwiftUI hit-tests the *drawn*
    /// content, so the touch target collapses to the plus glyph — 13.3pt on a
    /// control that looks 32pt.
    /// A bare "+", as ChatGPT draws it: the card's glass is the only glass.
    private var plus: some View {
        JunoIconView(.plus, size: 21)
            .foregroundStyle(Color.primary)
            .frame(width: 44, height: 44)
            .modifier(JunoMobileOptionalGlassID(id: "composer.plus", namespace: nil))
            .contentShape(Rectangle())
    }

    private var projectMenu: some View {
        Menu {
            // Buttons rather than a `Picker`: a picker in a menu infers its tag
            // type from the content, and an optional id makes that inference
            // ambiguous. The selected row uses the same trailing-check
            // convention as a system menu, rendered with Juno's icon asset.
            menuItem(id: nil, name: String(localized: "attachments.no-project"))
            ForEach(projects) { project in
                menuItem(id: project.id, name: project.name)
            }
        } label: {
            JunoIconLabel(verbatim: selectedProjectName, icon: .projects)
        }
        .accessibilityIdentifier("juno.mobile.composer-project")
        .contentShape(.rect)
    }

    /// The selected row keeps the checkmark and the rest carry the project mark,
    /// so the leading column is never empty. The web draws a folder on every row
    /// and puts its tick on the trailing edge; a system menu owns that slot and
    /// only draws one image per row, so the tick wins where there is a choice —
    /// which is the right way round, since it is the only thing here that
    /// changes.
    private func menuItem(id: String?, name: String) -> some View {
        Button {
            Task { await setProject(id) }
        } label: {
            if selectedProjectID == id {
                JunoIconLabel(verbatim: name, icon: .check)
            } else {
                JunoIconLabel(verbatim: name, icon: .projects)
            }
        }
        .contentShape(.rect)
    }

    private var selectedProjectName: String {
        guard let selectedProjectID,
            let project = projects.first(where: { $0.id == selectedProjectID })
        else { return String(localized: "attachments.project") }
        return project.name
    }

    /// Drives the menu's surfaces straight from a launch argument, so a
    /// screenshot of "the camera panel, dark, XXL" is one relaunch rather than a
    /// scripted tap sequence. No effect — and no code — outside DEBUG.
    private func applyPreviewFlags() async {
        #if DEBUG
        if JunoComposerPreviewFlags.opensPlus {
            try? await Task.sleep(for: .milliseconds(600))
            presented = true
            return
        }
        guard let raw = JunoComposerPreviewFlags.opensPicker,
            let surface = JunoAttachmentSurface(rawValue: raw)
        else { return }
        try? await Task.sleep(for: .milliseconds(400))
        open(surface)
        #endif
    }
}


/// `junoGlassID` when a namespace was handed down, and nothing when not.
struct JunoMobileOptionalGlassID: ViewModifier {
    let id: String
    let namespace: Namespace.ID?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let namespace {
            content.junoGlassID(id, in: namespace)
        } else {
            content
        }
    }
}
