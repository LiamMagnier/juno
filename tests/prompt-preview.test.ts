import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promptPreview } from "../src/lib/prompt-preview";

describe("promptPreview", () => {
  it("shows prose instead of structural prompt tags", () => {
    assert.equal(
      promptPreview("<role> You are a research assistant. </role>\n<context>Use primary sources.</context>"),
      "You are a research assistant. Use primary sources.",
    );
  });

  it("does not eat ordinary comparison text", () => {
    assert.equal(promptPreview("Keep a < b, x <= 3, and arrows -> intact."), "Keep a < b, x <= 3, and arrows -> intact.");
  });

  it("uses the caller's empty-state copy", () => {
    assert.equal(promptPreview(" \n\t ", "Nothing here."), "Nothing here.");
  });
});
