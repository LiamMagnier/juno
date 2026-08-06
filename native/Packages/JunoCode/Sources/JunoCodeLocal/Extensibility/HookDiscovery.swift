import Foundation
import JunoCodeCore

/// Reads only the two known, workspace-relative configuration files. The
/// `WorkspaceAccessing` gateway resolves and canonicalizes every path before
/// this type reads it, so a symlink cannot smuggle an external settings file
/// into the catalog.
public struct HookDiscovery: Sendable {
    private let access: any WorkspaceAccessing
    private let parser: HookConfigurationParser

    public init(
        access: any WorkspaceAccessing,
        parser: HookConfigurationParser = HookConfigurationParser()
    ) {
        self.access = access
        self.parser = parser
    }

    public func discover() -> HookDiscoveryResult {
        var configurations: [HookConfiguration] = []
        var hooks: [HookDefinition] = []
        var diagnostics: [HookDiagnostic] = []

        // Claude first and Juno second mirrors SlashCommands: a repository can
        // migrate one hook at a time, and the Juno convention wins when the
        // caller later chooses to de-duplicate by identity/name.
        for source in [ExtensibilitySource.claude, .juno] {
            let path = source.hooksPath
            guard let workspacePath = try? WorkspacePath(path) else {
                diagnostics.append(
                    HookDiagnostic(
                        path: path,
                        severity: .error,
                        message: "The built-in hook path is invalid."
                    )
                )
                continue
            }
            guard let url = try? access.resolveForReading(workspacePath) else {
                // Missing optional configuration is normal and should not put
                // a warning in the inspector.
                continue
            }
            guard FileManager.default.fileExists(atPath: url.path) else { continue }

            do {
                let data = try Self.readBoundedData(from: url)
                let configuration = try parser.parse(
                    data: data,
                    source: source,
                    path: path
                )
                configurations.append(configuration)
                hooks.append(contentsOf: configuration.hooks)
                diagnostics.append(contentsOf: configuration.diagnostics)
            } catch let error as HookDiscoveryReadError {
                diagnostics.append(
                    HookDiagnostic(
                        path: path,
                        severity: .error,
                        message: error.message
                    )
                )
            } catch let error as HookConfigurationError {
                diagnostics.append(
                    HookDiagnostic(
                        path: path,
                        severity: .error,
                        message: Self.configurationErrorMessage(error)
                    )
                )
            } catch {
                diagnostics.append(
                    HookDiagnostic(
                        path: path,
                        severity: .error,
                        message: "The hook configuration could not be read."
                    )
                )
            }
        }

        hooks.sort {
            if $0.source != $1.source {
                return $0.source == .claude
            }
            if $0.event != $1.event {
                return $0.event.rawValue < $1.event.rawValue
            }
            return $0.ordinal < $1.ordinal
        }
        return HookDiscoveryResult(
            configurations: configurations,
            hooks: hooks,
            diagnostics: diagnostics
        )
    }

    private static func readBoundedData(from url: URL) throws -> Data {
        if let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
           let size = values.fileSize,
           size > HookExecutionLimits.maximumConfigurationBytes
        {
            throw HookDiscoveryReadError.tooLarge
        }
        do {
            let data = try Data(contentsOf: url, options: [.mappedIfSafe])
            guard data.count <= HookExecutionLimits.maximumConfigurationBytes else {
                throw HookDiscoveryReadError.tooLarge
            }
            return data
        } catch let error as HookDiscoveryReadError {
            throw error
        } catch {
            throw HookDiscoveryReadError.unreadable
        }
    }

    private static func configurationErrorMessage(_ error: HookConfigurationError) -> String {
        switch error {
        case .invalidJSON:
            return "The hook configuration is not valid JSON."
        case .rootMustBeObject:
            return "The hook configuration must be a JSON object."
        case .hooksMustBeObject:
            return "The `hooks` field must be a JSON object."
        }
    }
}

private enum HookDiscoveryReadError: Error {
    case tooLarge
    case unreadable

    var message: String {
        switch self {
        case .tooLarge:
            return "The hook configuration exceeds Juno's size limit."
        case .unreadable:
            return "The hook configuration could not be read."
        }
    }
}
