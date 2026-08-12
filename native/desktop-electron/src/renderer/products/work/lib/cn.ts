import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Local to the Work surface so it owns no files outside `products/work`. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
