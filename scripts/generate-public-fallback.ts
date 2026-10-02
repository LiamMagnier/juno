/** Rebuild the router-independent offline fallback from the real root boundary. */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";

async function main() {
  const require = createRequire(import.meta.url);
  const previousCss = require.extensions[".css"];
  require.extensions[".css"] = () => {};
  (globalThis as unknown as { React: typeof React }).React = React;
  try {
    const { default: GlobalError } = await import("../src/app/global-error");
    const html = renderToStaticMarkup(React.createElement(GlobalError, { error: new Error(), reset: () => {} }))
      .replace("Something went wrong · Alevr", "You’re offline · Alevr")
      .replace("<h1>Something went wrong</h1>", "<h1>You’re offline</h1>")
      .replace('<p class="code">500</p>', '<p class="code" style="font-size:120px">Offline</p>')
      .replace("We couldn’t load this page. Try again in a moment. Your saved work is still there.", "Check your internet connection, then try again. Your saved work will be here when you reconnect.")
      .replace('<button type="button">Try again</button>', '<a href="/chat">Try again</a>');
    await writeFile("public/offline.html", `<!doctype html>${html}`);
  } finally {
    if (previousCss) require.extensions[".css"] = previousCss;
    else delete require.extensions[".css"];
  }
}
void main();
