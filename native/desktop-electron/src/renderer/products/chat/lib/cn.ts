import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Conditional class names, with later Tailwind utilities winning.
 *
 * A local copy, matching `products/code/lib/cn.ts`. The product surfaces are
 * intentionally self-contained: a surface may be lifted out, and a shared
 * helper reached through `../../lib` is the first thing that stops that being
 * true.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
