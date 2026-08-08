import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POST } from "../src/app/api/csp-report/route";

test("CSP reports are best-effort and never require the primary database", async () => {
  const source = readFileSync(new URL("../src/app/api/csp-report/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /@\/lib\/rate-limit|\brateLimit\b/);

  const responses = await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      POST(
        new Request("http://localhost/api/csp-report", {
          method: "POST",
          body: JSON.stringify({
            "csp-report": {
              "document-uri": `http://localhost/${index}`,
              "violated-directive": "script-src",
            },
          }),
          headers: { "content-type": "application/csp-report" },
        }),
      ),
    ),
  );

  assert.ok(responses.every((response) => response.status === 204));
});

test("malformed CSP reports are acknowledged without throwing", async () => {
  const response = await POST(
    new Request("http://localhost/api/csp-report", {
      method: "POST",
      body: "not-json",
      headers: { "content-type": "application/csp-report" },
    }),
  );
  assert.equal(response.status, 204);
});
