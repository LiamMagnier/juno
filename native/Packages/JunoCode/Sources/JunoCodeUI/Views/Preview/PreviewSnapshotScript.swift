import Foundation
import WebKit

/// Juno's reading of the page, run in an isolated content world
/// (`juno-preview`) so the page can neither see nor spoof its refs
/// (CODE_AGENT_SPEC §4.3, PV-20, PV-21).
///
/// - Walks open shadow roots and same-origin iframes.
/// - Puts viewport-visible elements first, then visible ones off-screen, then
///   hidden ones, with a cap of 300 refs; every element carries `visible`, its
///   box and its ARIA state.
/// - Refs are `e1…`, held as weak references in the isolated world and
///   replaced by every snapshot.
/// - Reads framework error overlays (`vite-error-overlay`, `nextjs-portal`,
///   the webpack overlay) that `innerText` cannot see.
enum PreviewSnapshotScript {
    static let worldName = "juno-preview"

    @MainActor
    static var world: WKContentWorld { WKContentWorld.world(name: worldName) }

    static let maximumRefs = 300

    /// The library, defined once per document in the isolated world. Every
    /// call prefixes it, guarded, so a page loaded before injection still
    /// answers.
    static let library = #"""
    if (!globalThis.__juno) {
      const J = {};
      globalThis.__juno = J;
      J.refs = new Map();
      J.mutations = 0;
      try {
        new MutationObserver((records) => { J.mutations += records.length; })
          .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch (_) {}
      const clean = (value, limit = 160) => String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit);
      const INTERACTIVE_ROLES = new Set(["button","link","tab","menuitem","menuitemcheckbox","menuitemradio","checkbox","switch","option","radio","combobox","textbox","searchbox","slider","spinbutton","treeitem","listbox"]);
      const LANDMARKS = new Set(["NAV","MAIN","HEADER","FOOTER","ASIDE","FORM","DIALOG","SECTION"]);
      const roleOf = (el) => {
        const explicit = el.getAttribute && el.getAttribute("role");
        if (explicit) return explicit.split(/\s+/)[0];
        const tag = el.tagName;
        if (tag === "A" && el.hasAttribute("href")) return "link";
        if (tag === "BUTTON" || tag === "SUMMARY") return "button";
        if (tag === "SELECT") return el.multiple ? "listbox" : "combobox";
        if (tag === "TEXTAREA") return "textbox";
        if (tag === "OPTION") return "option";
        if (tag === "INPUT") {
          const type = (el.type || "text").toLowerCase();
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "range") return "slider";
          if (type === "number") return "spinbutton";
          if (["button","submit","reset","image"].includes(type)) return "button";
          if (type === "search") return "searchbox";
          return "textbox";
        }
        if (/^H[1-6]$/.test(tag)) return "heading";
        if (tag === "IMG") return "img";
        if (el.isContentEditable) return "textbox";
        if (LANDMARKS.has(tag)) return tag.toLowerCase();
        return "generic";
      };
      const rootOf = (el) => el.getRootNode ? el.getRootNode() : document;
      const nameOf = (el) => {
        const label = el.getAttribute("aria-label");
        if (label) return clean(label);
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const root = rootOf(el);
          const text = labelledBy.split(/\s+/).map((id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id))).filter(Boolean).map((node) => node.textContent).join(" ");
          if (clean(text)) return clean(text);
        }
        if (el.labels && el.labels.length) return clean(Array.from(el.labels).map((l) => l.textContent).join(" "));
        if (el.tagName === "IMG") return clean(el.alt || el.title);
        const isPassword = el.tagName === "INPUT" && (el.type || "").toLowerCase() === "password";
        const own = el.innerText || el.textContent || "";
        return clean(own || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") ||
          ((el.tagName === "INPUT" && ["button","submit","reset"].includes((el.type || "").toLowerCase()) && !isPassword) ? el.value : ""));
      };
      const frameOffsetOf = (doc) => {
        let x = 0, y = 0, view = doc.defaultView;
        while (view && view.frameElement) {
          const rect = view.frameElement.getBoundingClientRect();
          x += rect.left; y += rect.top;
          view = view.parent;
        }
        return { x, y };
      };
      const isHidden = (el) => {
        const style = el.ownerDocument.defaultView.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
        if (Number(style.opacity) === 0) return true;
        const rect = el.getBoundingClientRect();
        return rect.width <= 0 || rect.height <= 0;
      };
      const isInteresting = (el, filter) => {
        if (!el || el.nodeType !== 1) return false;
        const role = roleOf(el);
        if (INTERACTIVE_ROLES.has(role)) return true;
        if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return true;
        const tabindex = el.getAttribute("tabindex");
        if (tabindex !== null && Number(tabindex) >= 0) return true;
        if (el.hasAttribute("onclick")) return true;
        if (el.tagName === "LABEL" && el.control) return false;
        if (filter === "all" && (role === "heading" || role === "img" || LANDMARKS.has(el.tagName))) return true;
        try {
          const style = el.ownerDocument.defaultView.getComputedStyle(el);
          if (style.cursor === "pointer") {
            const parent = el.parentElement;
            const parentPointer = parent && parent.ownerDocument.defaultView.getComputedStyle(parent).cursor === "pointer";
            return !parentPointer;
          }
        } catch (_) {}
        return false;
      };
      const walk = (root, visit, depthLimit) => {
        const stack = [{ node: root, depth: 0 }];
        let guard = 0;
        while (stack.length && guard < 60000) {
          guard++;
          const { node, depth } = stack.pop();
          if (node.nodeType === 1) visit(node, depth);
          if (depthLimit != null && depth >= depthLimit) continue;
          const children = [];
          if (node.shadowRoot) children.push(...node.shadowRoot.children);
          if (node.tagName === "IFRAME" || node.tagName === "FRAME") {
            try { if (node.contentDocument && node.contentDocument.documentElement) children.push(node.contentDocument.documentElement); } catch (_) {}
          }
          if (node.children) children.push(...node.children);
          for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index], depth: depth + 1 });
        }
      };
      J.overlay = () => {
        const parts = [];
        const vite = document.querySelector("vite-error-overlay");
        if (vite && vite.shadowRoot) parts.push(vite.shadowRoot.textContent);
        document.querySelectorAll("nextjs-portal").forEach((portal) => {
          if (!portal.shadowRoot) return;
          const dialog = portal.shadowRoot.querySelector("[data-nextjs-dialog], [data-nextjs-toast], [role=dialog]");
          const text = dialog ? dialog.textContent : "";
          if (/error|failed/i.test(text)) parts.push(text);
        });
        const webpack = document.getElementById("webpack-dev-server-client-overlay");
        if (webpack) { try { parts.push(webpack.contentDocument.body.innerText); } catch (_) {} }
        const custom = document.querySelector("[data-juno-error-overlay]");
        if (custom) parts.push(custom.shadowRoot ? custom.shadowRoot.textContent : custom.textContent);
        const text = clean(parts.join(" — "), 2000);
        return text || null;
      };
      J.textOf = (root, limit) => {
        const out = [];
        let length = 0;
        const add = (value) => {
          const text = clean(value, 4000);
          if (!text) return;
          out.push(text);
          length += text.length + 1;
        };
        const visit = (node) => {
          if (length > limit) return;
          if (node.nodeType === 3) { add(node.nodeValue); return; }
          if (node.nodeType !== 1) return;
          const tag = node.tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") return;
          if (node.hasAttribute && node.hasAttribute("data-juno-live-reload")) return;
          try { if (isHidden(node) && tag !== "BODY" && tag !== "HTML" && !node.shadowRoot) return; } catch (_) {}
          if (tag === "INPUT" && (node.type || "").toLowerCase() === "password") return;
          if (node.shadowRoot) node.shadowRoot.childNodes.forEach(visit);
          if (tag === "IFRAME") { try { if (node.contentDocument) visit(node.contentDocument.body); } catch (_) {} return; }
          node.childNodes.forEach(visit);
        };
        visit(root);
        return out.join("\n").slice(0, limit);
      };
      J.lookup = (ref) => {
        const weak = J.refs.get(ref);
        const el = weak && weak.deref();
        return el && el.isConnected ? el : null;
      };
      J.snapshot = (options) => {
        const filter = options.filter === "all" ? "all" : "interactive";
        const limit = Math.min(Number(options.limit) || 300, 300);
        let root = document.documentElement;
        if (options.ref) {
          const scoped = J.lookup(options.ref);
          if (!scoped) return { error: "ref" };
          root = scoped;
        }
        const found = [];
        walk(root, (el) => { if (isInteresting(el, filter)) found.push(el); }, options.depth == null ? null : Number(options.depth));
        const viewportWidth = window.innerWidth, viewportHeight = window.innerHeight;
        const described = found.map((el, order) => {
          const offset = frameOffsetOf(el.ownerDocument);
          const rect = el.getBoundingClientRect();
          const box = { x: Math.round(rect.left + offset.x), y: Math.round(rect.top + offset.y), w: Math.round(rect.width), h: Math.round(rect.height) };
          let hidden = true;
          try { hidden = isHidden(el); } catch (_) {}
          const inViewport = !hidden && box.x + box.w > 0 && box.y + box.h > 0 && box.x < viewportWidth && box.y < viewportHeight;
          return { el, order, box, visible: !hidden, inViewport };
        });
        described.sort((a, b) => {
          const rank = (d) => (d.inViewport ? 0 : d.visible ? 1 : 2);
          return rank(a) - rank(b) || a.order - b.order;
        });
        const kept = described.slice(0, limit);
        if (!options.ref) J.refs = new Map();
        const generation = (J.generation = (J.generation || 0) + 1);
        let next = options.ref ? J.refs.size + 1 : 1;
        const elements = kept.map((d) => {
          const el = d.el;
          let ref = null;
          for (const [key, value] of J.refs) { if (value.deref() === el) { ref = key; break; } }
          if (!ref) { ref = "e" + next++; J.refs.set(ref, new WeakRef(el)); }
          const role = roleOf(el);
          const tag = el.tagName.toLowerCase();
          const isPassword = tag === "input" && (el.type || "").toLowerCase() === "password";
          const states = {};
          for (const name of ["checked","expanded","selected","pressed","current","disabled","invalid","required","haspopup"]) {
            const value = el.getAttribute("aria-" + name);
            if (value !== null && value !== "false") states[name] = value === "true" ? true : value;
          }
          if (el.checked === true) states.checked = true;
          if (el.disabled === true) states.disabled = true;
          if (el.required === true) states.required = true;
          if (el.readOnly === true) states.readonly = true;
          if (el.ownerDocument.activeElement === el) states.focused = true;
          const level = /^h[1-6]$/.test(tag) ? Number(tag[1]) : (el.getAttribute("aria-level") ? Number(el.getAttribute("aria-level")) : null);
          let href = null;
          if (tag === "a" && el.href) {
            try {
              const url = new URL(el.href, location.href);
              href = url.origin === location.origin ? url.pathname + url.search + url.hash : url.origin + url.pathname;
            } catch (_) {}
          }
          let value = "";
          if (!isPassword && ("value" in el) && typeof el.value === "string" && ["input","textarea","select"].includes(tag)) value = clean(el.value, 160);
          return {
            ref, role, name: nameOf(el), tag,
            type: tag === "input" ? (el.type || "text").toLowerCase() : null,
            value, isPassword, visible: d.visible, inViewport: d.inViewport, box: d.box,
            states, level, href,
            inFrame: el.ownerDocument !== document, inShadow: !!(rootOf(el) && rootOf(el).host)
          };
        });
        return {
          url: location.href, title: document.title || "", visibility: document.visibilityState,
          viewport: { width: viewportWidth, height: viewportHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight },
          overlay: J.overlay(), total: found.length, generation, elements,
          text: options.includeText ? J.textOf(options.ref ? root : document.body || document.documentElement, Number(options.maxText) || 6000) : null
        };
      };
      J.find = (options) => {
        const result = J.snapshot({ filter: "all", limit: 300 });
        const terms = String(options.query || "").toLowerCase().split(/\s+/).filter(Boolean);
        const matches = result.elements.filter((element) => {
          const haystack = (element.role + " " + element.name + " " + element.tag + " " + (element.value || "")).toLowerCase();
          return terms.every((term) => haystack.includes(term));
        });
        return { url: result.url, title: result.title, total: matches.length, elements: matches.slice(0, Math.min(Number(options.limit) || 20, 20)) };
      };
      J.point = (ref) => {
        const el = J.lookup(ref);
        if (!el) return { error: "ref" };
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        const offset = frameOffsetOf(el.ownerDocument);
        const rect = el.getBoundingClientRect();
        const left = Math.max(rect.left + offset.x, 0), top = Math.max(rect.top + offset.y, 0);
        const right = Math.min(rect.right + offset.x, window.innerWidth), bottom = Math.min(rect.bottom + offset.y, window.innerHeight);
        if (right <= left || bottom <= top) return { error: "offscreen" };
        const x = (left + right) / 2, y = (top + bottom) / 2;
        let covered = null;
        const atPoint = document.elementFromPoint(x, y);
        if (atPoint && atPoint !== el && !el.contains(atPoint) && !(el.shadowRoot && el.shadowRoot.contains(atPoint)) && el.ownerDocument === document) {
          covered = (atPoint.tagName || "").toLowerCase() + (atPoint.id ? "#" + atPoint.id : "") + " \"" + nameOf(atPoint).slice(0, 60) + "\"";
        }
        const tag = el.tagName.toLowerCase();
        return {
          x, y, covered, tag, role: roleOf(el), name: nameOf(el),
          disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
          isPassword: tag === "input" && (el.type || "").toLowerCase() === "password",
          isFile: tag === "input" && (el.type || "").toLowerCase() === "file",
          editable: el.isContentEditable || tag === "textarea" || (tag === "input" && !["checkbox","radio","button","submit","reset","file","image","range","color"].includes((el.type || "text").toLowerCase())),
          href: tag === "a" && el.href ? el.href : null
        };
      };
      J.focus = (ref, replace) => {
        const el = J.lookup(ref);
        if (!el) return { error: "ref" };
        el.focus({ preventScroll: false });
        if (replace) {
          if (typeof el.select === "function") el.select();
          else if (el.isContentEditable) {
            const range = el.ownerDocument.createRange();
            range.selectNodeContents(el);
            const selection = el.ownerDocument.getSelection();
            selection.removeAllRanges(); selection.addRange(range);
          }
        } else if (typeof el.setSelectionRange === "function" && typeof el.value === "string") {
          try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) {}
        }
        return { focused: el.ownerDocument.activeElement === el };
      };
      J.select = (ref, values) => {
        const el = J.lookup(ref);
        if (!el) return { error: "ref" };
        if (el.tagName !== "SELECT") return { error: "not a select" };
        const wanted = values.map(String);
        const chosen = [];
        for (const option of el.options) {
          const match = wanted.includes(option.value) || wanted.includes(clean(option.textContent));
          if (el.multiple) option.selected = match;
          else if (match && !chosen.length) { option.selected = true; }
          if (option.selected && match) chosen.push(option.value);
        }
        if (!chosen.length) return { error: "no option matches " + wanted.join(", ") };
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { chosen };
      };
      J.scrollTo = (ref) => {
        const el = J.lookup(ref);
        if (!el) return { error: "ref" };
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        return { y: Math.round(scrollY) };
      };
      J.rect = (ref) => {
        const el = J.lookup(ref);
        if (!el) return { error: "ref" };
        const offset = frameOffsetOf(el.ownerDocument);
        const rect = el.getBoundingClientRect();
        return { x: rect.left + offset.x, y: rect.top + offset.y, w: rect.width, h: rect.height };
      };
      J.state = () => ({
        url: location.href, title: document.title || "", readyState: document.readyState,
        mutations: J.mutations, resources: performance.getEntriesByType("resource").length,
        overlay: J.overlay(), visibility: document.visibilityState,
        scrollHeight: document.documentElement.scrollHeight, width: window.innerWidth, height: window.innerHeight
      });
      J.matches = (options) => {
        if (options.selector) {
          try { const el = document.querySelector(options.selector); return { met: !!el && !isHidden(el) }; } catch (error) { return { error: "selector" }; }
        }
        if (options.text) return { met: J.textOf(document.body || document.documentElement, 200000).toLowerCase().includes(String(options.text).toLowerCase()) };
        return { met: false };
      };
    }
    """#

    /// One call into the library: `body` is a function body that can use
    /// `__juno` and the named arguments.
    static func call(_ body: String) -> String {
        library + "\n" + body
    }
}
