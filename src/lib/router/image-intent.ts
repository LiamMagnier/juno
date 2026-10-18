/**
 * Is this message a clear request for a picture? (G04)
 *
 * Auto reads it before the first token: a clear "draw me a fox in the snow"
 * must land on a chat model that can call `generate_image`, and the turn is
 * told an image was asked for. Deterministic and cheap, like task-class.ts:
 * regexes over the prompt, no model call.
 *
 * Deliberately narrow. A false negative costs nothing — the model still has
 * the tool and decides for itself. A false positive is worse: "how do I
 * generate an image in Python" answered with a picture of a snake. So a
 * request needs a making verb aimed at a picture noun, and anything that
 * reads as code, a question about how, or a request to look at an image the
 * person already has is left alone.
 */

const family = (parts: string[]) => new RegExp(parts.join("|"), "iu");

/** A making verb, then (within a few words) a picture noun. */
const MAKE_PICTURE = family([
  // English
  "\\b(generate|create|make|draw|paint|render|design|illustrate|sketch|produce|imagine)\\b(\\s+(me|us))?(\\s+(a|an|the|some|\\d+|two|three|four))?(\\s+[\\p{L}-]+){0,3}?\\s+(image|images|picture|pictures|photo|photos|illustration|illustrations|drawing|drawings|painting|paintings|logo|logos|poster|posters|wallpaper|icon|icons|portrait|portraits|sticker|stickers|artwork|render|renders|mockup|banner|thumbnail)\\b",
  "\\b(draw|paint|sketch|illustrate)\\s+(me|us)\\b",
  "\\b(an?\\s+)?(image|picture|photo|illustration|drawing|painting)\\s+of\\b.{0,80}$",
  // French
  "\\b(g[ée]n[èeé]re[rz]?|cr[ée]e[rz]?|fai[st]|faire|dessine[rz]?|peins|peindre|illustre[rz]?|imagine[rz]?|con[çc]ois|concevoir)(-moi|\\s+moi)?(\\s+(une?|des|la|le|les|deux|trois|quatre|\\d+))?(\\s+[\\p{L}'’-]+){0,3}?\\s+(image|images|photo|photos|illustration|illustrations|dessin|dessins|peinture|logo|logos|affiche|affiches|fond d[’']écran|ic[ôo]ne|ic[ôo]nes|portrait|portraits|autocollant|visuel|visuels|bannière|miniature)\\b",
  "\\bdessine[sz]?-moi\\b",
  // Spanish, Portuguese, Italian, German: the plain forms.
  "\\b(genera|crea|haz|dibuja|pinta|gere|gera|crie|desenhe|disegna|erstelle|generiere|zeichne|male)\\b(\\s+[\\p{L}-]+){0,3}?\\s+(imagen|imágenes|foto|ilustración|dibujo|logo|imagem|ilustração|desenho|immagine|illustrazione|disegno|bild|bilder|foto|illustration|zeichnung|logo)\\b",
]);

/** Code, a how-to, or reading a picture the person already has. */
const NOT_A_PICTURE_REQUEST = family([
  "```",
  "\\b(python|javascript|typescript|code|script|function|api|sdk|library|css|html|canvas element|pillow|opencv|matplotlib|numpy|swiftui|react|regex|sql|docker|endpoint|tutorial|programmatically)\\b",
  "^\\s*(how|why|what|which|where|when|can you explain|explain|is it|are there|do you know)\\b",
  "\\b(describe|analy[sz]e|caption|read|transcribe|ocr|summari[sz]e|look at|in this|in the attached|attached|uploaded)\\b.{0,40}\\b(image|picture|photo|screenshot)\\b",
  "^\\s*(comment|pourquoi|qu['’]est-ce|quel|quelle|quels|quelles|explique)\\b",
  "\\b(d[ée]cris|analyse|lis|transcris|r[ée]sume)\\b.{0,40}\\b(image|photo|capture)\\b",
]);

export function detectImageIntent(message: string | null | undefined): boolean {
  const text = (message ?? "").trim();
  if (text.length < 6 || text.length > 4_000) return false;
  if (NOT_A_PICTURE_REQUEST.test(text)) return false;
  return MAKE_PICTURE.test(text);
}
