/**
 * A GitHub repository's own skills (skills lane, cloud runs): what the cloud
 * composer offers under Project, read through GitHub's contents API by the
 * rules the runner applies to its clone (`.alevr/skills`, `.juno/skills`,
 * `.claude/skills`, nearest first; `<folder>/SKILL.md`; the front matter's
 * name, else the folder's). The parser is the runner's own (skill-parse.ts,
 * shared byte for byte), so a skill listed here is the skill the run reads.
 *
 * Names, descriptions and repository-relative paths only; never a body.
 */
import type { LocalSkillSummary } from "./contracts";
import { HEAD_BYTES, PROJECT_SKILL_DIRS, SKILL_LIST_MAX, SKILL_MAX_BYTES, parseSkillFile, skillName } from "./skill-parse";

/** Folders read per skills root: a repository with more lists the first ones. */
export const REPO_SKILL_FOLDERS_MAX = 60;

/** One entry of `GET /repos/{o}/{r}/contents/{dir}`. */
interface ContentsEntry {
  name?: string;
  path?: string;
  type?: string;
  size?: number;
}

/**
 * How the lister reaches GitHub: `list(dir)` answers a directory's entries
 * (null when it is absent), `read(file)` a file's text (null when absent or
 * too large). The route binds them to the reader's token and the ref.
 */
export interface RepoSkillReader {
  list(dir: string): Promise<ContentsEntry[] | null>;
  read(file: string, size?: number): Promise<string | null>;
}

export async function listRepoSkills(reader: RepoSkillReader): Promise<LocalSkillSummary[]> {
  const perRoot = await Promise.all(
    PROJECT_SKILL_DIRS.map(async ({ dir, origin }) => {
      const entries = (await reader.list(dir).catch(() => null)) ?? [];
      const folders = entries
        .filter((e) => typeof e.name === "string" && !e.name.startsWith(".") && (e.type === "dir" || e.type === "symlink"))
        .sort((a, b) => a.name!.localeCompare(b.name!))
        .slice(0, REPO_SKILL_FOLDERS_MAX);
      const found = await Promise.all(
        folders.map(async (folder): Promise<LocalSkillSummary | null> => {
          const file = `${dir}/${folder.name}/SKILL.md`;
          const text = await reader.read(file).catch(() => null);
          if (text === null || Buffer.byteLength(text) > SKILL_MAX_BYTES) return null;
          const parsed = parseSkillFile(text.slice(0, HEAD_BYTES));
          const name = skillName(parsed, folder.name!);
          if (!name) return null;
          return { name, description: parsed.description ?? "", source: "project", origin, path: file };
        }),
      );
      return found.filter((s): s is LocalSkillSummary => s !== null);
    }),
  );
  const seen = new Set<string>();
  const out: LocalSkillSummary[] = [];
  for (const skill of perRoot.flat()) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    out.push(skill);
  }
  return out.slice(0, SKILL_LIST_MAX);
}
