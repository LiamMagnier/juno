import "server-only";
import { appleMusicDeveloperToken } from "@/lib/apple/music-token";

/*
 * Thin Apple Music API client (api.music.apple.com). Every call carries the
 * runtime-minted developer token plus the user's Music-User-Token obtained via
 * MusicKit JS at connect time.
 */

export interface MusicItem {
  id: string;
  name: string;
  detail?: string;
}

/** Thrown when Apple rejects the Music-User-Token (expired/revoked). */
export class MusicAuthError extends Error {
  constructor() {
    super("Apple Music rejected the user token");
    this.name = "MusicAuthError";
  }
}

interface MusicResource {
  id?: string;
  type?: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    curatorName?: string;
    genreNames?: string[];
  };
}

async function musicRequest(path: string, musicUserToken: string, init?: RequestInit): Promise<unknown> {
  const devToken = await appleMusicDeveloperToken();
  const res = await fetch(`https://api.music.apple.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${devToken}`,
      "Music-User-Token": musicUserToken,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (res.status === 401 || res.status === 403) throw new MusicAuthError();
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Apple Music request failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

function toItem(r: MusicResource): MusicItem {
  const a = r.attributes ?? {};
  const detailParts = [a.artistName, a.albumName && a.albumName !== a.name ? a.albumName : undefined, a.curatorName].filter(
    Boolean
  );
  return { id: r.id ?? "", name: a.name ?? "(untitled)", detail: detailParts.length ? detailParts.join(" — ") : undefined };
}

/** The user's storefront (e.g. "fr") — also serves as the connect-time validation call. */
export async function getStorefront(musicUserToken: string): Promise<string> {
  const data = (await musicRequest("/v1/me/storefront", musicUserToken)) as { data?: Array<{ id?: string }> };
  const id = data?.data?.[0]?.id;
  if (!id) throw new Error("Apple Music returned no storefront");
  return id;
}

export async function searchCatalog(
  musicUserToken: string,
  query: string,
  types: string[] = ["songs", "albums", "artists", "playlists"]
): Promise<Record<string, MusicItem[]>> {
  const storefront = await getStorefront(musicUserToken);
  const params = new URLSearchParams({ term: query, types: types.join(","), limit: "10" });
  const data = (await musicRequest(`/v1/catalog/${storefront}/search?${params}`, musicUserToken)) as {
    results?: Record<string, { data?: MusicResource[] }>;
  };
  const out: Record<string, MusicItem[]> = {};
  for (const type of types) {
    const items = data?.results?.[type]?.data;
    if (items && items.length > 0) out[type] = items.map(toItem);
  }
  return out;
}

export async function listPlaylists(musicUserToken: string): Promise<MusicItem[]> {
  const data = (await musicRequest("/v1/me/library/playlists?limit=25", musicUserToken)) as { data?: MusicResource[] };
  return (data?.data ?? []).map(toItem);
}

export async function getRecentlyPlayed(musicUserToken: string): Promise<MusicItem[]> {
  const data = (await musicRequest("/v1/me/recent/played/tracks?limit=15", musicUserToken)) as { data?: MusicResource[] };
  return (data?.data ?? []).map(toItem);
}

export async function addToPlaylist(musicUserToken: string, playlistId: string, songIds: string[]): Promise<void> {
  await musicRequest(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, musicUserToken, {
    method: "POST",
    body: JSON.stringify({ data: songIds.map((id) => ({ id, type: "songs" })) }),
  });
}
