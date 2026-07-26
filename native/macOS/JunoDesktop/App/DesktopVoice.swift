import AppKit
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import JunoVoiceKit
import SwiftUI

struct DesktopVoiceSession: Identifiable {
    let id = UUID()
    let controller: JunoRealtimeVoiceController
    let modelID: String
    let conversationID: String?
    let projectID: String?
}

enum DesktopVoiceError: LocalizedError {
    case unavailable

    var errorDescription: String? {
        "Voice transcript saving is unavailable for this account."
    }
}

/// Account-owned authorization adapter for the shared realtime audio engine.
///
/// The app supplies the bearer-authenticated request sender; JunoVoiceKit never
/// reaches into Keychain or creates a second backend client.
struct JunoDesktopVoiceAuthorization: JunoVoiceRelayAuthorizing {
    let sender: any NativeAuthenticatedRequestSending
    let accountID: AccountID

    func relayToken() async throws -> JunoVoiceRelayToken {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/voice/relay-token",
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw JunoDesktopVoiceAuthorizationError(
                message: serverMessage(response.body)
                    ?? fallbackMessage(statusCode: response.statusCode)
            )
        }
        guard let decoded = try? JSONDecoder().decode(
            JunoVoiceRelayTokenResponse.self,
            from: response.body
        ), !decoded.token.isEmpty else {
            throw JunoDesktopVoiceAuthorizationError(
                message: "Juno returned an invalid voice credential."
            )
        }
        return decoded.resolved
    }

    private func serverMessage(_ body: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return nil }
        if let message = object["message"] as? String, !message.isEmpty {
            return message
        }
        if let error = object["error"] as? String,
            !error.isEmpty, !error.contains("_")
        {
            return error
        }
        return nil
    }

    private func fallbackMessage(statusCode: Int) -> String {
        switch statusCode {
        case 401: "Sign in again to start voice."
        case 402, 403: "Voice is not available on this account or plan."
        case 429: "Voice is busy. Wait a moment and try again."
        case 503: "Realtime voice is not configured for this environment."
        default: "Juno could not authorize the voice session."
        }
    }
}

private struct JunoDesktopVoiceAuthorizationError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

struct DesktopVoiceView: View {
    @Bindable var controller: JunoRealtimeVoiceController
    let saveTranscript:
        (UUID, [NativeVoiceTranscriptClient.Turn]) async throws -> String
    let close: () -> Void

