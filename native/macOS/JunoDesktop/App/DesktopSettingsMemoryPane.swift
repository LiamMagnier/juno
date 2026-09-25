import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// Settings › Memory (`sections/memory.tsx`): the two switches and the way to
/// the Memory page, the sensitive subjects Juno does not learn on its own, and
/// who may read your chats for background work.
///
/// "What Juno noticed" (on-device proposals) stays here until the Memory page
/// can review them (seam 14).
struct DesktopSettingsMemoryPane: View {
    let context: DesktopSettingsContext

    @State private var links = DesktopSettingsLinks.shared
    @State private var reviewingProposals = false

    var body: some View {
        if reviewingProposals, let learningModel = context.services.learningModel {
            proposalReview(learningModel)
        } else {
            DesktopSettingsRecordForm(context: context) { settings in
                sections(settings)
            }
        }
    }

    @ViewBuilder
    private func sections(_ settings: NativeAccountSettings) -> some View {
        let known = context.settingsModel.serverSettingsPhase == .ready
        Section {
            DesktopSettingToggleRow(
                title: "Reference saved memories",
                description: "Juno remembers lasting facts and preferences from your chats and uses them in later ones.",
                status: context.saves.status("memoryEnabled"),
                isOn: Binding(
                    get: { settings.memoryEnabled },
                    set: { context.save("memoryEnabled", NativeSettingsPatch(memoryEnabled: $0)) }
                ),
                identifier: "juno.desktop.settings.memory-enabled"
            )
            DesktopSettingToggleRow(
                title: "Learn from past chats in the background",
                description: "Between sessions, Juno reads older chats it hasn’t learned from yet, within your usage limits.",
                status: context.saves.status("memoryBackgroundLearning"),
                isOn: Binding(
                    get: { settings.memoryBackgroundLearning ?? false },
                    set: { context.save("memoryBackgroundLearning", NativeSettingsPatch(memoryBackgroundLearning: $0)) }
                ),
                isEnabled: settings.memoryEnabled && settings.memoryBackgroundLearning != nil,
                identifier: "juno.desktop.settings.memory-background"
            )
            // Drawn only while it can open something: a row with no control
            // would be a dead end (DesktopSettingsLinks).
            if let openMemory = links.openMemory {
                DesktopSettingRow(
                    title: "Memories",
                    description: "See what Juno remembers, change it or forget it."
                ) {
                    DesktopOutlineButton(title: "Manage", action: openMemory)
                        .accessibilityIdentifier("juno.desktop.settings.memory-manage")
                }
            }
            if let learningModel = context.services.learningModel {
                let waiting = learningModel.proposals.count
                DesktopSettingRow(
                    title: "What Juno noticed",
                    description: "Keep or discard details picked up in your chats. Nothing is saved until you keep it."
                ) {
                    DesktopOutlineButton(title: waiting == 0 ? "Review" : "Review (\(waiting))") {
                        reviewingProposals = true
                    }
                    .accessibilityIdentifier("juno.desktop.settings.memory-proposals")
                }
            }
        }

        Section {
            if known || settings.memorySensitiveTopics != nil {
                let allowed = Set(settings.memorySensitiveTopics ?? [])
                ForEach(DesktopSensitiveTopics.all, id: \.id) { topic in
                    DesktopSettingToggleRow(
                        title: topic.label,
                        description: topic.description,
                        status: context.saves.status("topic:\(topic.id)"),
                        isOn: Binding(
                            get: { allowed.contains(topic.id) },
                            set: { on in
                                let next = DesktopSensitiveTopics.all.map(\.id).filter {
                                    $0 == topic.id ? on : allowed.contains($0)
                                }
                                context.save("topic:\(topic.id)", NativeSettingsPatch(memorySensitiveTopics: next))
                            }
                        ),
                        identifier: "juno.desktop.settings.sensitive-\(topic.id)"
                    )
                }
            } else {
                serverPending
            }
        } header: {
            DesktopSettingsGroupHeader(
                title: "Sensitive subjects",
                note: "Juno doesn’t learn these on its own. Anything you ask it to remember is always kept."
            )
        }

        Section {
            backgroundRow(settings)
        } header: {
            DesktopSettingsGroupHeader(
                title: "Background work",
                note: "Memory, chat titles, summaries and moderation run without you asking."
            )
        }
    }

