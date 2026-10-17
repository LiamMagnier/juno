#!/usr/bin/env node
/*
 * The native apps' signing configuration, checked where it has silently broken
 * before (`npm run native:entitlements:check`).
 *
 * Commit 615d3a5b0 regenerated the iPhone project and left
 * JunoMobile.entitlements an empty <dict/>. Nothing failed: the app built,
 * signed and installed, and `registerForRemoteNotifications` simply never
 * succeeded again, which killed every push (agents, Work, research, Code
 * approvals) and "Continue on iPhone". The same kind of drift had project.yml
 * and the .pbxproj at iOS 18 while the xcconfigs and the Swift packages
 * required 26. Each rule below fails on one of those, by name:
 *
 *   entitlements-path   every JunoMobile xcconfig signs with the same,
 *                       existing entitlements file.
 *   aps-environment     the file carries `aps-environment`, and it resolves to
 *                       `development` or `production` in every configuration
 *                       (and follows the signing identity, as
 *                       JunoMobile-Push.xcconfig documents).
 *   signing-variable    project.yml and the .pbxproj sign through
 *                       $(JUNO_MOBILE_ENTITLEMENTS), with no XcodeGen
 *                       `entitlements:` block that would rewrite the file.
 *   post-gen-guard      project.yml re-runs this check after every generate.
 *   deployment-target   project.yml, the .pbxproj and the xcconfigs agree on
 *                       one floor per app, and no Swift package the app links
 *                       requires a newer one.
 *   app-group           an App Group the Swift code names is declared by every
 *                       target that names it, and the app and its widget
 *                       extension declare the same groups.
 *   associated-domains  declared domains are well formed; a universal-link
 *                       handler without any is reported.
 *   face-id-usage       code that uses LocalAuthentication ships
 *                       NSFaceIDUsageDescription (Face ID refuses without it).
 *
 * Neither App Groups nor Associated Domains are declared today, and none of
 * the Swift code needs an App Group yet, so those rules hold the line for when
 * they are added rather than demanding them now. The universal-link handler in
 * JunoMobileHandoff.swift is the exception: it cannot receive anything until
 * the App IDs have the Associated Domains capability, the entitlements carry
 * `applinks:` for the site and the site serves apple-app-site-association.
 * That needs the Apple Developer account, so it is a warning, not a failure.
 *
 * Pure Node (`node:*` only), so it runs on Linux without `npm ci`, and every
 * part is exported for tests/check-native-app-config.test.ts.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The iPhone app: the project whose entitlements this check owns. */
export const IOS_APP = {
  name: "JunoMobile",
  dir: "native/iOS/JunoMobile",
  spec: "native/iOS/JunoMobile/project.yml",
  pbxproj: "native/iOS/JunoMobile/JunoMobile.xcodeproj/project.pbxproj",
  infoPlist: "native/iOS/JunoMobile/Resources/Info.plist",
  appTarget: "JunoMobile",
  widgetTarget: "JunoMobileWidgets",
  configs: ["Debug", "Stable", "Next"],
  platform: "iOS",
  deploymentSetting: "IPHONEOS_DEPLOYMENT_TARGET",
  sdk: "iphoneos",
  appSources: ["native/iOS/JunoMobile/App"],
  widgetSources: ["native/iOS/JunoMobile/Widgets", "native/iOS/JunoMobile/App/JunoMobileLiveActivities.swift"],
};

/** The Mac app, held to the deployment-target rule only. */
export const MAC_APP = {
  name: "JunoDesktop",
  dir: "native/macOS/JunoDesktop",
  spec: "native/macOS/JunoDesktop/project.yml",
  pbxproj: "native/macOS/JunoDesktop/JunoDesktop.xcodeproj/project.pbxproj",
  platform: "macOS",
  deploymentSetting: "MACOSX_DEPLOYMENT_TARGET",
  sdk: "macosx",
};

const VALID_APS = new Set(["development", "production"]);
const SELF = "check-native-app-config.mjs";

// ---------------------------------------------------------------------------
// YAML: the subset project.yml uses (block maps and sequences, quoted and plain
// scalars, flow sequences, folded and literal block scalars, comments).
// ---------------------------------------------------------------------------

