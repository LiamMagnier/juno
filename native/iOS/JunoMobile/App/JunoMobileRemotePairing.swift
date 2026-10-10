import JunoCodeKit
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI
import UIKit

/// The pairing sheet (docs/code-v2/REMOTE-CONTROL.md §1): the scanner, or
/// "Allow this iPhone to control Alevr on <Mac>?" for an offer that was
/// scanned or opened as a link, then the answer.
///
/// Presented by the shell whenever `JunoMobileRemoteRouting.shared.pairing`
/// is set. The serif question with the Mac's name in italic is the greeting's
/// own voice; the bridge above it (this iPhone, the Continuum, the Mac) is
/// the one drawn detail, and it closes into a solid line once paired.
struct JunoMobileRemotePairingSheet: View {
  @State var model: JunoMobileRemotePairingModel
  var openCode: () -> Void
  var close: () -> Void
  /// Snapshot tests draw a still in place of the camera and a fixed clock.
  var cameraOverride: AnyView?
  var now: Date?
  var cameraAccessOverride: JunoMobileCameraAccess?

  var body: some View {
    Group {
      switch model.phase {
      case let .scanning(hint):
        JunoMobilePairingScannerScreen(
          hint: hint,
          cameraOverride: cameraOverride,
          accessOverride: cameraAccessOverride,
          scanned: { text in Task { await model.scanned(text) } },
          close: close
        )
      case .inspecting:
        JunoMobilePairingCheckingScreen(close: close)
      case .ready, .approving, .denying:
        if let summary = model.summary {
          JunoMobilePairingApproveScreen(
            summary: summary,
            busy: busyAction,
            now: now,
            approve: { Task { await model.approve() } },
            deny: { Task { await model.deny() } },
            expired: { model.expire() },
            close: close
          )
        }
      case let .paired(macName):
        JunoMobilePairingResultScreen(
          result: .paired(macName),
          primary: ("Open Code", { close(); openCode() }),
          secondary: ("Done", close),
          close: close
        )
      case let .denied(macName):
        JunoMobilePairingResultScreen(
          result: .denied(macName),
          primary: ("Done", close),
          secondary: nil,
          close: close
        )
      case let .failed(failure):
        JunoMobilePairingResultScreen(
          result: .failed(failure),
          primary: ("Scan again", { model.rescan() }),
          secondary: ("Close", close),
          close: close
        )
      }
    }
    .animation(JunoMotion.emphasized, value: model.phase)
    .task { await model.start() }
  }

  private var busyAction: JunoMobilePairingApproveScreen.Busy? {
    switch model.phase {
    case .approving: .approving
    case .denying: .denying
    default: nil
    }
  }
}

// MARK: - Scanner

/// The camera full bleed, a viewfinder, and what to point it at.
struct JunoMobilePairingScannerScreen: View {
  let hint: String?
  var cameraOverride: AnyView?
  var accessOverride: JunoMobileCameraAccess?
  let scanned: (String) -> Void
  let close: () -> Void

  @State private var access: JunoMobileCameraAccess = .undetermined
  @State private var scanner: JunoMobileQRScanner?
  @Environment(\.openURL) private var openURL
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var effectiveAccess: JunoMobileCameraAccess { accessOverride ?? access }

  var body: some View {
    Group {
      if effectiveAccess == .denied {
        deniedFallback
      } else {
        camera
      }
    }
    .task {
      guard accessOverride == nil, cameraOverride == nil else { return }
      access = JunoMobileCameraAccess.current
      if access == .undetermined { access = await JunoMobileCameraAccess.request() }
      if access == .granted, scanner == nil {
        scanner = JunoMobileQRScanner { code in scanned(code) }
      }
    }
    .onChange(of: hint) { _, _ in scanner?.reset() }
    .onDisappear { scanner?.stop() }
  }

