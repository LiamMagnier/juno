import { randomBytes } from "node:crypto";
import type { ExecLanguage } from "@/lib/exec/types";
import { SNIPPET_LANGUAGES } from "@/lib/exec/snippet-languages";

export { serverSnippetLanguage, snippetLabel } from "@/lib/exec/snippet-languages";

/**
 * Running a code block from the chat in a language the browser cannot run
 * (owner, 2026-10-09: "not only SQL, every language").
 *
 * JavaScript, TypeScript, Python and SQL run in the reader's browser
 * (src/components/canvas/sandbox-frame.tsx). Everything else goes to the
 * hosted sandbox that run_code uses (deploy/exec-host): no network, read-only
 * root, bounded CPU, memory and time. The host speaks python, javascript and
 * bash, so a compiled or other interpreted language is a short bash program
 * that writes the source under /tmp, compiles it there and runs it. The
 * toolchains live in the sandbox image (deploy/exec-host/image/Dockerfile).
 */

export const SNIPPET_MAX_CHARS = 20_000;

/**
 * The program the host runs for `code` in `language`: bash for every language,
 * the source written through a quoted heredoc whose delimiter is random, so
 * nothing in the source is expanded and nothing in it can end the heredoc.
 */
export function snippetProgram(language: string, code: string): { language: ExecLanguage; code: string } {
  const spec = SNIPPET_LANGUAGES[language];
  if (!spec) throw new Error(`No server runtime for ${language}`);
  let delimiter = `ALEVR_SOURCE_${randomBytes(8).toString("hex")}`;
  while (code.includes(delimiter)) delimiter = `ALEVR_SOURCE_${randomBytes(8).toString("hex")}`;
  const source = code.endsWith("\n") ? code : `${code}\n`;
  return {
    language: "bash",
    code: `set -e\nmkdir -p /tmp/snippet && cd /tmp/snippet\ncat > ${spec.file} <<'${delimiter}'\n${source}${delimiter}\nset +e\n${spec.run}\n`,
  };
}
