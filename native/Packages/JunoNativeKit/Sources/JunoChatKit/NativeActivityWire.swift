import Foundation
import JunoCore

/// One `ClientActivityEvent` off the wire — the live `activity` frame's
/// `event`, and every row of a message's persisted `activity`.
///
/// **Every field past the legacy five is lossy.** The typed payloads are the
/// rework's (Tool calls & research SPEC §2.4) and additive; a shape this build
/// reads wrongly must cost that field, never the row, and a row must never cost
/// the stream.
struct NativeActivityWire: Decodable {
    let id: String
    let kind: String
    let title: String
    let detail: String?
    let url: String?
    let createdAt: String?
    let seq: Int?
    let round: Int?
    let tool: ToolDetailWire?
    let memoryReceipt: LossyList<MemoryReceiptWire>?
    let call: CallWire?
    let segment: SegmentWire?
    let commentary: CommentaryWire?
    let notice: NoticeWire?
    let fact: FactWire?

    private enum CodingKeys: String, CodingKey {
        case id, kind, title, detail, url, createdAt, seq, round, tool, memoryReceipt, call, segment,
             commentary, notice, fact
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decode(String.self, forKey: .kind)
        title = try container.decode(String.self, forKey: .title)
        detail = try? container.decodeIfPresent(String.self, forKey: .detail)
        url = try? container.decodeIfPresent(String.self, forKey: .url)
        createdAt = try? container.decodeIfPresent(String.self, forKey: .createdAt)
        seq = try? container.decodeIfPresent(Int.self, forKey: .seq)
        round = try? container.decodeIfPresent(Int.self, forKey: .round)
        tool = try? container.decodeIfPresent(ToolDetailWire.self, forKey: .tool)
        memoryReceipt = try? container.decodeIfPresent(LossyList<MemoryReceiptWire>.self, forKey: .memoryReceipt)
        call = try? container.decodeIfPresent(CallWire.self, forKey: .call)
        segment = try? container.decodeIfPresent(SegmentWire.self, forKey: .segment)
        commentary = try? container.decodeIfPresent(CommentaryWire.self, forKey: .commentary)
        notice = try? container.decodeIfPresent(NoticeWire.self, forKey: .notice)
        fact = try? container.decodeIfPresent(FactWire.self, forKey: .fact)
    }

    func activity(parseDate: (String) -> Date?) -> NativeChatActivity? {
        guard !id.isEmpty, id.utf8.count <= 256, title.utf8.count <= 2_000 else { return nil }
        return NativeChatActivity(
            id: id,
            kind: NativeChatActivity.Kind(rawValue: kind) ?? .unknown,
            title: title,
            detail: detail.map { String($0.prefix(4_000)) },
            url: url,
            createdAt: createdAt.flatMap(parseDate),
            seq: seq.flatMap { $0 > 0 ? $0 : nil },
            round: round.flatMap { $0 >= 0 ? $0 : nil },
            call: call?.record(parseDate: parseDate),
            segment: segment.map { NativeReasoningSegment(round: $0.round ?? 0, part: $0.part, offset: max(0, $0.offset)) },
            commentary: commentary.map {
                // Untruncated on the wire (≤ 64 KiB, INV-4): commentary is
                // never cut, it is the model's own words.
                NativeRunCommentary(round: $0.round ?? 0, text: String($0.text.prefix(65_536)), inline: $0.inline ?? true)
            },
            notice: notice.map { NativeRunNotice(code: $0.code, params: $0.params ?? [:]) },
            fact: fact?.fact,
            tool: tool?.detail,
            memory: (memoryReceipt?.elements ?? []).map {
                NativeMemoryReceipt(id: $0.id, content: $0.content, category: $0.category)
            }
        )
    }

    struct ToolDetailWire: Decodable {
        let server: String
        let name: String
        let args: String?
        let argsNote: String?
        let argsTruncated: Bool?
        let result: String?
        let resultNote: String?
        let resultTruncated: Bool?
        let resultChars: Int?
        let status: String?
        let durationMs: Double?

