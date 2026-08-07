import Foundation
import JunoCodeCore
import JunoCodeRuntime

/// A bounded snapshot of the page currently rendered by Juno's local preview.
///
/// The page is untrusted project output. It is redacted and size-limited before
/// it is returned to the model, and the screenshot remains an ephemeral tool
/// result just like Computer Use captures.
struct CodePreviewInspection: Sendable {
    let url: URL
    let title: String
    let visibleText: String
    let interactiveElementCount: Int
    let diagnostics: [String]
    let screenshot: ModelImage?

    var renderedText: String {
        var sections = [
            "Preview URL: \(url.absoluteString)",
            "Page title: \(title.isEmpty ? "(untitled)" : title)",
            "Interactive elements: \(interactiveElementCount)",
        ]

        if visibleText.isEmpty {
            sections.append("Visible page text: (empty)")
        } else {
            sections.append("Visible page text:\n\(visibleText)")
        }

        if diagnostics.isEmpty {
            sections.append("Browser diagnostics: none captured")
        } else {
            sections.append(
                "Browser diagnostics (newest last):\n" + diagnostics.joined(separator: "\n")
            )
        }

        if screenshot != nil {
            sections.append("A screenshot is attached to this result.")
        }
        return sections.joined(separator: "\n\n")
    }
}

enum CodePreviewInspectionError: Error, LocalizedError, Sendable {
    case noActivePreview
    case previewNotReady(detail: String)
    case pageEvaluationFailed(String)
    case screenshotFailed(String)

    var errorDescription: String? {
        switch self {
        case .noActivePreview:
            return "No active local Preview is open for this workspace. Open the Preview pane, wait for the page to load, then try again."
        case let .previewNotReady(detail):
            return "The local Preview is not ready yet: \(detail)"
        case let .pageEvaluationFailed(message):
            return "Juno could not inspect the rendered page: \(message)"
        case let .screenshotFailed(message):
            return "Juno inspected the page, but could not capture its screenshot: \(message)"
        }
    }
}

/// Read-only browser QA for the local Code preview.
///
/// This is deliberately separate from Computer Use. Computer Use controls the
/// whole Mac after an explicit reader gesture; this tool can only inspect the
/// WebKit surface that Juno itself opened for the current granted workspace.
struct CodePreviewInspectTool: CodeTool {
    let name = "inspect_preview"
    let description = "Inspect the active Juno local website preview: rendered URL and title, bounded visible text, interactive-element count, browser runtime/console diagnostics, and an optional screenshot. It cannot open arbitrary URLs or control the Mac."

    var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "include_screenshot": [
                    "type": "boolean",
                    "description": "Attach an ephemeral screenshot when the model supports vision. Defaults to false.",
                ],
                "max_text": [
                    "type": "integer",
                    "minimum": 200,
                    "maximum": 12_000,
                    "description": "Maximum visible page text to return. Defaults to 6,000 characters.",
                ],
            ],
            "required": [],
        ]
    }

    func assessRisk(input: JSONValue) -> ActionRisk { .read }

    func summary(input: JSONValue) -> String {
        input["include_screenshot"]?.boolValue == true
            ? "Inspect the local Preview and capture its page"
            : "Inspect the local Preview page and browser diagnostics"
    }

    func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let requestedText = input["max_text"]?.intValue ?? 6_000
        let maxText = min(max(requestedText, 200), 12_000)
        let includeScreenshot = input["include_screenshot"]?.boolValue == true

        do {
            // `CodePreviewModel` is MainActor-isolated, so this hop keeps the
            // runtime free of WebKit references while still serializing all
            // page inspection with the live UI surface.
            let inspection = try await CodePreviewModel.inspectActive(
                sessionID: context.sessionID,
                includeScreenshot: includeScreenshot,
                maxText: maxText
            )
            return ToolResult(
                content: inspection.renderedText,
                images: inspection.screenshot.map { [$0] } ?? []
            )
        } catch let error as CodePreviewInspectionError {
            throw ToolError.executionFailed(message: error.localizedDescription)
        } catch {
            throw ToolError.executionFailed(message: "Preview inspection failed: \(error.localizedDescription)")
        }
    }
}
