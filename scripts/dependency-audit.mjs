import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Production advisories Juno has decided to ship with anyway. Each entry names
// the package, the exact GHSA ids it covers, why they cannot reach Juno or
// cannot be patched yet, and the last day the decision holds. An exception
// past its date fails the gate, so it is re-assessed rather than forgotten; an
// exception whose advisory has gone fails too, so the list never outlives the
// problem. Empty is the goal.
//
// Shape: { package: "name", advisories: ["GHSA-xxxx-xxxx-xxxx"],
//          reason: "why it is unreachable or unpatchable", expires: "YYYY-MM-DD" }
/** @type {{ package: string, advisories: string[], reason: string, expires: string }[]} */
export const ACCEPTED_ADVISORIES = [
  {
    package: "braces",
    advisories: ["GHSA-vfj7-8cjw-p6xm"],
    reason:
      "No patched release exists (3.0.3 is the latest and is affected). braces arrives only through tailwindcss (chokidar, micromatch) and runs at build time on the repository's own content globs; no request, upload or user string ever reaches it, so the stack-exhaustion pattern cannot be supplied by an attacker. Re-check for a fixed release by the expiry.",
    expires: "2026-10-17",
  },
];

// An exception may not be dated further out than this, so "accepted" always
// means "looked at this quarter".
export const MAX_EXCEPTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function advisoryId(via) {
  const ghsa = /GHSA(?:-[0-9a-z]{4}){3}/i.exec(String(via.url ?? ""));
  return ghsa ? ghsa[0] : `npm:${via.source}`;
}

/**
 * Checks an `npm audit --json` report against the accepted exceptions.
 * Only root advisories are judged: a package listed because it depends on a
 * vulnerable one (its `via` is a package name) is covered by that package's
 * advisory and clears when it does.
 *
 * @param {any} report parsed `npm audit --omit=dev --json` output
 * @param {{ package: string, advisories: string[], reason: string, expires: string }[]} accepted
 * @param {string} today UTC date, YYYY-MM-DD
 * @returns {{ failures: string[], accepted: string[] }}
 */
export function evaluateAudit(report, accepted, today) {
  const failures = [];
  const acceptedNow = [];

  // A failed audit (offline, registry error) still prints JSON, with no
  // report in it. That must fail rather than read as "no vulnerabilities".
  if (
    !report ||
    report.auditReportVersion !== 2 ||
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== "object"
  ) {
    const detail = report?.message || report?.error?.summary || "no report";
    return { failures: [`npm audit did not return a report: ${detail}`], accepted: [] };
  }

  const live = new Map();
  for (const entry of accepted) {
    const label = `exception for ${entry.package ?? "(unnamed)"}`;
    if (!entry.package || !Array.isArray(entry.advisories) || entry.advisories.length === 0) {
      failures.push(`${label}: must name a package and at least one GHSA id.`);
      continue;
    }
    if (!entry.reason || !entry.reason.trim()) {
      failures.push(`${label}: must say why the advisory is acceptable.`);
      continue;
    }
    if (!DATE_RE.test(entry.expires ?? "") || Number.isNaN(Date.parse(entry.expires))) {
      failures.push(`${label}: expires must be a YYYY-MM-DD date.`);
      continue;
    }
    if (entry.expires < today) {
      failures.push(
        `${label} expired on ${entry.expires}: upgrade, or re-assess and renew it with a fresh reason and date.`,
      );
      continue;
    }
    const daysOut = (Date.parse(entry.expires) - Date.parse(today)) / DAY_MS;
    if (daysOut > MAX_EXCEPTION_DAYS) {
      failures.push(`${label}: expires ${entry.expires}, more than ${MAX_EXCEPTION_DAYS} days out.`);
      continue;
    }
    for (const id of entry.advisories) live.set(`${entry.package}|${id}`, entry);
  }

  const seen = new Set();
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      const id = advisoryId(via);
      const key = `${via.name}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const exception = live.get(key);
      if (exception) {
        acceptedNow.push(`${via.name} ${id} (until ${exception.expires})`);
      } else {
        failures.push(`${via.name} ${id} [${via.severity}] ${via.title ?? ""} (affected ${via.range ?? "?"})`);
      }
    }
  }

  for (const key of live.keys()) {
    if (!seen.has(key)) {
      failures.push(`exception ${key.replace("|", " ")} is no longer reported by npm audit; remove it.`);
    }
  }

  return { failures, accepted: acceptedNow };
}

/**
 * package.json overrides image-size to the patched 2.x line although pptxgenjs
 * declares ^1. That is safe only while pptxgenjs never loads image-size: its
 * 4.0.1 build ships the sizing helper commented out. If a pptxgenjs upgrade
 * starts importing it, it would get an API it was not written for, so stop.
 *
 * @param {string} root repository root
 * @returns {string[]}
 */
export function imageSizeOverrideFailures(root) {
  const dist = path.join(root, "node_modules", "pptxgenjs", "dist");
  if (!existsSync(dist)) return [];
  const loads = /(?:require\s*\(\s*|from\s*|import\s*\(\s*)["']image-size(?:\/[^"']*)?["']/;
  return readdirSync(dist)
    .filter((file) => /\.[cm]?js$/.test(file))
    .filter((file) => loads.test(readFileSync(path.join(dist, file), "utf8")))
    .map(
      (file) =>
        `node_modules/pptxgenjs/dist/${file} loads image-size, which package.json overrides to 2.x; ` +
        "check deck image export and revisit the override.",
    );
}

function main() {
  const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  if (!audit.stdout.trim()) {
    process.stderr.write(audit.stderr);
    process.exit(audit.status || 1);
  }

  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    console.error("npm audit printed output that is not JSON.");
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const { failures, accepted } = evaluateAudit(report, ACCEPTED_ADVISORIES, today);
  failures.push(...imageSizeOverrideFailures(process.cwd()));

  if (failures.length > 0) {
    console.error("Dependency audit failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(
    accepted.length === 0
      ? "Dependency audit passed: no production advisories."
      : `Dependency audit passed: accepted ${accepted.join(", ")}.`,
  );
}

const invokedAsScript = process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url;
if (invokedAsScript) main();
