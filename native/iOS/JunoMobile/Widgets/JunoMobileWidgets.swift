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
    .configurationDisplayName("Alevr quick actions")
    .description("Start a new chat in Alevr. The larger size adds voice, Code and dictation.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
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

/// The quick actions at each size. Where WidgetKit honours one destination
/// (the small square, the Lock Screen) the whole widget is that destination
/// and draws only it; the medium widget keeps its row of four links. See
/// ``JunoMobileQuickAction``.
struct JunoMobileQuickActionsView: View {
  let entry: QuickActionsEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    switch family {
    case .systemMedium:
      medium
        .containerBackground(for: .widget) { JunoWidgetTileBackground() }
    case .accessoryCircular:
      circular
        .widgetURL(Self.single.url)
        .containerBackground(for: .widget) { AccessoryWidgetBackground() }
    case .accessoryRectangular:
      rectangular
        .widgetURL(Self.single.url)
        .containerBackground(for: .widget) { Color.clear }
    default:
      small
        .widgetURL(Self.single.url)
        .containerBackground(for: .widget) { JunoWidgetTileBackground() }
    }
  }

  /// The one action a single-destination size offers.
  private static let single = JunoMobileQuickAction.actions(for: .single)[0]

  // MARK: Home Screen

  /// One tile, edge to edge: the mark at the top, the action set large at the
  /// foot. Everything flexes, so nothing is cut off at any text size.
  private var small: some View {
    VStack(alignment: .leading, spacing: 0) {
      JunoIconView(.compose, size: 20)
        .foregroundStyle(Color.junoAccent)
        .frame(width: 40, height: 40)
        .background(Color.junoSurface, in: Circle())
        .overlay(Circle().strokeBorder(Color.junoHairline, lineWidth: 1))
      Spacer(minLength: 8)
      Text("New chat")
        .font(JunoSerif.font(size: 22, relativeTo: .title3, face: .medium))
        .foregroundStyle(Color.junoForeground)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
      Text("Ask Alevr anything")
        .font(.caption)
        .foregroundStyle(Color.junoMutedForeground)
        .lineLimit(2)
        .minimumScaleFactor(0.8)
        .padding(.top, 2)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text("New chat in Alevr"))
    .accessibilityAddTraits(.isLink)
  }

  private var medium: some View {
    VStack(alignment: .leading, spacing: 8) {
      mediumHeader
      HStack(spacing: 8) {
        ForEach(JunoMobileQuickAction.actions(for: .row), id: \.self) { action in
          tile(action)
        }
      }
    }
    .padding(.vertical, 4)
  }

  private var mediumHeader: some View {
    VStack(alignment: .leading, spacing: 2) {
      Label("Alevr", image: JunoIcon.home.assetName(.regular))
        .font(.headline.weight(.semibold))
        .foregroundStyle(Color.junoForeground)
      Text("Pick up where your thinking left off.")
        .font(.caption)
        .foregroundStyle(Color.junoMutedForeground)
        .lineLimit(1)
    }
  }

  private func tile(_ action: JunoMobileQuickAction) -> some View {
    Link(destination: action.url) {
      VStack(spacing: 5) {
        JunoIconView(Self.icon(for: action), size: 18)
          .foregroundStyle(Color.junoAccent)
        Text(Self.title(for: action))
          .font(.caption2.weight(.semibold))
          .lineLimit(1)
          .minimumScaleFactor(0.8)
      }
      .junoWidgetTile()
    }
  }

  // MARK: Lock Screen

  private var circular: some View {
    JunoIconView(.compose, size: 22)
      .accessibilityLabel(Text("New chat in Alevr"))
  }

  private var rectangular: some View {
    VStack(alignment: .leading, spacing: 1) {
      Label {
        Text("New chat")
          .font(.headline)
          .lineLimit(1)
      } icon: {
        JunoIconView(.compose, size: 14)
      }
      Text("Ask Alevr anything")
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text("New chat in Alevr"))
  }

  // MARK: Words and marks

  private static func title(for action: JunoMobileQuickAction) -> LocalizedStringKey {
    switch action {
    case .chat: "Chat"
    case .voice: "Voice"
    case .code: "Code"
    case .dictate: "Dictate"
    }
  }

  private static func icon(for action: JunoMobileQuickAction) -> JunoIcon {
    switch action {
    case .chat: .compose
    case .voice: .audioLines
    case .code: .code
    case .dictate: .mic
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
          JunoIconView(.audioLines, size: 18).foregroundStyle(Color.junoAccent)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(context.state.phase).font(.caption)
        }
        DynamicIslandExpandedRegion(.bottom) {
          Text(context.state.muted ? "Muted" : "Voice conversation in progress")
        }
      } compactLeading: {
        JunoIconView(.audioLines, size: 18)
      } compactTrailing: {
        Text(context.state.muted ? "Muted" : context.state.phase).font(.caption2)
      } minimal: {
        JunoIconView(.audioLines, size: 18)
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
          JunoIconView(.code, size: 18)
            .foregroundStyle(Color.junoAccent)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text("Approval").font(.caption.weight(.semibold))
        }
        DynamicIslandExpandedRegion(.bottom) {
          Text(context.state.summary).lineLimit(2)
        }
      } compactLeading: {
        JunoIconView(.code, size: 18)
      } compactTrailing: {
        JunoIconView(.error, size: 16, isOn: true).foregroundStyle(Color.junoAccent)
      } minimal: {
        JunoIconView(.error, size: 16, isOn: true)
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
      JunoIconView(.audioLines, size: 24)
        .foregroundStyle(Color.junoAccent)
      VStack(alignment: .leading, spacing: 2) {
        Text(context.attributes.title).font(.headline)
        Text(context.state.muted ? "Muted" : context.state.phase)
          .font(.subheadline)
          .foregroundStyle(Color.junoMutedForeground)
      }
      Spacer()
      Text("Open Alevr")
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
      Label("Alevr Code needs approval", image: JunoIcon.permission.assetName(.regular))
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
/// app through the same deep link a tap on the card would produce. The app
/// asks the owner to confirm (`JunoMobileApprovalGate`) before its
/// authenticated client sends it.
struct JunoMobileApprovalIntent: AppIntent {
  static let title: LocalizedStringResource = "Respond to Alevr Code approval"
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
