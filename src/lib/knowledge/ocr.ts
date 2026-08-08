/**
 * Bounded OCR fallback for image-only PDFs.
 *
 * OCR is deliberately a separate layer from the PDF text extractor. Embedded
 * text is verified at confidence 1; OCR is reconstructed text with a measured
 * word-confidence score and is never mixed into the parser's result silently.
 * Deployments may provide an HTTP OCR service or the `pdftoppm` + `tesseract`
 * binaries. If neither exists, the document remains citable as degraded and
 * says why instead of pretending a scan was indexed.
 */

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtractedBlock } from "./extract/types";

const execFile = promisify(execFileCallback);

export const OCR_VERSION = "1";
export const OCR_MAX_PAGES = 100;
const OCR_MAX_TEXT_CHARS_PER_PAGE = 100_000;
const OCR_TIMEOUT_MS = 90_000;
const OCR_ENDPOINT_TIMEOUT_MS = 45_000;

export interface OcrPage {
  page: number;
  text: string;
  /** 0..1, supplied by the OCR engine rather than invented by the caller. */
  confidence: number;
  bbox?: number[];
}

export type OcrOutcome =
  | { status: "ok"; pages: OcrPage[]; blocks: ExtractedBlock[]; provider: string }
  | { status: "unavailable" | "failed"; reason: string; provider: string };

function boundedConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function boundedPage(value: unknown): number | null {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > OCR_MAX_PAGES) return null;
  return value as number;
}

/** Converts a trusted OCR response into citable blocks, with no content guessing. */
export function ocrPagesToBlocks(
  pages: readonly OcrPage[],
  fileName: string
): { pages: OcrPage[]; blocks: ExtractedBlock[] } {
  const normalized = pages
    .map((page) => ({
      ...page,
      page: page.page,
      text: page.text.trim().slice(0, OCR_MAX_TEXT_CHARS_PER_PAGE),
      confidence: Math.max(0, Math.min(1, page.confidence)),
      bbox: page.bbox?.slice(0, 4),
    }))
    .filter((page) => page.page >= 1 && page.page <= OCR_MAX_PAGES && page.text.length > 0)
    .sort((a, b) => a.page - b.page);

  return {
    pages: normalized,
    blocks: normalized.map((page) => ({
      type: "paragraph" as const,
      text: page.text,
      page: page.page,
      path: fileName,
      heading: [],
      confidence: page.confidence,
      ...(page.bbox ? { bbox: page.bbox } : {}),
    })),
  };
}

