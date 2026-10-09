#if DEBUG
import Foundation
import JunoAuth
import JunoDesignSystem
import JunoStorage
import JunoSync

/// A practice conversation: an SQL exercise card and a written one, then an SQL
/// block and a Python block, each with Run (owner, 2026-10-09: "On IOS &
/// MacOS add the new exercices tool and the ability to run code like we did
/// on the website").
///
/// Open it with `--juno-preview-conversation conv-practice`. Run answers with
/// the web's own console documents, generated from
/// src/lib/sandbox/console-doc.ts by scripts/generate-console-fixtures.ts, so the preview runs exactly what the
/// route would return (``PreviewConsoleDocs``). `--juno-preview-practice empty|typed|run|sent` shows the
/// exercise card alone, its first exercise in that state; `code` shows the
/// runnable blocks alone, and `sql` / `python` with that block's output open.
public enum PreviewPracticeFixtures {
    public static let conversationID = "conv-practice"

    public static let sqlSample = "SELECT employee_id, first_name, last_name, salary\nFROM employees\nWHERE department_id = 60\nORDER BY salary DESC;"
    public static let answerSample = "SELECT last_name, salary\nFROM employees\nWHERE department_id = 60;"
    public static let pythonSample = "import math\n\nradii = [1, 2.5, 4]\nfor r in radii:\n    print(f\"r = {r}: area = {math.pi * r ** 2:.2f}\")\nprint(\"mean radius\", sum(radii) / len(radii))"

    static let liveUI = #"""
    {"title":"Pratique SQL","ui":[{"type":"exercise","id":"ex_dept60","title":"Exercice 1","tag":"SQL","prompt":"Affiche le **nom** et le **salaire** des employés du département `60`.","language":"sql","placeholder":"-- Ta requête","hints":["La table s’appelle `employees`.","Filtre avec `WHERE department_id = 60`."]},{"type":"exercise","id":"ex_alias","title":"Exercice 2","tag":"Cours","prompt":"Explique en une phrase à quoi sert un **alias** de colonne.","hints":["Pense au mot-clé `AS`."]}]}
    """#

    /// The exercise card, as the reply that poses it.
    public static let exerciseAnswer = """
    Voici deux exercices sur le schéma HR. Lance ta requête avec Run avant de l’envoyer : je la corrige ensuite.

    ```live-ui
    \(liveUI)
    ```
    """

    /// The runnable blocks, as a reply that shows them.
    public static let codeAnswer = """
    Pour rappel, la requête du cours, triée par salaire :

    ```sql
    \(sqlSample)
    ```

    Et un calcul en Python, pour comparer :

    ```python
    \(pythonSample)
    ```
    """

    /// The whole lesson; a screenshot state shows the part it is about, since
    /// one reply holding both is taller than a phone.
    public static var answer: String {
        switch state {
        case "code", "sql", "python": codeAnswer
        case "typed", "run", "sent", "empty": exerciseAnswer
        default: exerciseAnswer + "\n\n" + codeAnswer
        }
    }

    static func records(_ a: StorageAccountID) -> [StoredRecord] {
        let iso = PreviewFixtures.iso
        return [
            PreviewFixtures.record(a, "conversation", conversationID, 2, payload([
                "id": conversationID, "title": "Pratique SQL : le schéma HR", "model": "anthropic:claude-sonnet-4-6",
                "kind": "chat", "pinned": false, "archivedAt": NSNull(),
                "createdAt": iso(-2400), "updatedAt": iso(-2000), "lastMessageAt": iso(-2000),
            ])),
            PreviewFixtures.record(a, "message", "msg-p1", 1, payload([
                "id": "msg-p1", "conversationId": conversationID, "role": "user",
                "content": "Donne-moi des exercices SQL sur la base HR, avec la possibilité de tester mes requêtes.",
                "createdAt": iso(-2100),
            ])),
            PreviewFixtures.record(a, "message", "msg-p2", 1, payload([
                "id": "msg-p2", "conversationId": conversationID, "role": "assistant", "content": answer,
                "model": "anthropic:claude-sonnet-4-6", "promptTokens": 3100, "completionTokens": 900,
                "costMicroUsd": 9000, "createdAt": iso(-2000),
            ])),
        ]
    }

    // MARK: The console route

    /// The web's console document for a block, when the fixtures hold it.
    public static func consoleDocument(language: String, code: String, dark: Bool) -> String? {
        let theme = dark ? "dark" : "light"
        let wanted = code.trimmingCharacters(in: .whitespacesAndNewlines)
        return PreviewConsoleDocs.all.first {
            $0.language == language && $0.theme == theme && $0.code.trimmingCharacters(in: .whitespacesAndNewlines) == wanted
        }?.html
    }

    /// `POST /api/code/console`, answered from the fixtures.
    static func body(for request: NativeBearerRequest) -> Data? {
        guard request.path == "/api/code/console", request.method == .post else { return nil }
        guard let raw = request.body.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: String] }),
            let language = raw["language"], let code = raw["code"],
            let html = consoleDocument(language: language, code: code, dark: raw["theme"] == "dark")
        else { return Data("{}".utf8) }
        return Data(payload(["html": html, "language": language]).utf8)
    }

    // MARK: Screenshot states

    /// `--juno-preview-practice empty|typed|run|sent|code|sql|python`.
    public static var state: String? {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: "--juno-preview-practice"), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    /// The runnable blocks that open their output, for ``state``.
    public static var openBlocks: Set<String> {
        switch state {
        case "sql": ["sql"]
        case "python": ["python"]
        default: []
        }
    }

    /// The first exercise's state for ``state``.
    public static func seeds(for state: String?) -> [String: LiveExerciseSeed] {
        switch state {
        case "typed": ["ex_dept60": LiveExerciseSeed(answer: answerSample, hintsShown: 1)]
        case "run": ["ex_dept60": LiveExerciseSeed(answer: answerSample, hintsShown: 1, runOpen: true)]
        case "sent": ["ex_dept60": LiveExerciseSeed(answer: answerSample, hintsShown: 2, sent: true)]
        default: [:]
        }
    }

    private static func payload(_ object: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}
#endif
