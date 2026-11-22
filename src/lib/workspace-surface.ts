const sharedWorkspaceRoots = ["/library", "/artifacts", "/projects", "/connections", "/skills", "/design"] as const;

export function isSharedWorkspacePath(pathname: string | null): boolean {
  return pathname !== null && sharedWorkspaceRoots.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

/** Shared pages can explicitly keep Code's shell without changing their routes. */
export function workspaceHref(href: string, surface: "chat" | "code"): string {
  if (surface !== "code" || !isSharedWorkspacePath(href.split(/[?#]/, 1)[0])) return href;
  const link = new URL(href, "https://workspace.invalid");
  link.searchParams.set("surface", "code");
  return `${link.pathname}${link.search}${link.hash}`;
}
