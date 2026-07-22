/*
 * Workspace disclosure rules — a pure module with no server imports, so the
 * hermetic test suite can exercise them without a database (same reasoning as
 * `message-append.ts`).
 */

/**
 * Strips the absolute `path` from each registered workspace.
 *
 * A host registers its workspaces with a real filesystem path, because that is
 * how it finds them again. Nothing outside the host needs one: a workspace is
 * addressed by its stable `key`, with `name` for display. Handing the path back
 * out discloses the account name, the directory layout and usually the
 * project's real identity — to a phone, to any client, and to anything that
 * later gets hold of a response body.
 *
 * The Code session serialization was already path-free; this closes the same
 * hole on the device list, which was returning `device.workspaces` verbatim
 * straight out of its JSONB column.
 *
 * Input is deliberately `unknown`: it comes from JSONB and may be any shape,
 * including shapes written by an older host.
 */
export function publicWorkspaces(workspaces: unknown): Array<{ name?: unknown; key?: unknown }> {
  if (!Array.isArray(workspaces)) return [];
  return workspaces.map((workspace) => {
    if (typeof workspace !== "object" || workspace === null) return {};
    const { name, key } = workspace as { name?: unknown; key?: unknown };
    // Rebuilt field by field rather than deleted from a copy, so a key nobody
    // has thought of yet cannot ride along.
    return key === undefined ? { name } : { name, key };
  });
}
