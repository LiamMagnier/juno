import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// A change to one skill (`PatchWorkSkillInput`). Absent fields are left
/// alone; `projectID: .some(nil)` moves the skill back to the account.
public struct NativeSkillPatch: Equatable, Sendable {
    public var name: String?
    public var description: String?
    public var enabled: Bool?
    public var autoSelect: Bool?
    /// `untrusted` or `user_authored`; `verified` is not a client's to set.
    public var trust: String?
    public var projectID: String??

    public init(
        name: String? = nil,
        description: String? = nil,
        enabled: Bool? = nil,
        autoSelect: Bool? = nil,
        trust: String? = nil,
        projectID: String?? = nil
    ) {
        self.name = name
        self.description = description
        self.enabled = enabled
        self.autoSelect = autoSelect
        self.trust = trust
        self.projectID = projectID
    }

    var json: JunoJSONValue {
        var object: [String: JunoJSONValue] = [:]
        if let name { object["name"] = .string(name) }
        if let description { object["description"] = .string(description) }
        if let enabled { object["enabled"] = .bool(enabled) }
        if let autoSelect { object["autoSelect"] = .bool(autoSelect) }
        if let trust { object["trust"] = .string(trust) }
        if let projectID { object["projectId"] = projectID.map(JunoJSONValue.string) ?? .null }
        return .object(object)
    }
}

