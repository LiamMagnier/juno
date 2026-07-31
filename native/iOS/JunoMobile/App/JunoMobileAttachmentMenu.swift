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

    var body: some View {
        Menu {
            Section("attachments.add") {
                Button {
                    open(.camera)
                } label: {
                    Label("attachments.camera", systemImage: "camera")
                }
                .disabled(!canAttach)

                Button {
                    open(.photos)
                } label: {
                    Label("attachments.photos", systemImage: "photo")
                }
                .disabled(!canAttach)

                Button {
                    open(.files)
                } label: {
                    Label("attachments.files", systemImage: "paperclip")
                }
                .disabled(!canAttach)

                if let openLibrary {
                    Button(action: openLibrary) {
                        Label("attachments.library", systemImage: "books.vertical")
                    }
                    .disabled(!canAttach)
                }
            }

            Section {
                if let startCanvas {
                    Button(action: startCanvas) {
                        Label("composer.create-canvas", systemImage: "square.and.pencil")
                    }
                }
                if canPickProject {
                    projectMenu
                }
                toolsMenu
            }
        } label: {
            plus
        }
        // Top-to-bottom in source order — see the note on the type.
        .menuOrder(.fixed)
        // A `Menu` tints its whole label with the accent, which turned the "+"
        // coral the moment it stopped being a plain Button — and the composer's
        // other controls are ink. The foreground style inside the label cannot
        // override that on its own; the tint has to be set on the menu.
        .tint(Color.primary)
        // Opening the menu must not steal the composer's focus; `.automatic`
        // would let a chosen row dismiss the menu *and* the keyboard together,
        // which is the jump this feature exists to remove.
        .menuActionDismissBehavior(.automatic)
        .accessibilityLabel(
            tools.isArmed ? Text("attachments.add.armed") : Text("attachments.add")
        )
        .accessibilityIdentifier("juno.mobile.chat-plus")
        .task { await applyPreviewFlags() }
    }

    /// **Tools**, as a nested menu beside Project rather than as a run of rows.
    ///
    /// Same reasoning as the project list: the menu's length stops being a
    /// function of how many switches Juno has. Flat, Tools was five rows plus a
    /// nested Connectors — enough that on an iPhone the whole menu scrolled and
    /// Camera, the most-used row in it, was the one that fell off the end. As a
    /// submenu the top level stays four sources and three destinations, and the
    /// switches are one tap deeper for the people who actually change them.
    ///
    /// The label carries the count of what is **on**, which is the only thing
    /// visible at the top level saying that e.g. research is armed — the same
    /// job the web's collapsed `Tools` row does with its trailing number.
    private var toolsMenu: some View {
        Menu {
            toolsRows
        } label: {
            Label(toolsLabel, systemImage: "slider.horizontal.3")
        }
        .accessibilityIdentifier("juno.mobile.composer-tools")
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
            Label("composer.deep-research", systemImage: "binoculars")
        }

        if modelSupportsWebSearch {
            Toggle(isOn: $tools.webSearch) {
                Label("composer.web-search", systemImage: "globe")
            }
        } else {
            // Not a disabled toggle: a switch that cannot move still looks like
            // a setting, and the reason it cannot move is the useful part.
            Label("composer.web-search.unsupported", systemImage: "globe")
                .foregroundStyle(.secondary)
        }

        Toggle(isOn: $tools.canvas) {
            Label("composer.canvas", systemImage: "rectangle.on.rectangle")
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
                Label("composer.memory", systemImage: "brain.head.profile")
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
                Label("composer.connect-an-app", systemImage: "powerplug")
            }
            .disabled(!canOpenPlugins)
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
                        Text(connector.label)
                    }
                    .disabled(!on && !tools.canAddConnector)
                }
                Divider()
                Button(action: openPlugins) {
                    Label("composer.manage-connections", systemImage: "gearshape")
                }
                .disabled(!canOpenPlugins)
            } label: {
                Label(connectorLabel, systemImage: "powerplug")
            }
            .accessibilityIdentifier("juno.mobile.composer-connectors")
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
    private var plus: some View {
        Image(systemName: "plus")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(.primary)
            .frame(width: 34, height: 34)
            .modifier(JunoComposerGlassCircle())
            .overlay(alignment: .topTrailing) {
                if tools.isArmed {
                    Circle()
                        .fill(Color.junoAccent)
                        // The ring is what keeps the dot legible where it sits on
                        // the glass rim rather than on a flat fill.
                        .stroke(Color.junoSurface, lineWidth: 1.5)
                        .frame(width: 8, height: 8)
                        .offset(x: 1, y: -1)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .frame(width: 40, height: 44)
            .contentShape(Rectangle())
            .animation(JunoMotion.fast, value: tools.isArmed)
    }

    /// The conversation's project. A nested `Menu` rather than a run of rows:
    /// listing every project inline made the menu's length a function of how many
    /// projects the account has.
    private var projectMenu: some View {
        Menu {
            // Buttons rather than a `Picker`: a picker in a menu infers its tag
            // type from the content, and an optional id makes that inference
            // ambiguous. The checkmark is drawn by `Label(_:systemImage:)`, as
            // the system's own menus do.
            menuItem(id: nil, name: String(localized: "attachments.no-project"))
            ForEach(projects) { project in
                menuItem(id: project.id, name: project.name)
            }
        } label: {
            Label(selectedProjectName, systemImage: "folder")
        }
        .accessibilityIdentifier("juno.mobile.composer-project")
    }

    private func menuItem(id: String?, name: String) -> some View {
        Button {
            Task { await setProject(id) }
        } label: {
            if selectedProjectID == id {
                Label(name, systemImage: "checkmark")
            } else {
                Text(name)
            }
        }
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
        guard let raw = JunoComposerPreviewFlags.opensPicker,
            let surface = JunoAttachmentSurface(rawValue: raw)
        else { return }
        try? await Task.sleep(for: .milliseconds(400))
        open(surface)
        #endif
    }
}
