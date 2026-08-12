import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Local to the Code surface so it owns no files outside `products/code`. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
