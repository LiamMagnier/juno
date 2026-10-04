import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPromptSections } from "@/lib/chat/system-prompt";

/*
 * Installed macOS and iOS builds render SPREADSHEET / DOCUMENT / PRESENTATION
 * artifacts as nothing, so a turn from them keeps the Markdown contract until
 * the native views ship (src/lib/chat/turn/prompt.ts passes the client).
 */
const base = { memories: [], memoryEnabled: false, canvas: true, customInstructions: "", personality: "default", responseLanguage: "auto" };

test("the web prompt teaches semantic artifacts; a native client's never names them", () => {
  const web = buildSystemPromptSections({ ...base, semanticArtifacts: true } as never).stable;
  const native = buildSystemPromptSections({ ...base, semanticArtifacts: false } as never).stable;
  assert.match(web, /SEMANTIC artifacts/);
  assert.match(web, /juno:artifact-ops/);
  assert.doesNotMatch(native, /SPREADSHEET|DOCUMENT\b(?! ?\/)|PRESENTATION|juno:artifact-ops/);
  assert.match(native, /Documents, spreadsheets and decks are MARKDOWN artifacts/);
  // Absent means web: the default never silently downgrades the web app.
  assert.equal(buildSystemPromptSections(base as never).stable, web);
});
