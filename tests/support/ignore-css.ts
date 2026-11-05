import { createRequire } from "node:module";

/*
 * Node's test renderer has no stylesheet loader. A component that imports its
 * own CSS (code-work-list.tsx brings sidebar-column.css, which the Code
 * workspace renders) would otherwise fail to load with a syntax error.
 * Import this first, before the components under test; Next handles the CSS
 * in the app. (tests/download-feed.test.ts does the same around one import.)
 */
const require = createRequire(import.meta.url);
require.extensions[".css"] ??= () => {};
