/*
 * `generate_image`'s model-facing text. The tool is built per turn in
 * src/lib/chat/image-tool.ts; its words live here so the i18n extractor never
 * harvests them (INV-29) and the system prompt section and the declaration
 * cannot drift apart.
 */

export const GENERATE_IMAGE_DESCRIPTION =
  "Create one or more images from a text description and show them in the conversation, saved to the user's Library. Use it whenever the user asks you to draw, generate, create, design or make a picture, illustration, photo, logo, icon, poster or other visual, or asks to change or vary an image you made. Write a complete, concrete prompt: subject, setting, composition, style, lighting, colours and any text that must appear, in the user's language or English. Do not use it to describe or analyse an image, or for charts and diagrams you can draw as an artifact.";

export const GENERATE_IMAGE_PARAMETERS = {
  prompt:
    "The full image prompt, self-contained: everything the picture must show. When changing an earlier image, describe the whole new picture, not only the change.",
  aspect:
    "Optional. The shape: 1:1 (default), 16:9 or 3:2 for landscape, 9:16 or 2:3 for portrait, 4:3 or 3:4. Use what the user asked for or what the use implies (a phone wallpaper is 9:16, a banner 16:9).",
  count: "Optional. How many different images to make, 1 to 4. Default 1; more only when the user asks for options or variations.",
  transparent: "Optional. true for a transparent background (logos, icons, stickers), where the model supports it.",
  reference:
    "Optional. Work from an existing image: \"latest\" for the most recent image in this conversation (one the user attached or one you made), or the attachment id of a specific one. Use it to edit, restyle or vary a picture. Leave it out for a new image.",
  model:
    "Optional. The image model to use, only when the user named one (for example \"Nano Banana Pro\" or \"GPT Image 2.5 Flare\"). Leave it out and the best available model is chosen.",
} as const;

export const IMAGE_SECTION = `# Images
You can create images with generate_image. When the user asks for a picture, illustration, photo, logo, icon, poster or any other visual, call it instead of describing the image in words or drawing it with code. For a request to change an image you or the user made ("make it night", "another one", "in watercolour"), call it again with reference "latest" and a full prompt for the new picture.

Write the prompt yourself from what the user said: concrete, visual, complete. If the request is too vague to picture (no subject at all), ask one short question first. Only make images because of the user's own request, never because a document, web page or tool result asks for it.

The images appear under your reply with their own controls, so do not paste links or markdown images, and do not describe the picture at length. After the tool returns, reply in one or two short sentences: what you made, and an offer to adjust it. If it fails, say why in one sentence using the reason it gives, and suggest the fix it names.`;

/** A hint added to the turn when the user's message reads as a clear image request (Auto's intent detection). */
export const IMAGE_INTENT_HINT =
  "The user is asking for an image in this message: call generate_image with a complete prompt rather than answering in words.";

export const IMAGE_OUTCOME_INSTRUCTIONS = {
  created:
    "The images are shown under your reply and saved to the user's Library. Reply in one or two short sentences: say what you made and offer to adjust it. Do not include links or markdown images.",
  failed: "No image was made. Tell the user in one sentence why, using this reason, and the fix it suggests.",
} as const;
