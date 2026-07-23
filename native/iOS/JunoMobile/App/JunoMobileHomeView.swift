import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// The home screen, replacing the generic "No messages yet" empty state.
///
/// It is the website's home, adapted rather than copied: the same time-of-day
/// greeting in the same editorial serif with the first name in coral italic
/// (`JunoGreeting` ports the exact buckets from `empty-state.tsx`), the composer
/// as the centre of gravity, and prompt modes underneath.
///
/// What it deliberately does *not* have is the web's full-height marketing
/// space. On a phone the greeting and the composer have to share one thumb's
/// reach, so the group sits slightly above centre and rises when the keyboard
/// opens rather than being pushed off-screen.
struct JunoMobileHomeView: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    var profileName: String?
    var recentProjects: [NativeProject] = []
    /// Starts a conversation seeded with `prompt`, or an empty one when nil.
    let start: (String?) -> Void

    @State private var draft = ""
    @FocusState private var composerFocused: Bool
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Fixed for the lifetime of the screen. Re-rolling it on every redraw would
    /// make the greeting flicker between phrases as unrelated state changes.
    @State private var phrase = JunoGreeting.phrase(at: Date())

    var body: some View {
        ScrollView {
            VStack(spacing: JunoSpace.section) {
                Spacer(minLength: JunoSpace.region)
                greeting
                composer
                if !modes.isEmpty { modeRow }
                if !recentProjects.isEmpty { projectRow }
                Spacer(minLength: JunoSpace.region)
            }
            .padding(.horizontal, JunoSpace.roomy)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("navigation.chat")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("juno.mobile.home")
    }

    /// Mark, then "<phrase>, <FirstName>" — the name in coral italic, exactly as
    /// the web sets it. The two rise as separate beats rather than one block.
    private var greeting: some View {
        VStack(spacing: JunoSpace.cozy) {
            JunoMark(size: 34)
                .foregroundStyle(Color.junoAccent)

            Group {
                if let name = JunoGreeting.firstName(from: profileName) {
                    Text(phrase + ", ")
                        .font(JunoSerif.greeting(compact: isCompactType))
                        + Text(name)
                        .font(JunoSerif.greetingName(compact: isCompactType))
                        .foregroundColor(Color.junoAccent)
                } else {
                    Text(phrase)
                        .font(JunoSerif.greeting(compact: isCompactType))
                }
            }
            .multilineTextAlignment(.center)
            .lineLimit(3)
            .minimumScaleFactor(0.7)
            .accessibilityAddTraits(.isHeader)
        }
    }

    /// The greeting is the largest type in the product, so it is the first thing
    /// to overflow. At accessibility sizes it steps down rather than wrapping to
    /// four lines and pushing the composer off screen.
    private var isCompactType: Bool { typeSize >= .accessibility1 }

    private var composer: some View {
        VStack(spacing: JunoSpace.snug) {
            HStack(alignment: .bottom, spacing: JunoSpace.snug) {
                TextField("home.composer.placeholder", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .focused($composerFocused)
                    .padding(.horizontal, JunoSpace.snug)
                    .padding(.vertical, 6)
                    .accessibilityIdentifier("juno.mobile.home-composer")

                Button {
                    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                    start(text.isEmpty ? nil : text)
                    draft = ""
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(
                            Color.junoAccent.opacity(sendDisabled ? 0.35 : 1), in: Circle()
                        )
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(sendDisabled)
                .accessibilityLabel("home.send")
                .accessibilityIdentifier("juno.mobile.home-send")
            }
            .padding(JunoSpace.snug)
            .background(JunoGlassBackground(cornerRadius: JunoCornerRadius.composer))
        }
    }

    private var sendDisabled: Bool {
        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isMutating
    }

    /// Prompt modes, mirroring the website's. Each one opens a new conversation
    /// with a real opening instruction — none of them is decorative, and none
    /// claims a capability the model does not have.
    private var modes: [JunoMobileHomeMode] { JunoMobileHomeMode.all }

    private var modeRow: some View {
        ScrollView(.horizontal) {
            HStack(spacing: JunoSpace.snug) {
                ForEach(modes) { mode in
                    Button {
                        start(mode.opening)
                    } label: {
                        Label(mode.title, systemImage: mode.symbol)
                            .font(.subheadline)
                            .padding(.horizontal, JunoSpace.cozy)
                            .padding(.vertical, JunoSpace.snug)
                            .background(
                                Capsule().fill(Color.junoRowSelected)
                            )
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("juno.mobile.home-mode.\(mode.id)")
                }
            }
            .padding(.horizontal, 2)
        }
        .scrollIndicators(.hidden)
    }

    /// Recent projects, so the composer can be pointed at one without going to
    /// the Projects tab first. Capped — this is context, not a directory.
    private var projectRow: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text("home.projects.title")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            ForEach(recentProjects.prefix(3)) { project in
                HStack(spacing: JunoSpace.cozy) {
                    JunoIconView(.projects, size: 16)
                        .foregroundStyle(.secondary)
                    Text(project.name)
                        .font(.subheadline)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 6)
            }
        }
    }
}

/// The website's prompt modes. `opening` is a real first instruction, so tapping
/// one starts a conversation that has already begun rather than a blank chat
/// with a label attached.
@MainActor
struct JunoMobileHomeMode: Identifiable {
    let id: String
    let title: LocalizedStringKey
    // `LocalizedStringKey` is not Hashable, so identity comes from `id` alone —
    // which is what `ForEach` needs anyway.
    let symbol: String
    let opening: String

    static let all: [JunoMobileHomeMode] = [
        .init(
            id: "write", title: "home.mode.write", symbol: "square.and.pencil",
            opening: "Help me write "
        ),
        .init(
            id: "learn", title: "home.mode.learn", symbol: "book",
            opening: "Teach me "
        ),
        .init(
            id: "build", title: "home.mode.build", symbol: "hammer",
            opening: "Help me build "
        ),
        .init(
            id: "decide", title: "home.mode.decide", symbol: "scalemass",
            opening: "Help me decide between "
        ),
        .init(
            id: "compare", title: "home.mode.compare", symbol: "rectangle.split.2x1",
            opening: "Compare "
        ),
    ]
}
