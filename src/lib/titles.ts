import "server-only";
import { streamChat } from "@/lib/llm";
import type { ModelInfo } from "@/lib/models";

/** Tidy a model-generated label: first non-empty line, no quotes/prefixes/trailing punctuation. */
function clean(raw: string, max: number): string | null {
  let t = (raw || "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  t = t
    .replace(/^(title|titre|sujet|name|nom|project name?)\s*[:\-–—]\s*/i, "")
    .replace(/^["'`«»“”*]+|["'`«»“”*]+$/g, "")
    .replace(/[.!?,;:]+$/g, "")
    .trim();
  if (!t) return null;
  if (t.length > max) t = t.slice(0, max).trim();
  return t || null;
}

async function complete(model: ModelInfo, system: string, user: string, maxTokens: number): Promise<string | null> {
  let out = "";
  try {
    for await (const ev of streamChat({
      model,
      system,
      history: [{ role: "USER", content: user, attachments: [] }],
      maxTokens,
    })) {
      if (ev.type === "text") out += ev.text;
    }
  } catch {
    return null;
  }
  return out;
}

/** A concise, specific title for a chat, derived from its first exchange. */
export async function generateChatTitle(
  model: ModelInfo,
  userText: string,
  assistantText: string
): Promise<string | null> {
  const system = `You write a short, specific title for a conversation.
Rules:
- 2 to 6 words. No quotes, no ending punctuation, no emoji.
- Capture the concrete topic; avoid generic words like "Chat", "Question", "Help", "Conversation".
- Write the title in the SAME language as the user's message.
Reply with ONLY the title.`;
  const user = `User's first message:
"""${userText.slice(0, 2000)}"""

Assistant's reply (context only):
"""${assistantText.slice(0, 800)}"""

Title:`;
  const raw = await complete(model, system, user, 24);
  return raw == null ? null : clean(raw, 60);
}

/** A concise folder-style name for a project, derived from its instructions and/or first chat. */
export async function generateProjectName(
  model: ModelInfo,
  opts: { firstUser?: string; instructions?: string }
): Promise<string | null> {
  const basis = [
    opts.instructions?.trim() ? `Project instructions:\n"""${opts.instructions.slice(0, 1500)}"""` : "",
    opts.firstUser?.trim() ? `A chat in this project begins with:\n"""${opts.firstUser.slice(0, 1500)}"""` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!basis) return null;

  const system = `You name a workspace "project" that groups related chats.
Rules:
- 2 to 4 words — a concise theme/topic name, like a folder name, not a sentence.
- No quotes, no ending punctuation, no emoji.
- Write it in the SAME language as the content.
Reply with ONLY the name.`;
  const raw = await complete(model, system, `${basis}\n\nProject name:`, 16);
  return raw == null ? null : clean(raw, 40);
}
