import type { LibrarySkill, LibrarySource, SkillLibrary, SkillSourceUpdateCheck } from "@/lib/skills/library-contract";
import type { ClientWorkSkill, ClientWorkSkillVersion } from "@/lib/work/skills";
import type { SkillRowData } from "@/components/skills/skill-library-model";
import type { SkillImportPreview } from "@/components/skills/skills-transport";

/*
 * Fixture data for /dev/skills. Shaped exactly like the wire types, so the
 * gallery renders the real components the way the API would feed them.
 */

const NOW = "2026-09-22T10:00:00.000Z";
const DAYS = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

function skill(
  id: string,
  name: string,
  description: string,
  extra: Partial<SkillRowData> = {}
): SkillRowData {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    id,
    projectId: null,
    slug,
    name,
    description,
    currentVersion: 1,
    enabled: true,
    trust: "untrusted",
    autoSelect: false,
    securityStatus: "clear",
    securityUpdatedAt: DAYS(3),
    createdAt: DAYS(3),
    updatedAt: DAYS(3),
    sourceId: null,
    sourcePath: null,
    requiresConsent: false,
    ...extra,
  };
}

const yours: LibrarySkill[] = [
  skill("sk_weekly", "Weekly investor update", "Drafts the Friday update from the metrics sheet and last week’s notes.", {
    trust: "user_authored",
    autoSelect: true,
    currentVersion: 4,
  }),
  skill("sk_invoices", "Invoice filing", "Files incoming invoices into Drive by vendor and month, then renames them.", {
    trust: "user_authored",
    enabled: false,
  }),
  skill("sk_release", "Release notes", "Turns merged pull requests into customer-facing release notes.", {
    trust: "user_authored",
    currentVersion: 2,
  }),
];

const anthropicSkills: [string, string][] = [
  ["Algorithmic art", "Creates algorithmic art with p5.js, using seeded randomness and interactive parameters."],
  ["Brand guidelines", "Applies Anthropic’s brand colours and typography to artifacts that need its look."],
  ["Canvas design", "Makes posters and static visual art as .png and .pdf files from a design philosophy."],
  ["Doc coauthoring", "Guides you through writing documentation, proposals and specs together, section by section."],
  ["Docx", "Creates, edits and analyses Word documents, with tracked changes, comments and formatting."],
  ["Frontend design", "Builds distinctive, production-grade frontend interfaces that avoid generic AI aesthetics."],
  ["Internal comms", "Writes internal communications in the formats your company already uses."],
  ["Mcp builder", "Guides the creation of high-quality MCP servers that let models use external services."],
  ["Pdf", "Extracts text and tables from PDFs, fills forms, and merges or splits documents."],
  ["Pptx", "Creates and edits presentations, with layouts, speaker notes and charts."],
  ["Skill creator", "Helps you write a new skill, or improve one you already have."],
  ["Slack gif creator", "Makes animated GIFs sized and optimised for Slack."],
  ["Template skill", "A minimal skill to copy when you start a new one."],
  ["Theme factory", "Styles slides, documents and pages with one of ten preset themes, or a new one."],
  ["Web artifacts builder", "Builds multi-component HTML artifacts with React, Tailwind and shadcn/ui."],
  ["Webapp testing", "Tests local web applications with Playwright and captures screenshots of what broke."],
  ["Xlsx", "Builds spreadsheets with formulas, formatting and charts, and analyses existing ones."],
];

const anthropics: LibrarySource = {
  id: "src_anthropics",
  kind: "github",
  owner: "anthropics",
  repo: "skills",
  key: "github:anthropics/skills",
  ref: "main",
  path: "",
  commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  latestCommit: "f9e8d7c6b5a4938271605f4e3d2c1b0a98765432",
  lastCheckedAt: DAYS(0),
  enabled: true,
  url: "https://github.com/anthropics/skills",
  createdAt: DAYS(12),
  updatedAt: DAYS(1),
  skills: anthropicSkills.map(([name, description], index) =>
    skill(`sk_a${index}`, name, description, {
      sourceId: "src_anthropics",
      sourcePath: `skills/${name.toLowerCase().replace(/ /g, "-")}/SKILL.md`,
      // A realistic spread: most on, a few off by choice, one blocked, one
      // waiting for consent after an update widened what it asks for.
      enabled: ![1, 12, 13].includes(index) && name !== "Slack gif creator",
      securityStatus: name === "Slack gif creator" ? "blocked" : "clear",
      requiresConsent: name === "Mcp builder",
    })
  ),
};

