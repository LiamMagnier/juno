import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { blockedFetchAddress, blockedFetchTarget } from "../runner/agent-core/src/work/tools.js";
import { chatFetchBlockReason, isDisallowedAddress, isDisallowedHost } from "@/lib/search/url-safety";

/*
 * One SSRF classifier (SPEC §6.4 item 2, gap-web W8). The Work runner keeps its
 * own copy (`blockedFetchAddress` / `blockedFetchTarget`), which this rework
 * does not edit. The two had drifted — the runner blocked all of 0.0.0.0/8 and
 * multicast and documentation IPv6 at the host level, where src caught them
 * only after DNS — so src now carries the union plus the IPv6 transition
 * ranges, and this test holds the direction that matters: on one shared
 * fixture, src blocks EVERYTHING the runner blocks. (The reverse is not
 * required: src is deliberately stricter.)
 */

const ADDRESSES = [
  // IPv4: every range either side knows, and near misses.
  "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "100.63.255.255",
  "127.0.0.1", "127.255.255.254", "169.254.169.254", "169.253.0.1", "172.16.0.1", "172.31.255.255", "172.32.0.1",
  "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.7",
  "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "8.8.8.8", "93.184.216.34", "1.1.1.1",
  // IPv6.
  "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:8.8.8.8", "fc00::1", "fd12:3456::1",
  "fe80::1", "febf::1", "ff02::1", "ff0e::1", "2001:db8::1", "2001:db8:ffff::1", "2606:4700:4700::1111",
  "2a00:1450:4001:80b::200e",
  // The transition ranges src adds.
  "::127.0.0.1", "::a00:1", "64:ff9b::7f00:1", "64:ff9b::808:808", "64:ff9b:1::1", "2002:7f00:1::1",
  "2002:0a00:0001::1", "2002:0808:0808::1", "fec0::1", "100::1",
];

const URLS = [
  "http://localhost/", "http://LOCALHOST./", "http://app.localhost:3000/", "http://svc.internal/", "http://printer.local/",
  "https://example.com/", "https://example.com:8443/", "ftp://example.com/", "file:///etc/passwd", "data:text/html,x",
  "javascript:alert(1)", "https://user:pw@example.com/", "not a url",
  ...ADDRESSES.map((address) => (address.includes(":") ? `http://[${address}]/` : `http://${address}/`)),
];

test("src blocks every address the runner blocks", () => {
  for (const address of ADDRESSES) {
    if (blockedFetchAddress(address) !== null) {
      assert.equal(isDisallowedAddress(address), true, `the runner blocks ${address}; src must too`);
    }
  }
});

test("src blocks every URL the runner blocks", () => {
  for (const url of URLS) {
    if (blockedFetchTarget(url) !== null) {
      assert.equal(isDisallowedHost(url), true, `the runner blocks ${url}; src must too`);
      assert.notEqual(chatFetchBlockReason(url, new Set()), null, `the runner blocks ${url}; chat must too`);
    }
  }
});

test("the fixture is not vacuous: the runner blocks most of it", () => {
  const blocked = ADDRESSES.filter((address) => blockedFetchAddress(address) !== null);
  assert.ok(blocked.length >= 30, `only ${blocked.length} runner-blocked addresses`);
});

test("src also blocks the IPv6 roads back to an IPv4 address that the runner misses", () => {
  const added: Array<[string, string]> = [
    ["::127.0.0.1", "IPv4-compatible (::/96) loopback"],
    ["::a00:1", "IPv4-compatible 10.0.0.1"],
    ["64:ff9b::7f00:1", "NAT64 (64:ff9b::/96) — translated to whatever it embeds"],
    ["64:ff9b::808:808", "NAT64 is refused whole, public embedded address or not"],
    ["64:ff9b:1::1", "local-use NAT64 (64:ff9b:1::/48)"],
    ["2002:7f00:1::1", "6to4 embedding 127.0.0.1"],
    ["2002:0a00:0001::1", "6to4 embedding 10.0.0.1"],
    ["fec0::1", "deprecated site-local"],
    ["100::1", "discard-only (100::/64)"],
  ];
  for (const [address, why] of added) {
    assert.equal(isDisallowedAddress(address), true, `${address}: ${why}`);
    assert.equal(isDisallowedHost(`http://[${address}]/`), true, `${address} as a URL literal: ${why}`);
  }
  // 6to4 of a public address is an ordinary route.
  assert.equal(isDisallowedAddress("2002:0808:0808::1"), false);
});

test("public addresses stay reachable", () => {
  for (const address of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.32.0.1", "100.63.255.255", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"]) {
    assert.equal(isDisallowedAddress(address), false, address);
  }
  assert.equal(isDisallowedAddress("not-an-ip"), true, "a resolver answer that is not an address is refused");
});

test("the SSRF classifier keeps server-only out of a test's import graph (harness rule 1)", () => {
  for (const file of ["src/lib/search/url-safety.ts"]) {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /^import "server-only";/m, file);
    assert.doesNotMatch(source, /^import [^;]*from "@\/lib\/(search\/search-engine|web-search|prisma|db)";/m, file);
  }
});