  private var camera: some View {
    ZStack {
      Group {
        if let cameraOverride {
          cameraOverride
        } else if let scanner {
          JunoMobileQRScannerView(scanner: scanner)
        } else {
          Color.black
        }
      }
      .ignoresSafeArea()

      JunoMobileViewfinderScrim(window: JunoMobilePairingMetrics.viewfinder)
        .ignoresSafeArea()
        .allowsHitTesting(false)

      // The corners sit exactly over the scrim's window; the words hang
      // under them without moving them.
      JunoMobileViewfinderCorners(animated: !reduceMotion && cameraOverride == nil)
        .frame(width: JunoMobilePairingMetrics.viewfinder, height: JunoMobilePairingMetrics.viewfinder)
        .accessibilityHidden(true)
        .overlay(alignment: .top) {
          VStack(spacing: JunoSpace.snug) {
            Text("Scan the code on your Mac")
              .font(JunoMobileType.display(26, relativeTo: .title2))
              .foregroundStyle(.white)
              .multilineTextAlignment(.center)
              .accessibilityAddTraits(.isHeader)
            Text("On your Mac, open Settings, then Connections, then Control this Mac remotely.")
              .junoFont(size: 15, relativeTo: .subheadline)
              .foregroundStyle(.white.opacity(0.72))
              .multilineTextAlignment(.center)
              .fixedSize(horizontal: false, vertical: true)
          }
          .frame(width: 320)
          .offset(y: JunoMobilePairingMetrics.viewfinder + JunoSpace.section)
        }
        .offset(y: -JunoMobilePairingMetrics.viewfinderLift)
        // Centred on the whole screen, as the scrim is, not on the safe area.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea()

      VStack(spacing: 0) {
        HStack {
          Spacer()
          JunoMobilePairingCloseButton(action: close)
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.top, JunoSpace.snug)

        Spacer(minLength: 0)

        VStack(spacing: JunoSpace.cozy) {
          if let hint {
            Text(hint)
              .junoFont(size: 14, relativeTo: .footnote)
              .foregroundStyle(.white)
              .multilineTextAlignment(.center)
              .padding(.horizontal, JunoSpace.regular)
              .padding(.vertical, JunoSpace.snug)
              .glassEffect(.regular, in: .rect(cornerRadius: JunoSpace.regular))
              .transition(.opacity.combined(with: .offset(y: JunoSpace.snug)))
              .accessibilityAddTraits(.updatesFrequently)
          }
          JunoMobilePairingPasteButton(scanned: scanned, overCamera: true)
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.bottom, JunoSpace.section)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: hint)
      }
    }
    .environment(\.colorScheme, .dark)
    .background(Color.black)
  }

  private var deniedFallback: some View {
    JunoMobilePairingFrame(close: close) {
      VStack(spacing: JunoSpace.section) {
        JunoMobilePairingBadge(icon: .camera)
        VStack(spacing: JunoSpace.snug) {
          Text("Allow the camera to scan")
            .font(JunoMobileType.display(28, relativeTo: .title))
            .foregroundStyle(Color.junoForeground)
            .multilineTextAlignment(.center)
            .accessibilityAddTraits(.isHeader)
          Text("Alevr uses the camera only to read the code on your Mac. You can also copy the link your Mac shows and paste it here.")
            .junoFont(size: 16, relativeTo: .body)
            .foregroundStyle(Color.junoSecondaryInk)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    } actions: {
      Button {
        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
      } label: {
        Text("Open Settings")
          .junoFont(size: 16, relativeTo: .body, weight: .medium)
          .frame(maxWidth: .infinity, minHeight: JunoLayout.touchTarget)
      }
      .junoMobileCapsulePrimary()
      JunoMobilePairingPasteButton(scanned: scanned)
    }
  }
}

/// Paste a link the Mac showed, without the paste prompt.
private struct JunoMobilePairingPasteButton: View {
  let scanned: (String) -> Void
  /// Over the camera the capsule is a pale glass; on the canvas, the ink's.
  var overCamera = false

  var body: some View {
    PasteButton(payloadType: String.self) { strings in
      guard let text = strings.first else { return }
      Task { @MainActor in scanned(text) }
    }
    .buttonBorderShape(.capsule)
    .labelStyle(.titleAndIcon)
    .controlSize(.large)
    .tint(overCamera ? Color.white.opacity(0.18) : Color.junoSecondary)
    .foregroundStyle(overCamera ? Color.white : Color.junoForeground)
    .accessibilityIdentifier("juno.mobile.pairing-paste")
  }
}

/// Darkens the camera everywhere except the viewfinder's window.
private struct JunoMobileViewfinderScrim: View {
  let window: CGFloat

  var body: some View {
    GeometryReader { proxy in
      let rect = CGRect(
        x: (proxy.size.width - window) / 2,
        y: (proxy.size.height - window) / 2 - JunoMobilePairingMetrics.viewfinderLift,
        width: window,
        height: window
      )
      Path { path in
        path.addRect(CGRect(origin: .zero, size: proxy.size))
        path.addRoundedRect(in: rect, cornerSize: CGSize(width: 36, height: 36), style: .continuous)
      }
      .fill(Color.black.opacity(0.5), style: FillStyle(eoFill: true))
    }
  }
}

/// The viewfinder's four corners, breathing slowly while it looks.
private struct JunoMobileViewfinderCorners: View {
  let animated: Bool
  @State private var settled = false

  var body: some View {
    JunoMobileCornerBrackets(length: 34, radius: 36)
      .stroke(.white, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
      .scaleEffect(settled ? 0.97 : 1)
      .opacity(settled ? 0.86 : 1)
      .shadow(color: .black.opacity(0.25), radius: 8)
      .onAppear {
        guard animated else { return }
        withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { settled = true }
      }
  }
}

/// Four rounded corners of a square, open along each side.
private struct JunoMobileCornerBrackets: Shape {
  let length: CGFloat
  let radius: CGFloat

  func path(in rect: CGRect) -> Path {
    var path = Path()
    let r = min(radius, length)
    // Top left.
    path.move(to: CGPoint(x: rect.minX, y: rect.minY + length))
    path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
    path.addQuadCurve(to: CGPoint(x: rect.minX + r, y: rect.minY), control: CGPoint(x: rect.minX, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.minX + length, y: rect.minY))
    // Top right.
    path.move(to: CGPoint(x: rect.maxX - length, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
    path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + r), control: CGPoint(x: rect.maxX, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + length))
    // Bottom right.
    path.move(to: CGPoint(x: rect.maxX, y: rect.maxY - length))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
    path.addQuadCurve(to: CGPoint(x: rect.maxX - r, y: rect.maxY), control: CGPoint(x: rect.maxX, y: rect.maxY))
    path.addLine(to: CGPoint(x: rect.maxX - length, y: rect.maxY))
    // Bottom left.
    path.move(to: CGPoint(x: rect.minX + length, y: rect.maxY))
    path.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
    path.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.maxY - r), control: CGPoint(x: rect.minX, y: rect.maxY))
    path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - length))
    return path
  }
}