const vercel: LibrarySource = {
  id: "src_vercel",
  kind: "github",
  owner: "vercel-labs",
  repo: "agent-skills",
  key: "github:vercel-labs/agent-skills",
  ref: "main",
  path: "",
  commit: "0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
  latestCommit: null,
  lastCheckedAt: DAYS(4),
  enabled: false,
  url: "https://github.com/vercel-labs/agent-skills",
  createdAt: DAYS(30),
  updatedAt: DAYS(4),
  skills: [
    ["React best practices", "Performance rules for React and Next.js, ordered by impact."],
    ["Web design guidelines", "Reviews interfaces against accessibility, performance and UX guidelines."],
    ["Vercel deploy", "Deploys the current project to Vercel and returns the preview link."],
    ["Composition patterns", "Refactors components toward composition over boolean props."],
  ].map(([name, description], index) =>
    skill(`sk_v${index}`, name, description, {
      sourceId: "src_vercel",
      sourcePath: `skills/${name.toLowerCase().replace(/ /g, "-")}/SKILL.md`,
      enabled: index !== 2,
    })
  ),
};

export const FIXTURE_LIBRARY: SkillLibrary = {
  yours,
  sources: [anthropics, vercel],
  total: 24,
  truncated: false,
};

export const FIXTURE_EMPTY_LIBRARY: SkillLibrary = { yours: [], sources: [], total: 0, truncated: false };

export const FIXTURE_PREVIEW: SkillImportPreview = {
  repository: {
    owner: "anthropics",
    repo: "skills",
    ref: "main",
    commit: "f9e8d7c6b5a4938271605f4e3d2c1b0a98765432",
    url: "https://github.com/anthropics/skills/tree/f9e8d7c",
  },
  skills: anthropicSkills.slice(0, 12).map(([name, description], index) => {
    const slug = name.toLowerCase().replace(/ /g, "-");
    return {
      path: `skills/${slug}/SKILL.md`,
      directory: `skills/${slug}`,
      slug,
      name,
      description,
      license: index % 3 === 0 ? "Apache-2.0" : "Proprietary",
      compatibility: null,
      instructionChars: 3200 + index * 410,
      requestedTools: index === 7 ? ["web_fetch", "code_execution"] : [],
      droppedTools: index === 5 ? ["Bash(npm run *)", "Bash(git add *)", "Edit(src/**)"] : [],
      hostKeys: [],
      ignoredKeys: [],
      companionFiles: index === 4 ? ["scripts/ooxml.py", "reference.md", "templates/base.docx"] : [],
      url: `https://github.com/anthropics/skills/blob/f9e8d7c/skills/${slug}/SKILL.md`,
      installed: index === 2 || index === 9,
      slugTaken: slug === "pdf",
      suggestedSlug: slug === "pdf" ? "anthropics-pdf" : null,
      securityStatus: slug === "slack-gif-creator" ? "blocked" : "clear",
    };
  }),
  problems: [{ path: "skills/broken/SKILL.md", reason: "missing_frontmatter", message: "It has no frontmatter." }],
  more: false,
  total: 13,
  connected: true,
};

export const FIXTURE_UPDATE_CHECK: SkillSourceUpdateCheck = {
  source: anthropics,
  latestCommit: anthropics.latestCommit ?? "",
  upToDate: false,
  changed: [
    { path: "skills/pdf/SKILL.md", name: "Pdf", description: "", skillId: "sk_a8", slug: "pdf" },
    {
      path: "skills/mcp-builder/SKILL.md",
      name: "Mcp builder",
      description: "",
      skillId: "sk_a7",
      slug: "mcp-builder",
      widensPermissions: true,
    },
  ],
  added: [{ path: "skills/claude-api/SKILL.md", name: "Claude api", description: "" }],
  removed: [{ path: "skills/old-template/SKILL.md", name: "Old template", description: "", skillId: "sk_old" }],
  more: false,
};