function stripComment(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index).trimEnd();
    }
  }
  return text;
}

function unquote(text) {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0]) {
    return text.slice(1, -1);
  }
  return text;
}

function yamlScalar(text) {
  const value = text.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((item) => yamlScalar(item));
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  return unquote(value);
}

export function parseYaml(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cursor = 0;
  const indentOf = (line) => line.length - line.trimStart().length;
  const skippable = (line) => {
    const trimmed = line.trim();
    return trimmed === "" || trimmed.startsWith("#");
  };
  const isItem = (line) => {
    const trimmed = line.trimStart();
    return trimmed === "-" || trimmed.startsWith("- ");
  };
  const skip = () => {
    while (cursor < lines.length && skippable(lines[cursor])) cursor += 1;
  };

  function block(indent) {
    skip();
    if (cursor >= lines.length || indentOf(lines[cursor]) < indent) return null;
    const at = indentOf(lines[cursor]);
    return isItem(lines[cursor]) ? sequence(at) : mapping(at);
  }

  function blockScalar(header, parentIndent) {
    const collected = [];
    let blockIndent = null;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.trim() === "") {
        collected.push("");
        cursor += 1;
        continue;
      }
      const at = indentOf(line);
      if (at <= parentIndent) break;
      blockIndent ??= at;
      collected.push(line.slice(Math.min(blockIndent, at)));
      cursor += 1;
    }
    while (collected.length && collected.at(-1) === "") collected.pop();
    const joined = header.startsWith(">")
      ? collected.reduce((text, line) => (line === "" ? `${text}\n` : text === "" || text.endsWith("\n") ? text + line : `${text} ${line}`), "")
      : collected.join("\n");
    return header.endsWith("-") ? joined : `${joined}\n`;
  }

  function value(rest, parentIndent) {
    if (rest === "") {
      skip();
      if (cursor < lines.length) {
        const at = indentOf(lines[cursor]);
        if (at > parentIndent) return block(at);
        if (at === parentIndent && isItem(lines[cursor])) return sequence(at);
      }
      return null;
    }
    if (/^[>|][-+]?$/.test(rest)) return blockScalar(rest, parentIndent);
    return yamlScalar(rest);
  }

  function mapping(indent) {
    const object = {};
    for (;;) {
      skip();
      if (cursor >= lines.length) break;
      const line = lines[cursor];
      const at = indentOf(line);
      if (at < indent || (at === indent && isItem(line))) break;
      if (at > indent) throw new Error(`project.yml: unexpected indentation on line ${cursor + 1}`);
      const content = stripComment(line.trim());
      const match = /^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/.exec(content);
      if (!match) throw new Error(`project.yml: cannot read line ${cursor + 1}: ${content}`);
      cursor += 1;
      object[unquote(match[1].trim())] = value((match[2] ?? "").trim(), indent);
    }
    return object;
  }

  function sequence(indent) {
    const items = [];
    for (;;) {
      skip();
      if (cursor >= lines.length) break;
      const line = lines[cursor];
      if (indentOf(line) !== indent || !isItem(line)) break;
      const trimmed = line.trimStart();
      const afterDash = trimmed.slice(1);
      const content = stripComment(afterDash.trim());
      const itemIndent = indent + 1 + (afterDash.length - afterDash.trimStart().length);
      if (content === "") {
        cursor += 1;
        items.push(block(indent + 1));
      } else if (/^("[^"]*"|'[^']*'|[^\s"'[{][^:]*?):(\s|$)/.test(content)) {
        // `- key: value` opens a mapping whose first key sits after the dash.
        lines[cursor] = " ".repeat(itemIndent) + content;
        items.push(mapping(itemIndent));
      } else {
        cursor += 1;
        items.push(yamlScalar(content));
      }
    }
    return items;
  }

  return block(0) ?? {};
}

// ---------------------------------------------------------------------------
// XML property lists (entitlements, Info.plist).
// ---------------------------------------------------------------------------