/// Everything the skills pages ask the server for (`skills-transport.ts`):
///
///     GET    /api/skills                                  the library
///     PATCH  /api/skills/sources/{id}          {enabled}  a source's switch
///     DELETE /api/skills/sources/{id}                     remove a source
///     POST   /api/skills/sources/{id}/check               what changed upstream
///     POST   /api/skills/sources/{id}/update              apply it
///     POST   /api/skills/import/github         {source}   preview a repository
///                                              {source, commit, paths, renames} install
///     GET/PATCH/DELETE /api/work/skills/{id}              one skill
///     GET    /api/work/skills/{id}/versions               its history
///     POST   /api/work/skills/{id}/versions               a new version, or a restore
///     POST   /api/work/skills/{id}/versions/{v}/consent   approve what it asks for
///     POST   /api/work/skills                             write a new one
///
/// Every answer is a ``NativeSkillResult``: the web's `WorkResult`, which
/// keeps a refusal the server explained (409/429) apart from a failure the
/// reader can only retry. Every reader is tolerant: the library endpoints are
/// new, a deployment can be a step ahead of this build, and a field it does
/// not know must not take the page down.
public struct NativeSkillsClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    // MARK: The library

    public func library(for accountID: AccountID) async -> NativeSkillResult<NativeSkillLibrary> {
        await request(.get, "/api/skills", for: accountID) { root in
            let yours = Self.skills(root["yours"])
            let sources = Self.sources(root["sources"])
            return NativeSkillLibrary(
                yours: yours,
                sources: sources,
                total: root["total"]?.numberValue.map { Int($0) },
                truncated: root["truncated"]?.boolValue == true
            )
        }
    }

    public func setSourceEnabled(
        id: String,
        _ enabled: Bool,
        for accountID: AccountID
    ) async -> NativeSkillResult<NativeSkillSource?> {
        await request(
            .patch, "/api/skills/sources/\(id)", id: id, body: .object(["enabled": .bool(enabled)]), for: accountID
        ) { root in root["source"].flatMap(Self.source) }
    }

    /// Removes a source and the skills it brought; answers how many went.
    public func removeSource(id: String, for accountID: AccountID) async -> NativeSkillResult<Int> {
        await request(.delete, "/api/skills/sources/\(id)", id: id, for: accountID) { root in
            root["removed"]?.numberValue.map { Int($0) } ?? 0
        }
    }

    public func checkSource(id: String, for accountID: AccountID) async -> NativeSkillResult<NativeSkillSourceCheck> {
        await request(.post, "/api/skills/sources/\(id)/check", id: id, body: .object([:]), for: accountID) { root in
            NativeSkillSourceCheck(
                latestCommit: root["latestCommit"]?.stringValue ?? "",
                upToDate: root["upToDate"]?.boolValue == true,
                changed: Self.changes(root["changed"]),
                added: Self.changes(root["added"]),
                removed: Self.changes(root["removed"]),
                more: root["more"]?.boolValue == true
            )
        }
    }

    /// Applies an update the reader reviewed: the commit the check saw, and
    /// the paths they kept ticked.
    public func updateSource(
        id: String,
        commit: String,
        update: [String],
        install: [String],
        for accountID: AccountID
    ) async -> NativeSkillResult<NativeSkillSourceUpdateResult> {
        let body: JunoJSONValue = .object([
            "commit": .string(commit),
            "update": .array(update.map(JunoJSONValue.string)),
            "install": .array(install.map(JunoJSONValue.string)),
        ])
        return await request(.post, "/api/skills/sources/\(id)/update", id: id, body: body, for: accountID) { root in
            var skipped: [String] = []
            if case .array(let values)? = root["skipped"] {
                skipped = values.compactMap { value in
                    guard case .object(let object) = value else { return nil }
                    return object["reason"]?.stringValue
                }
            }
            return NativeSkillSourceUpdateResult(
                updated: Self.skills(root["updated"]).count,
                installed: Self.skills(root["installed"]).count,
                skipped: skipped,
                source: root["source"].flatMap(Self.source)
            )
        }
    }

    // MARK: Importing from GitHub

    /// Walks a repository and reports what is in it. Writes nothing.
    public func previewImport(
        source: String,
        for accountID: AccountID
    ) async -> NativeSkillResult<NativeSkillImportPreview> {
        await request(
            .post, "/api/skills/import/github", body: .object(["source": .string(source)]), for: accountID
        ) { root in
            let repository = Self.object(root["repository"]) ?? [:]
            var problems: [NativeSkillImportProblem] = []
            if case .array(let values)? = root["problems"] {
                problems = values.compactMap { value in
                    guard case .object(let object) = value, let path = object["path"]?.stringValue else { return nil }
                    return NativeSkillImportProblem(path: path, message: object["message"]?.stringValue ?? "")
                }
            }
            return NativeSkillImportPreview(
                repository: .init(
                    owner: repository["owner"]?.stringValue ?? "",
                    repo: repository["repo"]?.stringValue ?? "",
                    ref: repository["ref"]?.stringValue ?? "",
                    commit: repository["commit"]?.stringValue ?? "",
                    url: repository["url"]?.stringValue ?? ""
                ),
                skills: Self.candidates(root["skills"]),
                problems: problems,
                more: root["more"]?.boolValue == true,
                total: root["total"]?.numberValue.map { Int($0) }
            )
        }
    }

    /// Installs the chosen paths at the commit the preview read. `renames`
    /// is omitted when empty, so an older server reads the body it knows.
    public func install(
        source: String,
        commit: String,
        paths: [String],
        renames: [String: String],
        for accountID: AccountID
    ) async -> NativeSkillResult<NativeSkillImportOutcome> {
        var body: [String: JunoJSONValue] = [
            "source": .string(source),
            "commit": .string(commit),
            "paths": .array(paths.map(JunoJSONValue.string)),
        ]
        if !renames.isEmpty {
            body["renames"] = .object(renames.mapValues(JunoJSONValue.string))
        }
        return await request(.post, "/api/skills/import/github", body: .object(body), for: accountID) { root in
            var skipped: [NativeSkillImportOutcome.Skipped] = []
            if case .array(let values)? = root["skipped"] {
                skipped = values.compactMap { value in
                    guard case .object(let object) = value else { return nil }
                    return .init(
                        path: object["path"]?.stringValue ?? "",
                        message: object["message"]?.stringValue ?? ""
                    )
                }
            }
            var imported = 0
            if case .array(let values)? = root["imported"] { imported = values.count }
            return NativeSkillImportOutcome(
                importedCount: imported,
                skipped: skipped,
                blocked: root["blocked"]?.numberValue.map { Int($0) } ?? 0,
                source: root["source"].flatMap(Self.source)
            )
        }
    }

    // MARK: One skill

    public func skill(id: String, for accountID: AccountID) async -> NativeSkillResult<NativeSkillDetail> {
        await request(.get, "/api/work/skills/\(id)", id: id, for: accountID) { root in
            guard let skill = root["skill"].flatMap(Self.skill) else { throw SkillDecodeError() }
            var resources: [NativeSkillResource] = []
            if case .array(let values)? = root["resources"] {
                resources = values.compactMap { value in
                    guard case .object(let object) = value,
                        let id = object["attachmentId"]?.stringValue
                    else { return nil }
                    return NativeSkillResource(attachmentID: id, fileName: object["fileName"]?.stringValue ?? "")
                }
            }
            return NativeSkillDetail(
                skill: skill,
                version: root["version"].flatMap(Self.version),
                resources: resources,
                projectName: root["projectName"]?.stringValue,
                source: root["source"].flatMap(Self.source)
            )
        }
    }

    public func patch(
        id: String,
        _ patch: NativeSkillPatch,
        for accountID: AccountID
    ) async -> NativeSkillResult<NativeSkill> {
        await request(.patch, "/api/work/skills/\(id)", id: id, body: patch.json, for: accountID) { root in
            guard let skill = root["skill"].flatMap(Self.skill) else { throw SkillDecodeError() }
            return skill
        }
    }

    public func delete(id: String, for accountID: AccountID) async -> NativeSkillResult<Void> {
        await request(.delete, "/api/work/skills/\(id)", id: id, for: accountID) { _ in () }
    }

    public func versions(id: String, for accountID: AccountID) async -> NativeSkillResult<[NativeSkillVersion]> {
        await request(.get, "/api/work/skills/\(id)/versions", id: id, for: accountID) { root in
            guard case .array(let values)? = root["versions"] else { return [] }
            return values.compactMap(Self.version)
        }
    }

    /// Saves new instructions as a version, sending the rest of the
    /// declaration back whole.
    public func mintVersion(
        id: String,
        instructions: String,
        contract: JunoJSONValue?,
        requestedTools: [String]?,
        for accountID: AccountID
    ) async -> NativeSkillResult<NativeSkillVersion> {
        var body: [String: JunoJSONValue] = ["instructions": .string(instructions)]
        if let contract { body["contract"] = contract }
        if let requestedTools { body["requestedTools"] = .array(requestedTools.map(JunoJSONValue.string)) }
        return await request(
            .post, "/api/work/skills/\(id)/versions", id: id, body: .object(body), for: accountID
        ) { root in
            guard let version = root["version"].flatMap(Self.version) else { throw SkillDecodeError() }
            return version
        }
    }

    /// Brings an older version back as a new one.
    public func restoreVersion(
        id: String,
        version: Int,
        for accountID: AccountID
    ) async -> NativeSkillResult<NativeSkillVersion> {
        await request(
            .post, "/api/work/skills/\(id)/versions", id: id,
            body: .object(["restoreVersion": .number(Double(version))]), for: accountID
        ) { root in
            guard let version = root["version"].flatMap(Self.version) else { throw SkillDecodeError() }
            return version
        }
    }

    public func consent(
        id: String,
        version: Int,
        for accountID: AccountID
    ) async -> NativeSkillResult<NativeSkillVersion> {
        await request(
            .post, "/api/work/skills/\(id)/versions/\(version)/consent", id: id, body: .object([:]), for: accountID
        ) { root in
            guard let version = root["version"].flatMap(Self.version) else { throw SkillDecodeError() }
            return version
        }
    }

    /// Writes a new skill. A skill written here is yours (`authored`), and
    /// never chosen automatically until you say so on its page.
    public func create(
        name: String,
        description: String,
        instructions: String,
        for accountID: AccountID
    ) async -> NativeSkillResult<NativeSkill> {
        let body: JunoJSONValue = .object([
            "name": .string(name),
            "description": .string(description),
            "instructions": .string(instructions),
            "origin": .string("authored"),
            "autoSelect": .bool(false),
        ])
        return await request(.post, "/api/work/skills", body: body, for: accountID) { root in
            guard let skill = root["skill"].flatMap(Self.skill) else { throw SkillDecodeError() }
            return skill
        }
    }

    // MARK: Transport

    private struct SkillDecodeError: Error {}

    private func request<Value: Sendable>(
        _ method: HTTPMethod,
        _ path: String,
        id: String? = nil,
        body: JunoJSONValue? = nil,
        for accountID: AccountID,
        pick: ([String: JunoJSONValue]) throws -> Value
    ) async -> NativeSkillResult<Value> {
        if let id, !Self.isSafe(id) { return .failed(.rejected, message: nil) }
        let response: HTTPResponse
        do {
            var headers = ["accept": "application/json"]
            if body != nil { headers["content-type"] = "application/json" }
            response = try await sender.send(
                try NativeBearerRequest(
                    path: path,
                    method: method,
                    headers: try HTTPHeaders(headers),
                    body: try body.map { try JSONEncoder().encode($0) }
                ),
                for: accountID
            )
        } catch is URLError {
            return .failed(.offline, message: nil)
        } catch {
            return .failed(.server, message: nil)
        }
        let root = Self.body(response)
        guard (200...299).contains(response.statusCode) else {
            return Self.refusal(status: response.statusCode, body: root)
        }
        do {
            return .ok(try pick(root))
        } catch {
            return .failed(.server, message: nil)
        }
    }

    /// The same mapping as Work's: 409 and 429 are a decision with the
    /// server's sentence, 401/403 a sign-in, 404 a dead link, 400 this
    /// client's fault, anything else worth a retry.
    static func refusal<Value>(status: Int, body: [String: JunoJSONValue]) -> NativeSkillResult<Value> {
        let message = body["message"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        switch status {
        case 409, 429:
            return .blocked(
                reason: body["error"]?.stringValue ?? "unavailable",
                explanation: message ?? "Juno can’t do that right now. Try again in a moment."
            )
        case 401, 403:
            return .failed(.unauthorized, message: message)
        case 404:
            return .failed(.notFound, message: message)
        case 400:
            return .failed(.rejected, message: message)
        default:
            return .failed(.server, message: message)
        }
    }

    static func body(_ response: HTTPResponse) -> [String: JunoJSONValue] {
        guard let value = try? JSONDecoder().decode(JunoJSONValue.self, from: response.body),
            case .object(let root) = value
        else { return [:] }
        return root
    }

    static func isSafe(_ identifier: String) -> Bool {
        !identifier.isEmpty && identifier.count <= 200
            && !identifier.contains("/") && !identifier.contains("\\")
            && !identifier.contains("..") && !identifier.contains("%")
            && !identifier.contains("?") && !identifier.contains("#")
            && identifier.allSatisfy { !$0.isWhitespace && !$0.isNewline }
    }

    // MARK: Decoding

    static func object(_ value: JunoJSONValue?) -> [String: JunoJSONValue]? {
        guard case .object(let object)? = value else { return nil }
        return object
    }

    static func strings(_ value: JunoJSONValue?) -> [String] {
        guard case .array(let values)? = value else { return [] }
        return values.compactMap(\.stringValue)
    }

    static func skills(_ value: JunoJSONValue?) -> [NativeSkill] {
        guard case .array(let values)? = value else { return [] }
        return values.compactMap(skill)
    }

    static func skill(_ value: JunoJSONValue) -> NativeSkill? {
        guard case .object(let object) = value, let id = object["id"]?.stringValue else { return nil }
        let slug = object["slug"]?.stringValue ?? ""
        return NativeSkill(
            id: id,
            projectID: object["projectId"]?.stringValue,
            slug: slug,
            name: object["name"]?.stringValue ?? slug,
            description: object["description"]?.stringValue ?? "",
            currentVersion: object["currentVersion"]?.numberValue.map { Int($0) } ?? 1,
            enabled: object["enabled"]?.boolValue ?? true,
            trust: object["trust"]?.stringValue ?? "untrusted",
            autoSelect: object["autoSelect"]?.boolValue == true,
            securityStatus: object["securityStatus"]?.stringValue ?? "pending",
            createdAt: object["createdAt"]?.date,
            updatedAt: object["updatedAt"]?.date,
            sourceID: object["sourceId"]?.stringValue,
            sourcePath: object["sourcePath"]?.stringValue,
            requiresConsent: object["requiresConsent"]?.boolValue == true
        )
    }

    static func sources(_ value: JunoJSONValue?) -> [NativeSkillSource] {
        guard case .array(let values)? = value else { return [] }
        return values.compactMap(source)
    }

    static func source(_ value: JunoJSONValue) -> NativeSkillSource? {
        guard case .object(let object) = value, let id = object["id"]?.stringValue else { return nil }
        let owner = object["owner"]?.stringValue ?? ""
        let repo = object["repo"]?.stringValue ?? ""
        return NativeSkillSource(
            id: id,
            owner: owner,
            repo: repo,
            key: object["key"]?.stringValue,
            ref: object["ref"]?.stringValue ?? "",
            path: object["path"]?.stringValue ?? "",
            commit: object["commit"]?.stringValue ?? "",
            latestCommit: object["latestCommit"]?.stringValue,
            enabled: object["enabled"]?.boolValue != false,
            url: object["url"]?.stringValue,
            skills: skills(object["skills"])
        )
    }

    static func version(_ value: JunoJSONValue) -> NativeSkillVersion? {
        guard case .object(let object) = value,
            let id = object["id"]?.stringValue,
            let number = object["version"]?.numberValue
        else { return nil }
        var findings: [String] = []
        if case .object(let scan)? = object["securityScan"], case .array(let list)? = scan["findings"] {
            findings = list.compactMap { finding in
                guard case .object(let entry) = finding else { return nil }
                return entry["message"]?.stringValue
            }
        }
        return NativeSkillVersion(
            id: id,
            version: Int(number),
            instructions: object["instructions"]?.stringValue ?? "",
            contract: object["contract"] ?? .object([:]),
            requestedTools: strings(object["requestedTools"]),
            securityStatus: object["securityStatus"]?.stringValue ?? "pending",
            findings: findings,
            requiresConsent: object["requiresConsent"]?.boolValue == true,
            createdAt: object["createdAt"]?.date
        )
    }

    static func changes(_ value: JunoJSONValue?) -> [NativeSkillSourceChange] {
        guard case .array(let values)? = value else { return [] }
        return values.compactMap { value in
            guard case .object(let object) = value, let path = object["path"]?.stringValue else { return nil }
            return NativeSkillSourceChange(
                path: path,
                name: object["name"]?.stringValue ?? path,
                description: object["description"]?.stringValue ?? "",
                skillID: object["skillId"]?.stringValue,
                widensPermissions: object["widensPermissions"]?.boolValue == true
            )
        }
    }

    static func candidates(_ value: JunoJSONValue?) -> [NativeSkillImportCandidate] {
        guard case .array(let values)? = value else { return [] }
        return values.compactMap { value in
            guard case .object(let object) = value, let path = object["path"]?.stringValue else { return nil }
            let slug = object["slug"]?.stringValue ?? path
            return NativeSkillImportCandidate(
                path: path,
                slug: slug,
                name: object["name"]?.stringValue ?? slug,
                description: object["description"]?.stringValue ?? "",
                license: object["license"]?.stringValue,
                compatibility: object["compatibility"]?.stringValue,
                requestedTools: strings(object["requestedTools"]),
                droppedTools: strings(object["droppedTools"]),
                companionFiles: strings(object["companionFiles"]),
                url: object["url"]?.stringValue ?? "",
                installed: object["installed"]?.boolValue == true,
                slugTaken: object["slugTaken"]?.boolValue == true,
                suggestedSlug: object["suggestedSlug"]?.stringValue,
                securityStatus: object["securityStatus"]?.stringValue
            )
        }
    }
}
