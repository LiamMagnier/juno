"use client";

import * as React from "react";
import {
  DESKTOP_APP_DOWNLOAD_PATH,
  decideMacAppOpen,
  desktopAppURL,
  isDesktopShell,
  isMacBrowser,
  macAppProbeResult,
  probeDesktopApp,
  readOpenedHereBefore,
  writeOpenedHereBefore,
} from "@/lib/desktop-app-link";

/*
 * "Mac app" for any control on the web (src/lib/desktop-app-link.ts has the
 * why). The account's answer is fetched once per page load and shared: every
 * control that offers the app asks the same question.
 */

let accountHasMacRequest: Promise<boolean> | null = null;

function fetchAccountHasMac(): Promise<boolean> {
  accountHasMacRequest ??= fetch("/api/devices/mac-app", { credentials: "same-origin", cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((body: { installed?: boolean } | null) => body?.installed === true)
    .catch(() => false);
  return accountHasMacRequest;
}

export type MacAppLauncher = {
  /** False until mounted, and inside the app's own shell: render nothing. */
  visible: boolean;
  /** A Mac with evidence the app is there: offer "Open". */
  installedLikely: boolean;
  /** Opens the app (at `path` when it is a conversation or Code session), or the download page. */
  open: (path?: string | null) => void;
};

export function useMacAppLauncher({ checkAccount = true }: { checkAccount?: boolean } = {}): MacAppLauncher {
  const [env, setEnv] = React.useState<{ isMac: boolean; inShell: boolean } | null>(null);
  const [accountHasMac, setAccountHasMac] = React.useState(false);
  const [openedHereBefore, setOpenedHereBefore] = React.useState(false);
  const cancel = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    const isMac = isMacBrowser(navigator);
    const inShell = isDesktopShell(navigator.userAgent);
    setEnv({ isMac, inShell });
    setOpenedHereBefore(readOpenedHereBefore());
    if (!isMac || inShell || !checkAccount) return;
    let live = true;
    void fetchAccountHasMac().then((has) => {
      if (live) setAccountHasMac(has);
    });
    return () => {
      live = false;
    };
  }, [checkAccount]);

  React.useEffect(() => () => cancel.current?.(), []);

  const evidence = { accountHasMac, openedHereBefore };
  const decision = env ? decideMacAppOpen({ isMac: env.isMac, inDesktopShell: env.inShell, evidence }) : "hidden";

  const open = React.useCallback(
    (path?: string | null) => {
      const now = env
        ? decideMacAppOpen({ isMac: env.isMac, inDesktopShell: env.inShell, evidence: { accountHasMac, openedHereBefore } })
        : "download";
      if (now === "hidden") return;
      if (now === "download") {
        window.location.assign(DESKTOP_APP_DOWNLOAD_PATH);
        return;
      }
      cancel.current?.();
      cancel.current = probeDesktopApp({
        url: desktopAppURL(path),
        fallback: () => window.location.assign(DESKTOP_APP_DOWNLOAD_PATH),
        onResult: (outcome) => {
          const { remember } = macAppProbeResult(outcome);
          writeOpenedHereBefore(remember);
          setOpenedHereBefore(remember);
        },
      });
    },
    [env, accountHasMac, openedHereBefore],
  );

  return { visible: decision !== "hidden", installedLikely: decision === "try-app", open };
}
