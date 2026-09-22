import Foundation
import JunoCodeCore

/// Reads hooks from the known settings files and nothing else.
///
/// Repository files are read through the `WorkspaceAccessing` gateway, which
/// resolves and canonicalizes every path before this type reads it, so a
/// symlink cannot smuggle an external settings file into the catalog. The
/// reader's own `~/.juno/settings.json` is read directly, and only when the
/// caller names the folder it lives in — a test, or a host that has no user
/// settings, passes nil and gets repository hooks alone.
public struct HookDiscovery: Sendable {
    private let access: any WorkspaceAccessing
    private let userSettingsDirectory: URL?
    private let parser: HookConfigurationParser

    public init(
        access: any WorkspaceAccessing,
        userSettingsDirectory: URL? = nil,
        parser: HookConfigurationParser = HookConfigurationParser()
    ) {
        self.access = access
        self.userSettingsDirectory = userSettingsDirectory
        self.parser = parser
    }

    public func discover() -> HookDiscoveryResult {
        var configurations: [HookConfiguration] = []
        var hooks: [HookDefinition] = []
        var diagnostics: [HookDiagnostic] = []
        var readerDisabledAll = false
        var repositoryDisabledBy: String?

        // The reader's file first, then Claude's, then Juno's: the order hooks
        // are listed and, within one event, the order their results are read.
        // They run in parallel, so the order decides only whose reason is
        // quoted when two hooks block the same call.
        for file in HookConfigurationFile.allCases {
            let url: URL
            do {
                guard let resolved = try locate(file) else { continue }
                url = resolved
            } catch {
                diagnostics.append(
                    HookDiagnostic(
                        path: file.path,
                        severity: .error,
                        message: "The built-in hook path is invalid."
                    )
                )
                continue
            }
            // Missing optional configuration is normal and should not put a
            // warning in the inspector.
            guard FileManager.default.fileExists(atPath: url.path) else { continue }

            do {
                let data = try Self.readBoundedData(from: url)
                let configuration = try parser.parse(data: data, file: file)
                configurations.append(configuration)
                hooks.append(contentsOf: configuration.hooks)
                diagnostics.append(contentsOf: configuration.diagnostics)
                if configuration.disablesAllHooks {
                    if file.isInRepository {
                        repositoryDisabledBy = repositoryDisabledBy ?? file.path
                    } else {
                        readerDisabledAll = true
                    }
                }
            } catch let error as HookDiscoveryReadError {
                diagnostics.append(
                    HookDiagnostic(
                        path: file.path,
                        severity: .error,
                        message: error.message
                    )
                )
            } catch let error as HookConfigurationError {
                diagnostics.append(
                    HookDiagnostic(
                        path: file.path,
                        severity: .error,
                        message: Self.configurationErrorMessage(error)
                    )
                )
            } catch {
                diagnostics.append(
                    HookDiagnostic(
                        path: file.path,
                        severity: .error,
                        message: "The hook configuration could not be read."
                    )
                )
            }
        }

        // `disableAllHooks` turns hooks off, as in Claude Code, but only as far
        // as the file's author reaches. Turning a hook off is not the safe
        // direction when the hook is a guard: a reader who keeps a
        // `PreToolUse` check against force-pushes in their own file must not
        // lose it to a line in a cloned repository, or in a local settings
        // file the agent can write. So the reader's file switches off every
        // hook, and a repository's file only the repository's.
        let disabledBy: String?
        if readerDisabledAll {
            hooks = []
            disabledBy = HookConfigurationFile.junoUser.path
        } else if let repositoryDisabledBy {
            hooks.removeAll(where: \.isUntrusted)
            disabledBy = repositoryDisabledBy
        } else {
            disabledBy = nil
        }

        let fileOrder = Dictionary(
            uniqueKeysWithValues: HookConfigurationFile.allCases.enumerated().map { ($1.path, $0) }
        )
        let eventOrder = Dictionary(
            uniqueKeysWithValues: HookLifecycleEvent.allCases.enumerated().map { ($1, $0) }
        )
        hooks.sort {
            let left = fileOrder[$0.path] ?? Int.max
            let right = fileOrder[$1.path] ?? Int.max
            if left != right { return left < right }
            if $0.event != $1.event {
                return (eventOrder[$0.event] ?? 0) < (eventOrder[$1.event] ?? 0)
            }
            return $0.ordinal < $1.ordinal
        }
        return HookDiscoveryResult(
            configurations: configurations,
            hooks: hooks,
            diagnostics: diagnostics,
            disabledBy: disabledBy
        )
    }

    /// The file's location, or nil when it cannot exist here: the user file
    /// without a user folder, or a repository path the gateway will not
    /// resolve (for example, one that does not exist).
    private func locate(_ file: HookConfigurationFile) throws -> URL? {
        guard file.isInRepository else {
            return userSettingsDirectory?.appendingPathComponent("settings.json")
        }
        let workspacePath = try WorkspacePath(file.path)
        return try? access.resolveForReading(workspacePath)
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
