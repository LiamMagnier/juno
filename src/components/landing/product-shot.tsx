import { existsSync } from "node:fs";
import path from "node:path";
import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * Real product shots for the front door, rendered from the Mac app's offscreen
 * snapshot tests with sample data (docs/design/premium-pass/BRIEF.md) and kept
 * under public/brand/product/ as `<name>-light.png` / `<name>-dark.png`.
 *
 * Read from disk at render: a page that names a shot nobody has rendered yet
 * falls back to whatever the caller passes instead of a broken image, so the
 * art can land after the layout without a window where production shows a
 * hole.
 */

const DIR = path.join(process.cwd(), "public", "brand", "product");

export function hasProductShot(name: string): boolean {
  return existsSync(path.join(DIR, `${name}-light.png`));
}

export function ProductShot({
  name,
  alt,
  width,
  height,
  className,
  priority = false,
  sizes,
}: {
  name: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  priority?: boolean;
  sizes?: string;
}) {
  const dark = existsSync(path.join(DIR, `${name}-dark.png`));
  const common = { width, height, priority, sizes };
  const base = cn("h-auto w-full", className);
  return (
    <>
      <Image {...common} alt={alt} src={`/brand/product/${name}-light.png`} className={cn(base, dark && "dark:hidden")} />
      {dark && <Image {...common} alt={alt} src={`/brand/product/${name}-dark.png`} className={cn(base, "hidden dark:block")} />}
    </>
  );
}