function parseEndpointPages(raw: unknown): OcrPage[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const pages = (raw as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return null;
  const out: OcrPage[] = [];
  for (const entry of pages.slice(0, OCR_MAX_PAGES)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const value = entry as Record<string, unknown>;
    const page = boundedPage(value.page);
    const confidence = boundedConfidence(value.confidence);
    if (page === null || confidence === null || typeof value.text !== "string") continue;
    const bbox = Array.isArray(value.bbox) && value.bbox.every((part) => typeof part === "number" && Number.isFinite(part))
      ? value.bbox.slice(0, 4) as number[]
      : undefined;
    out.push({ page, text: value.text, confidence, ...(bbox ? { bbox } : {}) });
  }
  return out;
}

async function endpointOcr(bytes: Uint8Array, fileName: string): Promise<OcrOutcome | null> {
  const endpoint = process.env.JUNO_OCR_ENDPOINT?.trim();
  if (!endpoint) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
  } catch {
    return { status: "failed", provider: "endpoint", reason: "The configured OCR endpoint is not a valid HTTP URL." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OCR_ENDPOINT_TIMEOUT_MS);
  try {
    const headers = new Headers({
      "content-type": "application/pdf",
      "x-juno-file-name": fileName.slice(0, 200),
    });
    const apiKey = process.env.JUNO_OCR_API_KEY?.trim();
    if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
    const response = await fetch(url, { method: "POST", headers, body: Buffer.from(bytes), signal: controller.signal });
    if (!response.ok) {
      return { status: "failed", provider: "endpoint", reason: `The OCR service returned HTTP ${response.status}.` };
    }
    const pages = parseEndpointPages(await response.json().catch(() => null));
    if (!pages) return { status: "failed", provider: "endpoint", reason: "The OCR service returned an invalid page response." };
    const converted = ocrPagesToBlocks(pages, fileName);
    if (converted.blocks.length === 0) {
      return { status: "failed", provider: "endpoint", reason: "The OCR service returned no readable text." };
    }
    return { status: "ok", pages: converted.pages, blocks: converted.blocks, provider: "endpoint" };
  } catch (error) {
    return {
      status: "failed",
      provider: "endpoint",
      reason: error instanceof Error && error.name === "AbortError" ? "The OCR service timed out." : "The OCR service could not be reached.",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFile(command, ["--version"], { timeout: 5_000, maxBuffer: 256 * 1024 });
    return true;
  } catch {
    return false;
  }
}

function parseTsv(output: string, page: number): OcrPage | null {
  const lines = output.split(/\r?\n/);
  const groups = new Map<string, { words: string[]; confidence: number[] }>();
  for (const line of lines.slice(1)) {
    const fields = line.split("\t");
    if (fields.length < 12) continue;
    const text = fields[11]?.trim();
    const confidence = Number(fields[10]);
    if (!text || !Number.isFinite(confidence) || confidence < 0) continue;
    const key = `${fields[1]}:${fields[2]}:${fields[3]}:${fields[4]}`;
    const group = groups.get(key) ?? { words: [], confidence: [] };
    group.words.push(text);
    group.confidence.push(confidence / 100);
    groups.set(key, group);
  }
  const paragraphs = [...groups.values()];
  if (paragraphs.length === 0) return null;
  const text = paragraphs.map((group) => group.words.join(" ")).join("\n").trim();
  const confidences = paragraphs.flatMap((group) => group.confidence);
  if (!text || confidences.length === 0) return null;
  return {
    page,
    text,
    confidence: confidences.reduce((sum, value) => sum + value, 0) / confidences.length,
  };
}

async function commandOcr(bytes: Uint8Array, fileName: string, pageCount?: number): Promise<OcrOutcome> {
  if (!(await commandExists("pdftoppm")) || !(await commandExists("tesseract"))) {
    return {
      status: "unavailable",
      provider: "tesseract",
      reason: "OCR is not configured on this server. Install pdftoppm and tesseract or configure JUNO_OCR_ENDPOINT.",
    };
  }

  const temp = await mkdtemp(join(tmpdir(), "juno-ocr-"));
  const pdfPath = join(temp, "input.pdf");
  const prefix = join(temp, "page");
  const maxPages = Math.min(pageCount ?? OCR_MAX_PAGES, OCR_MAX_PAGES);
  const language = /^[A-Za-z0-9+_-]{1,32}$/.test(process.env.JUNO_OCR_LANG?.trim() ?? "")
    ? process.env.JUNO_OCR_LANG!.trim()
    : "eng";
  try {
    await writeFile(pdfPath, bytes);
    await execFile(
      "pdftoppm",
      ["-png", "-r", "150", "-f", "1", "-l", String(maxPages), pdfPath, prefix],
      { timeout: OCR_TIMEOUT_MS, maxBuffer: 512 * 1024 }
    );
    const images = (await readdir(temp))
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0));
    const pages: OcrPage[] = [];
    for (const image of images.slice(0, maxPages)) {
      const page = Number(image.match(/\d+/)?.[0] ?? 0);
      if (!page) continue;
      const result = await execFile("tesseract", [join(temp, image), "stdout", "-l", language, "--psm", "3", "tsv"], {
        timeout: OCR_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      const parsed = parseTsv(result.stdout, page);
      if (parsed) pages.push(parsed);
    }
    const converted = ocrPagesToBlocks(pages, fileName);
    if (converted.blocks.length === 0) {
      return { status: "failed", provider: "tesseract", reason: "OCR completed but found no readable text." };
    }
    return { status: "ok", pages: converted.pages, blocks: converted.blocks, provider: "tesseract" };
  } catch (error) {
    return {
      status: "failed",
      provider: "tesseract",
      reason: error instanceof Error && error.name === "ETIMEDOUT" ? "OCR timed out." : "The local OCR command failed.",
    };
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Try the configured service first, then the bounded local adapter. */
export async function ocrPdf(input: {
  bytes: Uint8Array;
  fileName: string;
  pageCount?: number;
}): Promise<OcrOutcome> {
  const endpoint = await endpointOcr(input.bytes, input.fileName);
  if (endpoint) return endpoint;
  return commandOcr(input.bytes, input.fileName, input.pageCount);
}
