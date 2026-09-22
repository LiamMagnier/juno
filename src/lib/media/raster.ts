/**
 * Pixels: rasterising a PDF page, and cropping / zooming an image.
 *
 * WHY THIS EXISTS AT ALL. Two things in the product needed the same missing
 * capability and neither could be faked without it:
 *
 *  - The Library and the composer drew a PDF as the word "PDF" on a grey
 *    square. Eight PDFs were eight identical squares. `FilePreview` already
 *    solved that for text files by showing their first lines; a PDF has no
 *    first lines to show, because its text is not bytes you can slice. The
 *    only honest preview of a page is the page.
 *  - `inspect_image` (src/lib/agent/image.ts) lets a model look *closer* at a
 *    picture it has already been shown — the licence plate, the axis label,
 *    the bottom-right corner of a screenshot. Every model in the catalogue
 *    downsamples a large image before it ever reaches the transformer, so
 *    "zoom in on the third row" is not something a model can do by trying
 *    harder. It needs a crop, and a crop is a raster operation.
 *
 * NOT `server-only`, deliberately, and for the reason `lib/search/pdf-text.ts`
 * already documents one directory over: the claim worth testing here is
 * "a real PDF turns into real pixels", and that is only testable if the test
 * runner can import this. It reaches nothing but `unpdf` and the canvas
 * binding, so there is no server secret or database handle for the marker to
 * be protecting. Every CALLER is server-only.
 *
 * WHY @napi-rs/canvas, AND WHAT HAPPENS WITHOUT IT. It is the canvas
 * implementation `unpdf` already names as its optional peer for exactly this
 * (`renderPageAsImage`), so the PDF engine is the one this repo already ships
 * rather than a second copy of pdf.js — the objection `extract/pdf-engine.ts`
 * raises against adding `pdfjs-dist`. It is a native module, though, which
 * means it can be absent: a platform with no prebuilt binary, a bundler that
 * did not trace it. Every entry point here therefore returns `null` rather
 * than throwing, and every caller has a real fallback — the tile falls back to
 * its extension badge, the tool tells the model it cannot crop. A missing
 * optional module must degrade the feature, never the request.
 */

