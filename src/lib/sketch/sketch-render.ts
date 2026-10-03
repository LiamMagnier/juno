/*
 * Drawing a sketch onto a 2D canvas: the editor's paper and the exported PNG
 * go through the same function, so what you see is what the model gets.
 */

import {
  TEXT_LINE_HEIGHT,
  arrowHead,
  exportSize,
  outlineToPath,
  strokeOutline,
  type SketchDoc,
  type SketchObject,
  type StrokeObject,
} from "./sketch-core";

export const PAPER_COLOR = "#ffffff";

/** The canvas font for a text object. */
export function sketchFont(size: number, family: string): string {
  return `500 ${size}px ${family}`;
}

const pathCache = new WeakMap<StrokeObject, Path2D>();

function strokePath(obj: StrokeObject): Path2D {
  let path = pathCache.get(obj);
  if (!path) {
    path = new Path2D(
      outlineToPath(strokeOutline(obj.points, { size: obj.size, simulatePressure: obj.simulated })),
    );
    pathCache.set(obj, path);
  }
  return path;
}

export function drawObject(ctx: CanvasRenderingContext2D, obj: SketchObject, fontFamily: string): void {
  ctx.save();
  ctx.strokeStyle = obj.color;
  ctx.fillStyle = obj.color;
  ctx.lineWidth = obj.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (obj.kind) {
    case "stroke":
      ctx.fill(strokePath(obj));
      break;
    case "rect": {
      const x = Math.min(obj.x1, obj.x2);
      const y = Math.min(obj.y1, obj.y2);
      const w = Math.abs(obj.x2 - obj.x1);
      const h = Math.abs(obj.y2 - obj.y1);
      // A hand-drawn box has soft corners; a hairline radius keeps it a box.
      const r = Math.min(obj.size * 0.75 + 2, w / 2, h / 2);
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.stroke();
      break;
    }
    case "ellipse": {
      ctx.beginPath();
      ctx.ellipse(
        (obj.x1 + obj.x2) / 2,
        (obj.y1 + obj.y2) / 2,
        Math.abs(obj.x2 - obj.x1) / 2,
        Math.abs(obj.y2 - obj.y1) / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    }
    case "line":
    case "arrow": {
      ctx.beginPath();
      ctx.moveTo(obj.x1, obj.y1);
      ctx.lineTo(obj.x2, obj.y2);
      if (obj.kind === "arrow") {
        const [a, b] = arrowHead(obj);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(obj.x2, obj.y2);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
      break;
    }
    case "text": {
      ctx.font = sketchFont(obj.size, fontFamily);
      ctx.textBaseline = "top";
      const lineHeight = obj.size * TEXT_LINE_HEIGHT;
      // The half-leading above the glyphs, so canvas text sits where the
      // textarea that typed it sat.
      const lead = (lineHeight - obj.size) / 2;
      obj.text.split("\n").forEach((line, i) => ctx.fillText(line, obj.x, obj.y + lead + i * lineHeight));
      break;
    }
  }
  ctx.restore();
}

export function drawObjects(
  ctx: CanvasRenderingContext2D,
  objects: readonly SketchObject[],
  fontFamily: string,
  skip?: ReadonlySet<string>,
): void {
  for (const obj of objects) if (!skip?.has(obj.id)) drawObject(ctx, obj, fontFamily);
}

/** Width of the widest line of a text block, in its own units. */
export function measureText(ctx: CanvasRenderingContext2D, text: string, size: number, fontFamily: string): number {
  ctx.save();
  ctx.font = sketchFont(size, fontFamily);
  const width = Math.max(0, ...text.split("\n").map((line) => ctx.measureText(line).width));
  ctx.restore();
  return width;
}

/**
 * The PNG an attachment carries: white paper in either theme (models read
 * ink on white; a dark export would read as a night scene), the sketch at the
 * fixed long edge from `exportSize`.
 */
export async function exportSketchPng(doc: SketchDoc, fontFamily: string): Promise<Blob> {
  const size = exportSize(doc.width, doc.height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable.");
  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.setTransform(size.scale, 0, 0, size.scale, 0, 0);
  drawObjects(ctx, doc.objects, fontFamily);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Couldn’t export the sketch.");
  return blob;
}
