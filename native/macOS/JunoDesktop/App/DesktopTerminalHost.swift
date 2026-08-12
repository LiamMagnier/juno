import Foundation
import Combine
import Observation

/// A native terminal host that wraps a macOS `Process` to execute bash commands,
/// allowing Juno Code to run local servers, git commands, and scripts autonomously.
@MainActor
@Observable
final class DesktopTerminalHost {
    static let shared = DesktopTerminalHost()

    private var process: Process?
    private var outputPipe: Pipe?
    private var inputPipe: Pipe?
    
    /// The raw terminal output buffer.
    private(set) var transcript: String = ""
    private(set) var isRunning: Bool = false
    
    init() {}
    
    /// Executes a command in the specified directory.
    func execute(command: String, in directory: URL? = nil) {
        guard !isRunning else { return }
        
        transcript += "\n$ \(command)\n"
        
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-c", command]
        
        if let dir = directory {
            process.currentDirectoryURL = dir
        }
        
        let outPipe = Pipe()
        let inPipe = Pipe()
        
        process.standardOutput = outPipe
        process.standardError = outPipe
        process.standardInput = inPipe
        
        self.process = process
        self.outputPipe = outPipe
        self.inputPipe = inPipe
        
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let string = String(data: data, encoding: .utf8) else { return }
            
            DispatchQueue.main.async {
                self?.transcript += string
            }
        }
        
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.isRunning = false
                self?.outputPipe?.fileHandleForReading.readabilityHandler = nil
            }
        }
        
        do {
            try process.run()
            isRunning = true
        } catch {
            transcript += "Error: Failed to launch process.\n\(error.localizedDescription)"
        }
    }
    
    /// Sends input directly to the running process (e.g. answering prompts).
    func sendInput(_ input: String) {
        guard isRunning, let inPipe = inputPipe else { return }
        if let data = (input + "\n").data(using: .utf8) {
            inPipe.fileHandleForWriting.write(data)
        }
    }
    
    func terminate() {
        process?.terminate()
        isRunning = false
    }
}