    @State private var sessionID = UUID()
    @State private var isSaving = false
    @State private var saveError: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            header
            HStack(spacing: 34) {
                orb
                VStack(alignment: .leading, spacing: 12) {
                    Text(statusTitle)
                        .font(.title2.weight(.semibold))
                    if let detail = statusDetail {
                        Text(detail)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let notice = controller.notice {
                        Label(notice, systemImage: "exclamationmark.circle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                    recovery
                }
                .frame(maxWidth: 300, alignment: .leading)
            }
            .padding(.horizontal, 38)
            .padding(.vertical, 28)

            transcript
            controls
        }
        .frame(minWidth: 700, idealWidth: 760, minHeight: 560, idealHeight: 620)
        .background(Color.junoCanvasWarm)
        .task { await controller.start() }
        .onDisappear { controller.end() }
        .interactiveDismissDisabled()
        .accessibilityIdentifier("juno.desktop.voice")
    }

    private var header: some View {
        HStack {
            Label("Voice conversation", systemImage: "waveform")
                .font(.headline)
            Spacer()
            Menu(controller.provider.displayName) {
                ForEach(JunoVoiceProvider.allCases) { provider in
                    Button {
                        if isLive {
                            controller.switchProvider(provider)
                        } else {
                            Task { await controller.start(provider: provider) }
                        }
                    } label: {
                        if provider == controller.provider {
                            Label(provider.displayName, systemImage: "checkmark")
                        } else {
                            Text(provider.displayName)
                        }
                    }
                }
            }
            Button {
                hangUp()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .help("End and save")
        }
        .padding(16)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }

    private var isLive: Bool {
        controller.phase == .live || controller.phase == .reconnecting
    }

    private var statusTitle: String {
        switch controller.phase {
        case .idle: "Starting…"
        case .connecting: "Connecting…"
        case .reconnecting: "Reconnecting…"
        case .ended: "Conversation ended"
        case .error: "Voice could not start"
        case .live:
            controller.assistantSpeaking
                ? "Juno is speaking"
                : (controller.muted ? "Microphone muted" : "Listening")
        }
    }

    private var statusDetail: String? {
        if let saveError { return saveError }
        switch controller.phase {
        case .error(let error):
            return error.errorDescription
        case .ended(let reason):
            return switch reason {
            case .sessionLimit: "This voice session reached its time limit."
            case .provider: "The voice provider ended this session."
            case .error: "The voice relay ended this session after an error."
            case .client: nil
            }
        default:
            guard let usage = controller.usage else { return nil }
            return String(
                format: "%.0f seconds · $%.3f",
                usage.audioInSec + usage.audioOutSec,
                usage.estCostUsd
            )
        }
    }

    @ViewBuilder
    private var recovery: some View {
        switch controller.phase {
        case .error(let error) where error.isPermissionDenial:
            Button("Open Privacy Settings") {
                let pane = error == .micPermissionDenied
                    ? "Privacy_Microphone" : "Privacy_SpeechRecognition"
                if let url = URL(
                    string: "x-apple.systempreferences:com.apple.preference.security?\(pane)"
                ) {
                    NSWorkspace.shared.open(url)
                }
            }
            .buttonStyle(.borderedProminent)
        case .error, .ended:
            Button("Start again") {
                saveError = nil
                Task { await controller.start() }
            }
            .buttonStyle(.borderedProminent)
        default:
            EmptyView()
        }
    }

    private var orb: some View {
        let level = reduceMotion ? 0 : min(max(controller.level, 0), 1)
        return ZStack {
            ForEach(0..<3, id: \.self) { ring in
                Circle()
                    .stroke(
                        Color.junoAccent.opacity(0.30 - Double(ring) * 0.08),
                        lineWidth: 1.5
                    )
                    .frame(width: 126, height: 126)
                    .scaleEffect(1 + Double(ring) * 0.22 + level * 0.16)
            }
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color.junoAccent.opacity(
                                controller.assistantSpeaking ? 0.95 : 0.76
                            ),
                            Color.junoAccent.opacity(0.46),
                        ],
                        center: .center,
                        startRadius: 4,
                        endRadius: 66
                    )
                )
                .frame(width: 126, height: 126)
                .scaleEffect(0.88 + level * 0.16)
        }
        .frame(width: 220, height: 220)
        .animation(.interpolatingSpring(stiffness: 210, damping: 19), value: level)
        .opacity(isLive ? 1 : 0.45)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var transcript: some View {
        if controller.transcript.isEmpty {
            Text("The live transcript will appear here.")
                .font(.callout)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(controller.transcript) { line in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(line.role == .user ? "You" : "Juno")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(line.text)
                                .foregroundStyle(
                                    line.final ? Color.primary : Color.secondary
                                )
                                .textSelection(.enabled)
                        }
                    }
                }
                .frame(maxWidth: 660, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding(20)
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 14) {
            Button {
                controller.toggleMute()
            } label: {
                Label(
                    controller.muted ? "Unmute" : "Mute",
                    systemImage: controller.muted ? "mic.slash.fill" : "mic.fill"
                )
            }
            .buttonStyle(.bordered)
            .disabled(!isLive)

            if controller.assistantSpeaking {
                Button {
                    controller.interrupt()
                } label: {
                    Label("Interrupt", systemImage: "hand.raised.fill")
                }
                .buttonStyle(.bordered)
            }

            Spacer()

            Button {
                hangUp()
            } label: {
                if isSaving {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Label("End and save", systemImage: "phone.down.fill")
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .disabled(isSaving)
        }
        .padding(16)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    private var savableTurns: [NativeVoiceTranscriptClient.Turn] {
        controller.transcript.compactMap { line in
            let content = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.final, !content.isEmpty else { return nil }
            return NativeVoiceTranscriptClient.Turn(
                role: line.role == .assistant ? .assistant : .user,
                content: content
            )
        }
    }

    private func hangUp() {
        controller.end()
        let turns = savableTurns
        guard !turns.isEmpty else {
            close()
            return
        }
        isSaving = true
        saveError = nil
        Task {
            do {
                _ = try await saveTranscript(sessionID, turns)
                close()
            } catch {
                saveError = error.localizedDescription
                isSaving = false
            }
        }
    }
}
