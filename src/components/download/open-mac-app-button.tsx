"use client";

import { ArrowRight } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { useMacAppLauncher } from "@/hooks/use-mac-app";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * "Open Alevr" beside Download, when this Mac looks like it already has the
 * app: the account has a Mac seen in the last 30 days, or this browser opened
 * the app before (src/hooks/use-mac-app.ts). Nothing renders otherwise, so a
 * visitor without the app never meets a button that cannot work.
 */
export function OpenMacAppButton() {
  const macApp = useMacAppLauncher();
  if (!macApp.installedLikely) return null;
  return (
    <Button type="button" size="lg" variant="secondary" onClick={() => macApp.open(null)}>
      {`Open ${PRODUCT_NAME}`}
      <ArrowRight aria-hidden />
    </Button>
  );
}
