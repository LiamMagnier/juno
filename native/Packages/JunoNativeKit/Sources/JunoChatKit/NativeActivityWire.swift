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

    private enum CodingKeys: String, CodingKey {
        case id, kind, title, detail, url, createdAt, seq, round, tool, memoryReceipt, call, segment,
             commentary, notice
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
            seq: seq,
            round: round,
            call: call?.record(parseDate: parseDate),
            segment: segment.map { NativeReasoningSegment(round: $0.round ?? 0, part: $0.part, offset: max(0, $0.offset)) },
            commentary: commentary.map {
                NativeRunCommentary(round: $0.round ?? 0, text: String($0.text.prefix(4_000)), inline: $0.inline ?? true)
            },
            notice: notice.map { NativeRunNotice(code: $0.code, params: $0.params ?? [:]) },
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

    /// `ToolCallRecord`.
    struct CallWire: Decodable {
        struct FigureWire: Decodable {
            let kind: String
            let n: Int?
            let value: String?
        }
        struct ErrorWire: Decodable { let code: String }
        struct ApprovalWire: Decodable { let status: String? }
        struct WebWire: Decodable {
            struct ResultWire: Decodable {
                let title: String
                let url: String
            }
            let query: String?
            let results: LossyList<ResultWire>?
            let requestedUrl: String?
            let finalUrl: String?
            let pages: Int?
            let chars: Int?
        }

        let callId: String
        let tool: String
        let origin: String?
        let title: String?
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

        private enum CodingKeys: String, CodingKey {
            case callId, tool, origin, title, connectorLabel, toolTitle, status, round, index, startedAt,
                 endedAt, durationMs, timeoutMs, args, figure, error, approval, web
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            callId = try container.decode(String.self, forKey: .callId)
            tool = try container.decode(String.self, forKey: .tool)
            origin = try? container.decodeIfPresent(String.self, forKey: .origin)
            title = try? container.decodeIfPresent(String.self, forKey: .title)
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
        }

        func record(parseDate: (String) -> Date?) -> NativeToolCall {
            var presentArgs: [String: String] = [:]
            for (key, value) in args ?? [:] {
                switch value {
                case .string(let text): presentArgs[key] = String(text.prefix(200))
                case .number(let number):
                    presentArgs[key] = number.rounded() == number ? String(Int(number)) : String(number)
                case .bool(let flag): presentArgs[key] = flag ? "true" : "false"
                default: continue
                }
            }
            return NativeToolCall(
                callID: callId,
                tool: tool,
                origin: origin ?? "juno",
                title: title ?? "",
                connectorLabel: connectorLabel,
                toolTitle: toolTitle,
                status: NativeToolCall.Status(wire: status),
                round: round ?? 0,
                index: index ?? 0,
                startedAt: startedAt.flatMap(parseDate),
                endedAt: endedAt.flatMap(parseDate),
                durationMs: durationMs.map { Int($0.rounded()) },
                timeoutMs: timeoutMs.map { Int($0.rounded()) },
                args: presentArgs,
                figure: figure.map { NativeToolCall.Figure(kind: $0.kind, n: $0.n, value: $0.value) },
                errorCode: error?.code,
                approvalStatus: approval?.status,
                web: web.map { web in
                    NativeToolCall.Web(
                        query: web.query,
                        results: (web.results?.elements ?? []).prefix(10).map {
                            NativeToolCall.Web.Result(title: $0.title, url: $0.url)
                        },
                        requestedURL: web.requestedUrl,
                        finalURL: web.finalUrl,
                        pages: web.pages,
                        chars: web.chars
                    )
                }
            )
        }
    }
}
