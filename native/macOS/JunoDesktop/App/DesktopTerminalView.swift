import SwiftUI

struct DesktopTerminalView: View {
    @Bindable var host: DesktopTerminalHost
    @State private var commandInput: String = ""
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Terminal")
                    .font(.system(.subheadline, design: .monospaced, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if host.isRunning {
                    ProgressView()
                        .controlSize(.small)
                    Button("Stop") {
                        host.terminate()
                    }
                    .buttonStyle(.plain)
                    .foregroundColor(.red)
                    .font(.caption)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial)
            .overlay(alignment: .bottom) {
                Divider()
            }
            
            // Output
            ScrollView {
                Text(host.transcript)
                    .font(.system(.caption, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black.opacity(0.85))
            
            // Input
            HStack {
                Text(">")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(.secondary)
                TextField("Enter command...", text: $commandInput)
                    .textFieldStyle(.plain)
                    .font(.system(.caption, design: .monospaced))
                    .onSubmit {
                        if host.isRunning {
                            host.sendInput(commandInput)
                        } else {
                            host.execute(command: commandInput)
                        }
                        commandInput = ""
                    }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial)
            .overlay(alignment: .top) {
                Divider()
            }
        }
    }
}
