"use client";

import * as React from "react";
import { MetalFx } from "metal-fx";

import { useEffectTheme, usePrefersReducedMotion } from "@/components/effects/use-effect-theme";
import { cn } from "@/lib/utils";

/**
 * The one liquid-metal object on a page (Libraries.dev Liquid metal, premium
 * brief): the CTA that sells a plan. Nothing else in the web app wears metal,
 * so a page never has two, and every page that uses it uses `silver`, the
 * preset closest to Juno's warm neutrals (chromatic is a rainbow sheen and
 * gold fights the coral).
 *
 * The package renders a fallback on the server and the canvas on the client,
 * so this mounts the metal only after hydration and shows the plain child
 * until then (and wherever WebGL2 is missing, where the package keeps the
 * child as is). Reduced motion: the shader and its glow are stopped, which the
 * package does not do on its own. The child keeps its semantics and focus;
 * the wrapper strips its fill and paints the metal's, so the child's label
 * colour is the only styling that matters.
 */
export function MetalCta({
  children,
  className,
}: {
  children: React.ReactElement<{ className?: string }>;
  className?: string;
}) {
  const theme = useEffectTheme();
  const reduced = usePrefersReducedMotion();
  if (!theme) return <div className={className}>{children}</div>;
  return (
    <MetalFx
      variant="button"
      preset="silver"
      theme={theme}
      strength={0.85}
      paused={reduced}
      disableGlow={reduced}
      className={cn("w-full", className)}
    >
      {/* The metal paints its own fill (near white on light, near black on
          dark), so the label must be the foreground ink, never the accent's
          white-on-coral, or it vanishes into the light fill. */}
      {React.cloneElement(children, { className: cn(children.props.className, "text-foreground") })}
    </MetalFx>
  );
}
