import { describe, it } from "node:test";
import { JUNK_RE, versionScore } from "../src/lib/model-discovery-core";

describe("scratch", () => {
  it("scores", () => {
    const ids = [
      "qwen-plus", "qwen-plus-2025-07-28", "qwen3.5-plus-02-15", "qwen3.5-plus-20260420",
      "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus",
      "mistral-small-latest", "mistral-small-2603", "mistral-small-24b-instruct-2501",
      "mistral-small-3.1-24b-instruct", "mistral-small-3.2-24b-instruct", "mistral-small-2501",
      "mistral-large", "mistral-large-latest", "mistral-large-2512", "mistral-large-2407",
      "ministral-14b-latest", "ministral-14b-2512", "ministral-8b-latest", "ministral-8b-2512",
      "mistral-medium-latest", "mistral-medium-3.1", "mistral-medium-3-5", "mistral-medium-2604",
      "codestral-latest", "codestral-2508",
      "glm-4-32b-0414-128k", "moonshot-v1-128k", "moonshot-v1-8k", "moonshot-v1-32k",
      "grok-4.20-multi-agent-0309", "grok-4.20-0309-reasoning", "grok-build-0.1", "grok-4.5",
      "qwen3-235b-a22b", "qwen3-30b-a3b", "qwen3-vl-235b-a22b-instruct", "qwen3-vl-plus", "qwen3-vl-flash",
      "qwen3-coder-plus","qwen3-coder-30b-a3b-instruct","qwen3-coder-next","qwen3-coder-flash","qwen3-coder",
      "qwen3.5-122b-a10b","qwen3.5-397b-a17b","qwen3.6-27b","qwen3.6-35b-a3b",
      "llama-4-maverick-17b-128e-instruct-fp8","Llama-3.3-70B-Instruct",
      "gpt-4o-2024-08-06","claude-haiku-4-5-20251001","gemini-3.1-pro-preview-05-06",
      "MiniMax-M2.7-highspeed","minimax-m2.1","MiniMax-M3",
      "mimo-v2.5-pro","mimo-v2.5","mimo-v2-flash",
      "LongCat-2.0","longcat-flash-chat",
    ];
    for (const id of ids) console.log(`${versionScore(id).toFixed(4).padStart(12)}  junk=${JUNK_RE.test(id)?1:0}  ${id}`);
  });
});
