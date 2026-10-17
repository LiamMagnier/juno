import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkAppConfig,
  expandMacros,
  packagePlatformFloor,
  parsePlist,
  parseYaml,
} from "../scripts/check-native-app-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch: string[] = [];
after(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A copy of exactly what the check reads, to break one thing at a time. */
function tree(): { root: string; edit: (file: string, change: (text: string) => string) => void } {
  const root = mkdtempSync(path.join(tmpdir(), "native-app-config-"));
  scratch.push(root);
  const copy = (relative: string) =>
    cpSync(path.join(ROOT, relative), path.join(root, relative), {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}.build`),
    });
  copy("native/Config");
  copy("native/iOS/JunoMobile/project.yml");
  copy("native/iOS/JunoMobile/JunoMobile.xcodeproj/project.pbxproj");
  copy("native/iOS/JunoMobile/Resources/Info.plist");
  copy("native/iOS/JunoMobile/Resources/JunoMobile.entitlements");
  copy("native/iOS/JunoMobile/App");
  copy("native/iOS/JunoMobile/Widgets");
  copy("native/macOS/JunoDesktop/project.yml");
  copy("native/macOS/JunoDesktop/JunoDesktop.xcodeproj/project.pbxproj");
  for (const name of ["JunoNativeKit", "JunoCode", "JunoWork", "JunoScreenControl"]) {
    copy(`native/Packages/${name}/Package.swift`);
  }
  return {
    root,
    edit(file, change) {
      const absolute = path.join(root, file);
      const before = readFileSync(absolute, "utf8");
      const next = change(before);
      assert.notEqual(next, before, `the edit to ${file} changed nothing`);
      writeFileSync(absolute, next);
    },
  };
}

const rules = (root: string) => checkAppConfig({ root }).errors.map((error: { rule: string }) => error.rule);

const ENTITLEMENTS = "native/iOS/JunoMobile/Resources/JunoMobile.entitlements";
const SPEC = "native/iOS/JunoMobile/project.yml";
const PBXPROJ = "native/iOS/JunoMobile/JunoMobile.xcodeproj/project.pbxproj";

describe("native app config check", () => {
  it("holds for the committed tree, with push resolving per configuration", () => {
    const { errors, facts } = checkAppConfig({ root: ROOT });
    assert.deepEqual(errors, []);
    assert.deepEqual(facts.apsEnvironment, { Debug: "development", Stable: "development", Next: "development" });
    assert.equal(facts.iosDeploymentTarget, "26.0");
    assert.equal(facts.macDeploymentTarget, "26.0");
  });

  it("fails on the empty entitlements 615d3a5b0 left behind", () => {
    const { root, edit } = tree();
    edit(ENTITLEMENTS, (text) => text.replace(/<dict>[\s\S]*<\/dict>/, "<dict/>"));
    assert.ok(rules(root).includes("aps-environment"));
  });

  it("fails when aps-environment no longer follows the signing identity", () => {
    const { root, edit } = tree();
    edit("native/Config/JunoMobile-Push.xcconfig", (text) =>
      text.replace(/^JUNO_APS_ENVIRONMENT = .*$/m, "JUNO_APS_ENVIRONMENT = production")
    );
    assert.ok(rules(root).includes("aps-environment"));
  });

  it("fails when aps-environment resolves to nothing", () => {
    const { root, edit } = tree();
    edit("native/Config/JunoMobile-Stable.xcconfig", (text) => text.replace('#include "JunoMobile-Push.xcconfig"\n', ""));
    // Without the include the variable is undefined, so Stable signs an empty value.
    assert.ok(rules(root).includes("aps-environment"));
  });

  it("fails when a shipping configuration stops signing with the entitlements", () => {
    const { root, edit } = tree();
    edit("native/Config/JunoMobile-Next.xcconfig", (text) =>
      text.replace("JUNO_MOBILE_ENTITLEMENTS = Resources/JunoMobile.entitlements", "JUNO_MOBILE_ENTITLEMENTS =")
    );
    assert.ok(rules(root).includes("entitlements-path"));
  });

  it("ignores the git-ignored personal-team override", () => {
    const { root } = tree();
    // A developer's JunoMobile-Local.xcconfig clears the entitlements for a
    // free team. It is optional (#include?) and not the committed config.
    writeFileSync(path.join(root, "native/Config/JunoMobile-Local.xcconfig"), "JUNO_MOBILE_ENTITLEMENTS =\n");
    assert.deepEqual(rules(root), []);
  });

  it("fails when project.yml or the pbxproj signs with a literal path", () => {
    const spec = tree();
    spec.edit(SPEC, (text) =>
      text.replace("CODE_SIGN_ENTITLEMENTS: $(JUNO_MOBILE_ENTITLEMENTS)", "CODE_SIGN_ENTITLEMENTS: Resources/JunoMobile.entitlements")
    );
    assert.ok(rules(spec.root).includes("signing-variable"));

    const pbx = tree();
    pbx.edit(PBXPROJ, (text) =>
      text.replace('CODE_SIGN_ENTITLEMENTS = "$(JUNO_MOBILE_ENTITLEMENTS)";', "CODE_SIGN_ENTITLEMENTS = Resources/JunoMobile.entitlements;")
    );
    assert.ok(rules(pbx.root).includes("signing-variable"));
  });

  it("fails on an XcodeGen entitlements block that would rewrite the file without push", () => {
    const { root, edit } = tree();
    edit(SPEC, (text) =>
      text.replace(
        "  JunoMobile:\n    type: application\n",
        "  JunoMobile:\n    type: application\n    entitlements:\n      path: Resources/JunoMobile.entitlements\n"
      )
    );
    assert.ok(rules(root).includes("signing-variable"));
  });

  it("fails when a generate stops re-running the check", () => {
    const { root, edit } = tree();
    edit(SPEC, (text) => text.replace("check-native-app-config.mjs", "something-else.mjs"));
    assert.ok(rules(root).includes("post-gen-guard"));
  });

  it("fails when project.yml, the pbxproj or a package drift from the xcconfig floor", () => {
    const spec = tree();
    spec.edit(SPEC, (text) => text.replace('iOS: "26.0"', 'iOS: "18.0"'));
    assert.ok(rules(spec.root).includes("deployment-target"));

    const pbx = tree();
    pbx.edit(PBXPROJ, (text) => text.replace("IPHONEOS_DEPLOYMENT_TARGET = 26.0;", "IPHONEOS_DEPLOYMENT_TARGET = 18.0;"));
    assert.ok(rules(pbx.root).includes("deployment-target"));

    const pkg = tree();
    pkg.edit("native/Packages/JunoCode/Package.swift", (text) => text.replace('.iOS("26.0")', '.iOS("27.0")'));
    assert.ok(rules(pkg.root).includes("deployment-target"));

    const mac = tree();
    mac.edit("native/macOS/JunoDesktop/project.yml", (text) => text.replace('macOS: "26.0"', 'macOS: "15.0"'));
    assert.ok(rules(mac.root).includes("deployment-target"));
  });

  it("fails when Swift names an App Group a target does not declare", () => {
    const { root } = tree();
    writeFileSync(
      path.join(root, "native/iOS/JunoMobile/Widgets/Snapshot.swift"),
      'let defaults = UserDefaults(suiteName: "group.com.liammagnier.JunoMobile")\n'
    );
    assert.ok(rules(root).includes("app-group"));
  });

  it("fails when the app and its widget declare different App Groups", () => {
    const { root, edit } = tree();
    edit(ENTITLEMENTS, (text) =>
      text.replace(
        "</dict>",
        "\t<key>com.apple.security.application-groups</key>\n\t<array>\n\t\t<string>group.one</string>\n\t</array>\n</dict>"
      )
    );
    writeFileSync(
      path.join(root, "native/iOS/JunoMobile/Widgets/JunoMobileWidgets.entitlements"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>com.apple.security.application-groups</key>\n\t<array>\n\t\t<string>group.two</string>\n\t</array>\n</dict>\n</plist>\n'
    );
    edit(SPEC, (text) =>
      text.replace(
        "        INFOPLIST_FILE: Widgets/Info.plist\n",
        "        INFOPLIST_FILE: Widgets/Info.plist\n        CODE_SIGN_ENTITLEMENTS: Widgets/JunoMobileWidgets.entitlements\n"
      )
    );
    const { errors } = checkAppConfig({ root });
    assert.ok(errors.some((error: { rule: string; message: string }) => error.rule === "app-group" && error.message.includes("different App Groups")));
  });

  it("checks associated domains once declared, and reports the handler without them", () => {
    const { root, edit } = tree();
    assert.ok(checkAppConfig({ root }).warnings.some((warning: { rule: string }) => warning.rule === "associated-domains"));
    edit(ENTITLEMENTS, (text) =>
      text.replace(
        "</dict>",
        "\t<key>com.apple.developer.associated-domains</key>\n\t<array>\n\t\t<string>https://chat.example</string>\n\t</array>\n</dict>"
      )
    );
    assert.ok(rules(root).includes("associated-domains"));
    edit(ENTITLEMENTS, (text) => text.replace("https://chat.example", "applinks:chat.example"));
    const result = checkAppConfig({ root });
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.length, 0);
  });

  it("fails when LocalAuthentication ships without a Face ID usage string", () => {
    const { root, edit } = tree();
    edit("native/iOS/JunoMobile/Resources/Info.plist", (text) =>
      text.replace(/\t<key>NSFaceIDUsageDescription<\/key>\n\t<string>[^<]*<\/string>\n/, "")
    );
    assert.ok(rules(root).includes("face-id-usage"));
  });
});

describe("native app config parsers", () => {
  it("expands nested macros with operators the way Xcode does", () => {
    const values: Record<string, string> = {
      CODE_SIGN_IDENTITY: "Apple Distribution",
      PICK_Apple_Distribution: "production",
    };
    const lookup = (name: string) => values[name] ?? "";
    assert.equal(expandMacros("$(PICK_$(CODE_SIGN_IDENTITY:c99extidentifier):default=development)", lookup), "production");
    values.CODE_SIGN_IDENTITY = "Apple Development: Someone (ABC123)";
    assert.equal(expandMacros("$(PICK_$(CODE_SIGN_IDENTITY:c99extidentifier):default=development)", lookup), "development");
  });

  it("reads plists, including attributes and comments", () => {
    const plist = parsePlist(
      '<?xml version="1.0"?>\n<!-- note -->\n<plist version="1.0"><dict><key>a</key><string>x &amp; y</string><key>b</key><array><true/><integer>3</integer></array><key>c</key><dict/></dict></plist>'
    );
    assert.deepEqual(plist, { a: "x & y", b: [true, 3], c: {} });
  });

  it("reads the YAML project.yml uses", () => {
    const parsed = parseYaml(
      [
        "options:",
        "  deploymentTarget:",
        '    iOS: "26.0" # floor',
        "  postGenCommand: >-",
        "    one",
        "    two",
        "targets:",
        "  App:",
        "    sources:",
        "      - path: App",
        "        excludes:",
        "          - Info.plist",
        "      - Widgets",
        "    build: [test]",
      ].join("\n")
    );
    assert.deepEqual(parsed, {
      options: { deploymentTarget: { iOS: "26.0" }, postGenCommand: "one two" },
      targets: { App: { sources: [{ path: "App", excludes: ["Info.plist"] }, "Widgets"], build: ["test"] } },
    });
  });

  it("reads both forms of a package's platform floor", () => {
    assert.equal(packagePlatformFloor('platforms: [.macOS("26.0"), .iOS("26.0")]', "iOS"), "26.0");
    assert.equal(packagePlatformFloor("platforms: [.macOS(.v14), .iOS(.v17)]", "iOS"), "17");
    assert.equal(packagePlatformFloor("platforms: [.macOS(.v14)]", "iOS"), null);
  });
});