function decodeXml(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parsePlist(xml) {
  const body = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?xml[^>]*\?>/, "").replace(/<!DOCTYPE[^>]*>/, "");
  const tokens = [...body.matchAll(/<(\/?)([A-Za-z]+)(?:\s+[^>]*?)?(\s*\/)?>|([^<]+)/g)];
  let index = 0;
  const next = () => tokens[index++];
  const skipText = () => {
    while (index < tokens.length && tokens[index][4] !== undefined && tokens[index][4].trim() === "") index += 1;
  };

  function readValue() {
    skipText();
    const token = next();
    if (!token || token[4] !== undefined) throw new Error("plist: expected an element");
    const [, closing, name, selfClosing] = token;
    if (closing) throw new Error(`plist: unexpected </${name}>`);
    if (selfClosing) {
      if (name === "true") return true;
      if (name === "false") return false;
      if (name === "dict") return {};
      if (name === "array") return [];
      if (name === "string") return "";
      throw new Error(`plist: unsupported <${name}/>`);
    }
    if (name === "plist") {
      const inner = readValue();
      skipText();
      next(); // </plist>
      return inner;
    }
    if (name === "dict") {
      const object = {};
      for (;;) {
        skipText();
        const peek = tokens[index];
        if (peek[1] === "/" && peek[2] === "dict") {
          index += 1;
          return object;
        }
        const keyOpen = next();
        if (keyOpen[2] !== "key") throw new Error("plist: expected <key>");
        const keyText = tokens[index][4] !== undefined ? decodeXml(next()[4]) : "";
        next(); // </key>
        object[keyText] = readValue();
      }
    }
    if (name === "array") {
      const items = [];
      for (;;) {
        skipText();
        const peek = tokens[index];
        if (peek[1] === "/" && peek[2] === "array") {
          index += 1;
          return items;
        }
        items.push(readValue());
      }
    }
    // string, integer, real, date, data: the text, then the closing tag.
    const text = tokens[index][4] !== undefined ? decodeXml(next()[4]) : "";
    next();
    if (name === "integer") return Number.parseInt(text, 10);
    if (name === "real") return Number.parseFloat(text);
    return text;
  }

  return readValue();
}

// ---------------------------------------------------------------------------
// xcconfig: assignments, `#include` (optional `#include?` is skipped: it is
// git-ignored personal or generated state, not the committed configuration),
// `[sdk=…]` conditions and the macro operators these files use.
// ---------------------------------------------------------------------------

export function loadXcconfig(file, read = (p) => readFileSync(p, "utf8"), seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  const assignments = [];
  for (const raw of read(file).split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line === "") continue;
    const include = /^#include(\?)?\s+"([^"]+)"/.exec(line);
    if (include) {
      if (include[1]) continue;
      assignments.push(...loadXcconfig(path.join(path.dirname(file), include[2]), read, seen));
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[[^\]]*\])*)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    const conditions = [...assignment[2].matchAll(/\[([^=\]]+)=([^\]]*)\]/g)].map((match) => ({
      key: match[1].trim(),
      pattern: match[2].trim(),
    }));
    assignments.push({ key: assignment[1], conditions, value: assignment[3].trim() });
  }
  return assignments;
}

function globMatches(pattern, value) {
  const expression = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return expression.test(value);
}

function applyOperator(value, operator) {
  if (operator.startsWith("default=")) return value === "" ? operator.slice("default=".length) : value;
  switch (operator) {
    case "c99extidentifier":
    case "identifier":
      return value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([0-9])/, "_$1");
    case "rfc1034identifier":
      return value.replace(/[^A-Za-z0-9.-]/g, "-");
    case "lower":
      return value.toLowerCase();
    case "upper":
      return value.toUpperCase();
    default:
      return value;
  }
}

/** Evaluates `name` the way Xcode would for one SDK, with `overrides` on top. */
export function resolveSetting(assignments, name, { sdk, overrides = {} } = {}, depth = 0) {
  if (depth > 32) throw new Error(`xcconfig: ${name} refers to itself`);
  if (Object.hasOwn(overrides, name)) return overrides[name];
  let chosen = null;
  for (const assignment of assignments) {
    if (assignment.key !== name) continue;
    const matches = assignment.conditions.every((condition) => condition.key === "sdk" && sdk && globMatches(condition.pattern, sdk));
    if (!matches) continue;
    // A matching conditional is more specific than the plain value.
    if (!chosen || assignment.conditions.length >= chosen.conditions.length) chosen = assignment;
  }
  if (!chosen) return "";
  return expandMacros(chosen.value, (inner) => resolveSetting(assignments, inner, { sdk, overrides }, depth + 1));
}

