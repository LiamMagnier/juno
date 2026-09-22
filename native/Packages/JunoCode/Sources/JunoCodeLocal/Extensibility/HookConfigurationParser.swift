import Foundation
import JunoCodeCore

/// Parses the small, safe subset of repository hook configuration Juno can
/// execute. The parser is intentionally more permissive about *shape* than
/// the runner is about *authority*: unknown keys are ignored, unsupported hook
/// types are diagnosed, and no parsed command is ever executed here.
public struct HookConfigurationParser: Sendable {
    public init() {}

    /// Where the hooks being parsed came from, carried into every definition.
    private struct Provenance {
        let source: ExtensibilitySource
        let path: String
        let trust: ExtensibilityTrust
    }

    /// Parses one of the known hook files, with that file's provenance.
    public func parse(data: Data, file: HookConfigurationFile) throws -> HookConfiguration {
        try parse(
            data: data,
            source: file.source,
            path: file.path,
            trust: file.trust,
            allowsBareEventMap: file == .junoHooks
        )
    }

    /// - Parameter allowsBareEventMap: whether the event map may be the file's
    ///   root. Only Juno's own `hooks.json` has that compact form; a settings
    ///   file always nests hooks under `hooks`, beside unrelated settings.
    ///   Nil keeps the older rule: any Juno file may.
    public func parse(
        data: Data,
        source: ExtensibilitySource,
        path: String,
        trust: ExtensibilityTrust = .untrustedWorkspace,
        allowsBareEventMap: Bool? = nil
    ) throws -> HookConfiguration {
        let root: JSONValue
        do {
            root = try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            throw HookConfigurationError.invalidJSON(path: path)
        }
        guard let object = root.objectValue else {
            throw HookConfigurationError.rootMustBeObject(path: path)
        }

        if object["disableAllHooks"]?.boolValue == true {
            return HookConfiguration(
                source: source,
                path: path,
                hooks: [],
                diagnostics: [
                    HookDiagnostic(
                        path: path,
                        severity: .warning,
                        message: "Hooks are disabled by this configuration."
                    )
                ],
                disablesAllHooks: true
            )
        }

        let hooksValue: JSONValue?
        if let explicit = object["hooks"] {
            hooksValue = explicit
        } else if allowsBareEventMap ?? (source == .juno),
                  object.keys.contains(where: { HookLifecycleEvent(configurationKey: $0) != nil })
        {
            hooksValue = .object(object)
        } else {
            hooksValue = nil
        }

        guard let hooksValue else {
            return HookConfiguration(source: source, path: path, hooks: [])
        }
        guard let hooksObject = hooksValue.objectValue else {
            throw HookConfigurationError.hooksMustBeObject(path: path)
        }

        let provenance = Provenance(source: source, path: path, trust: trust)
        var hooks: [HookDefinition] = []
        var diagnostics: [HookDiagnostic] = []
        var ordinal = 0

        for key in hooksObject.keys.sorted() {
            guard let value = hooksObject[key] else { continue }
            guard let event = HookLifecycleEvent(configurationKey: key) else {
                diagnostics.append(
                    HookDiagnostic(
                        path: path,
                        location: key,
                        message: "Unsupported hook event was ignored."
                    )
                )
                continue
            }

            parseEventValue(
                value,
                event: event,
                inheritedMatcher: nil,
                provenance: provenance,
                hooks: &hooks,
                diagnostics: &diagnostics,
                ordinal: &ordinal
            )
        }

        return HookConfiguration(
            source: source,
            path: path,
            hooks: hooks,
            diagnostics: diagnostics
        )
    }

    public func parse(
        json: String,
        source: ExtensibilitySource,
        path: String,
        trust: ExtensibilityTrust = .untrustedWorkspace
    ) throws -> HookConfiguration {
        try parse(data: Data(json.utf8), source: source, path: path, trust: trust)
    }

    // MARK: - Event shapes

