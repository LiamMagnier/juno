import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Conditional class names, with later Tailwind utilities winning.
 *
 * `clsx` alone is not enough: `cn('px-3', condition && 'px-2')` emits both, and
 * which one applies then depends on their order in the generated stylesheet
 * rather than in the call. `twMerge` resolves it the way the author obviously
 * meant — last one wins.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
