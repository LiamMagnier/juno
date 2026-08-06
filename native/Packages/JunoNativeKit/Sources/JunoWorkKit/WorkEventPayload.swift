import Foundation
import JunoCore

/// Reading a Work event payload — from either of the two executors that write one.
///
/// `WorkEvent.payload` is JSON, and the vocabulary in `JunoWorkEventKind`
/// constrains only the `kind` beside it, never the bytes. Two executors fill
/// those bytes and they do not agree on a shape:
///
///   The cloud runner hands the runtime's own event object straight through, so
///   its discriminated union arrives verbatim: a question is
///   `{ kind, question: { id, question, why, options } }`, an approval is
///   `{ kind, request: { id, action, risk, summary, … } }`, a plan is
///   `{ kind, plan: { version, steps } }`.
///
///   This Mac's own run host builds each payload by hand in
///   `DesktopWorkRunHost` and writes it flat: `["questionId": …, "text": …]`.
///   Same facts, no envelope, and occasionally a different key for the same
///   thing.
///
/// Every native reader used to read the flat shape and only the flat shape, and
/// the cost was not cosmetic: `NativeWorkModel.pendingQuestion` looked for
/// `payload["questionId"]` on an event whose id was one level down under
/// `question`, so a **cloud** run that stopped to ask something was invisible on
/// the Mac and on the phone. It sat there, apparently running, with no box to
/// answer it in — the exact spinner these screens exist to replace, and the same
/// bug the web carried until `src/components/work/work-payload.ts` was written.
///
/// This is the mirror of that file's `readEvent`, not a port of it: the same
/// idea, expressed once here so every native reader gets it by asking for the
/// event rather than for the payload.
public enum WorkEventPayload {
    /// The single sub-object the cloud runner wraps each kind's facts in.
    ///
    /// One key per kind rather than a list of candidates, because lifting
    /// *replaces* — the envelope's own fields win over the wrapper's — and that
    /// is only safe while there is exactly one candidate. `question_asked` is
    /// the case that proves it: it carries a `question` object at the top and a
    /// `question` string inside it, and a merge that let the outer one win would
    /// put a dictionary's description in front of somebody as their question.
    ///
    /// `run_finished` is deliberately absent. Its envelope is the whole
    /// `report` — goal, plan, actions, citations, artifacts — and hoisting that
    /// into one event's fields would let a finished run's summary of the plan
    /// stand in for the plan events that already said it.
    static let envelope: [JunoWorkEventKind: String] = [
        .planCreated: "plan",
        .planUpdated: "plan",
        .questionAsked: "question",
        .approvalRequested: "request",
        .artifactCreated: "artifact",
        .artifactUpdated: "artifact",
        .sourceCited: "citation",
        .validationResult: "result",
        // Not a wrapper around the event so much as around where the data came
        // from, but lifted for the same reason: `provenance.action` is the
        // identifier approvals are keyed on, and `provenance.source` is the only
        // non-path name a tool call has for what it touched.
        .toolStarted: "provenance",
        .toolFinished: "provenance",
    ]

    /// The event's facts, with the cloud runner's envelope flattened away.
    ///
    /// Total and silent. An executor a release ahead of this build is expected,
    /// so an event whose kind this build cannot name, or whose envelope holds
    /// something other than an object, comes back as the payload exactly as it
    /// arrived — one unreadable event has to cost one line of one panel, never
    /// the screen.
    public static func fields(of event: WorkEvent) -> [String: JunoJSONValue] {
        guard let kind = JunoWorkEventKind(rawValue: event.kind),
            let key = envelope[kind],
            case .object(let inner)? = event.payload[key]
        else { return event.payload }
        var lifted = event.payload
        lifted.removeValue(forKey: key)
        // The envelope's own fields win, which is what makes this a lift rather
        // than a merge — see the note on `envelope` above.
        for (name, value) in inner { lifted[name] = value }
        return lifted
    }

    /// The first of these keys holding a non-blank string.
    ///
    /// Several names per fact because the two executors chose different ones:
    /// the runtime's question is `question` and this Mac's is `text`, and a
    /// reader that knew only one of them renders half the runs.
    public static func string(
        _ payload: [String: JunoJSONValue], _ keys: String...
    ) -> String? {
        for key in keys {
            guard let value = payload[key]?.stringValue else { continue }
            if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return value }
        }
        return nil
    }
}