// MARK: - Checking

private struct JunoMobilePairingCheckingScreen: View {
  let close: () -> Void

  var body: some View {
    JunoMobilePairingFrame(close: close) {
      VStack(spacing: JunoSpace.section) {
        JunoMobilePairingBridge(state: .pending)
        Text("Checking the code")
          .junoFont(size: 16, relativeTo: .body)
          .foregroundStyle(Color.junoSecondaryInk)
      }
    } actions: {
      EmptyView()
    }
  }
}

// MARK: - Approve

/// "Allow this iPhone to control Alevr on <Mac>?"
struct JunoMobilePairingApproveScreen: View {
  enum Busy { case approving, denying }

  let summary: RemotePairingSummary
  let busy: Busy?
  var now: Date?
  let approve: () -> Void
  let deny: () -> Void
  let expired: () -> Void
  let close: () -> Void

  var body: some View {
    JunoMobilePairingFrame(close: close) {
      VStack(spacing: JunoSpace.region) {
        JunoMobilePairingBridge(state: .pending)
        VStack(spacing: JunoSpace.cozy) {
          question
            .multilineTextAlignment(.center)
            .accessibilityAddTraits(.isHeader)
          Text("It can start and steer Code sessions, answer approvals, and see changes and screenshots, only in the folders your Mac shares. Remove it anytime on the Mac.")
            .junoFont(size: 16, relativeTo: .body)
            .foregroundStyle(Color.junoSecondaryInk)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    } actions: {
      VStack(spacing: JunoSpace.cozy) {
        Button(action: approve) {
          ZStack {
            Text("Approve").opacity(busy == .approving ? 0 : 1)
            if busy == .approving { ProgressView().tint(Color.junoOnAccent) }
          }
          .junoFont(size: 16, relativeTo: .body, weight: .medium)
          .frame(maxWidth: .infinity, minHeight: JunoLayout.touchTarget)
        }
        .junoMobileCapsulePrimary()
        .disabled(busy != nil)
        .accessibilityIdentifier("juno.mobile.pairing-approve")

        Button(action: deny) {
          ZStack {
            Text("Deny").opacity(busy == .denying ? 0 : 1)
            if busy == .denying { ProgressView() }
          }
          .junoFont(size: 16, relativeTo: .body, weight: .medium)
          .foregroundStyle(Color.junoForeground)
          .frame(maxWidth: .infinity, minHeight: JunoLayout.touchTarget)
        }
        .junoMobileCapsuleAction()
        .disabled(busy != nil)
        .accessibilityIdentifier("juno.mobile.pairing-deny")

        countdown
          .padding(.top, JunoSpace.tight)
      }
    }
  }

  /// The greeting's voice: the question in the serif, the Mac's name in its italic.
  private var question: Text {
    var line = AttributedString("Allow this iPhone to control Alevr on ")
    line.font = JunoMobileType.display(30, relativeTo: .title)
    var name = AttributedString(summary.deviceName)
    name.font = JunoMobileType.displayItalic(30, relativeTo: .title)
    var mark = AttributedString("?")
    mark.font = JunoMobileType.display(30, relativeTo: .title)
    line.append(name)
    line.append(mark)
    line.foregroundColor = Color.junoForeground
    return Text(line)
  }

  @ViewBuilder
  private var countdown: some View {
    if let now {
      countdownText(at: now)
    } else {
      TimelineView(.periodic(from: .now, by: 1)) { context in
        countdownText(at: context.date)
          .onChange(of: remaining(at: context.date) <= 0) { _, out in
            if out { expired() }
          }
      }
    }
  }

  private func remaining(at date: Date) -> Int {
    max(0, Int(summary.expiresAt.timeIntervalSince(date).rounded(.down)))
  }

  private func countdownText(at date: Date) -> some View {
    let seconds = remaining(at: date)
    return Text("This code expires in \(seconds / 60):\(String(format: "%02d", seconds % 60))")
      .junoFont(size: 13, relativeTo: .footnote)
      .monospacedDigit()
      .foregroundStyle(Color.junoTertiaryInk)
      .contentTransition(.numericText(countsDown: true))
      .accessibilityLabel("This code expires in \(seconds / 60) minutes \(seconds % 60) seconds")
  }
}

// MARK: - Result

/// Paired, denied, or why not.
struct JunoMobilePairingResultScreen: View {
  enum Result: Equatable {
    case paired(String)
    case denied(String)
    case failed(JunoMobileRemotePairingModel.Failure)
  }

  let result: Result
  let primary: (String, () -> Void)
  let secondary: (String, () -> Void)?
  let close: () -> Void

  var body: some View {
    JunoMobilePairingFrame(close: close) {
      VStack(spacing: JunoSpace.region) {
        mark
        VStack(spacing: JunoSpace.cozy) {
          Text(title)
            .font(JunoMobileType.display(30, relativeTo: .title))
            .foregroundStyle(Color.junoForeground)
            .multilineTextAlignment(.center)
            .accessibilityAddTraits(.isHeader)
          Text(message)
            .junoFont(size: 16, relativeTo: .body)
            .foregroundStyle(Color.junoSecondaryInk)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    } actions: {
      VStack(spacing: JunoSpace.cozy) {
        Button(action: primary.1) {
          Text(primary.0)
            .junoFont(size: 16, relativeTo: .body, weight: .medium)
            .frame(maxWidth: .infinity, minHeight: JunoLayout.touchTarget)
        }
        .junoMobileCapsulePrimary()
        if let secondary {
          Button(action: secondary.1) {
            Text(secondary.0)
              .junoFont(size: 16, relativeTo: .body, weight: .medium)
              .foregroundStyle(Color.junoForeground)
              .frame(maxWidth: .infinity, minHeight: JunoLayout.touchTarget)
          }
          .junoMobileCapsuleAction()
        }
      }
    }
  }

  @ViewBuilder
  private var mark: some View {
    switch result {
    case .paired: JunoMobilePairingBridge(state: .paired)
    case .denied: JunoMobilePairingBridge(state: .apart)
    case .failed(.expired): JunoMobilePairingBadge(icon: .hourglass)
    case .failed: JunoMobilePairingBadge(icon: .triangleAlert)
    }
  }

  private var title: String {
    switch result {
    case .paired: "Paired"
    case .denied: "Not paired"
    case let .failed(failure): failure.title
    }
  }

  private var message: String {
    switch result {
    case let .paired(mac): "You can now control \(mac) from Code."
    case let .denied(mac): "Nothing changed. \(mac) was not given access to this iPhone."
    case let .failed(failure): failure.message
    }
  }
}

// MARK: - Pieces

enum JunoMobilePairingMetrics {
  static let viewfinder: CGFloat = 248
  /// The viewfinder sits a little above centre, where the eye lands.
  static let viewfinderLift: CGFloat = 40
  static let measure: CGFloat = 420
}

/// The canvas, a close button, the content centred a little high, and the
/// actions at the foot for the thumb.
private struct JunoMobilePairingFrame<Content: View, Actions: View>: View {
  let close: () -> Void
  @ViewBuilder let content: () -> Content
  @ViewBuilder let actions: () -> Actions

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Spacer()
        JunoMobilePairingCloseButton(action: close)
      }
      .padding(.horizontal, JunoSpace.regular)
      .padding(.top, JunoSpace.snug)

      Spacer(minLength: JunoSpace.section)
      content()
        .frame(maxWidth: JunoMobilePairingMetrics.measure)
        .padding(.horizontal, JunoSpace.region)
      Spacer(minLength: JunoSpace.section)
      Spacer(minLength: 0)

      actions()
        .frame(maxWidth: JunoMobilePairingMetrics.measure)
        .padding(.horizontal, JunoSpace.section)
        .padding(.bottom, JunoSpace.section)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.junoCanvas.ignoresSafeArea())
  }
}

private struct JunoMobilePairingCloseButton: View {
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      JunoIconView(.close, size: 16)
        .foregroundStyle(Color.primary)
        .frame(width: JunoLayout.touchTarget, height: JunoLayout.touchTarget)
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .modifier(JunoGlassCircle())
    .accessibilityLabel("Close")
    .accessibilityIdentifier("juno.mobile.pairing-close")
  }
}

