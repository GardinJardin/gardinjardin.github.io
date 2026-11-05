// After the portal zoom: every part of the page appears at the same time, square by square, from its bottom edge up.
// How it works, without copying or replacing any part of the page:
//  1. each part is cut into a grid of small squares (--materialize-pixel);
//  2. every square gets a moment to switch on: lower rows earlier, higher rows later, plus a little randomness,
//     so the part fills upward in a ragged, pixel-by-pixel front instead of a clean wipe;
//  3. each part wears a stencil (clip-path) that shows only the squares switched on so far;
//  4. when all of a part's squares are on, the stencil comes off and the part is back to normal.
(() => {
  const PARTS = ".icon-ribbon .social-link, #home-title, .section-tab, .divider-horizontal, " +
    ".note-view:not([hidden]) .note-block:not([hidden]), .page-view .note-block:not([hidden]), .note-edit-bar, .note-tags, .menu";
  const HIDDEN = "polygon(0 0, 0 0, 0 0)";   // a stencil with no area: nothing shows

  const visible = (el) => el.getClientRects().length > 0;

  function materialize() {
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = getComputedStyle(document.documentElement);
    const px = parseFloat(root.getPropertyValue("--materialize-pixel")) || 14;                    // side of one square
    const fillMs = (parseFloat(root.getPropertyValue("--materialize-seconds")) || 0.7) * 1000;    // bottom row → top row
    const raggedMs = parseFloat(root.getPropertyValue("--materialize-ragged")) || 250;             // randomness per square

    // Grid every visible part into squares (with one square of margin, so glows outside the box come along)
    const parts = [...document.querySelectorAll(PARTS)].filter(visible).map((el) => {
      const r = el.getBoundingClientRect();
      const cols = Math.ceil((r.width + 2 * px) / px), rows = Math.ceil((r.height + 2 * px) / px);
      const squares = [];
      for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
        const fromBottom = (rows - 1 - row) / Math.max(rows - 1, 1);   // 0 = bottom row, 1 = top row
        squares.push({ row, col, at: fromBottom * fillMs + Math.random() * raggedMs });
      }
      squares.sort((a, b) => a.at - b.at);   // in switch-on order, so each frame only looks at the next few
      el.style.clipPath = HIDDEN;           // set before the first paint, so the part never flashes in
      return { el, cols, rows, squares, next: 0, grid: new Uint8Array(cols * rows) };
    });
    if (!parts.length) return;

    // The stencil for one part: every square that's on, merged into runs along each row so the shape stays short
    function stencil(p) {
      let d = "";
      for (let row = 0; row < p.rows; row++) {
        let col = 0;
        while (col < p.cols) {
          if (!p.grid[row * p.cols + col]) { col++; continue; }
          const start = col;
          while (col < p.cols && p.grid[row * p.cols + col]) col++;
          d += `M${start * px - px} ${row * px - px}h${(col - start) * px}v${px}h${-(col - start) * px}Z`;
        }
      }
      return d ? `path("${d}")` : HIDDEN;
    }

    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      parts.forEach((p) => { p.el.style.clipPath = ""; });
    }

    const t0 = performance.now();
    function frame(now) {
      if (finished) return;
      const t = now - t0;
      let busy = false;
      for (const p of parts) {
        if (p.next >= p.squares.length) continue;
        const before = p.next;
        while (p.next < p.squares.length && p.squares[p.next].at <= t) {
          const s = p.squares[p.next++];
          p.grid[s.row * p.cols + s.col] = 1;
        }
        if (p.next !== before) p.el.style.clipPath = p.next < p.squares.length ? stencil(p) : "";   // all on: stencil off
        if (p.next < p.squares.length) busy = true;
      }
      if (busy) requestAnimationFrame(frame); else finish();
    }
    requestAnimationFrame(frame);
    setTimeout(finish, fillMs + raggedMs + 1000);   // safety: nothing stays hidden, whatever happens
  }

  // portal-pixels.js adds "portal-arrived" when the zoom ends; this runs before the browser paints that frame
  new MutationObserver((_, obs) => {
    if (document.body.classList.contains("portal-arrived")) { obs.disconnect(); materialize(); }
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
})();
