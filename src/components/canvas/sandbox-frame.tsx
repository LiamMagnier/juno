"use client";

import * as React from "react";
import type { ArtifactType } from "@/lib/message-content";

const TAILWIND_CDN = "https://cdn.tailwindcss.com";
const REACT_CDN = "https://unpkg.com/react@18/umd/react.production.min.js";
const REACT_DOM_CDN = "https://unpkg.com/react-dom@18/umd/react-dom.production.min.js";
const BABEL_CDN = "https://unpkg.com/@babel/standalone/babel.min.js";
const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

const BASE_STYLE = `<style>body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;color:#111}</style>`;

function reactDoc(code: string): string {
  const transformed = code
    .replace(/^\s*import[^\n]*\n/gm, "")
    .replace(/export\s+default\s+function/g, "window.__Component = function")
    .replace(/export\s+default\s+/g, "window.__Component = ")
    .replace(/^\s*export\s+(const|let|var|function|class)\s/gm, "$1 ");

  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<script src="${TAILWIND_CDN}"></script>
<script src="${REACT_CDN}"></script>
<script src="${REACT_DOM_CDN}"></script>
<script src="${BABEL_CDN}"></script>
${BASE_STYLE}</head>
<body><div id="root"></div>
<script type="text/babel" data-presets="react,typescript">
const { useState, useEffect, useRef, useMemo, useCallback, useReducer, Fragment } = React;
try {
${transformed}
const C = window.__Component;
if (!C) { document.getElementById('root').innerHTML = '<p style="padding:16px;color:#b00">No default export found.</p>'; }
else { ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(C)); }
} catch (e) {
  document.getElementById('root').innerHTML = '<pre style="padding:16px;color:#b00;white-space:pre-wrap">' + (e && e.message ? e.message : e) + '</pre>';
}
</script></body></html>`;
}

function htmlDoc(code: string): string {
  if (/<html[\s>]/i.test(code)) return code;
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><script src="${TAILWIND_CDN}"></script>${BASE_STYLE}</head><body>${code}</body></html>`;
}

function svgDoc(code: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/>${BASE_STYLE}<style>body{display:grid;place-items:center;min-height:100vh;background:#fff}</style></head><body>${code}</body></html>`;
}

function mermaidDoc(code: string): string {
  const escaped = code.replace(/<\/script>/g, "<\\/script>");
  return `<!doctype html><html><head><meta charset="utf-8"/>${BASE_STYLE}<style>body{display:grid;place-items:center;min-height:100vh;padding:16px}</style></head>
<body><pre class="mermaid">${escaped}</pre>
<script type="module">
import mermaid from "${MERMAID_CDN}";
mermaid.initialize({ startOnLoad: true });
</script></body></html>`;
}

export function buildSandboxDoc(type: ArtifactType, content: string): string {
  switch (type) {
    case "REACT":
      return reactDoc(content);
    case "HTML":
      return htmlDoc(content);
    case "SVG":
      return svgDoc(content);
    case "MERMAID":
      return mermaidDoc(content);
    default:
      return htmlDoc(`<pre style="padding:16px;white-space:pre-wrap">${content.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!))}</pre>`);
  }
}

export function SandboxFrame({ type, content }: { type: ArtifactType; content: string }) {
  const srcDoc = React.useMemo(() => buildSandboxDoc(type, content), [type, content]);
  return (
    <iframe
      title="Artifact preview"
      srcDoc={srcDoc}
      // Opaque origin (no allow-same-origin) so artifact code cannot touch the app, cookies, or storage.
      sandbox="allow-scripts allow-popups allow-forms allow-modals"
      className="h-full w-full border-0 bg-white"
    />
  );
}