    private func parseEventValue(
        _ value: JSONValue,
        event: HookLifecycleEvent,
        inheritedMatcher: String?,
        provenance: Provenance,
        hooks: inout [HookDefinition],
        diagnostics: inout [HookDiagnostic],
        ordinal: inout Int
    ) {
        let path = provenance.path
        guard hooks.count < HookExecutionLimits.maximumHooksPerConfiguration else {
            diagnostics.append(
                HookDiagnostic(
                    path: path,
                    location: event.rawValue,
                    severity: .error,
                    message: "The configuration exceeded Juno's hook limit; remaining hooks were ignored."
                )
            )
            return
        }

        switch value {
        case let .array(items):
            for (index, item) in items.enumerated() {
                guard hooks.count < HookExecutionLimits.maximumHooksPerConfiguration else {
                    diagnostics.append(
                        HookDiagnostic(
                            path: path,
                            location: "\(event.rawValue)[\(index)]",
                            severity: .error,
                            message: "The configuration exceeded Juno's hook limit; remaining hooks were ignored."
                        )
                    )
                    return
                }
                parseEventValue(
                    item,
                    event: event,
                    inheritedMatcher: inheritedMatcher,
                    provenance: provenance,
                    hooks: &hooks,
                    diagnostics: &diagnostics,
                    ordinal: &ordinal
                )
            }

        case let .object(object):
            // Claude's shape is an array of matcher groups, each carrying a
            // nested `hooks` array. Supporting an object here also makes the
            // compact Juno form ergonomic.
            if let nested = object["hooks"] {
                let validatedMatcher = tryMatcher(
                    object["matcher"],
                    path: path,
                    location: event.rawValue,
                    diagnostics: &diagnostics
                )
                guard validatedMatcher.valid else { return }
                let matcher = validatedMatcher.value ?? inheritedMatcher
                parseEventValue(
                    nested,
                    event: event,
                    inheritedMatcher: matcher,
                    provenance: provenance,
                    hooks: &hooks,
                    diagnostics: &diagnostics,
                    ordinal: &ordinal
                )
            } else {
                parseCommandObject(
                    object,
                    event: event,
                    inheritedMatcher: inheritedMatcher,
                    provenance: provenance,
                    hooks: &hooks,
                    diagnostics: &diagnostics,
                    ordinal: &ordinal
                )
            }

        case let .string(command):
            appendHook(
                command: command,
                matcher: inheritedMatcher,
                timeout: nil,
                event: event,
                provenance: provenance,
                location: event.rawValue,
                hooks: &hooks,
                diagnostics: &diagnostics,
                ordinal: &ordinal
            )

        case .null, .bool, .number:
            diagnostics.append(
                HookDiagnostic(
                    path: path,
                    location: event.rawValue,
                    message: "The hook entry must be a command string or object."
                )
            )
        }
    }

    private func parseCommandObject(
        _ object: [String: JSONValue],
        event: HookLifecycleEvent,
        inheritedMatcher: String?,
        provenance: Provenance,
        hooks: inout [HookDefinition],
        diagnostics: inout [HookDiagnostic],
        ordinal: inout Int
    ) {
        let path = provenance.path
        let location = "\(event.rawValue)[\(ordinal)]"
        if let type = object["type"]?.stringValue,
           type.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != "command"
        {
            diagnostics.append(
                HookDiagnostic(
                    path: path,
                    location: location,
                    message: "Only command hooks are supported; this hook type was ignored."
                )
            )
            ordinal += 1
            return
        }

        if object["type"] != nil, object["type"]?.stringValue == nil {
            diagnostics.append(
                HookDiagnostic(
                    path: path,
                    location: location,
                    message: "The hook type must be a string."
                )
            )
            ordinal += 1
            return
        }

        let matcher: String?
        if object["matcher"] != nil {
            let validatedMatcher = tryMatcher(
                object["matcher"],
                path: path,
                location: location,
                diagnostics: &diagnostics
            )
            guard validatedMatcher.valid else {
                ordinal += 1
                return
            }
            matcher = validatedMatcher.value
        } else {
            matcher = inheritedMatcher
        }

        let timeout: Double?
        if let rawTimeout = object["timeout_seconds"] ?? object["timeout"] {
            guard let number = rawTimeout.numberValue else {
                diagnostics.append(
                    HookDiagnostic(
                        path: path,
                        location: location,
                        message: "The hook timeout must be a number of seconds."
                    )
                )
                ordinal += 1
                return
            }
            timeout = number
        } else {
            timeout = nil
        }

        if object["async"]?.boolValue == true {
            diagnostics.append(
                HookDiagnostic(
                    path: path,
                    location: location,
                    message: "Asynchronous fire-and-forget hooks are not supported in the bounded runner."
                )
            )
            ordinal += 1
            return
        }

        // Claude Code's `if` narrows a hook with a permission rule. Juno does
        // not evaluate it, and says so, rather than let the reader believe a
        // hook runs less often than it does.
        if object["if"] != nil {
            diagnostics.append(
                HookDiagnostic(
                    path: path,
                    location: location,
                    message: "The `if` filter is not supported; this hook runs for every call its matcher matches."
                )
            )
        }

        guard let command = object["command"]?.stringValue else {
            diagnostics.append(
                HookDiagnostic(
                    path: path,
                    location: location,
                    message: "A command hook requires a string `command`."
                )
            )
            ordinal += 1
            return
        }

        appendHook(
            command: command,
            matcher: matcher,
            timeout: timeout,
            event: event,
            provenance: provenance,
            location: location,
            hooks: &hooks,
            diagnostics: &diagnostics,
            ordinal: &ordinal
        )
    }

