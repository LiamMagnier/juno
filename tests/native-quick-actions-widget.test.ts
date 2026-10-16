import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * The iPhone quick-actions widget, read from the Swift.
 *
 * WidgetKit follows one destination in systemSmall and on the Lock Screen: the
 * widget URL. The small widget used to draw four Links (three of them dead,
 * and about 200pt of tiles in a square about 160pt tall, so clipped) and its
 * description read "Start a Alevr chat". XCTest holds the actions per size to
 * the deep-link parser (JunoMobileWidgetLinkTests); this holds the view to
 * them, on Linux.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(ROOT, "native/iOS/JunoMobile/Widgets/JunoMobileWidgets.swift"), "utf8");

/** The text of a `var name: some View { … }` member of the quick-actions view, braces balanced. */
function member(name: string): string {
  const view = source.indexOf("struct JunoMobileQuickActionsView: View {");
  assert.ok(view >= 0, "no JunoMobileQuickActionsView");
  const found = new RegExp(`(?:private )?var ${name}: some View \\{`).exec(source.slice(view));
  assert.ok(found, `no ${name} view`);
  const start = view + found.index;
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced ${name}`);
}

describe("quick actions widget", () => {
  it("gives single-destination sizes one destination and no links", () => {
    for (const name of ["small", "circular", "rectangular"]) {
      assert.doesNotMatch(member(name), /Link\(/, `${name} draws a Link WidgetKit ignores`);
    }
    const body = member("body");
    for (const family of ["accessoryCircular", "accessoryRectangular"]) {
      const branch = body.slice(body.indexOf(`case .${family}:`));
      assert.match(branch.slice(0, branch.indexOf("case ", 5)), /\.widgetURL\(/, `${family} has no widget URL`);
    }
    const fallback = body.slice(body.indexOf("default:"));
    assert.match(fallback, /small\s*\n\s*\.widgetURL\(/, "the small widget has no widget URL");
  });

  it("keeps the links for the medium row", () => {
    assert.match(member("medium"), /JunoMobileQuickAction\.actions\(for: \.row\)/);
    assert.match(source, /Link\(destination: action\.url\)/);
  });

  it("lets nothing in the small square be cut off", () => {
    const small = member("small");
    assert.match(small, /maxHeight: \.infinity/);
    assert.match(small, /minimumScaleFactor/);
    assert.doesNotMatch(small, /\.frame\([^)]*height: (?:[5-9]\d|\d{3})/, "a fixed tall frame in the small widget");
  });

  it("describes itself in plain, correct English without the codename", () => {
    const description = /\.description\("([^"]*)"\)/.exec(source)?.[1] ?? "";
    assert.ok(description.length > 0);
    assert.doesNotMatch(description, /\ba Alevr\b/i);
    for (const literal of source.matchAll(/Text\("([^"]*)"\)|\.configurationDisplayName\("([^"]*)"\)/g)) {
      assert.doesNotMatch(literal[1] ?? literal[2], /Juno/, "a user-visible string names the codename");
    }
  });
});
