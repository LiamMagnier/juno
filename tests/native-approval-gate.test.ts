import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * The iPhone's approval paths, read from the Swift.
 *
 * `com.liammagnier.juno://juno/code/approval?…&approved=true` (any app or page
 * can open it, and the Live Activity's Allow and Deny produce it) used to send
 * the decision as soon as the root view parsed it, while the notification's
 * Allow once and Deny required Face ID. JunoMobileApprovalGateTests pins the
 * gate's behaviour in XCTest; this pins that the root view actually routes
 * both approval launch requests through it, so a refactor that calls the model
 * directly again fails on Linux, without Xcode.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "native/iOS/JunoMobile/App");
const read = (file: string) => readFileSync(path.join(APP, file), "utf8");

/** The body of one `case` in `handleLaunchRequest`, up to the next case. */
function caseBody(source: string, label: string): string {
  const start = source.indexOf(`case let .${label}(`);
  assert.ok(start >= 0, `RootView no longer handles .${label}`);
  const next = source.indexOf("\n    case ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

describe("iPhone approval paths", () => {
  const rootView = read("JunoMobileRootView.swift");

  it("sends a linked approval only from inside the owner-authentication gate", () => {
    const body = caseBody(rootView, "respondToRemoteApproval");
    const gate = body.indexOf("JunoMobileApprovalGate.shared.decide(");
    const send = body.indexOf("respondToApproval(");
    assert.ok(gate >= 0, "the approval link no longer goes through JunoMobileApprovalGate");
    assert.ok(send > gate, "respondToApproval is called outside the gate");
    assert.equal(body.split("respondToApproval(").length - 1, 1, "a second, ungated respondToApproval call");
  });

  it("hands a routed notification answer to Code only from inside the gate", () => {
    const body = caseBody(rootView, "respondToLinkApproval");
    const gate = body.indexOf("JunoMobileApprovalGate.shared.decide(");
    const answer = body.indexOf("linkApproval = ");
    assert.ok(gate >= 0, "the routed answer no longer goes through JunoMobileApprovalGate");
    assert.ok(answer > gate, "linkApproval is set outside the gate");
  });

  it("asks for device-owner authentication, never accepting the unlock as the answer", () => {
    const gate = read("JunoMobileApprovalGate.swift");
    assert.match(gate, /\.deviceOwnerAuthentication/);
    assert.match(gate, /touchIDAuthenticationAllowableReuseDuration = 0/);
  });

  it("keeps the notification actions behind the system's authentication", () => {
    const responder = read("JunoMobileLinkApprovalResponder.swift");
    const allow = /identifier: allowOnceAction, title: "Allow once", options: \[([^\]]*)\]/.exec(responder);
    const deny = /identifier: denyAction, title: "Deny", options: \[([^\]]*)\]/.exec(responder);
    assert.ok(allow && allow[1].includes(".authenticationRequired"));
    assert.ok(deny && deny[1].includes(".authenticationRequired"));
  });

  it("ships the Face ID usage string the prompt needs", () => {
    const info = readFileSync(path.join(ROOT, "native/iOS/JunoMobile/Resources/Info.plist"), "utf8");
    assert.match(info, /<key>NSFaceIDUsageDescription<\/key>\s*<string>[^<]*Face ID[^<]*<\/string>/);
  });
});
