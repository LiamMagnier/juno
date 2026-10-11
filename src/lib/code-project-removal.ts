/** Owner-scoped removal shared by the route and its regression tests. */
export async function removeOwnedCodeProject(
  userId: string,
  input: { id?: string; key?: string; cwd: string },
  deps: {
    find: (userId: string, input: { id?: string; key?: string; cwd: string }) => Promise<{ id: string; key: string | null; path: string } | null>;
    activeTasks: (userId: string, cwd: string, key?: string | null) => Promise<string[]>;
    cancel: (id: string) => Promise<void>;
    erase: (userId: string, cwd: string, key?: string | null, workspaceId?: string) => Promise<string[]>;
  },
): Promise<{ status: number; sessionIds?: string[]; error?: string }> {
  const workspace = await deps.find(userId, input);
  if (input.id && !workspace) return { status: 404, error: "Not found" };
  const cwd = workspace?.path ?? input.cwd;
  const key = workspace?.key ?? input.key;
  const active = await deps.activeTasks(userId, cwd, key);
  if (active.length) {
    for (const id of active) await deps.cancel(id);
    return { status: 409, error: "Stopping running sessions. Try removal again once they stop." };
  }
  return { status: 200, sessionIds: await deps.erase(userId, cwd, key, workspace?.id) };
}
