// Page content and the clickable boxes.
//
// Storage: content.json = bio + an index of the notes. Each note is its own folder:
//   notes/<box>/<note-id>/note.json (title, dates, tags, pin, layout), body.html (text), images/ (pictures)
//
// Everyone:  clicking a ribbon box swaps the Bio for the split layout, filled with that box's notes.
//            Clicking the title swaps back to the Bio. Clicking a note box opens that note: its parts
//            (title, text, pictures) drawn where its layout puts them (stacked in order on phones).
//            The full-screen button opens the title + text in a reading popup.
// Owner only (page opened on localhost, where the body has the "owner" class):
//            click the Bio, a note's title or text and type; it saves itself.
//            plus button: the add-note popup (a copy of the concept tracker's): box, title, body, tags, images.
//            the ribbon under an open note's title: the arrange popup (move / resize / reorder parts, add images).
//            pin (in an open note), tags (row under it), trash (in the lists).
//            Saving goes to dev-server.py, which writes the note folders and rebuilds content.json.
//            The live site has no dev-server, so nothing there can save.
(() => {
  const isOwner = document.body.classList.contains("owner");
  const inside = document.querySelector(".inside");
  const bio = inside.querySelector(".bio-box");
  const bioText = bio.querySelector(".bio-text");   // only this part is editable; the "Bio" heading isn't
  const tabs = [...inside.querySelectorAll(".section-tab")];
  const names = Object.fromEntries(tabs.map((t) => [t.dataset.section, t.textContent.trim()]));

  // The split layout lives in a <template>; copy it in once, right after the Bio.
  bio.after(document.getElementById("stash-split").content.cloneNode(true));
  const left = inside.querySelector(".split-left");
  const right = inside.querySelector(".split-right");   // pinned notes (max 3 per section)
  const PIN_LIMIT = 3;
  // The note view: takes the split's place when a note box is clicked. Empty shell for now.
  const noteView = document.createElement("section");
  noteView.className = "note-view";
  inside.querySelector(".split").after(noteView);

  let content = { bio: "", sections: { built: [], experiments: [], blogs: [], "my-system": [] } };
  let currentSection = null;

  // ---------- small helpers ----------
  const toast = document.createElement("div");
  toast.className = "toast";
  document.body.appendChild(toast);
  let toastTimer;
  function say(text) {
    toast.textContent = text; toast.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 1400);
  }
  function onActivate(el, fn) {   // click, or Enter / Space from the keyboard
    el.addEventListener("click", fn);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } });
  }
  const today = () => new Date().toLocaleDateString("en-CA");   // YYYY-MM-DD in local time
  const pad = (n) => String(n).padStart(2, "0");
  const nowStamp = () => { const d = new Date(); return `${today()}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };   // YYYY-MM-DDTHH:MM, local
  // "Nov 4, 2:47 PM"; notes saved before times were recorded show just the date
  function addedLabel(item) {
    const [y, m, d] = item.created.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    if (item.added) { const [h, min] = item.added.slice(11).split(":").map(Number); date.setHours(h, min); }
    const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return item.added ? `${day}, ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : day;
  }
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "item";

  // ---------- views: Bio or a section ----------
  // ---------- rich text: keep what Substack formatting can express, drop everything else ----------
  // Pasted text (e.g. copied from a Substack post) keeps its links, headings, bold/italic, lists, quotes,
  // code, images, footnotes and tables. Anything else (styles, scripts, classes, unknown tags) is removed,
  // and unknown tags are unwrapped so their words survive. Run on paste, on save, and again on display.
  const KEEP = {
    P: [], BR: [], DIV: [], H1: [], H2: [], H3: [], H4: [], H5: [], H6: [],
    STRONG: [], B: [], EM: [], I: [], U: [], S: [], DEL: [], STRIKE: [], MARK: [], SUP: [], SUB: [], SMALL: [],
    A: ["href", "title"], UL: [], OL: ["start"], LI: [], BLOCKQUOTE: [], PRE: [], CODE: [], HR: [],
    IMG: ["src", "alt", "title", "width", "height"], FIGURE: [], FIGCAPTION: [],
    TABLE: [], THEAD: [], TBODY: [], TR: [], TH: ["colspan", "rowspan"], TD: ["colspan", "rowspan"],
  };
  const DROP_WITH_CONTENTS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "SVG", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD", "TITLE"]);
  const safeUrl = (url, forImage) => {
    try {
      const u = new URL(url, location.href);
      return (forImage ? ["https:", "http:"] : ["https:", "http:", "mailto:"]).includes(u.protocol) ? u.href : null;
    } catch { return null; }
  };
  // When you copy PART of a heading (or of bold text), Chrome often leaves out the <h1>/<strong> tag and
  // copies the look as inline styles instead: <span style="font-size: 36px; font-weight: 700">Title</span>.
  // The cleaner strips styles, so first turn those styles back into real tags:
  //   text much bigger than the normal text around it -> heading (1.6x: H1, 1.3x: H2, 1.15x and bold: H3),
  //   bold -> <strong>, italic -> <em>, underline -> <u>, strikethrough -> <s>.
  //   "Normal size" = the most common font size in the paste, capped at 18px (so a title copied on its own,
  //   ~36px on Substack, still counts as big). Only runs where a style is present (pastes).
  function stylesToTags(doc) {
    // font size in px; Google Docs uses points (1pt = 4/3 px), Substack/Chrome use px
    const sizeOf = (el) => {
      const f = el.style.fontSize;
      return f.endsWith("px") ? parseFloat(f) : f.endsWith("pt") ? parseFloat(f) * 4 / 3 : f.endsWith("em") ? parseFloat(f) * 16 : 0;
    };
    // Google Docs wraps every copy in <b style="font-weight:normal" id="docs-internal-guid-…">: a bold tag
    // that isn't bold. Unwrap any <b>/<strong> whose own style says normal weight, keeping what's inside.
    for (const el of [...doc.body.querySelectorAll("b[style], strong[style]")]) {
      const w = el.style.fontWeight;
      if (w === "normal" || (parseInt(w, 10) && parseInt(w, 10) < 600)) el.replaceWith(...el.childNodes);
    }
    const counts = {};
    for (const el of doc.body.querySelectorAll("[style]")) {
      const px = sizeOf(el);
      if (px) counts[px] = (counts[px] || 0) + el.textContent.length;
    }
    const common = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const base = Math.min(common ? Number(common) : 16, 18);
    const headingFor = (px, bold) => {
      const r = px / base;
      return r >= 1.6 ? "H1" : r >= 1.3 ? "H2" : r >= 1.15 && bold ? "H3" : null;
    };
    for (const el of [...doc.body.querySelectorAll("[style]")]) {
      if (!el.isConnected || /^H[1-6]$/.test(el.tagName) || el.closest("h1,h2,h3,h4,h5,h6")) continue;
      const st = el.style;
      const px = sizeOf(el);
      const bold = st.fontWeight === "bold" || parseInt(st.fontWeight, 10) >= 600;
      const level = headingFor(px, bold);
      if (level) {
        const h = doc.createElement(level);
        h.append(...el.childNodes);
        // if it's the only thing in its paragraph, the heading replaces the paragraph (a heading can't sit inside a <p>)
        const parent = el.parentElement;
        const alone = parent && parent !== doc.body && /^(P|DIV)$/.test(parent.tagName) && parent.textContent.trim() === el.textContent.trim();
        (alone ? parent : el).replaceWith(h);
        continue;
      }
      let inner = null;
      const wrap = (tag) => { const w = doc.createElement(tag); w.append(...(inner ? [inner] : el.childNodes)); inner = w; };
      if (bold && !el.closest("strong,b")) wrap("strong");
      if (st.fontStyle === "italic" && !el.closest("em,i")) wrap("em");
      const deco = `${st.textDecorationLine} ${st.textDecoration}`;
      if (deco.includes("underline") && el.tagName !== "A" && !el.closest("u,a")) wrap("u");
      if (deco.includes("line-through") && !el.closest("s,del,strike")) wrap("s");
      if (inner) el.replaceChildren(inner);
    }
  }

  function cleanHtml(html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    // LaTeX: math that was already drawn (e.g. copied from Substack, which draws it with KaTeX/MathML) still
    // carries its original LaTeX inside. Swap the drawing back to that source text, so it survives the
    // cleaning and gets redrawn here: $$...$$ for a standalone equation, \( ... \) inside a sentence.
    for (const note of [...doc.querySelectorAll('annotation[encoding="application/x-tex"]')]) {
      if (!note.isConnected) continue;   // already replaced along with a neighbor
      const drawn = note.closest(".katex-display, .katex, math") || note;
      const outer = drawn.closest(".katex-display") || drawn;
      const display = !!drawn.closest(".katex-display") || drawn.closest("math")?.getAttribute("display") === "block";
      const tex = note.textContent.trim();
      outer.replaceWith(doc.createTextNode(display ? `$$${tex}$$` : `\\(${tex}\\)`));
    }
    stylesToTags(doc);
    (function walk(node) {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.COMMENT_NODE) { child.remove(); continue; }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.tagName;
        if (DROP_WITH_CONTENTS.has(tag)) { child.remove(); continue; }
        if (!KEEP[tag]) { walk(child); child.replaceWith(...child.childNodes); continue; }   // unwrap, keep the words
        for (const attr of [...child.attributes]) if (!KEEP[tag].includes(attr.name)) child.removeAttribute(attr.name);
        if (tag === "A") {
          const href = safeUrl(child.getAttribute("href") || "", false);
          if (href) { child.setAttribute("href", href); child.setAttribute("target", "_blank"); child.setAttribute("rel", "noopener noreferrer"); }
          else child.removeAttribute("href");
        }
        if (tag === "IMG") {
          const src = safeUrl(child.getAttribute("src") || "", true);
          if (!src) { child.remove(); continue; }
          child.setAttribute("src", src); child.setAttribute("loading", "lazy");
        }
        walk(child);
      }
    })(doc.body);
    return doc.body.innerHTML.trim();
  }
  // Draw LaTeX in a note with KaTeX. A plain "$" is NOT a math sign here, so prices like "$10 and $20" stay text.
  // Standalone equation: $$ E = mc^2 $$  or  \[ ... \]      Inside a sentence: \( x^2 \)
  // Substack equations often paste as bare LaTeX with no $$ around them, e.g. a line that's just
  //   f(L) = \text{rate}(L) - 0.005 \qquad f(L^*) = 0
  // A line counts as a bare equation if it uses a LaTeX math command and has almost no ordinary words
  // outside \text{...}. Such lines get $$...$$ added when shown, so they're drawn as math.
  const LATEX_CMD = /\\(frac|dfrac|tfrac|sum|prod|int|oint|text|mathrm|mathbf|mathit|mathcal|operatorname|qquad|quad|times|cdot|cdots|ldots|max|min|sqrt|left|right|le|ge|leq|geq|neq|approx|sim|propto|infty|partial|nabla|Delta|delta|alpha|beta|gamma|lambda|mu|sigma|theta|pi|omega|Omega|Sigma|forall|exists|to|rightarrow|Rightarrow|hat|bar|vec|overline|underbrace|begin|lim|log|ln|exp|sin|cos)(?![a-zA-Z])/;
  function wrapBareLatex(el) {
    for (const blk of el.querySelectorAll("p, div, li, td, figcaption")) {
      if (blk.querySelector("p, div, li, ul, ol, table, h1, h2, h3, h4, h5, h6, blockquote, pre, img, .katex")) continue;   // only innermost lines
      const t = blk.textContent.trim();
      if (!t || t.includes("$$") || t.includes("\\(") || t.includes("\\[") || !LATEX_CMD.test(t)) continue;
      const plainWords = t.replace(/\\text\{[^}]*\}/g, "").replace(/\\[a-zA-Z]+/g, "").match(/[A-Za-z]{4,}/g) || [];
      if (plainWords.length > 3) continue;   // a sentence that mentions some math, not an equation
      blk.textContent = `$$${t}$$`;
    }
  }

  function renderMath(el) {
    if (!el) return;
    wrapBareLatex(el);
    const draw = () => {
      window.renderMathInElement(el, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "\\(", right: "\\)", display: false },
        ],
        throwOnError: false,   // a typo shows the LaTeX in red instead of breaking the note
      });
      fitEquations(el);
      watchWidth(el);
    };
    if (window.renderMathInElement) draw();
    else window.addEventListener("load", () => window.renderMathInElement && draw(), { once: true });   // KaTeX still loading
  }

  // Equations shrink to fit their box (page, popup or full-screen reader) instead of spilling past its edge.
  // Each one is reset to full size, measured, and scaled down by exactly the amount it's too wide.
  // Never scaled up; redone whenever the box changes width (window resized, popup opened).
  function fitEquations(el) {
    for (const eq of el.querySelectorAll(".katex-display, .katex")) {
      if (eq.classList.contains("katex") && eq.closest(".katex-display")) continue;   // the display wrapper handles it
      eq.style.fontSize = "";
      const room = (eq.classList.contains("katex-display") ? eq : eq.parentElement).clientWidth;
      const need = eq.classList.contains("katex-display") ? (eq.querySelector(".katex")?.scrollWidth || 0) : eq.scrollWidth;
      if (room > 0 && need > room) eq.style.fontSize = `${Math.max(0.3, (room / need) * 0.98)}em`;
    }
  }
  const watched = new WeakSet();
  function watchWidth(el) {
    if (watched.has(el) || !window.ResizeObserver) return;
    watched.add(el);
    let lastWidth = el.clientWidth, frame = 0;
    new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitEquations(el));
    }).observe(el);
  }

  // Pasting into an editable box keeps the formatting (links, headings, lists, math...), cleaned by cleanHtml.
  // Cmd+Shift+V (Ctrl+Shift+V on Windows) pastes PLAIN text in the normal font and size, even when the
  // cursor is inside a heading, bold, a link, etc.: those get split at the cursor and the words go
  // between the two halves, outside any formatting.
  function keepFormattingOnPaste(el) {
    let plainNext = false;
    el.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "v") plainNext = true;
    });
    el.addEventListener("paste", (e) => {
      const plain = plainNext;
      plainNext = false;
      if (plain) { e.preventDefault(); pastePlainNormal(el, e.clipboardData.getData("text/plain")); return; }
      const html = e.clipboardData.getData("text/html");
      if (!html) return;   // plain text: let the browser paste it normally
      e.preventDefault();
      document.execCommand("insertHTML", false, cleanHtml(html));
    });
  }

  const FORMATTING = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "STRONG", "B", "EM", "I", "U", "S", "DEL", "STRIKE",
    "MARK", "SUP", "SUB", "SMALL", "CODE", "PRE", "A", "BLOCKQUOTE", "LI", "UL", "OL", "FIGCAPTION", "SPAN", "FONT"]);
  function pastePlainNormal(root, text) {
    if (!text) return;
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    // step out of every formatting element around the cursor by splitting it in two at the cursor
    let node = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer;
    while (node && node !== root && root.contains(node)) {
      const parent = node.parentNode;
      if (FORMATTING.has(node.tagName)) {
        const tail = document.createRange();
        tail.setStart(range.startContainer, range.startOffset);
        tail.setEndAfter(node.lastChild || node);
        const after = node.cloneNode(false);
        after.append(tail.extractContents());
        node.after(after);
        if (!after.textContent.trim() && !after.querySelector("img, br")) after.remove();
        range.setStartAfter(node); range.collapse(true);
        if (!node.textContent.trim() && !node.querySelector("img")) node.remove();
      }
      node = parent;
    }
    // the words, line breaks kept, in the normal style
    const frag = document.createDocumentFragment();
    text.replace(/\r\n?/g, "\n").split("\n").forEach((line, i) => {
      if (i) frag.append(document.createElement("br"));
      frag.append(document.createTextNode(line));
    });
    const last = frag.lastChild;
    range.insertNode(frag);
    range.setStartAfter(last); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
    root.dispatchEvent(new Event("input", { bubbles: true }));   // so it saves like any other edit
  }

  // older notes saved plain text: show their line breaks as breaks
  const plainToHtml = (text) => text.split("\n").map((line) => line.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])).join("<br>");

  // ---------- saving (owner): each call goes to dev-server.py ----------
  async function post(path, payload) {
    try {
      const r = await fetch(path, { method: "POST", body: typeof payload === "string" || payload instanceof Blob ? payload : JSON.stringify(payload) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { say(`save failed: ${data.error || r.status}`); return null; }
      return data;
    } catch { say("save failed (is dev-server.py running?)"); return null; }
  }
  async function saveBio() {
    if (await post("/save-bio", { bio: content.bio })) say("saved");
  }
  // A note = its folder: note.json (meta + layout) and one .html file per text box (body.html is the first).
  // texts = { "body.html": "<p>…</p>", "text-ab12.html": "…" }. The server rebuilds the index and sends it back.
  async function saveNote(section, meta, texts) {
    meta.textFiles = Object.keys(texts).length ? Object.keys(texts) : ["body.html"];   // every text box, shown or hidden
    const r = await post("/save-note", { section, note: meta, texts });
    if (!r) return false;
    content.sections = r.index.sections;
    if (r.pinRefused) { delete meta.pinned; say("saved (not pinned: this box already has 3 pins)"); }
    else say("saved");
    return true;
  }
  async function uploadImage(section, id, file) {
    const q = new URLSearchParams({ section, id, name: file.name || "image.png" });
    const r = await post(`/upload-image?${q}`, file);
    return r ? r.src : null;
  }
  const noteUrl = (section, id, file) => `notes/${section}/${id}/${file}`;
  const newTextFile = () => `text-${Math.random().toString(36).slice(2, 8)}.html`;
  const isPhone = () => matchMedia("(max-width: 760px)").matches;

  // Three views share the space under the ribbon: the Bio, a section's split, or one note.
  function setView(view) {
    inside.classList.toggle("show-split", view === "split");
    inside.classList.toggle("show-note", view === "note");
  }

  // The Bio is a note too (notes/about/bio/): pictures, text boxes, arrange popup, captions. Its "Bio"
  // heading is fixed; no pin or tags. If its folder isn't there (yet), the old plain bio text is shown.
  async function showBio() {
    currentSection = null;
    const ok = await showNote("about", "bio", true);
    if (!ok) {
      open = { section: "about", meta: { id: "bio", title: "Bio", created: today(), tags: [], textFiles: ["body.html"] },
               texts: { "body.html": plainToHtml(content.bio || "") } };
      drawNote();
    }
  }
  const isBioOpen = () => !!open && open.section === "about";

  // A box's page (Built, Experiments, ...): its own layout, stored in notes/<box>/page/. Its parts are the
  // notes list (left sidebar), the pinned list (right sidebar), the white line, plus any pictures and text
  // boxes, all placed with the same arrange popup as a note. Default: list | line | pinned, like before.
  const pageView = document.createElement("section");
  pageView.className = "page-view";
  inside.querySelector(".split").after(pageView);
  function defaultPageLayout() {
    return { blocks: [
      { kind: "list", x: 0, y: 0, w: 0.64, h: 1 },
      { kind: "line", x: 0.655, y: 0, w: 0.01, h: 1 },
      { kind: "pins", x: 0.68, y: 0, w: 0.32, h: 1 },
    ] };
  }
  const pageLayoutOf = (meta) => (meta.layout && meta.layout.blocks ? meta.layout : defaultPageLayout());

  async function showSection(key) {
    currentSection = key;
    let meta = { id: "page", textFiles: [] };
    const texts = {};
    try {
      const r = await fetch(noteUrl(key, "page", "page.json"), { cache: "no-store" });
      if (r.ok) meta = await r.json();
      const files = [...new Set([...(meta.textFiles || []), ...pageLayoutOf(meta).blocks.filter((b) => b.kind === "text").map((b) => b.file)])];
      await Promise.all(files.map((f) => fetch(noteUrl(key, "page", f), { cache: "no-store" })
        .then((x) => (x.ok ? x.text() : "")).then((t) => { texts[f] = t; })));
    } catch { /* no page yet: the default layout */ }
    if (currentSection !== key) return;   // you clicked somewhere else meanwhile
    open = { section: key, meta, texts, isPage: true };
    drawNote();
  }
  // the notes of the box on screen, oldest first
  // the index (content.json) is already in page order: newest first, or the order you dragged them into
  const sectionNotes = (key) => [...content.sections[key]];

  // ---------- one note: loaded from its folder, drawn from its layout ----------
  // open = { section, meta (note.json), texts: { file: html } } for the note on screen
  let open = null;
  let noteSaveTimer;
  // save whatever is open: a note (or the Bio) to its folder, or a box's page to notes/<box>/page/
  async function saveOpen(o) {
    if (!o.isPage) return saveNote(o.section, o.meta, o.texts);
    o.meta.textFiles = Object.keys(o.texts);
    const r = await post("/save-page", { section: o.section, page: { layout: o.meta.layout, textFiles: o.meta.textFiles }, texts: o.texts });
    if (!r) return false;
    content.sections = r.index.sections;
    say("saved");
    return true;
  }
  const saveOpenSoon = () => {
    clearTimeout(noteSaveTimer);
    const o = open;
    noteSaveTimer = setTimeout(() => o && saveOpen(o), 800);
  };

  // Layout = { aspect, blocks }. Blocks sit at x, w (shares of the note area's width) and y, h (shares of
  // the frame's height). The frame is "aspect" times as tall as it is wide; when that's taller than the
  // screen, the note area scrolls. No aspect = exactly the visible area (no scrolling).
  // Default arrangement: title across the top, text below it, pictures (if any) in a column on the right.
  function defaultLayout(imageSrcs = []) {
    const blocks = [{ kind: "title", x: 0, y: 0, w: 1, h: 0.13 }];
    const hasImages = imageSrcs.length > 0;
    blocks.push({ kind: "text", file: "body.html", x: 0, y: 0.17, w: hasImages ? 0.62 : 1, h: 0.83 });
    const each = Math.min(0.4, 0.83 / Math.max(1, imageSrcs.length));
    imageSrcs.forEach((src, i) => blocks.push({ kind: "image", src, x: 0.65, y: 0.17 + i * each, w: 0.35, h: each - 0.02 }));
    return { blocks };
  }
  function layoutOf(meta) {
    const layout = meta.layout && meta.layout.blocks ? meta.layout : defaultLayout();
    layout.blocks.forEach((b) => { if (b.kind === "text" && !b.file) b.file = "body.html"; });   // older layouts
    return layout;
  }
  // every text box the note has (shown in the layout or hidden from it)
  const textFiles = (meta) => [...new Set(["body.html", ...(meta.textFiles || []),
    ...layoutOf(meta).blocks.filter((b) => b.kind === "text").map((b) => b.file)])];

  async function showNote(section, id, quiet = false) {
    let meta;
    const texts = {};
    try {
      meta = await fetch(noteUrl(section, id, "note.json"), { cache: "no-store" }).then((r) => { if (!r.ok) throw 0; return r.json(); });
      await Promise.all(textFiles(meta).map((f) =>
        fetch(noteUrl(section, id, f), { cache: "no-store" }).then((r) => (r.ok ? r.text() : "")).then((t) => { texts[f] = t; })));
    } catch { if (!quiet) say("couldn't open that note"); return false; }
    open = { section, meta, texts };
    drawNote();
    return true;
  }

  // The edit ribbon (owner only): its own strip between the white line under the four boxes and a
  // second white line, shown while a note is open. Not on the live site.
  const editBar = document.createElement("div");
  editBar.className = "note-edit-bar";
  editBar.innerHTML = '<div class="note-edit-row"><button type="button" class="arrange-ribbon">arrange · add images · add text boxes</button>' +
    '<button type="button" class="note-pin edit-bar-pin"></button></div><div class="divider-horizontal" aria-hidden="true"></div>';
  const barPin = editBar.querySelector(".edit-bar-pin");
  if (isOwner) inside.querySelector(".divider-horizontal").after(editBar);
  editBar.querySelector(".arrange-ribbon").addEventListener("click", () => openArranger());
  barPin.addEventListener("click", () => togglePin());
  // pin / unpin (pinned notes also show on the right of the white line, max 3 per box): lives in the edit
  // ribbon, so it's there even when the title is hidden from the layout
  function updateBarPin() {
    if (!barPin.innerHTML) barPin.innerHTML = PIN_SVG;   // drawn on first use (the icon is defined further down)
    barPin.hidden = isBioOpen() || !!(open && open.isPage);   // only notes can be pinned
    const on = !!(open && open.meta.pinned);
    barPin.classList.toggle("pinned", on);
    barPin.setAttribute("aria-label", on ? "Unpin note" : "Pin note"); barPin.title = on ? "Unpin" : "Pin";
  }

  let canvasObserver = null;
  // Draw the open note. On phones the blocks simply stack in reading order instead (CSS does that).
  function drawNote() {
    const { section, meta } = open;
    const isBio = section === "about", isPage = !!open.isPage;
    const view = isPage ? pageView : noteView;
    noteView.classList.toggle("is-bio", isBio);
    const layout = isPage ? pageLayoutOf(meta) : layoutOf(meta);
    const canvas = document.createElement("div");
    canvas.className = "note-canvas";
    const frame = document.createElement("div");
    frame.className = "note-frame";
    canvas.append(frame);
    let titleWords = null;
    const editables = [];
    layout.blocks.forEach((b, i) => {
      const block = document.createElement("div");
      block.className = `note-block note-block-${b.kind}`;
      block.style.cssText = `--x:${b.x};--y:${b.y};--w:${b.w};--h:${b.h};z-index:${i + 1}`;
      if (b.kind === "title") {
        const title = document.createElement("h2");
        title.className = "text-box note-title";
        titleWords = document.createElement("span");
        titleWords.className = "fit-text";
        titleWords.textContent = meta.title;
        title.append(titleWords);
        block.append(title);
      } else if (b.kind === "text") {
        // The box (with its neon line) stays still; only the inner layer of text scrolls (if it can't shrink enough).
        const body = document.createElement("article");
        body.className = "text-box note-body";
        const text = document.createElement("div");
        text.className = "note-content";   // fixed, large letters: lines wrap and the box scrolls (never shrunk)
        text.innerHTML = cleanHtml(open.texts[b.file] || "");
        // click the box to read it full screen (links inside still open normally)
        body.classList.add("opens-reader");
        body.setAttribute("role", "button"); body.tabIndex = 0; body.title = "Click to read full screen";
        body.addEventListener("click", (e) => { if (!e.target.closest("a")) openReader(b.file); });
        body.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === body) openReader(b.file); });
        const dots = document.createElement("span");
        dots.className = "more-dots"; dots.textContent = "..."; dots.setAttribute("aria-hidden", "true");
        body.append(text, dots);
        watchMore(body, text, dots);
        if (!text.innerHTML && !isOwner) block.hidden = true;   // visitors don't see an empty text box
        block.append(body);
        editables.push([text, b.file]);
      } else if (b.kind === "list") {   // left sidebar: every note in this box
        const list = document.createElement("div");
        list.className = "page-list";
        list.append(...sectionNotes(section).map(itemRow));
        if (isOwner) makeReorderable(list, section);
        block.append(list);
      } else if (b.kind === "pins") {   // right sidebar: the pinned notes
        const pins = document.createElement("div");
        pins.className = "page-pins";
        pins.append(...sectionNotes(section).filter((n) => n.pinned).map(pinnedBox));
        block.append(pins);
      } else if (b.kind === "line") {   // the white line: runs along the long side of its box
        const line = document.createElement("div");
        line.className = "page-line";
        block.append(line);
      } else {
        const img = document.createElement("img");
        img.className = "note-image";
        img.src = noteUrl(section, meta.id, b.src);
        img.alt = b.caption || ""; img.loading = "lazy"; img.draggable = false;
        img.dataset.rotate = b.rotate || 0;
        img.addEventListener("load", () => placeImage(img));
        img.setAttribute("role", "button"); img.tabIndex = 0; img.title = "Click to enlarge";
        onActivate(img, () => openLightbox(b));
        block.append(img);
      }
      frame.append(block);
    });
    const parts = [canvas];
    if (isOwner && !isBio && !isPage) parts.push(tagRow());   // local only: edit this note's tags (not the Bio or a page)
    view.replaceChildren(...parts);
    view.dataset.id = meta.id;
    setView(isPage ? "split" : "note");
    if (isOwner) updateBarPin();

    // frame height = aspect × width (taller than the visible area = the note scrolls)
    const sizeFrame = () => {
      frame.style.height = isPhone() ? "" : `${layout.aspect ? canvas.clientWidth * layout.aspect : canvas.clientHeight}px`;
      fitAllText(frame);
      frame.querySelectorAll(".note-image").forEach(placeImage);
      frame.querySelectorAll(".page-line").forEach((l) => l.classList.toggle("across", l.parentElement.clientWidth > l.parentElement.clientHeight));
    };
    if (canvasObserver) canvasObserver.disconnect();
    canvasObserver = new ResizeObserver(() => requestAnimationFrame(sizeFrame));
    canvasObserver.observe(canvas);
    sizeFrame();
    editables.forEach(([text]) => renderMath(text));
    if (document.fonts) document.fonts.ready.then(() => fitAllText(frame));   // VT323 arriving late changes sizes
    if (isOwner) {
      if (!isBio) makeTitleEditable(titleWords);   // the Bio's heading is fixed
      // text is edited in the full-screen popup (clicking a box opens it), not in the small box on the page
    }
  }

  // ---------- "..." when a text box holds more than it shows ----------
  // Boxes on the page don't scroll. The text is cut at the last whole line that fits, and a "..." sits at the
  // end of that line when anything is hidden; clicking the box opens the whole text full screen.
  function markMore(body, text, dots) {
    text.style.maxHeight = "";
    const h = text.clientHeight;
    if (h === 0) return;
    const lineH = parseFloat(getComputedStyle(text).lineHeight) || 0;
    const more = text.scrollHeight > h + 1;
    if (more && lineH > 0) text.style.maxHeight = `${Math.max(1, Math.floor((h + 1) / lineH)) * lineH}px`;   // no half-cut last line
    body.classList.toggle("has-more", more);
    if (more) dots.style.bottom = `${body.clientHeight - (text.offsetTop + text.clientHeight)}px`;
  }
  function watchMore(body, text, dots) {
    const run = () => requestAnimationFrame(() => markMore(body, text, dots));
    if (window.ResizeObserver) new ResizeObserver(run).observe(body);
    if (document.fonts) document.fonts.ready.then(run);
    setTimeout(run, 600);   // after the equations have been drawn
  }

  // ---------- text always fits its box ----------
  // Each title / text box: start at full size; if the words don't fit, shrink them (down to 35%) until they do.
  // Only if even 35% is too big does the text box scroll. Re-done when the window or the frame changes size.
  function fitText(el) {
    const box = el.classList.contains("note-content") ? el : el.closest(".note-title");
    if (!box || isPhone()) { el.style.fontSize = ""; return; }
    el.style.fontSize = "";
    const fits = () => box.scrollHeight <= box.clientHeight + 1 && box.scrollWidth <= box.clientWidth + 1;
    if (box.clientHeight === 0 || fits()) return;
    let lo = 0.35, hi = 1;
    for (let k = 0; k < 8; k++) {
      const mid = (lo + hi) / 2;
      el.style.fontSize = `${mid}em`;
      if (fits()) lo = mid; else hi = mid;
    }
    el.style.fontSize = `${lo}em`;
    if (el.classList.contains("note-content")) fitEquations(el);
  }
  const fitAllText = (root) => root.querySelectorAll(".fit-text").forEach(fitText);

  const EXPAND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  const COLLAPSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>';

  // ---------- pictures: fit inside their box even when rotated, with the outline hugging the picture ----------
  // The biggest size at which the turned picture's corners still stay inside the box.
  function fitImage(img, boxW, boxH) {
    const box = img.parentElement;
    const W = boxW ?? box.clientWidth, H = boxH ?? box.clientHeight;
    if (!img.naturalWidth || !W || !H) return;
    const r = img.naturalWidth / img.naturalHeight, t = (Number(img.dataset.rotate) || 0) * Math.PI / 180;
    const c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
    const w = Math.min(W / (c + s / r), H / (s + c / r));
    img.style.width = `${w}px`; img.style.height = `${w / r}px`;
    img.style.transform = `translate(-50%, -50%) rotate(${img.dataset.rotate || 0}deg)`;
  }

  // On the page: the picture is exactly as wide as its box, as tall as its real proportions say, and turned
  // about its center: the same rectangle you see in the arrange popup.
  function placeImage(img) {
    const W = img.parentElement.clientWidth;
    if (!img.naturalWidth || !W) return;
    const r = img.naturalWidth / img.naturalHeight;
    img.style.width = `${W}px`; img.style.height = `${W / r}px`;
    img.style.transform = `translate(-50%, -50%) rotate(${img.dataset.rotate || 0}deg)`;
  }

  // ---------- picture popup: click a picture to see it big and upright (outline kept); caption shows here only ----------
  // On your laptop the caption line is editable (saves itself); visitors see the caption if there is one.
  const lightbox = document.createElement("div");
  lightbox.className = "lightbox";
  lightbox.innerHTML = '<figure class="lightbox-figure"><div class="lightbox-stage"><img class="lightbox-img" alt=""></div><figcaption class="lightbox-caption"></figcaption></figure>';
  document.body.appendChild(lightbox);
  const lbImg = lightbox.querySelector(".lightbox-img"), lbStage = lightbox.querySelector(".lightbox-stage");
  const lbCap = lightbox.querySelector(".lightbox-caption");
  let lbBlock = null;
  const closeLightbox = () => { lightbox.classList.remove("open"); lbBlock = null; };
  lightbox.addEventListener("mousedown", (e) => { if (!e.target.closest(".lightbox-img, .lightbox-caption")) closeLightbox(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });
  const fitLightbox = () => { if (lbBlock) fitImage(lbImg, lbStage.clientWidth, lbStage.clientHeight); };
  lbImg.addEventListener("load", fitLightbox);
  window.addEventListener("resize", fitLightbox);

  function openLightbox(block) {
    lbBlock = block;
    lbImg.dataset.rotate = 0;   // shown upright here, whatever its turn on the page
    lbImg.style.width = lbImg.style.height = "";
    lbImg.src = noteUrl(open.section, open.meta.id, block.src);
    lbImg.alt = block.caption || "";
    lbCap.textContent = block.caption || "";
    lbCap.hidden = !isOwner && !block.caption;
    lbImg.style.transform = "translate(-50%, -50%)";
    lightbox.classList.add("open");
    requestAnimationFrame(fitLightbox);
    if (lbImg.decode) lbImg.decode().then(() => requestAnimationFrame(fitLightbox)).catch(() => {});
  }
  if (isOwner) {
    lbCap.contentEditable = "plaintext-only";
    if (lbCap.contentEditable !== "plaintext-only") lbCap.contentEditable = "true";
    lbCap.dataset.placeholder = "Add a caption…";
    lbCap.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lbCap.blur(); } });
    lbCap.addEventListener("input", () => {
      if (!lbBlock) return;
      const text = lbCap.innerText.trim();
      if (text) lbBlock.caption = text; else delete lbBlock.caption;
      // lbBlock is the open note's own layout block, so the normal autosave stores it
      if (!open.meta.layout) open.meta.layout = layoutOf(open.meta);
      saveOpenSoon();
    });
  }

  // ---------- reading popup: the note's title + one text box, big, over a dimmed page ----------
  // Click outside it, the collapse icon, or press Escape to close. On your laptop it's editable like the
  // page (saves itself 0.8 s after you stop typing); visitors just read. Text here is full size and scrolls.
  const reader = document.createElement("div");
  reader.className = "reader-overlay";
  reader.innerHTML = '<div class="reader-modal" role="dialog" aria-modal="true"></div>';
  document.body.appendChild(reader);
  const readerBox = reader.querySelector(".reader-modal");
  const closeReader = () => {
    if (!reader.classList.contains("open")) return;
    reader.classList.remove("open"); readerBox.replaceChildren();
    // show the edits made in the popup: notes, the Bio AND box pages (the page view is "show-split")
    if (isOwner && open && (inside.classList.contains("show-note") || inside.classList.contains("show-split"))) {
      // redrawing builds a fresh scroll area, which would start at the top: put the reader back where they were
      const view = open.isPage ? pageView : noteView;
      const oldCanvas = view.querySelector(".note-canvas");
      const canvasTop = oldCanvas ? oldCanvas.scrollTop : 0, pageTop = window.scrollY;
      drawNote();
      const restore = () => {
        const c = view.querySelector(".note-canvas");
        if (c) c.scrollTop = canvasTop;
        window.scrollTo(0, pageTop);
      };
      restore(); requestAnimationFrame(restore); setTimeout(restore, 300);   // again once sizes settle
    }
  };
  reader.addEventListener("mousedown", (e) => { if (e.target === reader) closeReader(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeReader(); });

  function openReader(file) {
    if (!open) return;
    const title = document.createElement("h2");
    title.className = "text-box note-title";
    const words = document.createElement("span");
    words.textContent = open.meta.title || names[open.section] || "";
    title.append(words);
    const body = document.createElement("article");
    body.className = "text-box note-body";
    const text = document.createElement("div");
    text.className = "note-content";
    text.innerHTML = cleanHtml(open.texts[file] || "");
    const close = document.createElement("button");
    close.type = "button"; close.className = "note-fullscreen";
    close.innerHTML = COLLAPSE_SVG; close.setAttribute("aria-label", "Close"); close.title = "Close";
    close.addEventListener("click", closeReader);
    body.append(text, close);
    readerBox.replaceChildren(title, body);
    renderMath(text);
    reader.classList.add("open");
    if (isOwner) { if (!isBioOpen() && !open.isPage) makeTitleEditable(words); makeTextEditable(text, file, true); }   // same editing + autosave as the page
    else close.focus();
  }

  // ---------- owner: the tag row under an opened note (not on the live site) ----------
  // Chips for the note's tags: × removes one, clicking a chip's word moves it back into the box to edit,
  // type + Enter adds. Same tag rule as the popup (lowercase, spaces become dashes). Saves right away.
  function tagRow() {
    const meta = open.meta;
    meta.tags = meta.tags || [];
    const row = document.createElement("div");
    row.className = "text-box note-tags";
    row.innerHTML = '<span class="note-tags-label">Tags/</span><span class="note-tags-chips"></span>' +
      '<input type="text" class="note-tags-input" placeholder="add a tag, press Enter" autocomplete="off">';
    const chips = row.querySelector(".note-tags-chips"), input = row.querySelector("input");
    const changed = () => { draw(); saveOpenSoon(); };
    const draw = () => chips.replaceChildren(...meta.tags.map((tag, i) => {
      const chip = document.createElement("span");
      chip.className = "np-chip";
      const word = document.createElement("span");
      word.textContent = tag; word.title = "Click to edit"; word.style.cursor = "pointer";
      word.addEventListener("click", () => { meta.tags.splice(i, 1); changed(); input.value = tag; input.focus(); });
      const x = document.createElement("button");
      x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "Remove tag");
      x.addEventListener("click", () => { meta.tags.splice(i, 1); changed(); });
      chip.append(word, x);
      return chip;
    }));
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const tag = normalizeTag(input.value);
      input.value = "";
      if (!tag || meta.tags.includes(tag)) return;
      meta.tags.push(tag); changed();
    });
    draw();
    return row;
  }

  // ---------- owner: edit an opened note in place, like the Bio ----------
  // Click the title or any text box and type; it saves itself 0.8 s after you stop.
  // Pasting keeps formatting (same cleaner as the add-note popup). Click a drawn equation to turn it back
  // into LaTeX text and edit or delete it; it's redrawn when you click away. Saved as LaTeX source.
  function makeTitleEditable(titleEl) {
    if (!titleEl) return;
    titleEl.contentEditable = "plaintext-only";
    if (titleEl.contentEditable !== "plaintext-only") titleEl.contentEditable = "true";
    titleEl.classList.add("editable");
    titleEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); } });   // one line only
    titleEl.addEventListener("input", () => {
      const t = titleEl.innerText.trim();
      if (t) { open.meta.title = t; saveOpenSoon(); }
    });
    titleEl.addEventListener("blur", () => { if (!titleEl.innerText.trim()) titleEl.textContent = open.meta.title; fitText(titleEl); });
  }

  function makeTextEditable(body, file, inReader = false) {
    body.contentEditable = "true";
    body.classList.add("editable");
    body.dataset.placeholder = "Write here…";
    // Equations: drawn ones are locked (so typing can't scramble the drawing). Click one and it turns back
    // into its LaTeX text ($$...$$ or \(...\)), which you edit or delete like any text; click outside
    // the box and everything is drawn again.
    const lockEquations = () => body.querySelectorAll(".katex-display, .katex").forEach((m) => {
      m.contentEditable = "false"; m.classList.add("equation-locked"); m.title = "Click to edit this equation";
    });
    lockEquations();
    body.addEventListener("click", (e) => {
      const hit = e.target.closest(".katex-display, .katex");
      if (!hit || !body.contains(hit)) return;
      const outer = hit.closest(".katex-display") || hit;
      const tex = outer.querySelector('annotation[encoding="application/x-tex"]')?.textContent.trim();
      if (tex === undefined) return;
      const source = document.createTextNode(outer.classList.contains("katex-display") ? `$$${tex}$$` : `\\(${tex}\\)`);
      outer.replaceWith(source);
      body.focus();
      const r = document.createRange();
      r.setStart(source, source.length); r.collapse(true);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);   // cursor at the end of the LaTeX
    });
    body.addEventListener("blur", () => { renderMath(body); lockEquations(); if (!inReader) fitText(body); });
    keepFormattingOnPaste(body);
    let fitTimer;
    body.addEventListener("input", () => {
      open.texts[file] = cleanHtml(body.innerHTML);
      saveOpenSoon();
      if (!inReader) { clearTimeout(fitTimer); fitTimer = setTimeout(() => fitText(body), 400); }   // keep it fitting as you type
    });
  }


  // a pinned note on the right side: the same box, clickable, with its time underneath
  function pinnedBox(item) {
    const wrap = document.createElement("div");
    wrap.className = "pinned-note";
    const box = document.createElement("div");
    box.className = "text-box item";
    box.setAttribute("role", "button"); box.tabIndex = 0;
    box.textContent = item.title;
    const section = currentSection;
    onActivate(box, () => showNote(section, item.id));
    const time = document.createElement("time");
    time.className = "note-time";
    time.textContent = addedLabel(item);
    wrap.append(box, time);
    return wrap;
  }

  // owner: pin or unpin the open note (max 3 pinned per section)
  async function togglePin() {
    if (!open || isBioOpen() || open.isPage) return;
    const { section, meta } = open;
    if (!meta.pinned && content.sections[section].filter((n) => n.pinned && n.id !== meta.id).length >= PIN_LIMIT) {
      say(`${names[section]} already has ${PIN_LIMIT} pins: unpin one first`);
      return;
    }
    if (meta.pinned) delete meta.pinned; else meta.pinned = true;
    clearTimeout(noteSaveTimer);
    await saveNote(section, meta, open.texts);
    drawNote();   // stay on the note
  }

  // the concept tracker's trash icon, copied exactly
  const TRASH_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
    '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

  // pushpin: outline when unpinned, filled when pinned (the fill comes from CSS)
  const PIN_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path class="pin-head" d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z"/><path d="M12 14v7"/></svg>';

  // one row in the left 2/3: glowing gun, yellow beam, the item's box, its time, (owner) trash
  function itemRow(item) {
    const section = currentSection;
    const row = document.createElement("div");
    row.className = "box-row";
    row.dataset.id = item.id;
    row.innerHTML = '<span class="gun-wrap"><img class="row-gun" src="portal-gun.png" alt="" draggable="false"><span class="beam"></span></span>';
    const box = document.createElement("div");
    box.className = "text-box item";
    box.setAttribute("role", "button"); box.tabIndex = 0;
    box.textContent = item.title;
    onActivate(box, () => showNote(section, item.id));
    // when it was added, at the row's right end, just before the white line
    const time = document.createElement("time");
    time.className = "note-time";
    time.textContent = addedLabel(item);
    if (item.added) time.dateTime = item.added;
    row.append(box, time);
    // owner only: the tracker's trash can, right of the time. On the live site it isn't created at all.
    if (isOwner) {
      const trash = document.createElement("button");
      trash.type = "button"; trash.className = "note-trash";
      trash.setAttribute("aria-label", "Delete note"); trash.title = "Delete";
      trash.innerHTML = TRASH_SVG;
      trash.addEventListener("click", (e) => { e.stopPropagation(); askDelete(section, item); });
      row.append(trash);
    }
    return row;
  }

  // ---------- owner: drag note boxes up and down to set their order (saved to notes/<box>/order.json) ----------
  // New notes always land on top (newest first) until you drag them somewhere else.
  function makeReorderable(list, section) {
    let dragged = null, before = "";
    const ids = () => [...list.querySelectorAll(".box-row")].map((r) => r.dataset.id);
    list.querySelectorAll(".box-row").forEach((row) => {
      row.draggable = true;
      row.classList.add("reorderable");
      row.addEventListener("dragstart", (e) => {
        dragged = row; before = ids().join(",");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", row.dataset.id);
        requestAnimationFrame(() => row.classList.add("dragging"));
      });
      row.addEventListener("dragend", async () => {
        row.classList.remove("dragging");
        dragged = null;
        const order = ids();
        if (order.join(",") === before) return;
        const r = await post("/save-order", { section, order });
        if (r) { content.sections = r.index.sections; say("order saved"); }
      });
    });
    list.addEventListener("dragover", (e) => {
      if (!dragged) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // drop above the first row whose middle is below the pointer
      const next = [...list.querySelectorAll(".box-row:not(.dragging)")].find((r) => {
        const box = r.getBoundingClientRect();
        return e.clientY < box.top + box.height / 2;
      });
      if (next) { if (next !== dragged.nextSibling) list.insertBefore(dragged, next); }
      else if (list.lastElementChild !== dragged) list.append(dragged);
    });
    list.addEventListener("drop", (e) => { if (dragged) e.preventDefault(); });
  }

  tabs.forEach((tab) => onActivate(tab, () => showSection(tab.dataset.section)));
  onActivate(document.getElementById("home-title"), showBio);

  // ---------- owner: arrange popup (the edit ribbon between the two white lines) ----------
  // The note's parts (title, text boxes, pictures) as shapes inside a frame with the SAME width-to-height
  // proportions as the real note area, so positions and sizes (as shares of the frame) map straight onto
  // the page. Drag a shape to move it, its corner square to resize it. Drag the bar under the frame to make
  // the frame taller (the real note then scrolls); the dashed line marks what fits on screen without scrolling.
  // The list sets the reading order (also the stacking order: lower = drawn on top; phones use this order).
  // "+ Image" adds pictures (uploaded on Save); "+ Text box" adds another text box. × hides any part from the
  // layout (title and text keep their words; "Hidden" lists them with a "show" button). Cancel discards it all.
  const arranger = document.createElement("div");
  arranger.className = "np-overlay";
  arranger.innerHTML = `
    <div class="np-modal ar-modal" role="dialog" aria-labelledby="arTitle">
      <div class="np-header">
        <div class="np-header-title"><h2 id="arTitle">Arrange note</h2></div>
        <button type="button" class="np-close" aria-label="Close">&times;</button>
      </div>
      <div class="ar-main">
        <div class="ar-stage">
          <div class="ar-frame"><div class="ar-fold" title="what fits on screen without scrolling"></div></div>
          <div class="ar-grow" title="drag to make the note taller or shorter">drag to make the note taller ↕</div>
        </div>
        <div class="ar-side">
          <div class="np-field"><label>Order (top = first)</label><div class="ar-list"></div></div>
          <div class="np-field ar-hidden-field"><label>Out of the frame (kept, saved)</label><div class="ar-hidden"></div></div>
          <label class="np-btn np-btn-secondary ar-add">+ Image<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden></label>
          <button type="button" class="np-btn np-btn-secondary ar-add-text">+ Text box</button>
          <button type="button" class="np-btn np-btn-secondary ar-reset">Reset to default</button>
        </div>
      </div>
      <div class="np-footer">
        <button type="button" class="np-btn np-btn-secondary ar-cancel">Cancel</button>
        <button type="button" class="np-btn np-btn-primary ar-save">Save</button>
      </div>
    </div>`;
  if (isOwner) document.body.appendChild(arranger);
  const arStage = arranger.querySelector(".ar-stage"), arFrame = arranger.querySelector(".ar-frame");
  const arFold = arranger.querySelector(".ar-fold"), arGrow = arranger.querySelector(".ar-grow"), arList = arranger.querySelector(".ar-list");
  const arHidden = arranger.querySelector(".ar-hidden"), arHiddenField = arranger.querySelector(".ar-hidden-field");
  let work = [], parked = [], selected = -1, screenAspect = 0.6, aspect = 0.6, newTexts = {};
  const SNAP = 0.005;
  const snap = (v) => Math.round(v / SNAP) * SNAP;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const labelOf = (b) => {
    if (b.kind === "title") return "Title";
    if (b.kind === "list") return "Notes list";
    if (b.kind === "pins") return "Pinned notes";
    if (b.kind === "line") return "White line";
    if (b.kind === "text") return b.file === "body.html" ? "Text (main)" : "Text box";
    return `Image: ${(b.file ? b.file.name : b.src.replace("images/", ""))}`;
  };

  function openArranger() {
    if (!open) return;
    // the real note area, measured now: the frame copies its proportions
    const canvas = (open.isPage ? pageView : noteView).querySelector(".note-canvas");
    const r = canvas ? canvas.getBoundingClientRect() : { width: 1000, height: 600 };
    screenAspect = r.width > 0 && r.height > 0 ? r.height / r.width : 0.6;
    const layout = open.isPage ? pageLayoutOf(open.meta) : layoutOf(open.meta);
    arranger.querySelector("#arTitle").textContent = open.isPage ? `Arrange ${names[open.section]}` : "Arrange note";
    aspect = layout.aspect || screenAspect;
    work = layout.blocks.map((b) => ({ ...b }));
    parked = (layout.hidden || []).map((b) => ({ ...b }));
    newTexts = {};
    selected = -1;
    arranger.classList.add("open");
    requestAnimationFrame(() => { sizeArFrame(); drawShapes(); measurePictures(); });
  }
  const closeArranger = () => {
    if (!arranger.classList.contains("open")) return;
    arranger.classList.remove("open");
    [...work, ...parked].forEach((b) => b.preview && URL.revokeObjectURL(b.preview));
    work = []; parked = [];
  };
  // frame as wide as the stage; height = aspect × width (the stage scrolls when that's tall)
  function sizeArFrame() {
    const w = Math.max(200, arStage.clientWidth - 28);
    arFrame.style.width = `${w}px`; arFrame.style.height = `${w * aspect}px`;
    arGrow.style.width = `${w}px`;
    arFold.style.top = `${(screenAspect / aspect) * 100}%`;
    arFold.hidden = aspect <= screenAspect + 0.001;
  }

  // drag the bar under the frame: taller/shorter frame; shapes keep their place on the page
  arGrow.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    arGrow.setPointerCapture(e.pointerId);
    const startY = e.clientY, startAspect = aspect, w = arFrame.clientWidth;
    // can't shrink past the lowest shape's bottom edge
    const lowest = Math.max(...work.map((b) => (b.y + b.h) * startAspect));
    const move = (m) => {
      const next = clamp(startAspect + (m.clientY - startY) / w, Math.max(0.2, lowest), 20);
      const k = aspect / next;
      [...work, ...parked].forEach((b) => { b.y *= k; b.h *= k; });
      aspect = next;
      sizeArFrame(); placeShapes();
    };
    const up = () => { arGrow.removeEventListener("pointermove", move); arGrow.removeEventListener("pointerup", up); drawShapes(); };
    arGrow.addEventListener("pointermove", move);
    arGrow.addEventListener("pointerup", up);
  });

  function placeShapes() {
    arFrame.querySelectorAll(".ar-shape").forEach((s, i) => {
      const b = work[i];
      s.style.left = `${b.x * 100}%`; s.style.top = `${b.y * 100}%`; s.style.width = `${b.w * 100}%`; s.style.height = `${b.h * 100}%`;
    });
  }

  function drawShapes() {
    arFrame.replaceChildren(arFold, ...work.map((b, i) => {
      const s = document.createElement("div");
      s.className = `ar-shape ar-${b.kind}` + (i === selected ? " selected" : "");
      s.style.zIndex = i + 1;
      if (b.kind === "image") s.style.transform = `rotate(${b.rotate || 0}deg)`;   // the box turns with the picture
      if (b.kind === "image") {   // the box itself stands for the picture; its turn shows as text + a round handle
        const angle = document.createElement("span");
        angle.className = "ar-angle"; angle.textContent = `↻ ${Math.round(b.rotate || 0)}°`;
        const turn = document.createElement("span");
        turn.className = "ar-rotate"; turn.title = "Drag to rotate (snaps to 15°; hold Shift for any angle)";
        turn.addEventListener("pointerdown", (e) => startRotate(e, i, s, angle));
        s.append(angle, turn);
      }
      const label = document.createElement("span");
      label.className = "ar-label"; label.textContent = `${i + 1}. ${labelOf(b)}`;
      const handle = document.createElement("span");
      handle.className = "ar-handle";
      const bin = document.createElement("button");
      bin.type = "button"; bin.className = "ar-trash"; bin.title = "Take out of the frame (kept in the side list)";
      bin.innerHTML = TRASH_SVG;
      bin.addEventListener("pointerdown", (e) => e.stopPropagation());
      bin.addEventListener("click", (e) => { e.stopPropagation(); parkShape(i); });
      s.append(label, handle, bin);
      s.addEventListener("pointerdown", (e) => startDrag(e, i, e.target === handle));
      return s;
    }));
    placeShapes();
    drawHidden();
    arList.replaceChildren(...work.map((b, i) => {
      const row = document.createElement("div");
      row.className = "ar-row" + (i === selected ? " selected" : "");
      const name = document.createElement("span");
      name.textContent = `${i + 1}. ${labelOf(b)}`;
      name.addEventListener("click", () => { selected = i; drawShapes(); });
      const btn = (txt, title, fn, disabled) => {
        const x = document.createElement("button");
        x.type = "button"; x.className = "ar-mini"; x.textContent = txt; x.title = title; x.disabled = !!disabled;
        x.addEventListener("click", fn);
        return x;
      };
      const move = (d) => () => { const j = i + d; [work[i], work[j]] = [work[j], work[i]]; selected = j; drawShapes(); };
      row.append(name, btn("▲", "Earlier", move(-1), i === 0), btn("▼", "Later", move(1), i === work.length - 1));
      if (b.kind === "image") row.append(btn("↻", "Rotate 90°", () => { b.rotate = (((b.rotate || 0) + 90 + 180) % 360) - 180; drawShapes(); }));
      // × (like the trash can on the shape) takes the part out of the frame into the side list
      row.append(btn("×", "Take out of the frame (kept in the side list)", () => parkShape(i)));
      return row;
    }));
  }

  // parts the note has but this layout doesn't show: the title, any text box. "show" puts one back.
  // The side list of parts that are out of the frame: everything you trashed (kept with its place, size,
  // turn and caption, and saved with the layout as "hidden"), plus parts the note has that were never placed
  // (its title, any text box). "put back" returns a part to the frame.
  function drawHidden() {
    const inFrame = new Set(work.filter((b) => b.kind === "text").map((b) => b.file));
    const parkedFiles = new Set(parked.filter((b) => b.kind === "text").map((b) => b.file));
    const unplaced = [];
    (open.isPage ? ["list", "pins", "line"] : ["title"]).forEach((k) => {
      if (!work.some((b) => b.kind === k) && !parked.some((b) => b.kind === k)) unplaced.push({ kind: k });
    });
    [...Object.keys(open.texts), ...Object.keys(newTexts)].forEach((f) => {
      if (!inFrame.has(f) && !parkedFiles.has(f)) unplaced.push({ kind: "text", file: f });
    });
    const items = [...parked.map((b) => ({ b, saved: true })), ...unplaced.map((b) => ({ b, saved: false }))];
    arHiddenField.hidden = items.length === 0;
    arHidden.replaceChildren(...items.map(({ b, saved }) => {
      const row = document.createElement("div");
      row.className = "ar-row";
      const name = document.createElement("span");
      const words = b.kind === "text" ? ((open.texts[b.file] || newTexts[b.file] || "").replace(/<[^>]+>/g, " ").trim().slice(0, 30) || "empty") : "";
      name.textContent = b.kind === "text" ? `${labelOf(b)}: ${words}` : labelOf(b);
      const show = document.createElement("button");
      show.type = "button"; show.className = "ar-mini ar-show"; show.textContent = "put back";
      show.addEventListener("click", () => {
        if (saved) {   // back where it was, kept inside the frame
          parked.splice(parked.indexOf(b), 1);
          b.h = Math.min(b.h, 1); b.y = clamp(b.y, 0, 1 - b.h); b.x = clamp(b.x, 0, 1 - b.w);
          work.push(b);
        } else {
          const h = Math.min(0.2, 0.2 * screenAspect / aspect);
          work.push({
            title: { kind: "title", x: 0, y: 0, w: 1, h: Math.min(0.13, h) },
            list: { kind: "list", x: 0, y: 0, w: 0.64, h: 1 },
            pins: { kind: "pins", x: 0.68, y: 0, w: 0.32, h: 1 },
            line: { kind: "line", x: 0.655, y: 0, w: 0.01, h: 1 },
          }[b.kind] || { kind: "text", file: b.file, x: 0.05, y: 0.05, w: 0.6, h });
        }
        selected = work.length - 1; drawShapes();
      });
      row.append(name, show);
      return row;
    }));
  }
  // trash a part: out of the frame, into the side list (nothing is deleted)
  function parkShape(i) {
    const [b] = work.splice(i, 1);
    parked.push(b);
    selected = -1; drawShapes();
  }

  // A picture's box height (share of the frame's height) for its width, so it keeps the picture's proportions:
  // height in px = width in px / ratio, and the frame is "aspect" times as tall as it is wide.
  const heightFor = (b) => b.w / (b.ratio * aspect);
  // learn each picture's real proportions (from the file), then make its box match them
  function measurePictures() {
    work.filter((b) => b.kind === "image" && !b.ratio).forEach((b) => {
      const probe = new Image();
      probe.onload = () => {
        if (!probe.naturalWidth || !work.includes(b)) return;
        b.ratio = probe.naturalWidth / probe.naturalHeight;
        b.h = Math.min(heightFor(b), 1 - b.y);
        if (b.h < heightFor(b)) b.w = b.h * b.ratio * aspect;
        drawShapes();
      };
      probe.src = b.preview || noteUrl(open.section, open.meta.id, b.src);
    });
  }

  // turn a picture: angle from the shape's center to the pointer
  function startRotate(e, i, shape, angleLabel) {
    e.preventDefault(); e.stopPropagation();
    selected = i;
    const b = work[i];
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (m) => {
      const r = shape.getBoundingClientRect();
      let deg = Math.atan2(m.clientY - (r.top + r.height / 2), m.clientX - (r.left + r.width / 2)) * 180 / Math.PI + 90;
      if (!m.shiftKey) deg = Math.round(deg / 15) * 15;
      b.rotate = (((Math.round(deg * 10) / 10) + 540) % 360) - 180;
      angleLabel.textContent = `↻ ${Math.round(b.rotate)}°`;
      shape.style.transform = `rotate(${b.rotate}deg)`;
    };
    const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); drawShapes(); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  function startDrag(e, i, resizing) {
    e.preventDefault();
    selected = i;
    const b = work[i], fr = arFrame.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, bx: b.x, by: b.y, bw: b.w, bh: b.h };
    const shape = e.currentTarget;
    shape.setPointerCapture(e.pointerId);
    arFrame.querySelectorAll(".ar-shape").forEach((el, k) => el.classList.toggle("selected", k === i));
    const move = (m) => {
      const dx = (m.clientX - start.x) / fr.width, dy = (m.clientY - start.y) / fr.height;
      if (resizing && b.kind === "image" && b.ratio) {
        // pictures keep their proportions: width follows the drag, height follows the width
        b.w = clamp(start.bw + dx, 0.03, 1 - b.x);
        b.h = heightFor(b);
        if (b.y + b.h > 1) { b.h = 1 - b.y; b.w = b.h * b.ratio * aspect; }
      } else if (resizing) {
        b.w = snap(clamp(start.bw + dx, 0.03, 1 - b.x));
        b.h = snap(clamp(start.bh + dy, 0.02, 1 - b.y));
      } else {
        b.x = snap(clamp(start.bx + dx, 0, 1 - b.w));
        b.y = snap(clamp(start.by + dy, 0, 1 - b.h));
      }
      placeShapes();
    };
    const up = () => { shape.removeEventListener("pointermove", move); shape.removeEventListener("pointerup", up); drawShapes(); };
    shape.addEventListener("pointermove", move);
    shape.addEventListener("pointerup", up);
  }

  const arFile = arranger.querySelector(".ar-add input");
  arFile.addEventListener("change", () => {
    [...arFile.files].forEach((file, k) => {
      work.push({ kind: "image", file, preview: URL.createObjectURL(file), x: 0.65, y: clamp(0.17 + k * 0.05, 0, 0.6), w: 0.3, h: 0.35 / aspect * screenAspect });
    });
    arFile.value = "";
    selected = work.length - 1;
    drawShapes();
    measurePictures();   // then each new picture's box takes the picture's proportions
  });
  arranger.querySelector(".ar-add-text").addEventListener("click", () => {
    const file = newTextFile();
    newTexts[file] = "";
    const h = Math.min(0.25, 0.25 * screenAspect / aspect);
    work.push({ kind: "text", file, x: 0.05, y: clamp(1 - h - 0.02, 0, 1 - h), w: 0.5, h });
    selected = work.length - 1;
    drawShapes();
  });
  arranger.querySelector(".ar-reset").addEventListener("click", () => {
    const images = work.filter((b) => b.kind === "image");
    const extraTexts = work.filter((b) => b.kind === "text" && (open.isPage || b.file !== "body.html"));
    const fresh = open.isPage ? defaultPageLayout().blocks : defaultLayout(images.map((b) => b.src || "")).blocks;
    let k = 0;
    work = fresh.map((b) => (b.kind === "image" ? { ...images[k++], x: b.x, y: b.y, w: b.w, h: b.h } : b));
    if (open.isPage) images.forEach((im, n) => work.push({ ...im, x: 0.05 + n * 0.03, y: 0.05 + n * 0.03 }));   // pages: pictures stay, re-stacked
    extraTexts.forEach((t, n) => work.push({ ...t, x: 0.05 + n * 0.03, y: 0.6 + n * 0.03, w: 0.5, h: 0.2 }));
    aspect = screenAspect;
    work.forEach((b) => { if (b.kind === "image" && b.ratio) b.h = Math.min(heightFor(b), 1 - b.y); });   // keep proportions
    selected = -1; sizeArFrame(); drawShapes();
  });
  arranger.querySelector(".ar-cancel").addEventListener("click", closeArranger);
  arranger.querySelector(".np-close").addEventListener("click", closeArranger);
  arranger.addEventListener("mousedown", (e) => { if (e.target === arranger) closeArranger(); });
  window.addEventListener("resize", () => { if (arranger.classList.contains("open")) { sizeArFrame(); placeShapes(); } });

  arranger.querySelector(".ar-save").addEventListener("click", async () => {
    const { section, meta } = open;
    // upload new pictures first, then save the arrangement
    for (const b of [...work, ...parked]) {
      if (!b.file || b.kind !== "image") continue;
      const src = await uploadImage(section, meta.id, b.file);
      if (!src) return;   // the upload failed (message already shown); keep the popup open
      URL.revokeObjectURL(b.preview);
      b.src = src; delete b.file; delete b.preview;
    }
    const toBox = (b) => {
      const box = { kind: b.kind, x: b.x, y: b.y, w: b.w, h: b.h };
      if (b.kind === "image") {
        box.src = b.src;
        if (b.rotate) box.rotate = b.rotate;
        if (b.caption) box.caption = b.caption;
        if (b.ratio) box.ratio = Math.round(b.ratio * 100000) / 100000;
      }
      if (b.kind === "text") box.file = b.file;
      return box;
    };
    const blocks = work.map(toBox);
    const layout = { blocks };
    if (parked.length) layout.hidden = parked.map(toBox);   // trashed parts, kept to put back later
    if (Math.abs(aspect - screenAspect) > 0.001) layout.aspect = Math.round(aspect * 10000) / 10000;   // taller than the screen: scrolls
    // every text box is kept, shown or hidden; new ones start empty
    const texts = { ...newTexts, ...open.texts };
    meta.layout = layout;
    open.texts = texts;
    clearTimeout(noteSaveTimer);
    if (await saveOpen(open)) { closeArranger(); drawNote(); }
  });

  // ---------- owner: add a note (plus button) ----------
  // A copy of the concept tracker's "New Concept" popup: header + close, Title, Body, tags, Cancel / Save.
  // Left out on purpose: the Obsidian parts (folder search, "Mark as link", "Fill tags").
  // The tracker's folder picker becomes "which of the four boxes"; its two tag rows become one.
  // Pictures picked here are uploaded into the new note's folder and placed in a column on the right.
  const adder = document.createElement("div");
  adder.className = "np-overlay";
  adder.innerHTML = `
    <div class="np-modal" role="dialog" aria-labelledby="npTitle">
      <div class="np-header">
        <div class="np-header-title">
          <h2 id="npTitle">New Note</h2>
          <select id="npSection" aria-label="Goes under">${tabs.map((t) => `<option value="${t.dataset.section}">${t.textContent.trim()}</option>`).join("")}</select>
        </div>
        <button type="button" class="np-close" aria-label="Close">&times;</button>
      </div>
      <div class="np-body">
        <div class="np-field">
          <label for="npTitleInput">Title</label>
          <input type="text" id="npTitleInput" placeholder="Note title" autocomplete="off">
        </div>
        <div class="np-field np-body-field">
          <label for="npBody">Body</label>
          <div id="npBody" class="np-editor" contenteditable="true" data-placeholder="Write the note..."></div>
        </div>
        <div class="np-field np-tags">
          <label>Tags (optional)</label>
          <div class="np-tag-row">
            <span class="np-tag-label">Tags/</span>
            <div class="np-tag-field">
              <input type="text" id="npTagInput" placeholder="Type and press Enter" autocomplete="off">
              <div class="np-chips" id="npChips"></div>
            </div>
          </div>
        </div>
        <div class="np-field np-images">
          <label>Images (optional)</label>
          <div class="np-tag-row">
            <label class="np-btn np-btn-secondary np-pick">Choose images<input type="file" id="npImages" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden></label>
            <div class="np-thumbs" id="npThumbs"></div>
          </div>
        </div>
        <div class="np-error" id="npError">Please fill in a title.</div>
      </div>
      <div class="np-footer">
        <button type="button" class="np-btn np-btn-secondary" id="npCancel">Cancel</button>
        <button type="button" class="np-btn np-btn-primary" id="npSave">Save</button>
      </div>
    </div>`;
  if (isOwner) document.body.appendChild(adder);
  const $ = (id) => adder.querySelector("#" + id);
  const sectionPick = $("npSection"), titleInput = $("npTitleInput"), bodyEditor = $("npBody");
  const tagInput = $("npTagInput"), chipBox = $("npChips"), errorLine = $("npError");
  const imagePick = $("npImages"), thumbs = $("npThumbs");
  let tags = [], newImages = [];

  // same rule as the tracker: tags are lowercase, spaces become dashes ("Voltage Divider" -> "voltage-divider")
  const normalizeTag = (raw) => (raw || "").trim().toLowerCase().replace(/\s+/g, "-");

  function renderChips() {
    chipBox.replaceChildren(...tags.map((tag, i) => {
      const chip = document.createElement("span");
      chip.className = "np-chip";
      const text = document.createElement("span");
      text.textContent = tag;
      const remove = document.createElement("button");
      remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", "Remove tag");
      remove.addEventListener("click", () => { tags.splice(i, 1); renderChips(); });
      chip.append(text, remove);
      return chip;
    }));
  }
  tagInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const tag = normalizeTag(tagInput.value);
    if (tag && !tags.includes(tag)) { tags.push(tag); renderChips(); }
    tagInput.value = "";
  });

  function renderThumbs() {
    thumbs.replaceChildren(...newImages.map((im, i) => {
      const t = document.createElement("span");
      t.className = "np-thumb"; t.style.backgroundImage = `url("${im.preview}")`; t.title = im.file.name;
      const x = document.createElement("button");
      x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "Remove image");
      x.addEventListener("click", () => { URL.revokeObjectURL(im.preview); newImages.splice(i, 1); renderThumbs(); });
      t.append(x);
      return t;
    }));
  }
  imagePick.addEventListener("change", () => {
    for (const file of imagePick.files) newImages.push({ file, preview: URL.createObjectURL(file) });
    imagePick.value = "";
    renderThumbs();
  });

  // Pasting into the Body keeps the formatting (links, headings, lists...), cleaned by cleanHtml.
  // There's no formatting toolbar on purpose: write in Substack (or anywhere), copy, paste here.
  keepFormattingOnPaste(bodyEditor);

  const closeAdder = () => adder.classList.remove("open");
  $("npCancel").addEventListener("click", closeAdder);
  adder.querySelector(".np-close").addEventListener("click", closeAdder);
  adder.addEventListener("mousedown", (e) => { if (e.target === adder) closeAdder(); });   // click outside the popup

  const plus = document.querySelector(".menu-plus");
  if (isOwner && plus) plus.addEventListener("click", () => {
    titleInput.value = ""; bodyEditor.textContent = ""; tags = []; renderChips(); tagInput.value = "";
    newImages.forEach((im) => URL.revokeObjectURL(im.preview)); newImages = []; renderThumbs();
    errorLine.classList.remove("show");
    if (currentSection) sectionPick.value = currentSection;   // default to the box you're looking at
    adder.classList.add("open");
    titleInput.focus();
  });

  let adding = false;
  $("npSave").addEventListener("click", async () => {
    if (adding) return;
    const section = sectionPick.value, title = titleInput.value.trim();
    if (!title) { errorLine.classList.add("show"); titleInput.focus(); return; }
    adding = true;
    try {
      const meta = { id: `${slug(title)}-${Date.now().toString(36)}`, title, created: today(), added: nowStamp(), tags: [...tags] };
      const texts = { "body.html": cleanHtml(bodyEditor.innerHTML) };
      if (!(await saveNote(section, meta, texts))) return;   // makes the note's folder
      if (newImages.length) {
        const srcs = [];
        for (const im of newImages) {
          const src = await uploadImage(section, meta.id, im.file);
          if (src) srcs.push(src);
        }
        meta.layout = defaultLayout(srcs);
        await saveNote(section, meta, texts);
      }
      newImages.forEach((im) => URL.revokeObjectURL(im.preview)); newImages = [];
      closeAdder();
      showSection(section);   // jump to where it went
    } finally { adding = false; }
  });

  // ---------- owner: delete a note (trash), with the tracker's "are you sure" popup ----------
  const confirmBox = document.createElement("div");
  confirmBox.className = "np-overlay";
  confirmBox.innerHTML = `
    <div class="np-modal np-confirm" role="dialog" aria-labelledby="npDelTitle">
      <div class="np-header"><h2 id="npDelTitle">Delete this note?</h2></div>
      <div class="np-body"></div>
      <div class="np-footer">
        <button type="button" class="np-btn np-btn-secondary" id="npKeep">Keep</button>
        <button type="button" class="np-btn np-btn-danger" id="npDelete">Delete</button>
      </div>
    </div>`;
  if (isOwner) document.body.appendChild(confirmBox);
  let pendingDelete = null;
  const closeConfirm = () => { confirmBox.classList.remove("open"); pendingDelete = null; };
  function askDelete(section, item) {
    pendingDelete = { section, item };
    confirmBox.querySelector(".np-body").textContent =
      `"${item.title}" will be removed from ${names[section]}. Its folder is moved to notes/.trash, not erased.`;
    confirmBox.classList.add("open");
  }
  confirmBox.querySelector("#npKeep").addEventListener("click", closeConfirm);
  confirmBox.addEventListener("mousedown", (e) => { if (e.target === confirmBox) closeConfirm(); });
  confirmBox.querySelector("#npDelete").addEventListener("click", async () => {
    if (!pendingDelete) return closeConfirm();
    const { section, item } = pendingDelete;
    closeConfirm();
    const r = await post("/delete-note", { section, id: item.id });
    if (r) { content.sections = r.index.sections; say("deleted"); showSection(section); }
  });

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeAdder(); closeConfirm(); closeArranger(); } });

  // ---------- load ----------
  fetch("content.json", { cache: "no-store" })
    .then((r) => r.json())
    .then((data) => {
      content = data;
      for (const key of Object.keys(names)) content.sections[key] = content.sections[key] || [];
    })
    .catch(() => {})   // no content.json yet
    .finally(() => showBio());   // the page opens on the Bio
})();
