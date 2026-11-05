import test from "node:test";
import assert from "node:assert/strict";
import { isUnconsumedProviderRejection } from "@/lib/utility-attempt";

const silent = { receivedEvent: false, aborted: false };

test("explicit validation, credential, quota and rate rejections before a stream do not invent token consumption", () => {
  for (const status of [400, 401, 402, 403, 404, 413, 422, 429]) {
    assert.equal(isUnconsumedProviderRejection({ status }, silent), true, `HTTP ${status}`);
    assert.equal(isUnconsumedProviderRejection({ statusCode: status }, silent), true, `statusCode ${status}`);
  }
});

test("any provider event or an aborted request preserves conservative billing", () => {
  for (const status of [400, 401, 402, 403, 404, 413, 422, 429]) {
    assert.equal(isUnconsumedProviderRejection({ status }, { ...silent, receivedEvent: true }), false);
    assert.equal(isUnconsumedProviderRejection({ status }, { ...silent, aborted: true }), false);
  }
});

test("ambiguous failures and error-message text never waive a consumed request", () => {
  for (const error of [
    null, undefined, "HTTP 429", new Error("401 Unauthorized"),
    { status: "429" }, { code: 429 }, { error: { status: 429 } },
    { status: 408 }, { status: 409 }, { status: 500 }, { status: 503 }, { status: 529 },
  ]) {
    assert.equal(isUnconsumedProviderRejection(error, silent), false);
  }
});
