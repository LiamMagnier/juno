import "server-only";
import { runUtilityPrompt, type UtilityLlm } from "@/lib/memory";

export interface TitleContextMessage {
  role: "USER" | "ASSISTANT";
  content: string;
}

/** Tidy a model-generated label: first non-empty line, no quotes/prefixes/trailing punctuation. */
function clean(raw: string, max: number, maxWords = 7): string | null {
  let t = (raw || "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  t = t
    .replace(/^(title|titre|sujet|name|nom|project name?)\s*[:\-–—]\s*/i, "")
    .replace(/^["'`«»“”*]+|["'`«»“”*]+$/g, "")
    .replace(/[.!?,;:]+$/g, "")
    .trim();
  if (!t) return null;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) t = words.slice(0, maxWords).join(" ");
  if (t.length > max) t = t.slice(0, max).trim();
  if (/^(chat|conversation|question|help|user asked|conversation summary|help with stuff)$/i.test(t)) return null;
  return t || null;
}

/**
 * Naming runs on the shared utility-model walk (the same one memory and
 * clarification use): it tries the fastest free-tier model of each configured
 * provider in turn, retries transient failures, and logs why an attempt failed.
 *
 * This used to be a single streamChat call whose errors were swallowed by a
 * bare `catch`, so one rate-limited provider silently downgraded every title to
 * the crude first-7-words fallback with nothing in the logs to explain it.
 */
async function complete(
  system: string,
  user: string,
  maxTokens: number,
  label: string,
  parse: (text: string) => string | null,
  llm?: UtilityLlm
): Promise<string | null> {
  const { result } = await runUtilityPrompt({ system, userMsg: user, maxTokens, label, parse, llm });
  return result;
}

function compact(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
}

export function fallbackChatTitle(messages: TitleContextMessage[]): string | null {
  const firstUser = messages.find((m) => m.role === "USER")?.content ?? "";
  const text = compact(firstUser)
    .replace(/^please\s+/i, "")
    .replace(/^(can|could|would)\s+you\s+/i, "")
    .replace(/^help\s+(me\s+)?(with|to)\s+/i, "")
    .replace(/^i\s+need\s+(help\s+)?(with|to)\s+/i, "");
  if (!text) return null;
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/^["'`([{]+|["'`.,!?;:)\]}]+$/g, ""))
    .filter(Boolean)
    .slice(0, 7);
  return clean(words.join(" "), 60) ?? null;
}

export async function generateChatTitleFromMessages(
  messages: TitleContextMessage[],
  opts: { llm?: UtilityLlm } = {}
): Promise<string | null> {
  const usable = messages
    .filter((m) => (m.role === "USER" || m.role === "ASSISTANT") && m.content.trim())
    .slice(0, 8);
  if (!usable.some((m) => m.role === "USER")) return null;

  const system = `Generate a concise title for this chat based on the conversation so far.
Rules:
- 3 to 7 words maximum.
- No quotes. No punctuation at the end. No emoji.
- Capture the concrete topic, intent, or task.
- Do not use generic titles like "Chat", "Question", "Conversation Summary", or "Help With Stuff".
- Write the title in the SAME language as the user's message.
Return ONLY the title.`;
  const transcript = usable
    .map((m) => `${m.role === "USER" ? "User" : "Assistant"}: ${compact(m.content).slice(0, m.role === "USER" ? 1600 : 1000)}`)
    .join("\n\n");
  return complete(
    system,
    `Conversation so far:\n${transcript}\n\nTitle:`,
    32,
    "title",
    (raw) => clean(raw, 60, 7),
    opts.llm
  );
}

/** A concise, specific title for a chat, derived from its first exchange. */
export async function generateChatTitle(
  userText: string,
  assistantText: string,
  opts: { llm?: UtilityLlm } = {}
): Promise<string | null> {
  return generateChatTitleFromMessages(
    [
      { role: "USER", content: userText },
      { role: "ASSISTANT", content: assistantText },
    ],
    opts
  );
}

/** A concise folder-style name for a project, derived from its instructions and/or first chat. */
export async function generateProjectName(
  opts: { firstUser?: string; instructions?: string; llm?: UtilityLlm }
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
  return complete(system, `${basis}\n\nProject name:`, 16, "project-name", (raw) => clean(raw, 40, 4), opts.llm);
}