    /// Skeleton rows while `GET /api/settings` is out; a quiet error with Try
    /// Again when it failed. Never a guess.
    @ViewBuilder
    private var serverPending: some View {
        if context.settingsModel.serverSettingsPhase == .failed {
            DesktopSettingRow(title: "Couldn’t load these settings", tone: .normal) {
                DesktopOutlineButton(title: "Try Again") {
                    Task { await context.loadServerSettings() }
                }
            }
        } else {
            DesktopSettingRowSkeleton()
            DesktopSettingRowSkeleton()
        }
    }

    private func backgroundRow(_ settings: NativeAccountSettings) -> some View {
        let current = settings.backgroundProviderMode
        let options = current == .selectedProvider
            ? DesktopBackgroundWork.options + [DesktopBackgroundWork.legacy]
            : DesktopBackgroundWork.options
        return DesktopSettingRow(
            title: "Who may read your chats for it",
            description: options.first { $0.mode == current }?.description,
            status: context.saves.status("backgroundProviderMode")
        ) {
            Picker("Who may read your chats for background work", selection: Binding(
                get: { current },
                set: { mode in
                    guard mode != current else { return }
                    context.save("backgroundProviderMode", NativeSettingsPatch(backgroundProviderMode: mode))
                }
            )) {
                ForEach(options, id: \.mode) { option in
                    Text(option.label.desktopMenuTitle).tag(option.mode)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .tint(nil)
            .fixedSize()
            .accessibilityIdentifier("juno.desktop.settings.background-provider")
        }
    }

    private func proposalReview(_ learningModel: MemoryLearningModel<SQLiteAccountRepository>) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: JunoSpace.cozy) {
                Button {
                    reviewingProposals = false
                } label: {
                    JunoIconLabel("Memory", icon: .arrowLeft, size: 13)
                        .junoType(.ui)
                        .frame(minHeight: 28)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.junoSecondaryInk)
                .help("Back to settings")
                .accessibilityIdentifier("juno.desktop.memory-proposals.back")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.regular)

            NativeMemoryManagerView(
                model: context.settingsModel,
                proposals: learningModel.proposals,
                onDecideProposal: { candidate, keep in
                    Task {
                        if keep {
                            await learningModel.accept(candidate)
                        } else {
                            learningModel.decline(candidate)
                        }
                    }
                }
            )
        }
        .accessibilityIdentifier("juno.desktop.memory-proposals")
    }
}

/// `SENSITIVE_TOPIC_META` (`src/lib/memory-sensitive.ts`), in the web's order.
enum DesktopSensitiveTopics {
    static let all: [(id: String, label: String, description: String)] = [
        ("health", "Health", "Conditions, diagnoses, medication, therapy, disability and pregnancy."),
        ("ethnicity", "Race and ethnicity", "Racial or ethnic background, and national origin."),
        ("religion", "Religion and beliefs", "Faith, practice, and philosophical convictions."),
        ("politics", "Political views", "Party affiliation, voting, and political convictions."),
        ("sexuality", "Sexuality and gender", "Sexual orientation and gender identity."),
        ("finances", "Money", "Income, debt, savings and financial circumstances."),
    ]
}

/// The web's `BACKGROUND_OPTIONS` and the legacy choice it still shows.
enum DesktopBackgroundWork {
    struct Option {
        let mode: BackgroundProviderMode
        let label: String
        let description: String
    }

    static let options: [Option] = [
        Option(mode: .sameProvider, label: "The lab I chat with", description: "A chat’s background work goes to the lab that answered it."),
        Option(mode: .anyAllowedProvider, label: "Any configured lab", description: "Whichever lab on this server can do the job at the lowest cost."),
        Option(mode: .localOnly, label: "Juno’s own models only", description: "Nothing goes to an outside lab. Some background work may not run."),
    ]

    static let legacy = Option(
        mode: .selectedProvider,
        label: "A provider I chose",
        description: "No longer offered, and background work is paused on it. Pick another option."
    )
}
