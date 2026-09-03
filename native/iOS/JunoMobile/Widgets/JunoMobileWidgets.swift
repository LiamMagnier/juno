import ActivityKit
import AppIntents
import JunoDesignSystem
import SwiftUI
import WidgetKit

@main
struct JunoMobileWidgetsBundle: WidgetBundle {
  var body: some Widget {
    JunoMobileQuickActionsWidget()
    JunoMobileVoiceLiveActivity()
    JunoMobileCodeApprovalLiveActivity()
  }
}

// The widget and the Live Activities are cut from the app's one material:
// `junoCanvas` ground, `junoSurface` raised tiles, a hairline, and real colour
// on the primary action — the same tonal layering every in-app surface uses,
// resolved per environment rather than baked to one appearance.
private struct JunoWidgetTileBackground: View {
  var body: some View {
    Color.junoCanvas
  }
}

private struct JunoWidgetTile: ViewModifier {
  func body(content: Content) -> some View {
    content
      .frame(maxWidth: .infinity, minHeight: 44)
      .foregroundStyle(Color.junoForeground)
      .background(Color.junoSurface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .strokeBorder(Color.junoHairline, lineWidth: 1)
      )
      .contentShape(.rect)
  }
}

private extension View {
  func junoWidgetTile() -> some View { modifier(JunoWidgetTile()) }
}

struct JunoMobileQuickActionsWidget: Widget {
  let kind = "com.liammagnier.JunoMobile.quick-actions"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: QuickActionsProvider()) { entry in
      JunoMobileQuickActionsView(entry: entry)
    }
    .configurationDisplayName("Juno quick actions")
    .description("Start a Juno chat, voice conversation, Code session, or dictation.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct QuickActionsProvider: TimelineProvider {
  func placeholder(in context: Context) -> QuickActionsEntry { .init(date: .now) }
  func getSnapshot(in context: Context, completion: @escaping (QuickActionsEntry) -> Void) {
    completion(.init(date: .now))
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<QuickActionsEntry>) -> Void) {
    completion(Timeline(entries: [.init(date: .now)], policy: .never))
  }
}

struct QuickActionsEntry: TimelineEntry { let date: Date }

struct JunoMobileQuickActionsView: View {
  let entry: QuickActionsEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    Group {
      switch family {
      case .systemMedium:
        VStack(alignment: .leading, spacing: 8) {
          mediumHeader
          HStack(spacing: 8) {
            action("Chat", icon: "square.and.pencil", route: "chat")
            action("Voice", icon: "waveform", route: "voice")
            action("Code", icon: "chevron.left.forwardslash.chevron.right", route: "code")
            action("Dictate", icon: "mic", route: "dictate")
          }
        }
      default:
        // The small square carries the four actions alone: a header would
        // crowd every tile below a comfortable thumb's reach.
        VStack(spacing: 8) {
          action("Chat", icon: "square.and.pencil", route: "chat")
          action("Voice", icon: "waveform", route: "voice")
          action("Code", icon: "chevron.left.forwardslash.chevron.right", route: "code")
          action("Dictate", icon: "mic", route: "dictate")
        }
      }
    }
    .padding(.vertical, family == .systemMedium ? 4 : 0)
    .containerBackground(for: .widget) { JunoWidgetTileBackground() }
  }

  private var mediumHeader: some View {
    VStack(alignment: .leading, spacing: 2) {
      Label("Juno", systemImage: "sparkles")
        .font(.headline.weight(.semibold))
        .foregroundStyle(Color.junoForeground)
      Text("Pick up where your thinking left off.")
        .font(.caption)
        .foregroundStyle(Color.junoMutedForeground)
        .lineLimit(1)
    }
  }

  private func action(_ title: LocalizedStringKey, icon: String, route: String) -> some View {
    Link(destination: JunoMobileWidgetRoute.url(path: route)) {
      VStack(spacing: 5) {
        Image(systemName: icon)
          .font(.body.weight(.medium))
          .foregroundStyle(Color.junoAccent)
        Text(title)
          .font(.caption2.weight(.semibold))
      }
      .junoWidgetTile()
    }
  }
}

struct JunoMobileVoiceLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: JunoVoiceActivityAttributes.self) { context in
      VoiceActivityLockScreenView(context: context)
        .activityBackgroundTint(Color.junoCanvas)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Image(systemName: "waveform").foregroundStyle(Color.junoAccent)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(context.state.phase).font(.caption)
        }
        DynamicIslandExpandedRegion(.bottom) {
          Text(context.state.muted ? "Muted" : "Voice conversation in progress")
        }
      } compactLeading: {
        Image(systemName: "waveform")
      } compactTrailing: {
        Text(context.state.muted ? "Muted" : context.state.phase).font(.caption2)
      } minimal: {
        Image(systemName: "waveform")
      }
      .widgetURL(JunoMobileWidgetRoute.url(path: "voice"))
    }
  }
}

struct JunoMobileCodeApprovalLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: JunoCodeApprovalActivityAttributes.self) { context in
      CodeApprovalActivityView(context: context)
        .activityBackgroundTint(Color.junoCanvas)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Image(systemName: "chevron.left.forwardslash.chevron.right")
            .foregroundStyle(Color.junoAccent)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text("Approval").font(.caption.weight(.semibold))
        }
        DynamicIslandExpandedRegion(.bottom) {
          Text(context.state.summary).lineLimit(2)
        }
      } compactLeading: {
        Image(systemName: "chevron.left.forwardslash.chevron.right")
      } compactTrailing: {
        Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Color.junoAccent)
      } minimal: {
        Image(systemName: "exclamationmark.circle.fill")
      }
      .widgetURL(
        JunoMobileWidgetRoute.url(
          path: "code/session/\(context.attributes.deviceID)/\(context.attributes.sessionID)"
        )
      )
    }
  }
}

private struct VoiceActivityLockScreenView: View {
  let context: ActivityViewContext<JunoVoiceActivityAttributes>

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "waveform")
        .font(.title2)
        .foregroundStyle(Color.junoAccent)
      VStack(alignment: .leading, spacing: 2) {
        Text(context.attributes.title).font(.headline)
        Text(context.state.muted ? "Muted" : context.state.phase)
          .font(.subheadline)
          .foregroundStyle(Color.junoMutedForeground)
      }
      Spacer()
      Text("Open Juno")
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color.junoSurface, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.junoHairline, lineWidth: 1))
    }
    .foregroundStyle(Color.junoForeground)
    .padding(.horizontal)
    .padding(.vertical, 8)
  }
}

private struct CodeApprovalActivityView: View {
  let context: ActivityViewContext<JunoCodeApprovalActivityAttributes>

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Label("Juno Code needs approval", systemImage: "exclamationmark.shield")
        .font(.headline)
      Text(context.state.summary)
        .font(.subheadline)
        .foregroundStyle(Color.junoMutedForeground)
        .lineLimit(2)
      if !context.state.risk.isEmpty {
        Text(context.state.risk)
          .font(.caption2.weight(.semibold))
          .foregroundStyle(Color.junoCaution)
      }
      HStack(spacing: 8) {
        Button(intent: JunoMobileApprovalIntent(
          deviceID: context.attributes.deviceID, sessionID: context.attributes.sessionID,
          requestID: context.attributes.requestID, approved: false
        )) {
          Text("Deny")
            .frame(minWidth: 64, minHeight: 44)
        }
        .frame(minWidth: 64, minHeight: 44)
        .contentShape(.rect)
        .tint(.gray)
        Button(intent: JunoMobileApprovalIntent(
          deviceID: context.attributes.deviceID, sessionID: context.attributes.sessionID,
          requestID: context.attributes.requestID, approved: true
        )) {
          Text("Allow")
            .frame(minWidth: 64, minHeight: 44)
        }
        .frame(minWidth: 64, minHeight: 44)
        .contentShape(.rect)
        .tint(Color.junoAccent)
      }
    }
    .foregroundStyle(Color.junoForeground)
    .padding(.horizontal)
    .padding(.vertical, 10)
  }
}

/// `openAppWhenRun` is required — a Lock Screen button has no background
/// runtime to talk to the relay with, so the intent hands the decision to the
/// app through the same deep link a tap on the card would produce, and the
/// app's existing authenticated client sends it.
struct JunoMobileApprovalIntent: AppIntent {
  static let title: LocalizedStringResource = "Respond to Juno Code approval"
  static let openAppWhenRun = true

  @Parameter(title: "Device") var deviceID: String
  @Parameter(title: "Session") var sessionID: String
  @Parameter(title: "Request") var requestID: String
  @Parameter(title: "Allow") var approved: Bool

  init() {}
  init(deviceID: String, sessionID: String, requestID: String, approved: Bool) {
    self.deviceID = deviceID
    self.sessionID = sessionID
    self.requestID = requestID
    self.approved = approved
  }

  func perform() async throws -> some IntentResult & OpensIntent {
    .result(opensIntent: OpenURLIntent(JunoMobileWidgetRoute.approvalURL(
      deviceID: deviceID, sessionID: sessionID, requestID: requestID, approved: approved
    )))
  }
}
