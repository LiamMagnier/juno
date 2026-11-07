import test from "node:test";
import assert from "node:assert/strict";
import { splitMessageContent } from "../src/lib/message-content";

/*
 * A model sometimes wraps the artifact tag in a code fence (```juno:artifact,
 * ```xml, ```html). The tag is lifted out into its card, and the fence used to
 * stay behind as an empty code block ("artifact · juno") with its closing
 * ``` opening a second block that swallowed the prose after it.
 */

const TAG = '<juno:artifact identifier="ai-brief" type="MARKDOWN" title="AI assistants">\n# Brief\n\nBody.\n</juno:artifact>';

test("a fence around a closed artifact tag is dropped with it", () => {
  for (const opener of ["```juno:artifact", "```xml", "```", "~~~html"]) {
    const closer = opener.startsWith("~") ? "~~~" : "```";
    const parts = splitMessageContent(`Here is the brief.\n\n${opener}\n${TAG}\n${closer}\n\nThe pricing parts are a week old.`);
    assert.deepEqual(
      parts.map((p) => p.type),
      ["text", "artifact", "text"],
      opener,
    );
    const texts = parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text);
    for (const text of texts) assert.ok(!/```|~~~/.test(text), `${opener}: fence left in ${JSON.stringify(text)}`);
    assert.match(texts[1], /The pricing parts are a week old\./);
  }
});

test("a fence around a streaming artifact tag is not drawn as an empty block", () => {
  const parts = splitMessageContent('Here is the brief.\n\n```juno:artifact\n<juno:artifact identifier="ai-brief" type="MARKDOWN" title="AI">\n# Bri');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].type, "text");
  assert.ok(!(parts[0] as { text: string }).text.includes("```"));
  assert.equal(parts[1].type, "artifact");
});

test("a closed code block before an artifact is left alone", () => {
  const parts = splitMessageContent(`Run this:\n\n\`\`\`sh\nnpm test\n\`\`\`\n${TAG}\nDone.`);
  const first = (parts[0] as { text: string }).text;
  assert.match(first, /```sh\nnpm test\n```/);
  assert.equal(parts[1].type, "artifact");
  assert.match((parts[2] as { text: string }).text, /Done\./);
});
