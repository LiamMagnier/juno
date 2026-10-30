/**
 * Geometry audit: the browser half.
 *
 * `collectGeometry` runs inside the page (Playwright serialises it with
 * page.evaluate), so it must stay self-contained: no imports, no closures over
 * module scope. It walks every visible element in DOM pre-order and returns
 * compact records (the shape is documented at the top of geometry-lib.mjs).
 *
 * Visibility: display:none and opacity:0 prune a subtree; visibility:hidden
 * skips the element but not its children; boxes of 1px or less (sr-only) are
 * skipped; and a box must intersect the clip rectangle it inherits from its
 * overflow-clipping ancestors and the viewport (or the whole document with
 * `full`). The Next.js dev overlay and SVG internals are never entered.
 */
export function collectGeometry(opts) {
  const options = opts || {};
  const full = !!options.full;
  const targetSize = options.targetSize || 24;
  const maxRecords = options.maxRecords || 25000;
  const scopeSelector = options.scope || null;
  // Loading placeholders (and everything inside one) are marked so the checks
  // skip them: a skeleton is not the geometry the page settles into.
  const busySelector = options.busy || null;

  const R = (n) => Math.round(n * 100) / 100;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const sx = full ? window.scrollX : 0;
  const sy = full ? window.scrollY : 0;
  const doc = document.documentElement;

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "BR", "WBR", "TITLE", "BASE", "SOURCE", "TRACK", "PARAM", "AREA", "MAP", "DATALIST", "NEXTJS-PORTAL", "OPTION", "OPTGROUP"]);
  const REPLACED = new Set(["IMG", "VIDEO", "CANVAS", "IFRAME", "PICTURE", "OBJECT", "EMBED"]);
  const FIELD_TYPES = new Set(["text", "search", "email", "password", "url", "tel", "number", "date", "datetime-local", "month", "week", "time", "color", ""]);
  const INTERACTIVE_ROLES = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "checkbox", "radio", "switch", "slider", "combobox", "treeitem", "spinbutton", "searchbox", "textbox", "gridcell", "row"]);
  const GENERIC_COMPONENT = /^(.*Slot(\..*)?|.*CollectionSlot.*|RovingFocusGroup.*|Primitive\..*|Primitive|Slot|SlotClone|Slottable|Presence|Portal|PortalImpl|DismissableLayer|DismissableLayerBranch|FocusScope|FocusGuards|Popper|PopperAnchor|PopperContent|PopperArrow|Collection|CollectionSlot|CollectionItemSlot|CollectionProvider|RovingFocusGroup|RovingFocusGroupImpl|RovingFocusGroupItem|VisuallyHidden|RemoveScroll|SideCar|Combination|Fragment|Suspense|StrictMode|Profiler|SegmentViewNode|InnerLayoutRouter|OuterLayoutRouter|LayoutRouter|RenderFromTemplateContext|ScrollAndFocusHandler|InnerScrollAndFocusHandler|HotReload|AppRouter|Router|ServerRoot|ReactDevOverlay|Anonymous|MenuAnchor|MenuRootContentNonModal|MenuRootContentModal|MenuContentImpl|MenuItemImpl|MenuSubContent|SelectContentImpl|SelectItemImpl|DialogContentImpl|DialogContentModal|DialogContentNonModal|PopoverContentImpl|PopoverContentModal|PopoverContentNonModal|TooltipContentImpl|TooltipContentHoverable|Primitive\.div|_c\d*|LinkComponent|Link|MotionConfig|motion\..*|(Tooltip|DropdownMenu|Popover|Dialog|AlertDialog|HoverCard|ContextMenu|Collapsible|Sheet)Trigger|Menu|MenuSub|DropdownMenu|DropdownMenuSub|Popover|Tooltip|Dialog|AlertDialog|HoverCard|ContextMenu|Collapsible|Sheet|Select|.*Provider|.*Context|.*Boundary)$/;

  // ---- React internals (dev and prod builds both expose them on DOM nodes)
  let fiberKey = null;
  let propsKey = null;
  const findKeys = (el) => {
    if (fiberKey) return;
    for (const k of Object.keys(el)) {
      if (k.startsWith("__reactFiber$")) fiberKey = k;
      else if (k.startsWith("__reactProps$")) propsKey = k;
    }
  };
  const typeName = (t) => {
    if (!t) return null;
    if (typeof t === "function") return t.displayName || t.name || null;
    if (typeof t === "object") {
      if (t.displayName) return t.displayName;
      if (t.render) return t.render.displayName || t.render.name || null;
      if (t.type) return typeName(t.type);
    }
    return null;
  };
  const componentChain = (el) => {
    findKeys(el);
    if (!fiberKey || !el[fiberKey]) return [];
    const names = [];
    let f = el[fiberKey].return;
    let steps = 0;
    while (f && steps < 40 && names.length < 3) {
      if (typeof f.type !== "string") {
        const n = typeName(f.type);
        if (n && !GENERIC_COMPONENT.test(n) && names[names.length - 1] !== n) names.push(n);
      }
      f = f.return;
      steps++;
    }
    return names;
  };
  const hasClickHandler = (el) => {
    findKeys(el);
    const p = propsKey ? el[propsKey] : null;
    return !!(p && (p.onClick || p.onPointerDown || p.onMouseDown || p.onPointerUp));
  };

  // ---- Small helpers
  const px = (s) => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : 0;
  };
  const alpha = (c) => {
    if (!c || c === "transparent") return 0;
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean);
      if (parts.length >= 4) return parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      return 1;
    }
    const s = /\/\s*([\d.]+%?)\s*\)\s*$/.exec(c);
    if (s) return s[1].endsWith("%") ? parseFloat(s[1]) / 100 : parseFloat(s[1]);
    return 1;
  };
  const radius = (s, w, h) => {
    // "12px", "12px 8px" (elliptical) or "50%"
    const parts = String(s).trim().split(/\s+/);
    const one = (p, basis) => (p.endsWith("%") ? (parseFloat(p) / 100) * basis : px(p));
    const rx = one(parts[0], w);
    const ry = one(parts[1] || parts[0], h);
    return R(Math.min(rx, ry));
  };
  const range = document.createRange();
  const firstLine = (node) => {
    range.selectNodeContents(node);
    const rects = range.getClientRects();
    let first = null;
    let last = null;
    for (const rc of rects) {
      if (rc.width <= 0.5 || rc.height <= 0.5) continue;
      if (!first) first = rc;
      last = rc;
    }
    return first ? { l: first.left, r: last.right, t: first.top, b: first.bottom, h: first.height } : null;
  };
  const textBox = (node) => {
    range.selectNodeContents(node);
    const rc = range.getBoundingClientRect();
    return rc.width > 0.5 && rc.height > 0.5 ? rc : null;
  };
  const shortText = (s, n = 40) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) : t;
  };
  const firstTextOf = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    let guard = 0;
    while ((n = walker.nextNode()) && guard++ < 200) {
      if (/\S/.test(n.nodeValue)) return shortText(n.nodeValue);
    }
    return "";
  };
  const seg = (el) => {
    let s = el.tagName.toLowerCase();
    const id = el.id;
    if (id && id.length < 40 && !/radix|[:«»]|^r\d|\d{3,}/i.test(id)) return { s: `${s}#${id}`, stop: true };
    const tid = el.getAttribute("data-testid");
    if (tid) return { s: `${s}[data-testid="${tid}"]`, stop: true };
    const role = el.getAttribute("role");
    if (role) s += `[role=${role}]`;
    const al = el.getAttribute("aria-label");
    if (al && al.length <= 40) return { s: `${s}[aria-label="${al}"]`, stop: false };
    const p = el.parentElement;
    if (p) {
      let n = 0;
      let idx = 0;
      for (const c of p.children) {
        if (c.tagName === el.tagName) {
          n++;
          if (c === el) idx = n;
        }
      }
      if (n > 1) s += `:nth-of-type(${idx})`;
    }
    return { s, stop: false };
  };
  const cssPath = (el) => {
    const parts = [];
    let e = el;
    while (e && e !== document.body && e !== doc && parts.length < 4) {
      const { s, stop } = seg(e);
      parts.unshift(s);
      if (stop) break;
      e = e.parentElement;
    }
    return parts.join(" > ");
  };
  const HOOK_SKIP = /^data-(radix|state-|reactroot|nextjs|headlessui|floating|side-?offset|align-?offset|orientation$|rm$|jicon-pose$)/;
  const hooksOf = (el) => {
    const out = {};
    let n = 0;
    for (const a of el.attributes) {
      if (!a.name.startsWith("data-") || HOOK_SKIP.test(a.name)) continue;
      out[a.name] = a.value.length > 24 ? a.value.slice(0, 24) : a.value;
      if (++n >= 6) break;
    }
    return out;
  };
  const kindOf = (el, role, tag) => {
    if (role === "tab") return "tab";
    if (role === "menuitem" || role === "menuitemcheckbox" || role === "menuitemradio") return "menuitem";
    if (role === "option") return "option";
    if (role === "switch") return "switch";
    if (role === "checkbox") return "checkbox";
    if (role === "radio") return "radio";
    if (role === "slider") return "slider";
    // An editable combobox (a composer with a slash palette) is a text field, not a select.
    if (role === "combobox") return tag === "INPUT" ? "input" : el.isContentEditable || tag === "TEXTAREA" ? "textarea" : "select";
    if (role === "treeitem" || role === "row" || role === "gridcell") return "row";
    if (tag === "BUTTON" || role === "button" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "select";
    if (tag === "TEXTAREA") return "textarea";
    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "submit" || t === "button" || t === "reset" || t === "file" || t === "image") return "button";
      if (FIELD_TYPES.has(t)) return "input";
      return "input";
    }
    if ((tag === "A" && el.hasAttribute("href")) || role === "link") return "link";
    if (role === "textbox" || role === "searchbox" || role === "spinbutton" || el.isContentEditable) return el.isContentEditable && tag !== "INPUT" ? "textarea" : "input";
    return null;
  };
  // Glyphs are roughly square; a wordmark or a wide illustration is not an icon.
  const squarish = (w, h) => Math.max(w, h) <= 1.34 * Math.min(w, h);
  const isIconEl = (el, w, h, tag, role) => {
    if (tag === "svg") return w <= 64 && h <= 64 && squarish(w, h);
    if (tag === "IMG") return w <= 48 && h <= 48 && Math.abs(w - h) <= 8;
    if (role === "img") return w <= 48 && h <= 48 && !/\S/.test(el.textContent || "");
    return false;
  };

  // ---- The walk
  const records = [];
  const meta = new Map(); // record index -> element
  const viewportClip = full ? { l: -window.scrollX, t: -window.scrollY, r: doc.scrollWidth - window.scrollX, b: doc.scrollHeight - window.scrollY } : { l: 0, t: 0, r: vw, b: vh };

  const visit = (el, parentIndex, clip, depth) => {
    if (records.length >= maxRecords) return;
    const tag = el.tagName;
    if (SKIP.has(tag)) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none") return;
    if (parseFloat(cs.opacity) === 0) return;
    if (cs.clip && cs.clip !== "auto" && /rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(cs.clip)) return;
    if (cs.clipPath && /inset\(\s*50%/.test(cs.clipPath)) return;

    const pos = cs.position;
    let ownClip = clip;
    if (pos === "fixed") ownClip = { l: 0, t: 0, r: vw, b: vh };
    const rc = el.getBoundingClientRect();
    const box = { l: rc.left, t: rc.top, r: rc.right, b: rc.bottom };
    const visL = Math.max(box.l, ownClip.l);
    const visT = Math.max(box.t, ownClip.t);
    const visR = Math.min(box.r, ownClip.r);
    const visB = Math.min(box.b, ownClip.b);
    const isSvg = tag === "svg" || el instanceof SVGElement;
    const tagName = isSvg ? el.tagName.toLowerCase() : tag;
    const visible = cs.display !== "contents" && cs.visibility !== "hidden" && cs.visibility !== "collapse" && rc.width > 1 && rc.height > 1 && visR - visL > 0.5 && visB - visT > 0.5;

    let index = parentIndex;
    if (visible) {
      index = records.length;
      const role = el.getAttribute("role") || "";
      const w = R(rc.width);
      const h = R(rc.height);
      const bw = [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)].map(R);
      const bstyles = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
      for (let k = 0; k < 4; k++) if (bstyles[k] === "none" || bstyles[k] === "hidden") bw[k] = 0;
      const pad = [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)].map(R);
      const marRaw = [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].map(px).map(R);
      let mar = marRaw;
      if (marRaw.some((m) => m !== 0) && el.computedStyleMap) {
        try {
          const map = el.computedStyleMap();
          mar = ["margin-top", "margin-right", "margin-bottom", "margin-left"].map((p, k) => {
            const v = map.get(p);
            return v && String(v) === "auto" ? null : marRaw[k];
          });
        } catch {
          mar = marRaw;
        }
      }
      const rad = [radius(cs.borderTopLeftRadius, w, h), radius(cs.borderTopRightRadius, w, h), radius(cs.borderBottomRightRadius, w, h), radius(cs.borderBottomLeftRadius, w, h)];
      const disp = cs.display;
      const flexOrGrid = /flex|grid/.test(disp);
      const gap = flexOrGrid ? [cs.rowGap === "normal" ? null : R(px(cs.rowGap)), cs.columnGap === "normal" ? null : R(px(cs.columnGap))] : null;

      let paint = "";
      if (alpha(cs.backgroundColor) > 0.02) paint += "b";
      if (cs.backgroundImage && cs.backgroundImage !== "none") paint += "i";
      const bcolors = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor];
      if (bw.some((v, k) => v > 0 && alpha(bcolors[k]) > 0.02)) paint += "r";
      if (cs.boxShadow && cs.boxShadow !== "none") paint += "s";
      if (REPLACED.has(tag)) paint += "m";
      if (cs.backdropFilter && cs.backdropFilter !== "none") paint += "f";
      const clips = cs.overflowX !== "visible" || cs.overflowY !== "visible" || /paint|strict|content/.test(cs.contain || "");

      const kind0 = isSvg ? null : kindOf(el, role, tag);
      const disabled = !!(el.disabled || el.getAttribute("aria-disabled") === "true");
      const tabbable = el.hasAttribute("tabindex") && parseInt(el.getAttribute("tabindex"), 10) >= 0;
      const clickable = !isSvg && !kind0 && hasClickHandler(el);
      const kind = kind0 || (clickable || (tabbable && INTERACTIVE_ROLES.has(role)) ? "clickable" : null);
      const inter = !!kind;

      // Own text
      let txt = false;
      let tl = null;
      let tr = null;
      let ownText = "";
      if (!isSvg) {
        for (const n of el.childNodes) {
          if (n.nodeType === 3 && /\S/.test(n.nodeValue)) {
            const line = firstLine(n);
            if (!line) continue;
            if (!txt) tl = line.l;
            txt = true;
            tr = tr === null ? line.r : Math.max(tr, line.r);
            if (ownText.length < 40) ownText += n.nodeValue;
          }
        }
      }
      // A link or chip inside running text (WCAG target exception; not a control).
      let inline = false;
      if (kind && /^inline/.test(disp)) {
        // Climb inline wrappers (spans) to the block that holds the sentence.
        let p = el.parentElement;
        for (let hops = 0; p && hops < 4 && !inline; hops++) {
          for (const n of p.childNodes) if (n.nodeType === 3 && /\S/.test(n.nodeValue)) inline = true;
          if (!/^inline/.test(getComputedStyle(p).display)) break;
          p = p.parentElement;
        }
      }

      const rec = {
        i: index,
        p: parentIndex,
        tag: tagName.toLowerCase(),
        path: cssPath(el),
        x: R(rc.left + sx),
        y: R(rc.top + sy),
        w,
        h,
        disp,
        pos,
        pad,
        mar,
        bw,
        rad,
        gap,
        paint,
        clip: clips,
      };
      if (role) rec.role = role;
      const chain = isSvg ? [] : componentChain(el);
      if (chain.length) {
        rec.comp = chain[0];
        rec.comps = chain;
      }
      const label = el.getAttribute("aria-label");
      if (label) rec.label = shortText(label);
      const text = txt ? shortText(ownText) : firstTextOf(el);
      if (text) rec.text = text;
      const hooks = hooksOf(el);
      if (Object.keys(hooks).length) rec.hooks = hooks;
      if (/flex/.test(disp)) {
        rec.fd = cs.flexDirection;
        rec.fw = cs.flexWrap;
      }
      if (paint) rec.bg = cs.backgroundColor;
      if (kind) rec.kind = kind;
      if (inter) rec.inter = true;
      if (disabled) rec.disabled = true;
      if (inline) rec.inline = true;
      if (busySelector) {
        try {
          if (el.closest(busySelector)) rec.busy = true;
        } catch {
          /* an invalid selector marks nothing */
        }
      }
      const selAttr = el.getAttribute("aria-pressed") ?? el.getAttribute("aria-selected") ?? el.getAttribute("aria-checked");
      if (selAttr !== null) rec.sel = selAttr === "true";
      if (txt) {
        rec.txt = true;
        rec.tl = R(tl + sx);
        rec.tr = R(tr + sx);
        rec.fs = R(px(cs.fontSize));
        rec.lh = cs.lineHeight === "normal" ? null : R(px(cs.lineHeight));
        rec.ta = cs.textAlign;
        rec.dir = cs.direction;
      }
      if (isIconEl(el, w, h, tag === "svg" || tagName === "svg" ? "svg" : tag, role)) rec.icon = true;
      records.push(rec);
      meta.set(index, el);
    }

    if (isSvg) return; // never descend into SVG internals
    if (tag === "IFRAME") return;
    let childClip = ownClip;
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
      childClip = {
        l: Math.max(ownClip.l, cs.overflowX !== "visible" ? box.l : -Infinity),
        t: Math.max(ownClip.t, cs.overflowY !== "visible" ? box.t : -Infinity),
        r: Math.min(ownClip.r, cs.overflowX !== "visible" ? box.r : Infinity),
        b: Math.min(ownClip.b, cs.overflowY !== "visible" ? box.b : Infinity),
      };
      if (childClip.r - childClip.l <= 0 || childClip.b - childClip.t <= 0) return;
    }
    for (const child of el.children) visit(child, index, childClip, depth + 1);
  };

  // Scope: a selector, or "new" = only the layers an open script added to
  // <body> (portaled menus, popovers, dialogs), falling back to the page.
  let roots = [document.body];
  let scopeUsed = "page";
  if (scopeSelector === "new") {
    const base = window.__geometryBase;
    const fresh = base ? [...document.body.children].filter((c) => !base.has(c) && c.getBoundingClientRect().width > 0) : [];
    // A portal wrapper can be zero-sized with visible children: keep any new child that has visible content.
    const visibleFresh = base ? [...document.body.children].filter((c) => !base.has(c) && !SKIP.has(c.tagName) && [...c.querySelectorAll("*")].some((d) => d.getBoundingClientRect().width > 1)) : [];
    const pick = visibleFresh.length ? visibleFresh : fresh;
    if (pick.length) {
      roots = pick;
      scopeUsed = "new layers";
    }
  } else if (scopeSelector) {
    roots = [...document.querySelectorAll(scopeSelector)];
    scopeUsed = scopeSelector;
  }
  for (const root of roots) visit(root, -1, viewportClip, 0);

  // ---- Icon-to-text gaps: a flow icon child beside text, on one line.
  const iconish = (el, w, h) => {
    const tag = el.tagName;
    if (tag === "svg" || tag === "SVG") return w <= 48 && h <= 48;
    if (tag === "IMG") return w <= 32 && h <= 32;
    if (el.children.length === 1 && !/\S/.test(el.textContent || "")) {
      const c = el.children[0];
      if (c.tagName === "svg" || c.tagName === "IMG") return w <= 48 && h <= 48;
    }
    return false;
  };
  for (const rec of records) {
    const el = meta.get(rec.i);
    if (!el || rec.tag === "svg" || el.childNodes.length < 2) continue;
    const items = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        if (!/\S/.test(n.nodeValue)) continue;
        const b = textBox(n);
        if (b) items.push({ type: "text", l: b.left, r: b.right, t: b.top, b: b.bottom });
      } else if (n.nodeType === 1) {
        const cs = getComputedStyle(n);
        if (cs.display === "none" || cs.position === "absolute" || cs.position === "fixed" || parseFloat(cs.opacity) === 0) continue;
        const rc = n.getBoundingClientRect();
        if (rc.width <= 1 || rc.height <= 1) continue;
        if (iconish(n, rc.width, rc.height)) items.push({ type: "icon", l: rc.left, r: rc.right, t: rc.top, b: rc.bottom });
        else if (/\S/.test(n.textContent || "") && !n.querySelector("svg, img")) {
          const b = textBox(n);
          if (b) items.push({ type: "text", l: b.left, r: b.right, t: b.top, b: b.bottom });
        } else items.push({ type: "other", l: rc.left, r: rc.right, t: rc.top, b: rc.bottom });
      }
    }
    if (items.length < 2) continue;
    let lead = null;
    let trail = null;
    for (let k = 1; k < items.length; k++) {
      const a = items[k - 1];
      const b = items[k];
      const overlap = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (overlap < 0.5 * Math.min(a.b - a.t, b.b - b.t)) continue;
      if (a.type === "icon" && b.type === "text" && lead === null && b.l >= a.r - 0.5) lead = R(b.l - a.r);
      if (a.type === "text" && b.type === "icon" && trail === null && b.l >= a.r - 0.5) trail = R(b.l - a.r);
    }
    if (lead !== null || trail !== null) rec.ig = [lead, trail];
  }

  // ---- Effective target size for small interactive elements (hit tested).
  if (!full) {
    for (const rec of records) {
      if (!rec.inter || rec.inline || rec.disabled) continue;
      if (rec.w >= targetSize && rec.h >= targetSize) continue;
      const el = meta.get(rec.i);
      const cx = rec.x + rec.w / 2;
      const cy = rec.y + rec.h / 2;
      if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;
      const hits = (x, y) => {
        if (x < 0 || y < 0 || x >= vw || y >= vh) return false;
        const hit = document.elementFromPoint(x, y);
        if (!hit) return false;
        if (hit === el || el.contains(hit)) return true;
        const lbl = hit.closest && hit.closest("label");
        return !!(lbl && lbl.control === el);
      };
      if (!hits(cx, cy)) {
        rec.covered = true;
        continue;
      }
      const half = targetSize / 2;
      const reach = (dx, dy) => {
        let d = 0;
        for (let s = 1; s <= half; s++) {
          if (hits(cx + dx * s, cy + dy * s)) d = s;
          else break;
        }
        return d;
      };
      const tw = R(Math.max(rec.w, reach(-1, 0) + reach(1, 0)));
      const th = R(Math.max(rec.h, reach(0, -1) + reach(0, 1)));
      rec.tgt = [tw, th];
    }
  }

  return {
    records,
    truncated: records.length >= maxRecords,
    viewport: { width: vw, height: vh, scrollX: window.scrollX, scrollY: window.scrollY, docWidth: doc.scrollWidth, docHeight: doc.scrollHeight },
    title: document.title,
    url: location.href,
    hydrated: !!fiberKey,
    scope: scopeUsed,
  };
}

