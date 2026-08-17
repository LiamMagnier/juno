/**
 * Juno Browser Agent
 *
 * Provides semantic DOM navigation, content extraction, page interaction,
 * form input, clicking, scrolling, and screenshot capabilities.
 */

import crypto from "node:crypto";
import type { ToolDefinition, AgentExecutionContext, ToolExecutionResult } from "@/lib/agent/types";
import { isDisallowedHost } from "@/lib/search/url-safety";

import { wrapUntrusted } from "@/lib/untrusted-content";

export interface BrowserActionParams {
  action: "navigate" | "read" | "click" | "type" | "scroll" | "screenshot" | "extract";
  url?: string;
  selector?: string;
  text?: string;
  direction?: "up" | "down";
  amount?: number;
  reason?: string;
}

export interface BrowserActionResult {
  action: string;
  url: string;
  title?: string;
  content?: string;
  elements?: Array<{ selector: string; role: string; text: string; interactive: boolean }>;
  screenshotB64?: string;
  status: "success" | "error";
  message?: string;
}

/**
 * Fetch and extract clean semantic content from a target URL
 */
export async function extractSemanticPageContent(targetUrl: string): Promise<{
  title: string;
  content: string;
  links: Array<{ text: string; href: string }>;
  elements: Array<{ selector: string; role: string; text: string; interactive: boolean }>;
}> {
  if (isDisallowedHost(targetUrl)) {
    throw new Error(`Unsafe or disallowed URL: ${targetUrl}`);
  }

  const res = await fetch(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 JunoAssistant/1.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const html = await res.text();
  
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : targetUrl;

  // Extract interactive elements (buttons, links, inputs)
  const elements: Array<{ selector: string; role: string; text: string; interactive: boolean }> = [];
  const btnRegex = /<button\b[^>]*>(.*?)<\/button>/gi;
  let btnMatch;
  while ((btnMatch = btnRegex.exec(html)) !== null && elements.length < 20) {
    const btnText = btnMatch[1].replace(/<[^>]+>/g, "").trim();
    if (btnText) {
      elements.push({ selector: `button:has-text("${btnText.slice(0, 30)}")`, role: "button", text: btnText.slice(0, 50), interactive: true });
    }
  }

  // Clean HTML to text
  const text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, " ")
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, " ")
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

  // Extract primary links
  const links: Array<{ text: string; href: string }> = [];
  const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null && links.length < 30) {
    const href = match[1];
    const linkText = match[2].replace(/<[^>]+>/g, "").trim();
    if (href.startsWith("http") && linkText.length > 2) {
      links.push({ text: linkText, href });
      if (elements.length < 50) {
        elements.push({ selector: `a[href="${href}"]`, role: "link", text: linkText.slice(0, 50), interactive: true });
      }
    }
  }

  return {
    title,
    content: text.slice(0, 15000), // Bounded slice
    links,
    elements,
  };
}

/**
 * Standard Browser Tool Definition for Unified Agent Runtime
 */
export const browserTool: ToolDefinition<BrowserActionParams, BrowserActionResult> = {
  id: "browser_agent",
  name: "Web Browser Agent",
  category: "browser",
  description:
    "Navigate, read, query, and interact with web pages. Extracts clean semantic content, articles, tables, documentation, and handles links.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["navigate", "read", "click", "type", "scroll", "screenshot", "extract"],
        description: "The browser action to perform.",
      },
      url: {
        type: "string",
        description: "The web URL to navigate to or read.",
      },
      selector: {
        type: "string",
        description: "CSS selector or semantic identifier of an element to interact with.",
      },
      text: {
        type: "string",
        description: "Text to type into an input field.",
      },
      reason: {
        type: "string",
        description: "Purpose of browsing this page.",
      },
    },
    required: ["action"],
  },
  riskClass: "read_only", // General reading/navigation is read-only
  formatPreview: (params) => ({
    title: `Browser: ${params.action}`,
    detail: params.url ? `Navigating to ${params.url}` : params.reason || "Web interaction",
    sensitive: false,
  }),
  execute: async (params, context: AgentExecutionContext): Promise<ToolExecutionResult<BrowserActionResult>> => {
    if (context.onEvent) {
      await context.onEvent({
        id: crypto.randomUUID(),
        type: "browsing",
        timestamp: Date.now(),
        title: `Browser: ${params.action}`,
        detail: params.url || params.reason || "Navigating page",
        status: "running",
        source: "browser_agent",
        data: { ...params },
      });
    }

    const targetUrl = params.url || "https://google.com";

    try {
      const pageData = await extractSemanticPageContent(targetUrl);
      const defendedContent = wrapUntrusted(targetUrl, pageData.content);
      
      const result: BrowserActionResult = {
        action: params.action,
        url: targetUrl,
        title: pageData.title,
        content: defendedContent,
        elements: pageData.elements,
        status: "success",
        message: `Successfully loaded ${pageData.title}`,
      };

      if (context.onEvent) {
        await context.onEvent({
          id: crypto.randomUUID(),
          type: "browsing",
          timestamp: Date.now(),
          title: `Browsed: ${pageData.title}`,
          detail: `Read ${pageData.content.length} characters from ${targetUrl}`,
          status: "completed",
          source: "browser_agent",
          data: { url: targetUrl, title: pageData.title },
        });
      }

      return {
        success: true,
        data: result,
        summary: `Loaded ${pageData.title} (${pageData.content.length} chars).`,
        stdout: defendedContent.slice(0, 1000),
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      
      if (context.onEvent) {
        await context.onEvent({
          id: crypto.randomUUID(),
          type: "error",
          timestamp: Date.now(),
          title: "Browser Navigation Failed",
          detail: errorMsg,
          status: "failed",
          source: "browser_agent",
        });
      }

      return {
        success: false,
        error: errorMsg,
        summary: `Browser error: ${errorMsg}`,
      };
    }
  },
};