/** Expands `$(NAME)`, `${NAME}` and `$(NAME:op:op=…)`, nested ones first. */
export function expandMacros(text, lookup) {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const opener = text.slice(index, index + 2);
    if (opener !== "$(" && opener !== "${") {
      output += text[index];
      index += 1;
      continue;
    }
    const close = opener === "$(" ? ")" : "}";
    let depth = 1;
    let end = index + 2;
    while (end < text.length && depth > 0) {
      if (text.slice(end, end + 2) === "$(" || text.slice(end, end + 2) === "${") {
        depth += 1;
        end += 2;
        continue;
      }
      if (text[end] === close || text[end] === ")" || text[end] === "}") depth -= 1;
      end += 1;
    }
    const inner = expandMacros(text.slice(index + 2, end - 1), lookup);
    const [name, ...operators] = inner.split(":");
    let value = name === "inherited" ? "" : lookup(name);
    for (const operator of operators) value = applyOperator(value, operator);
    output += value;
    index = end;
  }
  return output;
}

// ---------------------------------------------------------------------------
// .pbxproj: objects by id, a target's build configurations.
// ---------------------------------------------------------------------------

export function pbxObjects(text) {
  const objects = new Map();
  const opener = /^\t\t([0-9A-F]{24})(?: \/\* (.*?) \*\/)? = \{/gm;
  for (const match of text.matchAll(opener)) {
    const start = match.index + match[0].length;
    const lineEnd = text.indexOf("\n", start);
    const firstLine = text.slice(start, lineEnd);
    const end = firstLine.trimEnd().endsWith("};") ? start + firstLine.lastIndexOf("};") : text.indexOf("\n\t\t};", start);
    objects.set(match[1], { comment: match[2] ?? "", body: text.slice(start, end) });
  }
  return objects;
}

function pbxField(body, field) {
  const match = new RegExp(`\\b${field} = ("(?:[^"\\\\]|\\\\.)*"|[^;]*);`).exec(body);
  return match ? unquote(match[1].trim()) : null;
}

/** `{ name, settings }` for each build configuration of the named target. */
export function pbxTargetConfigurations(text, targetName) {
  const objects = pbxObjects(text);
  for (const object of objects.values()) {
    if (pbxField(object.body, "isa") !== "PBXNativeTarget" || pbxField(object.body, "name") !== targetName) continue;
    const listID = /buildConfigurationList = ([0-9A-F]{24})/.exec(object.body)?.[1];
    const list = listID ? objects.get(listID) : null;
    if (!list) return [];
    const ids = [...(/buildConfigurations = \(([\s\S]*?)\);/.exec(list.body)?.[1] ?? "").matchAll(/([0-9A-F]{24})/g)].map((m) => m[1]);
    return ids.map((id) => {
      const configuration = objects.get(id);
      const settings = /buildSettings = \{([\s\S]*?)\n\t\t\t\};/.exec(configuration?.body ?? "")?.[1] ?? "";
      return {
        name: pbxField(configuration?.body ?? "", "name"),
        baseConfiguration: /baseConfigurationReference = [0-9A-F]{24} \/\* (.*?) \*\//.exec(configuration?.body ?? "")?.[1] ?? null,
        setting: (key) => pbxField(settings, key),
      };
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Swift packages and sources.
// ---------------------------------------------------------------------------

/** The `.iOS(…)` / `.macOS(…)` floor a Package.swift declares, as "26.0" or "17". */
export function packagePlatformFloor(manifest, platform) {
  const match = new RegExp(`\\.${platform}\\(\\s*(?:"([0-9.]+)"|\\.v([0-9_]+))\\s*\\)`).exec(manifest);
  if (!match) return null;
  return match[1] ?? match[2].replace(/_/g, ".");
}

export function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function swiftFiles(root, entries) {
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry);
    if (!existsSync(absolute)) continue;
    if (statSync(absolute).isFile()) {
      if (absolute.endsWith(".swift")) files.push(absolute);
      continue;
    }
    for (const name of readdirSync(absolute)) {
      const child = path.join(absolute, name);
      if (statSync(child).isDirectory()) files.push(...swiftFiles(root, [path.relative(root, child)]));
      else if (name.endsWith(".swift")) files.push(child);
    }
  }
  return files;
}

/** App Group identifiers a Swift source names as string literals. */
export function appGroupsNamed(source) {
  const groups = new Set();
  for (const match of source.matchAll(/"(group\.[A-Za-z0-9.\-]+)"/g)) groups.add(match[1]);
  return groups;
}

// ---------------------------------------------------------------------------
// The check.
// ---------------------------------------------------------------------------

function relativeConfigFile(specDir, file) {
  return path.normalize(path.join(specDir, file));
}

function deploymentFindings(root, app, report) {
  const specPath = path.join(root, app.spec);
  const pbxPath = path.join(root, app.pbxproj);
  if (!existsSync(specPath) || !existsSync(pbxPath)) {
    report.error("deployment-target", `${app.name}: missing ${!existsSync(specPath) ? app.spec : app.pbxproj}.`);
    return null;
  }
  const spec = parseYaml(readFileSync(specPath, "utf8"));
  const pbx = readFileSync(pbxPath, "utf8");
  const floors = new Map();
  const note = (where, value) => {
    if (value === null || value === undefined || value === "") return;
    floors.set(where, String(value));
  };
  note(`${app.spec} options.deploymentTarget.${app.platform}`, spec.options?.deploymentTarget?.[app.platform]);
  const configFiles = new Set();
  for (const [targetName, target] of Object.entries(spec.targets ?? {})) {
    const targetFloor = target?.deploymentTarget;
    note(`${app.spec} targets.${targetName}.deploymentTarget`, typeof targetFloor === "object" ? targetFloor?.[app.platform] : targetFloor);
    for (const file of Object.values(target?.configFiles ?? {})) configFiles.add(relativeConfigFile(path.dirname(app.spec), file));
  }
  for (const file of configFiles) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) {
      report.error("deployment-target", `${app.name}: ${file} is named by project.yml but does not exist.`);
      continue;
    }
    note(file, resolveSetting(loadXcconfig(absolute), app.deploymentSetting, { sdk: app.sdk }));
  }
  const pbxFloors = new Set([...pbx.matchAll(new RegExp(`${app.deploymentSetting} = ([0-9.]+);`, "g"))].map((m) => m[1]));
  for (const floor of pbxFloors) note(`${app.pbxproj} ${app.deploymentSetting} = ${floor}`, floor);

  const distinct = new Set(floors.values());
  if (distinct.size > 1) {
    const listing = [...floors].map(([where, value]) => `  ${value}  ${where}`).join("\n");
    report.error(
      "deployment-target",
      `${app.name}: the deployment target differs between files. Set one floor everywhere ` +
        `(project.yml, then regenerate; the xcconfigs):\n${listing}`
    );
  }
  const appFloor = floors.get([...configFiles][0]) ?? [...distinct][0];
  for (const [packageName, entry] of Object.entries(spec.packages ?? {})) {
    if (!entry?.path) continue;
    const manifestPath = path.join(root, path.dirname(app.spec), entry.path, "Package.swift");
    if (!existsSync(manifestPath)) {
      report.error("deployment-target", `${app.name}: package ${packageName} has no Package.swift at ${path.relative(root, manifestPath)}.`);
      continue;
    }
    const floor = packagePlatformFloor(readFileSync(manifestPath, "utf8"), app.platform);
    if (floor && appFloor && compareVersions(floor, appFloor) > 0) {
      report.error(
        "deployment-target",
        `${app.name}: package ${packageName} requires ${app.platform} ${floor}, newer than the app's ${appFloor}.`
      );
    }
  }
  return { spec, pbx, floor: appFloor, configFiles };
}

export function checkAppConfig({ root = DEFAULT_ROOT } = {}) {
  const errors = [];
  const warnings = [];
  const report = {
    error: (rule, message) => errors.push({ rule, message }),
    warn: (rule, message) => warnings.push({ rule, message }),
  };
  const facts = {};

  const ios = deploymentFindings(root, IOS_APP, report);
  const mac = deploymentFindings(root, MAC_APP, report);
  facts.iosDeploymentTarget = ios?.floor ?? null;
  facts.macDeploymentTarget = mac?.floor ?? null;
  if (!ios) return { errors, warnings, facts };

  const { spec, pbx } = ios;
  const specDir = path.dirname(IOS_APP.spec);
  const appTarget = spec.targets?.[IOS_APP.appTarget] ?? {};
  const widgetTarget = spec.targets?.[IOS_APP.widgetTarget] ?? {};

  // --- signing-variable / post-gen-guard (project.yml and .pbxproj) --------
  const specSigning = appTarget.settings?.base?.CODE_SIGN_ENTITLEMENTS;
  if (specSigning !== "$(JUNO_MOBILE_ENTITLEMENTS)") {
    report.error(
      "signing-variable",
      `${IOS_APP.spec}: targets.${IOS_APP.appTarget}.settings.base.CODE_SIGN_ENTITLEMENTS must be $(JUNO_MOBILE_ENTITLEMENTS) ` +
        `(found ${JSON.stringify(specSigning ?? null)}). A literal path outranks the xcconfigs and lets XcodeGen rewrite the file.`
    );
  }
  if (appTarget.entitlements) {
    const properties = appTarget.entitlements.properties ?? {};
    if (!Object.hasOwn(properties, "aps-environment")) {
      report.error(
        "signing-variable",
        `${IOS_APP.spec}: targets.${IOS_APP.appTarget} has an \`entitlements:\` block without aps-environment. XcodeGen ` +
          "writes that block's properties over JunoMobile.entitlements on every generate, which is how push was lost."
      );
    }
  }
  const postGen = String(spec.options?.postGenCommand ?? "");
  if (!postGen.includes(SELF)) {
    report.error("post-gen-guard", `${IOS_APP.spec}: options.postGenCommand must run scripts/${SELF}, so a generate that drops push fails.`);
  }
  const appConfigurations = pbxTargetConfigurations(pbx, IOS_APP.appTarget);
  if (!appConfigurations || appConfigurations.length === 0) {
    report.error("signing-variable", `${IOS_APP.pbxproj}: no build configurations for target ${IOS_APP.appTarget}.`);
  } else {
    for (const configuration of appConfigurations) {
      const value = configuration.setting("CODE_SIGN_ENTITLEMENTS");
      if (value !== "$(JUNO_MOBILE_ENTITLEMENTS)") {
        report.error(
          "signing-variable",
          `${IOS_APP.pbxproj}: ${IOS_APP.appTarget} (${configuration.name}) signs with ${JSON.stringify(value)}, not $(JUNO_MOBILE_ENTITLEMENTS). Regenerate with native/Scripts/generate-projects.sh.`
        );
      }
    }
  }
  if (/JunoMobile\.entitlements in Resources/.test(pbx)) {
    report.error("signing-variable", `${IOS_APP.pbxproj}: JunoMobile.entitlements is copied as a resource; exclude it in project.yml.`);
  }

  // --- entitlements-path / aps-environment ---------------------------------
  const configFiles = Object.fromEntries(
    IOS_APP.configs.map((name) => [name, appTarget.configFiles?.[name] ? relativeConfigFile(specDir, appTarget.configFiles[name]) : null])
  );
  const entitlementsByConfig = {};
  let entitlements = null;
  let entitlementsFile = null;
  for (const [configuration, file] of Object.entries(configFiles)) {
    if (!file || !existsSync(path.join(root, file))) {
      report.error("entitlements-path", `${IOS_APP.spec}: ${IOS_APP.appTarget} has no xcconfig for ${configuration}.`);
      continue;
    }
    const assignments = loadXcconfig(path.join(root, file));
    const relative = resolveSetting(assignments, "JUNO_MOBILE_ENTITLEMENTS", { sdk: IOS_APP.sdk });
    entitlementsByConfig[configuration] = { relative, assignments, file };
    if (!relative) {
      report.error(
        "entitlements-path",
        `${file}: JUNO_MOBILE_ENTITLEMENTS is empty, so ${configuration} builds sign without push. Only the git-ignored JunoMobile-Local.xcconfig may clear it.`
      );
    }
  }
  const paths = new Set(Object.values(entitlementsByConfig).map((entry) => entry.relative).filter(Boolean));
  if (paths.size > 1) {
    report.error("entitlements-path", `The JunoMobile xcconfigs sign with different entitlements files: ${[...paths].join(", ")}.`);
  }
  if (paths.size >= 1) {
    entitlementsFile = path.join(IOS_APP.dir, [...paths][0]);
    facts.entitlementsFile = entitlementsFile;
    const absolute = path.join(root, entitlementsFile);
    if (!existsSync(absolute)) {
      report.error("entitlements-path", `${entitlementsFile} does not exist.`);
    } else {
      try {
        entitlements = parsePlist(readFileSync(absolute, "utf8"));
      } catch (error) {
        report.error("entitlements-path", `${entitlementsFile} is not a readable property list: ${error.message}`);
      }
    }
  }

  if (entitlements) {
    const raw = entitlements["aps-environment"];
    if (typeof raw !== "string" || raw === "") {
      report.error(
        "aps-environment",
        `${entitlementsFile} has no aps-environment, so registerForRemoteNotifications fails and the iPhone gets no push. ` +
          "Restore <key>aps-environment</key><string>$(JUNO_APS_ENVIRONMENT)</string>."
      );
    } else {
      facts.apsEnvironment = {};
      for (const [configuration, entry] of Object.entries(entitlementsByConfig)) {
        const resolve = (overrides = {}) =>
          expandMacros(raw, (name) => resolveSetting(entry.assignments, name, { sdk: IOS_APP.sdk, overrides }));
        const resolved = resolve();
        facts.apsEnvironment[configuration] = resolved;
        if (!VALID_APS.has(resolved)) {
          report.error(
            "aps-environment",
            `${entitlementsFile}: aps-environment resolves to ${JSON.stringify(resolved)} for ${configuration} (${entry.file}); it must be development or production.`
          );
          continue;
        }
        if (raw.includes("$(")) {
          const development = resolve({ CODE_SIGN_IDENTITY: "Apple Development" });
          const distribution = resolve({ CODE_SIGN_IDENTITY: "Apple Distribution" });
          if (development !== "development" || distribution !== "production") {
            report.error(
              "aps-environment",
              `${entry.file}: aps-environment must follow the signing identity (Apple Development → development, ` +
                `Apple Distribution → production); it gives ${development} and ${distribution}. See JunoMobile-Push.xcconfig.`
            );
          }
        }
      }
    }
  }

  // --- app-group --------------------------------------------------------------
  const read = (file) => readFileSync(file, "utf8");
  const groupsIn = (entries) => {
    const groups = new Set();
    for (const file of swiftFiles(root, entries)) for (const group of appGroupsNamed(read(file))) groups.add(group);
    return groups;
  };
  const resolveGroups = (declared, entry) =>
    new Set(
      (Array.isArray(declared) ? declared : []).map((group) =>
        entry ? expandMacros(String(group), (name) => resolveSetting(entry.assignments, name, { sdk: IOS_APP.sdk })) : String(group)
      )
    );
  const anyEntry = Object.values(entitlementsByConfig)[0];
  const appGroups = resolveGroups(entitlements?.["com.apple.security.application-groups"], anyEntry);
  const widgetSigning = widgetTarget.settings?.base?.CODE_SIGN_ENTITLEMENTS ?? widgetTarget.entitlements?.path ?? null;
  let widgetEntitlements = null;
  if (widgetSigning) {
    const relative = anyEntry ? expandMacros(String(widgetSigning), (name) => resolveSetting(anyEntry.assignments, name, { sdk: IOS_APP.sdk })) : widgetSigning;
    const absolute = path.join(root, IOS_APP.dir, relative);
    if (relative && existsSync(absolute)) widgetEntitlements = parsePlist(read(absolute));
    else if (relative) report.error("app-group", `${IOS_APP.widgetTarget} signs with ${relative}, which does not exist.`);
  }
  const widgetGroups = resolveGroups(widgetEntitlements?.["com.apple.security.application-groups"], anyEntry);
  const appUses = groupsIn(IOS_APP.appSources);
  const widgetUses = groupsIn(IOS_APP.widgetSources);
  for (const group of appUses) {
    if (!appGroups.has(group)) {
      report.error("app-group", `The app's Swift names App Group ${group}, but ${entitlementsFile ?? "its entitlements"} does not declare it.`);
    }
  }
  for (const group of widgetUses) {
    if (!widgetGroups.has(group)) {
      report.error(
        "app-group",
        `The widget extension's Swift names App Group ${group}, but ${IOS_APP.widgetTarget} declares no entitlements with it ` +
          "(give the target an entitlements file in project.yml)."
      );
    }
  }
  if (appGroups.size && widgetGroups.size && [...appGroups].sort().join() !== [...widgetGroups].sort().join()) {
    report.error(
      "app-group",
      `The app (${[...appGroups].join(", ")}) and the widget extension (${[...widgetGroups].join(", ")}) declare different App Groups, so they cannot share a container.`
    );
  }
  facts.appGroups = [...appGroups];

  // --- associated-domains -----------------------------------------------------
  const domains = entitlements?.["com.apple.developer.associated-domains"];
  const declaredDomains = Array.isArray(domains) ? domains.map(String) : [];
  for (const domain of declaredDomains) {
    if (!/^(applinks|webcredentials|activitycontinuation|appclips):[A-Za-z0-9.*-]+(\?mode=(developer|managed|developer\+managed))?$/.test(domain)) {
      report.error("associated-domains", `${entitlementsFile}: ${JSON.stringify(domain)} is not a valid associated domain (service:host).`);
    }
  }
  const appSourceFiles = swiftFiles(root, IOS_APP.appSources);
  const handlesWebLinks = appSourceFiles.some((file) => /onContinueUserActivity\(\s*NSUserActivityTypeBrowsingWeb/.test(read(file)));
  if (handlesWebLinks && !declaredDomains.some((domain) => domain.startsWith("applinks:"))) {
    report.warn(
      "associated-domains",
      "JunoMobileHandoff.swift continues NSUserActivityTypeBrowsingWeb, but the app declares no applinks: domain, so web chat links " +
        "and Safari handoff never reach it. Needs the Associated Domains capability on the App IDs (Apple Developer account), " +
        "applinks:<site> in the entitlements and apple-app-site-association on the site."
    );
  }
  facts.associatedDomains = declaredDomains;

  // --- face-id-usage ----------------------------------------------------------
  const usesLocalAuthentication = appSourceFiles.some((file) => /\bLAContext\b/.test(read(file)));
  if (usesLocalAuthentication) {
    const infoPath = path.join(root, IOS_APP.infoPlist);
    const info = existsSync(infoPath) ? parsePlist(read(infoPath)) : {};
    if (typeof info.NSFaceIDUsageDescription !== "string" || info.NSFaceIDUsageDescription.trim() === "") {
      report.error(
        "face-id-usage",
        `${IOS_APP.infoPlist}: the app uses LocalAuthentication but has no NSFaceIDUsageDescription, so Face ID refuses the prompt.`
      );
    }
  }

  return { errors, warnings, facts };
}

function main() {
  const { errors, warnings, facts } = checkAppConfig();
  for (const warning of warnings) console.warn(`warning [${warning.rule}] ${warning.message}`);
  if (errors.length) {
    for (const error of errors) console.error(`error [${error.rule}] ${error.message}`);
    console.error(`\n${errors.length} native signing configuration problem(s).`);
    process.exit(1);
  }
  const aps = Object.entries(facts.apsEnvironment ?? {})
    .map(([configuration, value]) => `${configuration} ${value}`)
    .join(", ");
  console.log(
    `Native app config holds: aps-environment (${aps}), iOS ${facts.iosDeploymentTarget} and macOS ${facts.macDeploymentTarget} everywhere.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
