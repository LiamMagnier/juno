import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// Juno's ghost, drawn rather than borrowed.
///
/// The website's incognito control is a hand-authored 48×48 SVG, not a stock
/// glyph — a rounded body with a scalloped hem, two pupils that follow the
/// cursor, and a small smile. Substituting SF Symbols' `theatermasks` or an
/// `eye.slash` would have been quicker and would have thrown away the one mark
/// the reader already recognises from the browser.
///
/// The pupils hold still. On the web they follow the cursor, which a phone has no
/// equivalent of — and an idle drift added in its place was just a face twitching
/// at you from the corner of the screen for the whole session. Nothing here moves.
struct JunoGhostMark: View {
    /// Filled when incognito is active, outlined when it is merely offered.
    var active: Bool = false
    var size: CGFloat = 21

    var body: some View {
        // The path is authored in the web's own 48×48 box and scaled, so the two
        // clients cannot drift apart on the silhouette.
        Canvas { context, canvasSize in
            let scale = min(canvasSize.width, canvasSize.height) / 48
            context.scaleBy(x: scale, y: scale)

            let body = Path { path in
                path.move(to: CGPoint(x: 9.5, y: 39))
                path.addLine(to: CGPoint(x: 9.5, y: 21))
                path.addCurve(
                    to: CGPoint(x: 24, y: 6.5),
                    control1: CGPoint(x: 9.5, y: 12),
                    control2: CGPoint(x: 16, y: 6.5)
                )
                path.addCurve(
                    to: CGPoint(x: 38.5, y: 21),
                    control1: CGPoint(x: 32, y: 6.5),
                    control2: CGPoint(x: 38.5, y: 12)
                )
                path.addLine(to: CGPoint(x: 38.5, y: 39))
                // The hem: four scallops, drawn as the web draws them.
                path.addLine(to: CGPoint(x: 35.3, y: 41.6))
                path.addLine(to: CGPoint(x: 31.9, y: 39))
                path.addLine(to: CGPoint(x: 28.5, y: 41.6))
                path.addLine(to: CGPoint(x: 25.4, y: 41.6))
                path.addLine(to: CGPoint(x: 22, y: 38))
                path.addLine(to: CGPoint(x: 18.6, y: 40.6))
                path.addLine(to: CGPoint(x: 15.5, y: 40.6))
                path.addLine(to: CGPoint(x: 12.1, y: 38))
                path.addLine(to: CGPoint(x: 8.7, y: 40.6))
                path.closeSubpath()
            }

            // Outlined, it draws in the surrounding foreground style rather
            // than a fixed `.primary`, so the same mark sits in ink on the
            // page, in light on the incognito page, and on a tinted button.
            let ink: GraphicsContext.Shading = active ? .color(.junoOnAccent) : .foreground
            if active {
                context.fill(body, with: .color(.junoAccent))
            } else {
                context.stroke(body, with: .foreground, lineWidth: 2)
            }

            context.fill(
                Path(ellipseIn: CGRect(x: 16.6, y: 19.6, width: 4.8, height: 4.8)),
                with: ink
            )
            context.fill(
                Path(ellipseIn: CGRect(x: 26.6, y: 19.6, width: 4.8, height: 4.8)),
                with: ink
            )

            let smile = Path { path in
                path.move(to: CGPoint(x: 20.5, y: 30))
                path.addQuadCurve(
                    to: CGPoint(x: 27.5, y: 30),
                    control: CGPoint(x: 24, y: 32.4)
                )
            }
            var mouth = context
            mouth.opacity = 0.7
            mouth.stroke(
                smile,
                with: ink,
                style: StrokeStyle(lineWidth: 2, lineCap: .round)
            )
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// An incognito chat: the transcript, the composer, and no trace of either.
///
/// **It replaces the chat screen in place; it is not presented over it.** A
/// `fullScreenCover` was the first attempt and it was wrong twice over — it
/// animated as a whole new window sliding up, and it stacked a second navigation
/// context on top of the shell's, so the mode read as somewhere you had gone
/// rather than as a change in what the current page *is*. The web does not
/// navigate either: the same chat view stays mounted and its own chrome changes.
///
/// So this is the chat destination's other face. The filled coral ghost in the
/// toolbar, the dashed composer and the greeting are the whole visual difference,
/// and the crossfade between them is short on purpose — a long transition would
/// imply travel.
///
/// There was a tinted banner under the navigation bar as well, and it went: the
/// navigation bar samples what is beneath it, so a coral strip turned the entire
/// top of the screen orange rather than reading as one quiet line.
struct JunoMobileIncognitoChat: View {
    @Bindable var model: NativePrivateChatModel
    var selectableModels: [NativeChatModelOption]
    var initialModelID: String
    var profileName: String?
    /// Leaves the mode. Owned by the shell, which is what holds the flag.
    var onClose: () -> Void
    @State private var prompt = ""
    @State private var selectedModelID = ""
    @State private var reasoningEffort: NativeReasoningEffort?
    // Deliberately NOT cleared by `configureThinking()` when the model changes,
    // matching the web, where `changeModel` re-fits the effort and leaves the
    // mode prefs alone. The toggle hides itself on a model without the mode and
    // the chat route re-checks support, so a carried-over flag is inert rather
    // than wrong — and clearing it would make a sticky preference un-sticky the
    // moment someone browsed the model list.
    @State private var fastMode = false
    @State private var proMode = false
    @State private var showingCloseWarning = false
    @State private var scrollPosition = ScrollPosition(edge: .bottom)
    @FocusState private var composerFocused: Bool

    /// The app's own appearance, read before this screen overrides it for
    /// its children. The ink ground is chosen from it: see ``inkGround``.
    @Environment(\.colorScheme) private var appColorScheme
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        transcript
            .background(inkGround.ignoresSafeArea())
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        // Only warn when there is something to lose.
                        if model.isEmpty { close() } else { showingCloseWarning = true }
                    } label: {
                        JunoIncognitoToggleLabel(active: true, showsTitle: sizeClass == .regular)
                    }
                    // The toggle, on: the system's prominent glass in the
                    // accent. Off, on the draft, it is the same control in
                    // plain glass, so entering and leaving is one button
                    // changing state in place.
                    .junoProminentAction()
                    .accessibilityLabel("End incognito chat")
                    .accessibilityIdentifier("juno.mobile.incognito")
                }
            }
            .safeAreaInset(edge: .bottom) { composer }
            // The ink treatment: this face is always drawn dark, whatever the
            // app is set to. A private chat should look like somewhere else
            // at a glance, and a darker page is the plainest honest way to say
            // it; no banner, no stripes, nothing that moves.
            .environment(\.colorScheme, .dark)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .confirmationDialog(
                "End this incognito chat?",
                isPresented: $showingCloseWarning,
                titleVisibility: .visible
            ) {
                Button("End chat", role: .destructive) { close() }
                .contentShape(.rect)
                Button("Keep chatting", role: .cancel) {}
                .contentShape(.rect)
            } message: {
                Text("It was never saved, so closing it is the only copy gone.")
            }
            .onAppear {
                selectedModelID = initialModelID
                configureThinking()
            }
            .onChange(of: selectedModelID) { _, _ in configureThinking() }
        // NO identifier on this container. An identifier on a container is
        // inherited by every descendant, so stamping the whole mode with
        // `juno.mobile.incognito` shadowed the composer's and the send button's
        // own identifiers and they vanished from the accessibility tree — the same
        // mistake the search screen had. The toolbar ghost carries it instead.
    }

    /// The page an incognito chat is written on: a warm near-black in either
    /// appearance, a step deeper than the dark canvas when the app is already
    /// dark, so the change still reads.
    private var inkGround: Color {
        appColorScheme == .dark ? JunoIncognitoInk.deep : JunoIncognitoInk.ground
    }

    // MARK: - Transcript

    @ViewBuilder
    private var transcript: some View {
        ScrollView {
            if model.turns.isEmpty {
                greeting
                    .frame(maxWidth: .infinity)
                    .containerRelativeFrame(.vertical)
            } else {
                LazyVStack(spacing: JunoSpace.section) {
                    ForEach(model.turns) { turn in
                        JunoMobileIncognitoTurnRow(turn: turn)
                    }
                    if let error = model.lastErrorDescription {
                        JunoInlineError(message: error)
                    }
                }
                .padding(.horizontal, JunoSpace.regular)
                .padding(.vertical, JunoSpace.section)
                .frame(maxWidth: JunoMobileMeasure.reading)
                .frame(maxWidth: .infinity)
            }
        }
        .scrollContentBackground(.hidden)
        .defaultScrollAnchor(.bottom)
        .scrollPosition($scrollPosition)
        // Same correction as the saved transcript: `proxy.scrollTo(id:)` is inert
        // on a bottom-anchored scroll view, so this follow was doing nothing and
        // the anchor's own pinning was quietly carrying the feature.
        .onChange(of: streamSignature) { _, _ in
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                scrollPosition.scrollTo(edge: .bottom)
            }
        }
    }

    private var streamSignature: Int {
        model.turns.count + (model.turns.last?.content.count ?? 0)
    }

    /// The web's incognito greeting, verbatim — the sentence is the promise, and
    /// rewording a privacy claim per platform is how the two stop matching.
    private var greeting: some View {
        VStack(spacing: JunoSpace.regular) {
            JunoGhostMark(active: false, size: 48)
                .foregroundStyle(Color.junoForeground)
                .junoMobileRise(delay: 0.04, distance: 8)
            VStack(spacing: JunoSpace.snug) {
                Text("You're incognito")
                    .font(JunoMobileType.display(sizeClass == .regular ? 44 : 36))
                    .tracking(-0.8)
                    .foregroundStyle(Color.junoForeground)
                    .multilineTextAlignment(.center)
                Text("Chats aren't saved, added to memory, or used to train models.")
                    .junoFont(size: 16, relativeTo: .subheadline)
                    .lineSpacing(3)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            }
            .junoMobileRise(delay: 0.12, distance: 10)
        }
        .padding(.horizontal, JunoSpace.section)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Composer

    /// Deliberately NOT `JunoMobileComposer`. That composer owns attachments,
    /// projects and the plugin menu, and the server's private branch refuses
    /// attachments with a 400 and ignores connectors entirely — so offering them
    /// would be offering controls that cannot work. This is the same shell with
    /// only the controls incognito actually supports.
    private var composer: some View {
        GlassEffectContainer(spacing: JunoSpace.snug) { composerCapsule }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.top, JunoSpace.snug)
            .safeAreaInset(edge: .bottom, spacing: JunoSpace.tight) { notSavedNote }
            .frame(maxWidth: JunoMobileMeasure.reading)
            .frame(maxWidth: .infinity)
    }

    private var composerCapsule: some View {
        VStack(spacing: JunoSpace.snug) {
            TextField("Message Juno privately", text: $prompt, axis: .vertical)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .focused($composerFocused)
                .padding(.horizontal, JunoSpace.snug)
                .padding(.top, JunoSpace.hairline)
                .accessibilityIdentifier("juno.mobile.incognito-composer")

            HStack(spacing: JunoSpace.tight) {
                JunoMobileModelControl(
                    models: selectableModels,
                    selectedModelID: $selectedModelID,
                    fallbackName: junoDisplayModelName(initialModelID)
                )
                .layoutPriority(1)

                if let scale = thinkingScale {
                    JunoMobileThinkingControl(
                        scale: scale,
                        effort: $reasoningEffort,
                        fastMode: $fastMode,
                        proMode: $proMode
                    )
                        .layoutPriority(2)
                }

                Spacer(minLength: 2)

                if model.isStreaming {
                    Button { model.stopGeneration() } label: {
                        JunoIconView(.stop, size: 14)
                            .foregroundStyle(Color.junoOnAccent)
                            .frame(width: 34, height: 34)
                            .modifier(JunoComposerSendBackground(active: true))
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Stop generation")
                } else {
                    Button(action: send) {
                        JunoIconView(.send, size: 15)
                            // Follows the ground: `junoOnAccent` on the coral,
                            // the quiet ink on the untinted glass the inactive
                            // state now wears.
                            .foregroundStyle(
                                sendDisabled ? Color.junoMutedForeground : Color.junoOnAccent
                            )
                            .frame(width: 34, height: 34)
                            .modifier(JunoComposerSendBackground(active: !sendDisabled))
                            .scaleEffect(sendDisabled ? 0.92 : 1)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(sendDisabled)
                    .accessibilityLabel("Send message")
                    .accessibilityIdentifier("juno.mobile.incognito-send")
                }
            }
        }
        .padding(JunoSpace.snug)
        // The glass is the capsule's own effect, inside the container, as the
        // chat composer's is. A glass *background* view in a container is
        // merged with its siblings and drew the field and chips blurred.
        .junoGlass(in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        // Dashed, as the web marks its private composer, but in the ink's own
        // light rather than the accent: on the dark page the shape is enough,
        // and a coral outline read as an error state.
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(
                    Color.junoForeground.opacity(0.26),
                    style: StrokeStyle(lineWidth: 1, dash: [5, 4])
                )
        )
    }

    /// The standing promise, under the composer for as long as the chat
    /// lasts: the greeting says it once and scrolls away with the first turn.
    private var notSavedNote: some View {
        HStack(spacing: 5) {
            Image(systemName: "eye.slash")
                .imageScale(.small)
            Text("Not saved to your history")
        }
        .font(.footnote)
        .foregroundStyle(Color.junoSecondaryInk)
        .frame(maxWidth: .infinity)
        .padding(.bottom, JunoSpace.snug)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.mobile.incognito-note")
    }

    private var sendDisabled: Bool {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isStreaming
    }

    private var thinkingScale: NativeThinkingScale? {
        selectableModels.first { $0.id == selectedModelID }.map(NativeThinkingScale.init)
    }

    private func configureThinking() {
        guard let scale = thinkingScale else {
            reasoningEffort = nil
            return
        }
        reasoningEffort = scale.adjusting(reasoningEffort).effort
    }

    private func send() {
        let text = prompt
        prompt = ""
        model.send(
            prompt: text,
            modelID: selectedModelID.isEmpty ? initialModelID : selectedModelID,
            reasoningEffort: reasoningEffort,
            fastMode: fastMode,
            proMode: proMode
        )
    }

    private func close() {
        model.reset()
        onClose()
    }
}

/// The incognito page's ground. Warm near-blacks from the dark canvas's own
/// hue (30°), so the mode is the same product in a different light rather
/// than a neutral grey stranger.
enum JunoIncognitoInk {
    /// Over a light app: the dark canvas's weight.
    static let ground = Color(hue: 30 / 360, saturation: 0.07, brightness: 0.12)
    /// Over a dark app: a step deeper than the canvas, so the change reads.
    static let deep = Color(hue: 30 / 360, saturation: 0.08, brightness: 0.065)
}

/// The incognito toggle's face: the ghost, and on an iPad its name. The same
/// label in both states; the button style says whether it is on.
struct JunoIncognitoToggleLabel: View {
    var active: Bool
    var showsTitle: Bool

    var body: some View {
        HStack(spacing: 6) {
            JunoGhostMark(active: false, size: 20)
            if showsTitle {
                Text("Incognito")
                    .font(.subheadline.weight(.medium))
            }
        }
        .foregroundStyle(active ? Color.junoOnAccent : Color.primary)
    }
}

/// One incognito turn. Same shapes as the saved transcript so the mode reads as
/// the same product — only the chrome around it says otherwise.
private struct JunoMobileIncognitoTurnRow: View {
    let turn: NativePrivateChatModel.Turn

    @State private var rowWidth: CGFloat = 0

    private static let bubble = UnevenRoundedRectangle(
        topLeadingRadius: JunoRadius.message,
        bottomLeadingRadius: JunoRadius.message,
        bottomTrailingRadius: 6,
        topTrailingRadius: JunoRadius.message,
        style: .continuous
    )

    var body: some View {
        if turn.role == .user {
            HStack(spacing: 0) {
                Spacer(minLength: 0)
                Text(turn.content)
                    .junoFont(size: 15, relativeTo: .subheadline)
                    .lineSpacing(5)
                    .textSelection(.enabled)
                    .padding(.horizontal, JunoSpace.regular)
                    .padding(.vertical, JunoSpace.cozy)
                    .background(Color.junoMuted, in: Self.bubble)
                    .overlay(Self.bubble.strokeBorder(Color.junoHairline, lineWidth: 1))
                    .frame(maxWidth: rowWidth > 0 ? rowWidth * 0.85 : nil, alignment: .trailing)
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { rowWidth = $0 }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("You said, \(turn.content)")
        } else {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                if !turn.content.isEmpty {
                    JunoLessonText(turn.content)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    HStack(spacing: JunoSpace.cozy) {
                        JunoThinkingMatrix()
                            .foregroundStyle(Color.junoMutedForeground)
                        Text("Thinking about your request")
                            .junoFont(size: 17, relativeTo: .body)
                            .foregroundStyle(Color.junoMutedForeground)
                    }
                    .frame(minHeight: 40)
                }
                if let model = turn.model, !model.isEmpty, !turn.content.isEmpty {
                    Text(junoDisplayModelName(model))
                        .junoFont(size: 12, relativeTo: .caption)
                        .foregroundStyle(Color.junoMutedForeground)
                        .padding(.top, JunoSpace.hairline)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Juno replied")
        }
    }
}

#if DEBUG
#Preview("Ghost") {
    HStack(spacing: JunoSpace.section) {
        JunoGhostMark(active: false, size: 28)
        JunoGhostMark(active: true, size: 28)
        JunoGhostMark(active: false, size: 44)
    }
    .padding(JunoSpace.region)
    .background(Color.junoCanvas)
}
#endif
