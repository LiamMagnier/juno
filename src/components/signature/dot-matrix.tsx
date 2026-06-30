import { cn } from "@/lib/utils";

/** The Juno dot-matrix mark: a small orbit/spark rendered from dots. */
export function DotMatrixMark({ className }: { className?: string }) {
  // 5x5 grid; `1` = coral, `2` = muted dot, `0` = empty. Forms an orbiting spark.
  const grid = [
    [0, 0, 2, 0, 0],
    [0, 2, 0, 2, 0],
    [2, 0, 1, 0, 2],
    [0, 2, 0, 2, 0],
    [0, 0, 2, 0, 0],
  ];
  return (
    <svg viewBox="0 0 20 20" className={cn("text-primary", className)} aria-hidden="true">
      {grid.flatMap((row, y) =>
        row.map((v, x) =>
          v === 0 ? null : (
            <circle
              key={`${x}-${y}`}
              cx={2 + x * 4}
              cy={2 + y * 4}
              r={v === 1 ? 1.6 : 1}
              fill="currentColor"
              opacity={v === 1 ? 1 : 0.35}
            />
          )
        )
      )}
    </svg>
  );
}

/** ASCII/dot-matrix wordmark for the sidebar header. */
export function AsciiWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center justify-center", className)}>
      <span className="font-mono text-sm font-semibold uppercase tracking-[0.28em]">Juno</span>
    </span>
  );
}

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic dot-matrix identicon (5x5, horizontally symmetric) from a seed. */
export function DotIdenticon({ seed, className }: { seed: string; className?: string }) {
  const h = hash(seed || "juno");
  const cells: boolean[][] = [];
  for (let y = 0; y < 5; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < 3; x++) row.push(((h >> (y * 3 + x)) & 1) === 1);
    cells.push([row[0], row[1], row[2], row[1], row[0]]);
  }
  return (
    <svg viewBox="0 0 20 20" className={cn("text-primary", className)} aria-hidden="true">
      <rect width="20" height="20" rx="6" className="fill-secondary" />
      {cells.flatMap((row, y) =>
        row.map((on, x) =>
          on ? <circle key={`${x}-${y}`} cx={2.5 + x * 3.75} cy={2.5 + y * 3.75} r={1.3} fill="currentColor" /> : null
        )
      )}
    </svg>
  );
}

/** Dot-fill progress bar (quota, uploads). */
export function DotFillBar({
  value,
  max,
  dots = 18,
  className,
}: {
  value: number;
  max: number;
  dots?: number;
  className?: string;
}) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const filled = Math.round(ratio * dots);
  return (
    <div className={cn("flex items-center gap-[3px]", className)} aria-hidden>
      {Array.from({ length: dots }).map((_, i) => (
        <span
          key={i}
          className={cn("h-[5px] w-[5px] rounded-full transition-colors", i < filled ? "bg-primary" : "bg-border")}
        />
      ))}
    </div>
  );
}
