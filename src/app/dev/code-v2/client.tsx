"use client";

import nextDynamic from "next/dynamic";

/** Client-only: the fixtures are stamped relative to now, so the server must not render them. */
export const CodeV2GalleryClient = nextDynamic(() => import("./gallery").then((m) => m.CodeV2Gallery), { ssr: false });
