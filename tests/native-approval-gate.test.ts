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

/**
 * Splits a case body around the trailing closure of its gate call:
 * `inside` is the closure the gate runs only once the owner has confirmed,
 * `outside` is everything else in the case. Position alone is not enough: a
 * send written after the gate call but outside its closure would run whether
 * or not Face ID succeeded.
 */
function aroundGate(body: string, what: string): { inside: string; outside: string } {
  const call = body.indexOf("JunoMobileApprovalGate.shared.decide(");
  assert.ok(call >= 0, `${what} no longer goes through JunoMobileApprovalGate`);
  const open = body.indexOf("{", body.indexOf(")", call));
  assert.ok(open >= 0, `${what}: the gate call has no trailing closure`);
  let depth = 0;
  for (let index = open; index < body.length; index += 1) {
    if (body[index] === "{") depth += 1;
    if (body[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return { inside: body.slice(open, index + 1), outside: body.slice(0, open) + body.slice(index + 1) };
      }
    }
  }
  throw new Error(`${what}: the gate's closure is unbalanced`);
}

describe("iPhone approval paths", () => {
  const rootView = read("JunoMobileRootView.swift");

  it("sends a linked approval only from inside the owner-authentication gate", () => {
    const { inside, outside } = aroundGate(caseBody(rootView, "respondToRemoteApproval"), "the approval link");
    assert.equal(inside.split("respondToApproval(").length - 1, 1, "the gate's closure no longer sends the decision");
    assert.doesNotMatch(outside, /respondToApproval\(/, "respondToApproval is called outside the gate's closure");
    assert.doesNotMatch(outside, /resolveApproval\(/, "the Live Activity is resolved before the owner confirmed");
  });

  it("hands a routed notification answer to Code only from inside the gate", () => {
    const { inside, outside } = aroundGate(caseBody(rootView, "respondToLinkApproval"), "the routed answer");
    assert.match(inside, /linkApproval = /, "the gate's closure no longer hands the answer to Code");
    assert.doesNotMatch(outside, /linkApproval = /, "linkApproval is set outside the gate's closure");
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

  it("never decides an approval where a link, intent or activity first arrives", () => {
    // These files parse what other apps, Siri, Shortcuts, Handoff and the Lock
    // Screen hand the app. They may only record a launch request; the root view
    // decides it, through the gate. A send here would skip Face ID again.
    const entryPoints = [
      "native/iOS/JunoMobile/App/JunoMobileIntents.swift",
      "native/iOS/JunoMobile/App/JunoMobileApp.swift",
      "native/iOS/JunoMobile/App/JunoMobileHandoff.swift",
      "native/iOS/JunoMobile/App/JunoMobileLiveActivities.swift",
      "native/iOS/JunoMobile/Widgets/JunoMobileWidgets.swift",
    ];
    for (const file of entryPoints) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      assert.doesNotMatch(source, /respondToApproval\(|answerRouted\(|\blinkApproval\s*=/, `${file} decides an approval directly`);
    }
  });
});