/// A glyph in a glass circle: the camera ask and the failures.
private struct JunoMobilePairingBadge: View {
  let icon: JunoIcon

  var body: some View {
    JunoIconView(icon, size: 26)
      .foregroundStyle(Color.junoForeground)
      .frame(width: 76, height: 76)
      .glassEffect(.regular, in: Circle())
      .accessibilityHidden(true)
  }
}

/// This iPhone, the Continuum, the Mac: dashed while asking, solid once
/// paired, pulled apart when denied.
struct JunoMobilePairingBridge: View {
  enum Stage { case pending, paired, apart }
  let state: Stage

  var body: some View {
    HStack(spacing: 0) {
      end(.smartphone)
      link
      JunoMark(size: 34)
        .foregroundStyle(Color.junoForeground)
        .frame(width: 76, height: 76)
        .glassEffect(.regular, in: Circle())
        .overlay(alignment: .bottomTrailing) {
          if state == .paired {
            JunoIconView(.check, size: 13, weight: .bold)
              .foregroundStyle(Color.junoCanvas)
              .frame(width: 24, height: 24)
              .background(Color.junoForeground, in: Circle())
              .overlay(Circle().stroke(Color.junoCanvas, lineWidth: 2))
              .transition(.scale.combined(with: .opacity))
          }
        }
      link
      end(.device)
    }
    .accessibilityHidden(true)
  }

  private func end(_ icon: JunoIcon) -> some View {
    JunoIconView(icon, size: 20)
      .foregroundStyle(state == .apart ? Color.junoTertiaryInk : Color.junoForeground)
      .frame(width: 52, height: 52)
      .glassEffect(.regular, in: Circle())
  }

  private var link: some View {
    Capsule()
      .fill(Color.clear)
      .frame(width: 30, height: 2)
      .overlay {
        switch state {
        case .paired:
          Capsule().fill(Color.junoForeground.opacity(0.55))
        case .pending:
          Line()
            .stroke(Color.junoForeground.opacity(0.35), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [2, 5]))
        case .apart:
          EmptyView()
        }
      }
      .padding(.horizontal, JunoSpace.tight)
  }

  private struct Line: Shape {
    func path(in rect: CGRect) -> Path {
      var path = Path()
      path.move(to: CGPoint(x: rect.minX + 1, y: rect.midY))
      path.addLine(to: CGPoint(x: rect.maxX - 1, y: rect.midY))
      return path
    }
  }
}
