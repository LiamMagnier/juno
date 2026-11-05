import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UiLocaleOverride } from "@/lib/i18n-format";
import {
  ImageGenerationCard,
  attachmentsForGeneration,
  imageFailureSentence,
  imageGenerationsOf,
  varyModelFor,
} from "@/components/chat/image-generation-card";
import { IMAGE_FAILURE_CODES, type ClientImageGeneration } from "@/lib/media/image-generation";
import { SHELL_STRINGS } from "@/lib/strings";
import type { ClientAttachment } from "@/types/chat";

/*
 * G04 — the card a picture made in chat sits in, rendered to markup: the
 * placeholder while it is made, the pictures with their actions and the
 * honest caption when done, and a failure that names its real cause, in
 * English and French.
 */

// The icon set's JSX compiles to the classic runtime under tsx.
(globalThis as { React?: typeof React }).React = React;

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const BASE: ClientImageGeneration = {
  v: 1,
  callId: "image-abc",
  status: "generating",
  prompt: "A fox in the snow, watercolour",
  modelId: "google:gemini-nano-banana-2.1",
  modelName: "Nano Banana 2.1",
  auto: true,
  aspect: "16:9",
  count: 1,
  referenceAttachmentId: null,
  attachmentIds: [],
  failure: null,
};

const FILE: ClientAttachment = {
  id: "att_1",
  kind: "IMAGE",
  fileName: "Nano Banana 2.1 — A fox in the snow.png",
  mimeType: "image/png",
  size: 1234,
  url: "/api/files/uploads/u/fox.png",
  width: 1344,
  height: 768,
};

function render(generation: ClientImageGeneration, attachments: ClientAttachment[] = [], locale = "en") {
  return renderToStaticMarkup(
    React.createElement(
      UiLocaleOverride.Provider,
      { value: locale },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ImageGenerationCard, {
          generation,
          attachments,
          live: true,
          onEdit: () => undefined,
          onVary: () => undefined,
        }),
      ),
    ),
  );
}

test("while generating: the placeholder at the asked shape, naming the model", () => {
  const html = render(BASE);
  assert.match(html, /data-image-generation="generating"/);
  assert.match(html, /data-modality="image"/);
  assert.match(html, /role="status"/, "the stage is announced politely");
  assert.match(html, /Nano Banana 2\.1/);
});

test("done: the picture, its actions, and the caption saying who made it and where it went", () => {
  const html = render({ ...BASE, status: "done", attachmentIds: ["att_1"] }, [FILE]);
  assert.match(html, /data-image-generation="done"/);
  assert.match(html, /aria-label="Download"/);
  assert.match(html, /aria-label="Copy"/);
  assert.match(html, /aria-label="Vary"/, "Nano Banana edits, so a variation is offered");
  assert.match(html, /aria-label="Open in Library"/);
  assert.match(html, /href="\/library\?view=files"/);
  assert.match(html, /Auto picked Nano Banana 2\.1/);
  assert.match(html, /Saved to your Library/);
  assert.match(html, /AI-generated/);
  const named = render({ ...BASE, status: "done", auto: false, attachmentIds: ["att_1"] }, [FILE]);
  assert.match(named, /Made with Nano Banana 2\.1/);
});

test("done, in French: the shared table's words", () => {
  const html = render({ ...BASE, status: "done", attachmentIds: ["att_1"] }, [FILE], "fr-FR");
  assert.match(html, /Auto a choisi Nano Banana 2\.1/);
  assert.match(html, /Enregistrée dans votre bibliothèque/);
  assert.match(html, /aria-label="Télécharger"/);
});

test("a picture with no image model that can work from it offers no Vary", () => {
  const html = render({ ...BASE, status: "done", modelId: null, modelName: null, attachmentIds: ["att_1"] }, [FILE]);
  assert.doesNotMatch(html, /aria-label="Vary"/);
  assert.match(html, /Saved to your Library/, "the caption still says where it went");
  assert.equal(varyModelFor({ modelId: "anthropic:claude-sonnet-4-6" }), null, "a chat model never runs a variation");
  assert.equal(varyModelFor({ modelId: "google:gemini-nano-banana-2.1" }), "google:gemini-nano-banana-2.1");
  assert.equal(varyModelFor({ modelId: null }), null);
});

