import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { pinnedLookup } from "@/lib/search/pinned-fetch";

// A real socket, because the failure only happens there: Node's net.connect
// asks the lookup for `{ all: true }` and rejects a bare (address, family)
// answer with ERR_INVALID_IP_ADDRESS. Every earlier test replaced the
// transport, so nothing noticed that every pinned fetch failed.
test("a pinned lookup connects a real socket to the validated address", async () => {
  const server = http.createServer((_req, res) => res.end("pinned"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        {
          // A name that does not resolve: only the pinned answer can connect it.
          hostname: "pinned.invalid",
          port,
          path: "/",
          lookup: pinnedLookup("127.0.0.1", 4),
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () => resolve(text));
        },
      );
      request.on("error", reject);
      request.end();
    });
    assert.equal(body, "pinned");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a pinned lookup answers both the array and the single-address form", () => {
  const lookup = pinnedLookup("93.184.216.34", 4) as unknown as (
    hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => void;
  lookup("example.com", { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
  });
  lookup("example.com", {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, "93.184.216.34");
    assert.equal(family, 4);
  });
});