export const FIXTURE_DETAIL_SKILL: ClientWorkSkill = {
  ...anthropics.skills[8],
  currentVersion: 2,
  trust: "untrusted",
  autoSelect: false,
};

export const FIXTURE_DETAIL_VERSION: ClientWorkSkillVersion = {
  id: "ver_pdf_2",
  skillId: FIXTURE_DETAIL_SKILL.id,
  version: 2,
  instructions: `# PDF processing

Use this skill whenever the task involves reading, filling or reshaping a PDF.

## Quick start

1. Read the file with \`pypdf\` and check whether it has a text layer.
2. If it does not, run OCR before anything else.
3. Keep the original untouched; write every change to a new file.

## Filling forms

- List the form's fields first, then match them to the data you were given.
- Never guess a value. Leave a field empty and say so.

## Merging and splitting

\`\`\`python
from pypdf import PdfWriter

writer = PdfWriter()
for path in paths:
    writer.append(path)
writer.write("merged.pdf")
\`\`\`

When a page range is asked for, confirm it back before writing.`,
  contract: {
    inputs: [],
    outputs: [],
    requestedConnectors: [],
    requestedApps: [],
    requestedDomains: [],
    resourceAttachmentIds: [],
    provenance: {
      "source.kind": "github",
      "source.owner": "anthropics",
      "source.repo": "skills",
      "source.ref": "main",
      "source.commit": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      "source.path": "skills/pdf/SKILL.md",
      "source.url": "https://github.com/anthropics/skills/blob/a1b2c3d/skills/pdf/SKILL.md",
      "skill.license": "Proprietary",
    },
    preferredTarget: null,
    preferredModel: null,
    requestedPolicy: null,
    requestedBudget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 },
    examples: [],
  },
  contractVersion: 3,
  requestedTools: ["code_execution"],
  securityStatus: "clear",
  securityScan: { findings: [] },
  permissionDigest: null,
  requiresConsent: false,
  bundle: {
    digest: "9f2c4e1a7b3d5f6081a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708",
    totalBytes: 18_432,
    files: [
      { path: "SKILL.md", size: 1_204, kind: "instructions", mime: "text/markdown" },
      { path: "reference/forms.md", size: 6_310, kind: "reference", mime: "text/markdown" },
      { path: "scripts/fill_form.py", size: 4_118, kind: "script", mime: "text/x-python" },
      { path: "scripts/merge.py", size: 1_980, kind: "script", mime: "text/x-python" },
      { path: "assets/blank-form.pdf", size: 4_820, kind: "asset", mime: "application/pdf" },
    ],
    skipped: [{ path: "bin/qpdf", reason: "type_not_kept" }],
    scripts: 2,
  },
  createdAt: DAYS(1),
};

export const FIXTURE_DETAIL_VERSIONS: ClientWorkSkillVersion[] = [
  FIXTURE_DETAIL_VERSION,
  { ...FIXTURE_DETAIL_VERSION, id: "ver_pdf_1", version: 1, createdAt: DAYS(12), instructions: "# PDF processing\n\nThe first version." },
];

export const FIXTURE_OWN_SKILL: ClientWorkSkill = { ...yours[0] };

export const FIXTURE_OWN_VERSION: ClientWorkSkillVersion = {
  ...FIXTURE_DETAIL_VERSION,
  id: "ver_weekly_4",
  skillId: FIXTURE_OWN_SKILL.id,
  version: 4,
  requestedTools: [],
  contract: { ...FIXTURE_DETAIL_VERSION.contract, provenance: {}, resourceAttachmentIds: ["att_1", "att_2"] },
  instructions: `Write the weekly investor update every Friday.

## Steps

1. Open the **Metrics** sheet and read this week’s row.
2. Compare revenue, burn and runway with last week.
3. Pull three highlights and one lowlight from the team notes.
4. Draft the email in the template. Keep it under 250 words.

## Tone

Plain and specific. Numbers first, adjectives last.`,
};