test("failed: the real cause, in the reader's language, never a generic error", () => {
  const html = render({
    ...BASE,
    status: "failed",
    failure: { code: "plan_required", message: "Nano Banana Pro requires the MAX plan.", model: "Nano Banana Pro", plan: "MAX" },
  });
  assert.match(html, /data-failure="plan_required"/);
  assert.match(html, /Couldn’t create the image/);
  assert.match(html, /Nano Banana Pro needs the Max plan\./);
  const fr = render(
    { ...BASE, status: "failed", failure: { code: "provider_unavailable", message: "x", model: "Nano Banana 2.1" } },
    [],
    "fr",
  );
  assert.match(fr, /Impossible de créer l’image/);
  assert.match(fr, /Nano Banana 2\.1 est injoignable/);
});

test("every failure code has its sentence in both languages", () => {
  for (const code of IMAGE_FAILURE_CODES) {
    const en = imageFailureSentence({ code, message: "server words", model: "Model X", plan: "PRO" }, "Model X", "en");
    const fr = imageFailureSentence({ code, message: "server words", model: "Model X", plan: "PRO" }, "Model X", "fr");
    assert.notEqual(en, "server words", `${code} has an English sentence`);
    assert.notEqual(fr, en, `${code} has a French sentence`);
    assert.doesNotMatch(en + fr, /\{model\}|\{plan\}/, `${code} fills its placeholders`);
  }
  // A sentence that needs a model the row lacks falls back to the server's words.
  assert.equal(imageFailureSentence({ code: "not_configured", message: "server words" }, null, "en"), "server words");
  for (const key of Object.keys(SHELL_STRINGS).filter((k) => k.startsWith("image."))) {
    const entry = SHELL_STRINGS[key as keyof typeof SHELL_STRINGS] as { en: string; fr: string };
    assert.ok(entry.en && entry.fr, `${key} is in English and French`);
  }
});

test("one card per call, the last state of a re-sent row winning", () => {
  const generating = { id: "activity-1", imageGeneration: BASE };
  const done = { id: "activity-1", imageGeneration: { ...BASE, status: "done" as const, attachmentIds: ["att_1"] } };
  const other = { id: "activity-2", imageGeneration: { ...BASE, callId: "image-def" } };
  const cards = imageGenerationsOf([generating, { id: "activity-x" }, done, other]);
  assert.deepEqual(cards.map((c) => [c.generation.callId, c.generation.status]), [
    ["image-abc", "done"],
    ["image-def", "generating"],
  ]);
  assert.deepEqual(imageGenerationsOf(undefined), []);
});

test("the files come from the saved answer, else from the live row", () => {
  const live = { ...BASE, status: "done" as const, attachmentIds: ["att_1"], images: [{ ...FILE, url: "/live" }] };
  assert.equal(attachmentsForGeneration(live, [])[0]?.url, "/live");
  assert.equal(attachmentsForGeneration(live, [FILE])[0]?.url, FILE.url);
  assert.deepEqual(attachmentsForGeneration({ ...BASE, attachmentIds: ["gone"] }, []), []);
});

test("the transcript draws tool-made pictures in their card, once, and keeps Regenerate", () => {
  const item = read("../src/components/chat/message-item.tsx");
  assert.match(item, /imageGenerationsOf\(view\.activity\)/);
  assert.match(item, /!imageCardIds\.has\(a\.id\)/, "a card's files are not drawn again as plain media");
  assert.match(item, /sourceModelId=\{editSourceModel \?\? message\.model\}/, "Edit runs on the model that made the picture");
});

test("the composer's + menu has Create image, wired to image mode with a removable mark", () => {
  const composer = read("../src/components/chat/composer.tsx");
  assert.match(composer, /id: "image",\s*label: "Create image",\s*icon: ComposerIcons\.image,\s*checked: modality === "image"/);
  assert.match(composer, /\.\.\.\(imageRow \? \[imageRow\] : \[\]\),\s*\.\.\.\(researchRow/);
  assert.match(composer, /removeLabel: "Stop creating images",\s*remove: exitImageMode/);
  assert.match(composer, /defaultImageModel\(models, quota\.plan, lastUsed, isModelLocked\)/);
});