/**
 * Draws numbered outlines over the offenders (runs in the page). Fixed
 * position, no pointer events, appended to <html>: it cannot move layout.
 */
export function drawOverlay(arg) {
  const items = arg.items || [];
  const position = arg.fixed ? "fixed" : "absolute";
  const old = document.getElementById("__geometry_overlay");
  if (old) old.remove();
  const root = document.createElement("div");
  root.id = "__geometry_overlay";
  root.setAttribute("style", `position:${position};left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;`);
  for (const it of items) {
    const color = it.color || "#111";
    const [x, y, w, h] = it.rect;
    const box = document.createElement("div");
    box.setAttribute("style", `position:absolute;left:${x - 1}px;top:${y - 1}px;width:${w + 2}px;height:${h + 2}px;outline:2px solid ${color};outline-offset:0;box-sizing:border-box;background:${color}14;`);
    const tag = document.createElement("div");
    const above = y > 18;
    tag.textContent = String(it.n);
    tag.setAttribute("style", `position:absolute;left:${Math.max(0, x - 1)}px;top:${above ? y - 17 : y + h + 1}px;min-width:16px;height:16px;padding:0 3px;box-sizing:border-box;background:${color};color:#fff;font:600 11px/16px ui-monospace,Menlo,monospace;text-align:center;border-radius:3px;`);
    root.appendChild(box);
    root.appendChild(tag);
  }
  document.documentElement.appendChild(root);
  return items.length;
}
