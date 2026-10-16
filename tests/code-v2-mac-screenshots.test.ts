import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ClientCommandResults, ComputerActionItem } from "@/lib/code-v2/contracts";
import { buildComputerTimeline } from "@/lib/code-v2/computer-timeline";
import { MacScreenshotCache, useMacScreenshots, type MacFrameSource } from "@/lib/code-v2/use-mac-screenshots";

(globalThis as { React?: typeof React }).React = React;

type Frame = ClientCommandResults["computer.frame"];
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

/** An env link whose `computer.frame` answers are released by the test. */
function fakeMac(answer: (ref: string) => Promise<Frame> = async () => ({ mime: "image/jpeg", data: JPEG.toString("base64"), bytes: JPEG.length })) {
  const asked: string[] = [];
  const source: MacFrameSource = {
    request(type, params) {
      assert.equal(type, "computer.frame");
      asked.push(params.ref);
      return answer(params.ref);
    },
  };
  return { source, asked };
}

function blobs() {
  let n = 0;
  const made: Blob[] = [];
  const revoked: string[] = [];
  return {
    made,
    revoked,
    createObjectURL: (blob: Blob) => {
      made.push(blob);
      return `blob:frame-${++n}`;
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url);
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the resolver returns null, fetches once, then the blob URL after the frame arrives", async () => {
  const mac = fakeMac();
  const urls = blobs();
  const cache = new MacScreenshotCache(mac.source, urls);
  let arrivals = 0;
  cache.subscribe(() => arrivals++);
  const ref = "alevr-shot://claude:t7/toolu_1.jpg";

  assert.equal(cache.resolve(ref), null, "nothing to show before the frame arrives");
  assert.equal(cache.resolve(ref), null);
  assert.deepEqual(mac.asked, [ref], "one fetch however often it renders meanwhile");

  await tick();
  assert.equal(arrivals, 1, "the view is told to render again");
  assert.equal(cache.resolve(ref), "blob:frame-1");
  assert.equal(urls.made[0].type, "image/jpeg");
  assert.deepEqual(Buffer.from(await urls.made[0].arrayBuffer()), JPEG, "the blob is the Mac's bytes");
  assert.deepEqual(mac.asked, [ref], "no second fetch once it is cached");

  cache.dispose();
  assert.deepEqual(urls.revoked, ["blob:frame-1"], "blob URLs are revoked on unmount");
  assert.equal(cache.resolve(ref), null);
  assert.deepEqual(mac.asked, [ref], "a disposed cache fetches nothing");
});

test("refs the web can load directly pass through; nothing else is fetched", () => {
  const mac = fakeMac();
  const cache = new MacScreenshotCache(mac.source, blobs());
  assert.equal(cache.resolve("data:image/png;base64,AAA"), "data:image/png;base64,AAA");
  assert.equal(cache.resolve("https://x.test/3.png"), "https://x.test/3.png");
  assert.equal(cache.resolve("file:///Users/me/a.png"), null);
  assert.deepEqual(mac.asked, []);
});

test("a frame that fails is not hammered, and is asked for again later", async () => {
  let now = 1_000;
  let fail = true;
  const mac = fakeMac(async () => {
    if (fail) throw new Error("Your Mac is asleep.");
    return { mime: "image/png", data: Buffer.from([0x89, 0x50]).toString("base64"), bytes: 2 };
  });
  const cache = new MacScreenshotCache(mac.source, { ...blobs(), retryAfterMs: 30_000, now: () => now });
  const ref = "alevr-shot://s1/c1.png";
  assert.equal(cache.resolve(ref), null);
  await tick();
  assert.equal(cache.resolve(ref), null);
  assert.equal(mac.asked.length, 1, "no retry inside the window");
  now += 30_001;
  fail = false;
  assert.equal(cache.resolve(ref), null);
  await tick();
  assert.equal(mac.asked.length, 2);
  assert.equal(cache.resolve(ref), "blob:frame-1");
});

test("an answer that is not an image is not shown", async () => {
  const mac = fakeMac(async () => ({ mime: "text/html" as "image/png", data: "PGh0bWw+", bytes: 6 }));
  const urls = blobs();
  const cache = new MacScreenshotCache(mac.source, urls);
  cache.resolve("alevr-shot://s/x.jpg");
  await tick();
  assert.equal(cache.resolve("alevr-shot://s/x.jpg"), null);
  assert.equal(urls.made.length, 0);
});

test("the oldest frames go past the limit, and their blob URLs are revoked", async () => {
  const mac = fakeMac();
  const urls = blobs();
  const cache = new MacScreenshotCache(mac.source, { ...urls, limit: 2 });
  for (const ref of ["alevr-shot://s/1.jpg", "alevr-shot://s/2.jpg", "alevr-shot://s/3.jpg"]) {
    cache.resolve(ref);
    await tick();
  }
  assert.deepEqual(urls.revoked, ["blob:frame-1"]);
  assert.equal(cache.resolve("alevr-shot://s/3.jpg"), "blob:frame-3");
});

test("the timeline built with the resolver shows the Mac's frame once it arrives", async () => {
  const mac = fakeMac();
  const cache = new MacScreenshotCache(mac.source, blobs());
  const items: ComputerActionItem[] = [
    { id: "a1", kind: "computer_action", createdAt: "2026-10-16T10:00:00Z", callId: "toolu_1", action: "click", status: "completed", screenshotRef: "alevr-shot://claude:t7/toolu_1.jpg" },
  ];
  assert.equal(buildComputerTimeline(items, cache.resolver())[0].src, null);
  await tick();
  assert.equal(buildComputerTimeline(items, cache.resolver())[0].src, "blob:frame-1");
});

test("the hook fetches nothing while rendering on the server, and Mac refs resolve to null there", () => {
  const mac = fakeMac();
  let seen: string | null | undefined;
  function Probe() {
    const resolve = useMacScreenshots(mac.source);
    seen = resolve("alevr-shot://claude:t7/toolu_1.jpg");
    return React.createElement("span", null, resolve("data:image/png;base64,AAA") ?? "none");
  }
  const html = renderToStaticMarkup(React.createElement(Probe));
  assert.equal(seen, null);
  assert.match(html, /data:image\/png;base64,AAA/);
  assert.deepEqual(mac.asked, [], "the cache exists only once the view mounts");
});
