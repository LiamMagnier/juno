import type { Workspace } from "@/components/code/code-target-picker";

/*
 * Which Mac owns a synced workspace, and whether it is awake.
 *
 * Lives here because two screens need the same answer and were about to answer
 * it twice: the session view (is this session runnable right now) and the
 * project picker (is this row runnable BEFORE you pick it). Matching a
 * workspace to a device is one rule, and one rule with two copies is a rule
 * that will disagree with itself.
 */

export type DeviceRow = {
  id: string;
  name: string;
  online?: boolean;
  lastSeenAt: string;
  workspaces: unknown;
};

export function deviceOffersWorkspace(device: DeviceRow, key: string | null, name: string | null): boolean {
  if (!Array.isArray(device.workspaces)) return false;
  return (device.workspaces as { name?: unknown; key?: unknown }[]).some((w) => {
    // Stable identity first — a host that re-registered the folder from a new
    // location still owns this session's workspace.
    if (key != null && w?.key === key) return true;
    // Name is the fallback, not path. The device list no longer returns paths
    // at all: they disclose the account name and directory layout, and nothing
    // outside the host needs one. A key-less host with two identically named
    // workspaces is the only case this reads less precisely than before, and
    // that is worth the disclosure it removes.
    return name != null && w?.name === name;
  });
}

/** The device that offers this workspace, preferring an online one. */
export function ownerDevice(devices: DeviceRow[], workspace: Workspace): DeviceRow | null {
  const candidates = devices
    .filter((d) => deviceOffersWorkspace(d, workspace.key ?? null, workspace.name))
    .sort((a, b) => (!!a.online === !!b.online ? 0 : a.online ? -1 : 1));
  return candidates[0] ?? null;
}
