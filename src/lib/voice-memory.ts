/*
 * WHAT A VOICE CALL KNOWS ABOUT YOU — the memory block the voice relay adds
 * to its instructions when a call starts.
 *
 * Voice ran on the relay's fixed instructions and the chat's recent turns, and
 * nothing else: a user whose typed chats knew their name, their job and how
 * they like answers was a stranger the moment they pressed the microphone.
 *
 * HOW IT TRAVELS — server to server, never through the browser. The relay is
 * a separate service with no database; the app mints the call's token, and
 * when that token says memory is wanted, the relay asks the app for this block
 * with a short-lived, direction-scoped callback token (the same construction
 * as its spend reports — see src/app/api/voice/memory/route.ts). The browser
 * only ever asks for memory to be USED; it never carries the memory itself,
 * so nothing a page can do puts words in it.
 *
 * WHAT IT CONTAINS — exactly what the same chat typed would see: the account
 * summary and ranked notes, or, in a project chat, that project's own summary
 * and notes and nothing else (getMemoryProfile's isolation). Nothing at all
 * when memory is paused, and never in an incognito chat, which does not ask.
 *
 * SHAPED FOR SPEECH. Headings become plain labels and emphasis is dropped: a
 * realtime model is told never to speak Markdown, and instructions written in
 * it invite the habit. It is capped well under the relay's context budget,
 * cut at a line so no fact ends mid-sentence, and it tells the model not to
 * recite it — nobody wants their profile read aloud to them.
 *
 * Pure — no Prisma — so every one of those rules is testable.
 */

/** Room the block may take in a voice model's instructions. */
export const VOICE_MEMORY_MAX_CHARS = 3_500;

/**
 * Plain lines from Markdown: "## Work context" → "Work context:". Shared with
 * an agent's persona (src/lib/voice-persona.ts), which is Markdown for the same
 * reason a summary is — it was written for a chat model first.
 */
export function plain(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
      if (heading) return `${heading[1].replace(/[*_`#]/g, "").trim()}:`;
      return line
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        // A `*` bullet is a bullet before it is emphasis to strip.
        .replace(/^\s*[-+*]\s+/, "- ")
        .replace(/[*_`]/g, "")
        .trimEnd();
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cut at the last line that fits, so no fact ends mid-sentence. */
export function cutAtLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const atLine = cut.lastIndexOf("\n");
  return (atLine > max * 0.5 ? cut.slice(0, atLine) : cut).trimEnd();
}

export function voiceMemoryInstructions(profile: {
  summary: string | null;
  recent: readonly string[];
  scope: "account" | "project";
}): string | null {
  const summary = profile.summary?.trim() ? plain(profile.summary) : "";
  const notes = profile.recent.map((note) => note.trim()).filter(Boolean);
  if (!summary && notes.length === 0) return null;

  const heading =
    profile.scope === "project"
      ? "What you already know from this project's chats"
      : "What you already know about this user";
  const lines = [
    `${heading}, from earlier conversations. Use it where it helps, the way a friend would — never recite it, never read it out as a list, and if it disagrees with what they say now, what they say now wins.`,
  ];
  if (summary) lines.push(summary);
  if (notes.length) lines.push(`${summary ? "More recent notes" : "Notes"}:\n${notes.map((n) => `- ${n}`).join("\n")}`);
  return cutAtLine(lines.join("\n\n"), VOICE_MEMORY_MAX_CHARS);
}

/**
 * What a relay token says about memory, read from the mint request.
 *
 * Absent means no memory — the default a client has to opt out of nothing to
 * get, and the one every older client and the native apps keep until they ask.
 */
export function parseVoiceMemoryRequest(params: URLSearchParams): { projectId: string | null } | null {
  if (params.get("memory") !== "1") return null;
  const projectId = params.get("projectId")?.trim() || null;
  // A cuid, or nothing: the value is signed into a token and checked against
  // access, but a shape check keeps garbage out of both.
  if (projectId && !/^[a-z0-9]{20,40}$/i.test(projectId)) return null;
  return { projectId };
}
