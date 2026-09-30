import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ACCEPTED_ADVISORIES,
  MAX_EXCEPTION_DAYS,
  evaluateAudit,
  imageSizeOverrideFailures,
} from "../scripts/dependency-audit.mjs";

/*
 * The dependency gate hard-coded the accepted set as two package names with no
 * reason or date, so it could only ever be edited, never expire, and ten live
 * advisories (next-auth via nodemailer, imapflow, ip-address, brace-expansion,
 * fast-uri) sat behind a gate nothing ran. It now judges each GHSA id, accepts
 * one only with a reason and a date at most a quarter out, and fails on an
 * expired or stale exception and on an audit that returned no report.
 */

const TODAY = "2026-09-30";

function advisory(name: string, ghsa: string, severity = "high") {
  return {
    source: 1,
    name,
    dependency: name,
    title: `${name} advisory`,
    url: `https://github.com/advisories/${ghsa}`,
    severity,
    range: "<=1.0.0",
  };
}

function report(vulnerabilities: Record<string, unknown>) {
  return { auditReportVersion: 2, vulnerabilities, metadata: {} };
}

// The shape npm printed for the image-size chain before the override: the
// root advisory on image-size, and pptxgenjs listed only by name.
const imageSizeChain = report({
  "image-size": { name: "image-size", via: [advisory("image-size", "GHSA-5p2g-fcmc-qvqq")] },
  pptxgenjs: { name: "pptxgenjs", via: ["image-size"] },
});

const accept = (overrides: Partial<(typeof ACCEPTED_ADVISORIES)[number]> = {}) => ({
  package: "image-size",
  advisories: ["GHSA-5p2g-fcmc-qvqq"],
  reason: "pptxgenjs never loads it",
  expires: "2026-10-31",
  ...overrides,
});

test("a clean report passes", () => {
  assert.deepEqual(evaluateAudit(report({}), [], TODAY), { failures: [], accepted: [] });
});

test("every shipped exception is well formed and in date today", () => {
  const today = new Date().toISOString().slice(0, 10);
  const covered = report(
    Object.fromEntries(
      ACCEPTED_ADVISORIES.map((entry) => [
        entry.package,
        { name: entry.package, via: entry.advisories.map((id) => advisory(entry.package, id)) },
      ]),
    ),
  );
  assert.deepEqual(evaluateAudit(covered, ACCEPTED_ADVISORIES, today).failures, []);
});

test("an unaccepted advisory fails with its package and GHSA id", () => {
  const { failures } = evaluateAudit(
    report({
      nodemailer: { name: "nodemailer", via: [advisory("nodemailer", "GHSA-6vj9-mwq6-2f5v")] },
      "next-auth": { name: "next-auth", via: ["@auth/core", "nodemailer"] },
      "@auth/core": { name: "@auth/core", via: ["nodemailer"] },
    }),
    [],
    TODAY,
  );
  // One failure for the root advisory; the packages that merely depend on it
  // clear when it does.
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^nodemailer GHSA-6vj9-mwq6-2f5v \[high\]/);
});

test("a dated, reasoned exception covers its advisory and the packages it reaches", () => {
  const result = evaluateAudit(imageSizeChain, [accept()], TODAY);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.accepted, ["image-size GHSA-5p2g-fcmc-qvqq (until 2026-10-31)"]);
});

test("an exception covers only the GHSA ids it names", () => {
  const { failures } = evaluateAudit(
    report({
      "image-size": {
        name: "image-size",
        via: [advisory("image-size", "GHSA-5p2g-fcmc-qvqq"), advisory("image-size", "GHSA-w3rx-r6r6-pgpr")],
      },
    }),
    [accept()],
    TODAY,
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /GHSA-w3rx-r6r6-pgpr/);
});

test("an exception fails the gate the day after it expires", () => {
  assert.deepEqual(evaluateAudit(imageSizeChain, [accept({ expires: TODAY })], TODAY).failures, []);
  const { failures } = evaluateAudit(imageSizeChain, [accept({ expires: "2026-09-29" })], TODAY);
  assert.ok(failures.some((f) => /expired on 2026-09-29/.test(f)), failures.join("\n"));
  // The advisory it covered is reported again, not silently carried.
  assert.ok(failures.some((f) => /^image-size GHSA-5p2g-fcmc-qvqq/.test(f)), failures.join("\n"));
});

test("an exception cannot be dated more than a quarter out, lack a reason, or use a loose date", () => {
  const farOut = new Date(Date.parse(TODAY) + (MAX_EXCEPTION_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
  for (const [entry, pattern] of [
    [accept({ expires: farOut }), /more than 90 days out/],
    [accept({ reason: "  " }), /must say why/],
    [accept({ expires: "31/10/2026" }), /YYYY-MM-DD/],
    [accept({ advisories: [] }), /at least one GHSA id/],
  ] as const) {
    const { failures } = evaluateAudit(imageSizeChain, [entry], TODAY);
    assert.ok(failures.some((f) => pattern.test(f)), `${pattern}: ${failures.join("\n")}`);
  }
});

test("an exception whose advisory is gone fails until it is removed", () => {
  const { failures } = evaluateAudit(report({}), [accept()], TODAY);
  assert.deepEqual(failures, [
    "exception image-size GHSA-5p2g-fcmc-qvqq is no longer reported by npm audit; remove it.",
  ]);
});

test("an audit that returned no report fails instead of passing as clean", () => {
  // What npm prints with the registry unreachable.
  const offline = {
    message: "request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed",
    error: { summary: "", detail: "" },
  };
  const { failures } = evaluateAudit(offline, [], TODAY);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /did not return a report: request to/);
  assert.equal(evaluateAudit(null, [], TODAY).failures.length, 1);
});

test("the image-size override is safe: pptxgenjs does not load image-size", () => {
  assert.deepEqual(imageSizeOverrideFailures(process.cwd()), []);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.overrides["image-size"], "2.0.4");

  // And the guard does fire on a build that imports it.
  const root = mkdtempSync(path.join(tmpdir(), "dep-audit-"));
  try {
    const dist = path.join(root, "node_modules", "pptxgenjs", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, "pptxgen.cjs.js"), "const sizeOf = require('image-size');\n");
    writeFileSync(path.join(dist, "pptxgen.es.js"), "// image-size is mentioned only in a comment\n");
    const failures = imageSizeOverrideFailures(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /pptxgen\.cjs\.js loads image-size/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("imapflow no longer pulls nodemailer and still constructs a client", async () => {
  // imapflow 1.6+ dropped its nodemailer dependency; Juno's magic link goes
  // through Resend over fetch, so nodemailer is out of the production tree.
  const imapPkg = JSON.parse(readFileSync("node_modules/imapflow/package.json", "utf8"));
  assert.equal(imapPkg.dependencies?.nodemailer, undefined);
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    auth: { user: "someone@icloud.com", pass: "placeholder" },
    logger: false,
  });
  assert.equal(typeof client.connect, "function");
  assert.equal(client.usable, false);
});