    // MARK: - Validation

    private func tryMatcher(
        _ value: JSONValue?,
        path: String,
        location: String,
        diagnostics: inout [HookDiagnostic]
    ) -> (value: String?, valid: Bool) {
        guard let value else { return (nil, true) }
        guard let raw = value.stringValue else {
            diagnostics.append(
                HookDiagnostic(
                    path: path,
                    location: location,
                    message: "The hook matcher must be a string."
                )
            )
            return (nil, false)
        }
        let matcher = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if matcher.isEmpty || matcher == "*" {
            return (nil, true)
        }
        guard matcher.utf8.count <= HookExecutionLimits.maximumMatcherBytes else {
            diagnostics.append(
                HookDiagnostic(
                    path: path,
                    location: location,
                    message: "The hook matcher is too long."
                )
            )
            return (nil, false)
        }
        guard (try? NSRegularExpression(pattern: matcher)) != nil else {
            diagnostics.append(
                HookDiagnostic(
                    path: path,
                    location: location,
                    message: "The hook matcher is not a valid regular expression."
                )
            )
            return (nil, false)
        }
        return (matcher, true)
    }

    private func appendHook(
        command rawCommand: String,
        matcher: String?,
        timeout: Double?,
        event: HookLifecycleEvent,
        provenance: Provenance,
        location: String,
        hooks: inout [HookDefinition],
        diagnostics: inout [HookDiagnostic],
        ordinal: inout Int
    ) {
        defer { ordinal += 1 }
        let path = provenance.path
        let command = rawCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else {
            diagnostics.append(
                HookDiagnostic(
                    path: path,
                    location: location,
                    message: "An empty hook command was ignored."
                )
            )
            return
        }
        guard !command.unicodeScalars.contains(where: { $0.value == 0 }) else {
            diagnostics.append(
                HookDiagnostic(
                    path: path,
                    location: location,
                    message: "A hook command containing a NUL byte was ignored."
                )
            )
            return
        }
        guard command.utf8.count <= HookExecutionLimits.maximumCommandBytes else {
            diagnostics.append(
                HookDiagnostic(
                    path: path,
                    location: location,
                    message: "The hook command is too long."
                )
            )
            return
        }

        switch CommandClassifier().classify(command) {
        case let .forbidden(reason):
            diagnostics.append(
                HookDiagnostic(
                    path: path,
                    location: location,
                    severity: .error,
                    message: "The hook command is forbidden by the command policy: " + reason
                )
            )
            return
        case let .permitted(risk, _):
            var effectiveTimeout = timeout ?? HookExecutionLimits.defaultTimeoutSeconds
            guard effectiveTimeout.isFinite, effectiveTimeout > 0 else {
                diagnostics.append(
                    HookDiagnostic(
                        path: path,
                        location: location,
                        message: "The hook timeout must be a positive number of seconds."
                    )
                )
                return
            }
            if effectiveTimeout > HookExecutionLimits.maximumTimeoutSeconds {
                effectiveTimeout = HookExecutionLimits.maximumTimeoutSeconds
                diagnostics.append(
                    HookDiagnostic(
                        path: path,
                        location: location,
                        message: "The hook timeout was shortened to Juno's limit of \(Int(HookExecutionLimits.maximumTimeoutSeconds)) seconds."
                    )
                )
            }

            let hookMatcher = HookMatcher(pattern: matcher)
            // Only an identical earlier entry shifts this one's ID; see
            // `HookDefinition.makeID`.
            let occurrence = hooks.count(where: {
                $0.event == event && $0.matcher == hookMatcher && $0.command == command
            })
            hooks.append(
                HookDefinition(
                    event: event,
                    matcher: hookMatcher,
                    command: command,
                    timeoutSeconds: effectiveTimeout,
                    source: provenance.source,
                    path: path,
                    ordinal: ordinal,
                    occurrence: occurrence,
                    trust: provenance.trust,
                    risk: risk
                )
            )
        }
    }
}