        var detail: NativeToolDetail {
            NativeToolDetail(
                server: server,
                name: name,
                args: args,
                argsNote: argsNote,
                argsTruncated: argsTruncated ?? false,
                result: result,
                resultNote: resultNote,
                resultTruncated: resultTruncated ?? false,
                resultChars: resultChars,
                status: status,
                durationMs: durationMs.map { Int($0.rounded()) }
            )
        }
    }

    struct MemoryReceiptWire: Decodable {
        let id: String
        let content: String
        let category: String?
    }

    struct SegmentWire: Decodable {
        let round: Int?
        let part: Int?
        let offset: Int
    }

    struct CommentaryWire: Decodable {
        let round: Int?
        let text: String
        let inline: Bool?
    }

    struct NoticeWire: Decodable {
        let code: String
        let params: [String: String]?

        private enum CodingKeys: String, CodingKey { case code, params }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            code = try container.decode(String.self, forKey: .code)
            // Params are strings or numbers on the wire; both read as text.
            if let raw = try? container.decodeIfPresent([String: JunoJSONValue].self, forKey: .params) {
                var params: [String: String] = [:]
                for (key, value) in raw {
                    switch value {
                    case .string(let text): params[key] = text
                    case .number(let number):
                        params[key] = number.rounded() == number ? String(Int(number)) : String(number)
                    case .bool(let flag): params[key] = flag ? "true" : "false"
                    default: continue
                    }
                }
                self.params = params
            } else {
                params = nil
            }
        }
    }

    /// `RunFact`, by its `key`. A key this build does not know is dropped.
    struct FactWire: Decodable {
        struct ConnectorWire: Decodable {
            let id: String
            let label: String
            let tools: Int?
            let reason: String?
        }

        let fact: NativeRunFact?

        private enum CodingKeys: String, CodingKey {
            case key, modelId, provider, label, routed, effort, auto, historyMessages, attachments, projectFiles,
                 offered, nativeSearch, roundBudget, ready, failed, runId, title, workedMs, cited, read, pages,
                 leadModel, state
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            func int(_ key: CodingKeys) -> Int {
                (try? container.decodeIfPresent(Double.self, forKey: key)).map { Int($0.rounded()) } ?? 0
            }
            func text(_ key: CodingKeys) -> String? {
                (try? container.decodeIfPresent(String.self, forKey: key)) ?? nil
            }
            switch text(.key) {
            case "model":
                guard let modelID = text(.modelId) else { fact = nil; return }
                fact = .model(
                    modelID: modelID,
                    provider: text(.provider) ?? "",
                    label: text(.label) ?? modelID,
                    routed: ((try? container.decodeIfPresent(Bool.self, forKey: .routed)) ?? nil) ?? false
                )
            case "effort":
                guard let effort = text(.effort) else { fact = nil; return }
                fact = .effort(effort: effort, auto: ((try? container.decodeIfPresent(Bool.self, forKey: .auto)) ?? nil) ?? false)
            case "context":
                fact = .context(historyMessages: int(.historyMessages), attachments: int(.attachments), projectFiles: int(.projectFiles))
            case "tools":
                let offered = ((try? container.decodeIfPresent([String].self, forKey: .offered)) ?? nil) ?? []
                fact = .tools(
                    offered: offered,
                    nativeSearch: ((try? container.decodeIfPresent(Bool.self, forKey: .nativeSearch)) ?? nil) ?? false,
                    roundBudget: int(.roundBudget)
                )
            case "connectors":
                let ready = ((try? container.decodeIfPresent(LossyList<ConnectorWire>.self, forKey: .ready)) ?? nil)?.elements ?? []
                let failed = ((try? container.decodeIfPresent(LossyList<ConnectorWire>.self, forKey: .failed)) ?? nil)?.elements ?? []
                fact = .connectors(
                    ready: ready.map { NativeRunFact.Connector(id: $0.id, label: $0.label, tools: $0.tools) },
                    failed: failed.map { NativeRunFact.Connector(id: $0.id, label: $0.label, reason: $0.reason) }
                )
            case "memory":
                fact = .memory
            case "research":
                guard let runID = text(.runId) else { fact = nil; return }
                fact = .research(NativeRunFact.Research(
                    runID: runID,
                    title: text(.title) ?? "",
                    workedMs: int(.workedMs),
                    cited: int(.cited),
                    read: int(.read),
                    pages: int(.pages),
                    leadModel: text(.leadModel) ?? "",
                    state: text(.state) ?? "completed"
                ))
            default:
                fact = nil
            }
        }
    }

    /// `ToolCallRecord` (SPEC §2.4). Every field past `callId` and `tool` is
    /// lossy: an unknown status reads as running, an unknown error code as a
    /// generic failure, and a malformed part costs that part only.
    struct CallWire: Decodable {
        struct FigureWire: Decodable {
            let kind: String
            let n: Int?
            let value: String?

            private enum CodingKeys: String, CodingKey { case kind, n, value }

            init(from decoder: any Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                kind = try container.decode(String.self, forKey: .kind)
                n = (try? container.decodeIfPresent(Double.self, forKey: .n)).map { Int($0.rounded()) }
                value = try? container.decodeIfPresent(String.self, forKey: .value)
            }
        }
        struct ErrorWire: Decodable {
            let code: String
            let detail: String?
        }
        struct ApprovalWire: Decodable {
            let id: String?
            let status: String?
            let riskClass: String?
            let decision: String?
            let decidedAt: String?
            let expiresAt: String?
        }
        struct WebWire: Decodable {
            struct ResultWire: Decodable {
                let n: Int?
                let title: String
                let url: String
            }
            let query: String?
            let engine: String?
            let results: LossyList<ResultWire>?
            let requestedUrl: String?
            let finalUrl: String?
            let contentType: String?
            let pages: Int?
            let chars: Int?
            let totalChars: Int?
            let links: [String]?
            let injection: String?

            private enum CodingKeys: String, CodingKey {
                case query, engine, results, requestedUrl, finalUrl, contentType, pages, chars, totalChars, links, injection
            }

            init(from decoder: any Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                query = try? container.decodeIfPresent(String.self, forKey: .query)
                engine = try? container.decodeIfPresent(String.self, forKey: .engine)
                results = try? container.decodeIfPresent(LossyList<ResultWire>.self, forKey: .results)
                requestedUrl = try? container.decodeIfPresent(String.self, forKey: .requestedUrl)
                finalUrl = try? container.decodeIfPresent(String.self, forKey: .finalUrl)
                contentType = try? container.decodeIfPresent(String.self, forKey: .contentType)
                pages = try? container.decodeIfPresent(Int.self, forKey: .pages)
                chars = try? container.decodeIfPresent(Int.self, forKey: .chars)
                totalChars = try? container.decodeIfPresent(Int.self, forKey: .totalChars)
                links = try? container.decodeIfPresent([String].self, forKey: .links)
                injection = try? container.decodeIfPresent(String.self, forKey: .injection)
            }
        }

        let callId: String
        let providerCallId: String?
        let tool: String
        let origin: String?
        let title: String?
        let connectorId: String?
        let connectorLabel: String?
        let toolTitle: String?
        let status: String?
        let round: Int?
        let index: Int?
        let startedAt: String?
        let endedAt: String?
        let durationMs: Double?
        let timeoutMs: Double?
        let args: [String: JunoJSONValue]?
        let figure: FigureWire?
        let error: ErrorWire?
        let approval: ApprovalWire?
        let web: WebWire?
        let cached: Bool?

        private enum CodingKeys: String, CodingKey {
            case callId, providerCallId, tool, origin, title, connectorId, connectorLabel, toolTitle, status, round,
                 index, startedAt, endedAt, durationMs, timeoutMs, args, figure, error, approval, web, cached
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            callId = try container.decode(String.self, forKey: .callId)
            tool = try container.decode(String.self, forKey: .tool)
            providerCallId = try? container.decodeIfPresent(String.self, forKey: .providerCallId)
            origin = try? container.decodeIfPresent(String.self, forKey: .origin)
            title = try? container.decodeIfPresent(String.self, forKey: .title)
            connectorId = try? container.decodeIfPresent(String.self, forKey: .connectorId)
            connectorLabel = try? container.decodeIfPresent(String.self, forKey: .connectorLabel)
            toolTitle = try? container.decodeIfPresent(String.self, forKey: .toolTitle)
            status = try? container.decodeIfPresent(String.self, forKey: .status)
            round = try? container.decodeIfPresent(Int.self, forKey: .round)
            index = try? container.decodeIfPresent(Int.self, forKey: .index)
            startedAt = try? container.decodeIfPresent(String.self, forKey: .startedAt)
            endedAt = try? container.decodeIfPresent(String.self, forKey: .endedAt)
            durationMs = try? container.decodeIfPresent(Double.self, forKey: .durationMs)
            timeoutMs = try? container.decodeIfPresent(Double.self, forKey: .timeoutMs)
            args = try? container.decodeIfPresent([String: JunoJSONValue].self, forKey: .args)
            figure = try? container.decodeIfPresent(FigureWire.self, forKey: .figure)
            error = try? container.decodeIfPresent(ErrorWire.self, forKey: .error)
            approval = try? container.decodeIfPresent(ApprovalWire.self, forKey: .approval)
            web = try? container.decodeIfPresent(WebWire.self, forKey: .web)
            cached = try? container.decodeIfPresent(Bool.self, forKey: .cached)
        }

        /// The eight statuses; anything else reads as running.
        static let knownErrorCodes: Set<String> = [
            "timeout", "invalid_args", "tool_error", "denied", "expired", "blocked", "not_permitted",
            "unavailable", "cancelled", "rate_limited", "budget", "unknown_tool", "no_results",
            "provider_error", "url_not_in_prior_context", "url_not_allowed", "url_not_accessible",
            "url_too_long", "unsupported_content_type", "too_large", "needs_browser",
        ]

        func record(parseDate: (String) -> Date?) -> NativeToolCall {
            var presentArgs: [String: String] = [:]
            for (key, value) in args ?? [:] {
                switch value {
                case .string(let text):
                    presentArgs[key] = String(text.replacingOccurrences(of: "\n", with: " ").prefix(200))
                case .number(let number):
                    presentArgs[key] = number.rounded() == number ? String(Int(number)) : String(number)
                case .bool(let flag): presentArgs[key] = flag ? "true" : "false"
                default: continue
                }
            }
            // A persisted record that was never finished reads as cancelled;
            // a non-terminal approval as expired (SPEC §2.5, INV-18).
            let approvalRecord = approval.flatMap { wire -> NativeToolCall.Approval? in
                guard let id = wire.id, let status = wire.status else { return nil }
                return NativeToolCall.Approval(
                    id: id,
                    status: status,
                    riskClass: wire.riskClass,
                    decision: wire.decision,
                    decidedAt: wire.decidedAt.flatMap(parseDate),
                    expiresAt: wire.expiresAt.flatMap(parseDate)
                )
            }
            let code = error.map { Self.knownErrorCodes.contains($0.code) ? $0.code : "tool_error" }
            return NativeToolCall(
                callID: callId,
                providerCallID: providerCallId,
                tool: tool,
                origin: origin ?? "juno",
                title: title ?? "",
                connectorID: connectorId,
                connectorLabel: connectorLabel,
                toolTitle: toolTitle,
                status: NativeToolCall.Status(wire: status),
                round: max(0, round ?? 0),
                index: max(0, index ?? 0),
                startedAt: startedAt.flatMap(parseDate),
                endedAt: endedAt.flatMap(parseDate),
                durationMs: durationMs.map { Int($0.rounded()) },
                timeoutMs: timeoutMs.map { Int($0.rounded()) },
                args: presentArgs,
                figure: figure.map { NativeToolCall.Figure(kind: $0.kind, n: $0.n, value: $0.value) },
                errorCode: code,
                errorDetail: error?.detail.map { String($0.replacingOccurrences(of: "\n", with: " ").prefix(300)) },
                approval: approvalRecord,
                web: web.map { web in
                    NativeToolCall.Web(
                        query: web.query,
                        engine: web.engine,
                        results: (web.results?.elements ?? []).prefix(10).map {
                            NativeToolCall.Web.Result(n: $0.n, title: $0.title, url: $0.url)
                        },
                        requestedURL: web.requestedUrl,
                        finalURL: web.finalUrl,
                        contentType: web.contentType,
                        pages: web.pages,
                        chars: web.chars,
                        totalChars: web.totalChars,
                        links: Array((web.links ?? []).prefix(20)),
                        injection: web.injection == "suspicious" || web.injection == "hostile" ? web.injection : nil
                    )
                },
                cached: cached ?? false
            )
        }
    }
}