/** A decoded, re-encoded image and the dimensions it actually came out at. */
export interface RasterImage {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

type CanvasModule = typeof import("@napi-rs/canvas");

/**
 * Resolved once per process, including the failure.
 *
 * `import()` of a missing module rejects every time and is not cheap about it;
 * a Library scrolling 300 tiles past a server with no canvas binary would pay
 * that 300 times to learn the same thing. The promise is cached, not the
 * value, so concurrent callers share one attempt.
 */
let canvasModule: Promise<CanvasModule | null> | null = null;

export function loadCanvas(): Promise<CanvasModule | null> {
  canvasModule ??= import("@napi-rs/canvas")
    .then((mod) => mod)
    .catch((error) => {
      console.warn("[raster] canvas is unavailable; page and crop rendering are off", {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  return canvasModule;
}

/** Whether this process can rasterise at all. Cheap after the first call. */
export async function canRaster(): Promise<boolean> {
  return (await loadCanvas()) !== null;
}

/**
 * Upper bound on the bytes of a document handed to the page renderer.
 *
 * The same 32 MB ceiling `extract/pdf-engine.ts` applies, and for the same
 * reason it states: a PDF is attacker-controlled input, and pdf.js will
 * happily try to open whatever it is given.
 */
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/** Formats whose first page can be drawn. PDF is the only one pdf.js reads. */
export function canRenderDocumentPage(mimeType: string): boolean {
  return mimeType.toLowerCase() === "application/pdf";
}

/**
 * Draw one page of a PDF, scaled so its long edge is about `targetWidth`.
 *
 * `scale` rather than `width` is passed to unpdf because unpdf's `width`
 * option sets the *canvas* width and lets the page overflow it; deriving the
 * scale from the page's own viewport keeps the whole page inside the frame,
 * which is the entire point of a thumbnail.
 */
export async function renderDocumentPage(input: {
  bytes: Uint8Array;
  /** 1-based, as PDF pages are numbered everywhere else in this codebase. */
  page?: number;
  /** Target width in device pixels. The height follows the page's aspect. */
  targetWidth?: number;
  quality?: number;
}): Promise<RasterImage | null> {
  if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) return null;
  const canvas = await loadCanvas();
  if (!canvas) return null;

  const page = Math.max(1, Math.floor(input.page ?? 1));
  const targetWidth = clampEdge(input.targetWidth ?? 640);

  try {
    // Imported here, not at module scope, for the reason `pdf-engine.ts`
    // gives: unpdf bundles the whole of pdf.js, and a static import puts
    // ~1.6 MB into the server graph of every route that transitively touches
    // this file — including the ones that never render a page.
    const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
    /*
     * `.slice()`: pdf.js TRANSFERS the buffer it is handed, so passing the
     * caller's array leaves them holding a detached, zero-length view. The
     * same defect cost OCR its bytes for the whole of this function's life
     * one directory over (see `extract/index.ts`); rendering a page must not
     * be a way of destroying the document you rendered it from.
     */
    const pdf = await getDocumentProxy(input.bytes.slice(), { verbosity: 0 });
    if (page > pdf.numPages) return null;

    const viewport = (await pdf.getPage(page)).getViewport({ scale: 1 });
    const scale = viewport.width > 0 ? targetWidth / viewport.width : 1;
    const raw = await renderPageAsImage(pdf, page, {
      scale: Math.min(Math.max(scale, 0.1), 4),
      canvasImport: () => loadCanvas() as Promise<CanvasModule>,
    });

    // unpdf hands back a PNG of the rendered page. A page is mostly white with
    // thin dark text, which PNG stores well and JPEG does not — but a tile is
    // 64 to 320 px wide and re-encoding at that size is where the saving is,
    // so the re-encode below is a resize first and a format change second.
    return await encodeFrom(canvas, new Uint8Array(raw), {
      // `maxWidth`, not `maxEdge`: a portrait page's longest edge is its
      // height, so bounding the long edge at 320 produced a 247-wide tile.
      maxWidth: targetWidth,
      // The long edge still gets a ceiling, for the landscape and poster-sized
      // pages where width alone would let the height run away.
      maxEdge: Math.round(targetWidth * 2),
      quality: input.quality ?? 82,
      background: "#ffffff",
    });
  } catch (error) {
    console.warn("[raster] could not render document page", {
      page,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** A rectangle in PERCENT of the source image, x/y from the top-left corner. */
export interface RasterRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TransformOptions {
  /** The part of the image to keep. Omitted means all of it. */
  region?: RasterRegion;
  /** Longest output edge. The aspect ratio of the region is preserved. */
  maxEdge?: number;
  /**
   * Upper bound on the output WIDTH specifically.
   *
   * Not the same knob as `maxEdge`, and the difference is the whole reason it
   * exists: a page is portrait, so its longest edge is its height, and a
   * thumbnail asked for "320 wide" through `maxEdge` came back 247 wide —
   * the height had been pinned to 320 and the width had followed it down.
   * A tile is laid out in a column of a known width, so width is the bound
   * that matters for a page.
   */
  maxWidth?: number;
  /**
   * Shortest output edge, which is what makes a crop *useful*.
   *
   * A 4% crop of a screenshot is maybe 60 px across; handed to a model at that
   * size it is no more legible than the full image was, and the round trip
   * bought nothing. Small crops are scaled up to this.
   */
  minEdge?: number;
  grayscale?: boolean;
  /** 1 leaves the image alone; 1.4 is a firm push; the range is clamped. */
  contrast?: number;
  rotate?: 0 | 90 | 180 | 270;
  format?: "jpeg" | "png";
  quality?: number;
}

/**
 * Crop / scale / clean up an image, or `null` if it cannot be decoded.
 *
 * Deliberately total: a truncated upload, an unsupported codec, a region that
 * reduces to zero pixels all come back as `null` for the caller to explain.
 */
export async function transformImage(
  bytes: Uint8Array,
  options: TransformOptions = {},
): Promise<RasterImage | null> {
  const canvas = await loadCanvas();
  if (!canvas) return null;
  try {
    return await encodeFrom(canvas, bytes, options);
  } catch (error) {
    console.warn("[raster] could not transform image", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Dimensions only, without paying to re-encode. `null` when undecodable. */
export async function imageDimensions(
  bytes: Uint8Array,
): Promise<{ width: number; height: number } | null> {
  const canvas = await loadCanvas();
  if (!canvas) return null;
  try {
    const image = await canvas.loadImage(Buffer.from(bytes));
    return { width: image.width, height: image.height };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/** 16 px to 4096 px. Below, nothing is legible; above, nothing is a preview. */
function clampEdge(value: number): number {
  if (!Number.isFinite(value)) return 640;
  return Math.min(4096, Math.max(16, Math.round(value)));
}

/** A region in percent, clamped to the image and never of zero extent. */
function resolveRegion(
  region: RasterRegion | undefined,
  width: number,
  height: number,
): { sx: number; sy: number; sw: number; sh: number } {
  if (!region) return { sx: 0, sy: 0, sw: width, sh: height };
  const pct = (value: number, fallback: number) =>
    Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback;

  const x = pct(region.x, 0);
  const y = pct(region.y, 0);
  // A width of 0 is a mistake, not a request for an empty image — most often a
  // model that meant "the whole width". Falling back to the remainder of the
  // image is the reading that can still answer the question.
  const w = pct(region.width, 100) || 100 - x;
  const h = pct(region.height, 100) || 100 - y;

  const sx = Math.floor((x / 100) * width);
  const sy = Math.floor((y / 100) * height);
  const sw = Math.max(1, Math.min(width - sx, Math.round((w / 100) * width)));
  const sh = Math.max(1, Math.min(height - sy, Math.round((h / 100) * height)));
  return { sx, sy, sw, sh };
}

async function encodeFrom(
  canvas: CanvasModule,
  bytes: Uint8Array,
  options: TransformOptions & { background?: string },
): Promise<RasterImage | null> {
  const image = await canvas.loadImage(Buffer.from(bytes));
  if (!image.width || !image.height) return null;

  const { sx, sy, sw, sh } = resolveRegion(options.region, image.width, image.height);

  // Scale so the long edge lands on maxEdge, the width within maxWidth, and
  // the short edge on at least minEdge — then clamp again, because a tall thin
  // crop asked to satisfy all three could otherwise be told to grow past a
  // ceiling it had already been brought under.
  const maxEdge = clampEdge(options.maxEdge ?? Math.max(sw, sh));
  const maxWidth = options.maxWidth ? clampEdge(options.maxWidth) : 0;
  const minEdge = options.minEdge ? clampEdge(options.minEdge) : 0;
  const longest = Math.max(sw, sh);
  const shortest = Math.min(sw, sh);
  let scale = longest > maxEdge ? maxEdge / longest : 1;
  if (maxWidth && sw * scale > maxWidth) scale = maxWidth / sw;
  if (minEdge && shortest * scale < minEdge) scale = minEdge / shortest;
  if (longest * scale > maxEdge) scale = maxEdge / longest;
  if (maxWidth && sw * scale > maxWidth) scale = maxWidth / sw;

  const drawWidth = Math.max(1, Math.round(sw * scale));
  const drawHeight = Math.max(1, Math.round(sh * scale));

  const rotate = options.rotate ?? 0;
  const quarterTurn = rotate === 90 || rotate === 270;
  const outWidth = quarterTurn ? drawHeight : drawWidth;
  const outHeight = quarterTurn ? drawWidth : drawHeight;

  const surface = canvas.createCanvas(outWidth, outHeight);
  const ctx = surface.getContext("2d");

  // White underneath, always. A JPEG has no alpha channel, so a PNG
  // screenshot with a transparent background would otherwise come out on
  // whatever the uninitialised buffer held — in practice black, which inverts
  // dark-on-transparent text into something illegible.
  ctx.fillStyle = options.background ?? "#ffffff";
  ctx.fillRect(0, 0, outWidth, outHeight);

  if (rotate) {
    ctx.translate(outWidth / 2, outHeight / 2);
    ctx.rotate((rotate * Math.PI) / 180);
    ctx.translate(-drawWidth / 2, -drawHeight / 2);
  }
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, drawWidth, drawHeight);
  if (rotate) ctx.setTransform(1, 0, 0, 1, 0, 0);

  if (options.grayscale || (options.contrast && options.contrast !== 1)) {
    applyTone(ctx, outWidth, outHeight, options);
  }

  const format = options.format ?? "jpeg";
  const encoded =
    format === "png"
      ? surface.toBuffer("image/png")
      : surface.encodeSync("jpeg", Math.min(100, Math.max(40, Math.round(options.quality ?? 82))));

  return {
    bytes: new Uint8Array(encoded),
    mimeType: format === "png" ? "image/png" : "image/jpeg",
    width: outWidth,
    height: outHeight,
  };
}

/**
 * Grayscale and contrast, in pixels rather than through `ctx.filter`.
 *
 * The CSS filter string is the obvious way to ask for this and is only
 * partially implemented outside browsers, so a build where it silently does
 * nothing would hand back an unchanged image while reporting that it had been
 * enhanced. Doing the arithmetic here means the result matches what was asked
 * for on every platform that can draw at all.
 */
function applyTone(
  ctx: ReturnType<ReturnType<CanvasModule["createCanvas"]>["getContext"]>,
  width: number,
  height: number,
  options: TransformOptions,
): void {
  const frame = ctx.getImageData(0, 0, width, height);
  const data = frame.data;
  const contrast = Math.min(3, Math.max(0.2, options.contrast ?? 1));
  // The standard contrast transform around mid-grey: values above 128 move up,
  // values below move down, and 128 stays where it is.
  const intercept = 128 * (1 - contrast);

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    if (options.grayscale) {
      // Rec. 601 luma: green carries most of perceived brightness, so a flat
      // mean would wash out exactly the green-on-white UI text that is the
      // usual reason for asking.
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      r = g = b = luma;
    }
    if (contrast !== 1) {
      r = r * contrast + intercept;
      g = g * contrast + intercept;
      b = b * contrast + intercept;
    }
    data[i] = clampByte(r);
    data[i + 1] = clampByte(g);
    data[i + 2] = clampByte(b);
  }
  ctx.putImageData(frame, 0, 0);
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}
