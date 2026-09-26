"use client";

import * as React from "react";
import { ImageGeneration } from "img-fx";

import { usePrefersReducedMotion } from "@/components/effects/use-effect-theme";

/**
 * The generated-image placeholder's surface (Libraries.dev Image, premium
 * brief): a soft pixel mosaic churning in the box the picture will fill,
 * for as long as /api/generate is working on it.
 *
 * No reveal here. The finished image arrives as an attachment on the turn
 * and the placeholder unmounts; revealing a copy inside this canvas would put
 * the picture on screen twice, once without alt text. So this is the recipe
 * the package calls "only animate while working": no `images`, the shader
 * alone, stopped under reduced motion (the package does not check it).
 *
 * Loaded with `next/dynamic` by its one caller, because it brings three.js,
 * and only a turn that is making an image should pay for that. The box is
 * the caller's; this fills it, and takes its radius from the child.
 */
export default function GenerationMosaic() {
  const reduced = usePrefersReducedMotion();
  return (
    <ImageGeneration
      preset="pixels-organic"
      strength={0.9}
      paused={reduced}
      aria-hidden="true"
      className="!absolute inset-0"
    >
      <div className="size-full rounded-field" />
    </ImageGeneration>
  );
}
