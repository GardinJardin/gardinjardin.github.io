// Pixel-art portal. Every frame:
//  1. find which background-grid squares the portal's box covers (same square size as bubbles.js),
//  2. draw portal.png, rotated to the current spin angle, into a tiny canvas with ONE pixel per square
//     (the browser averages each square's area into that one pixel's color),
//  3. make each pixel fully solid or fully see-through (no half-faded edge pixels), then paint the gold/white splotches,
//  4. blow the tiny canvas up so each pixel is one square, with no blurring, lined up with the background grid.
(() => {
  const box = document.getElementById("portal");
  const img = box.querySelector("img");
  const view = box.querySelector(".portal-pixels");
  const viewCtx = view.getContext("2d");
  const tiny = document.createElement("canvas");
  const tinyCtx = tiny.getContext("2d", { willReadFrequently: true });

  const root = getComputedStyle(document.documentElement);
  const size = parseFloat(root.getPropertyValue("--bubble-size"));            // one pixel = one background square
  const spinSeconds = parseFloat(root.getPropertyValue("--portal-spin-seconds")) || 0;
  const still = spinSeconds === 0 || matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- Splotches: short gold or white arcs that grow pixel by pixel, ride the spin, then shrink away ----
  // Life of one splotch:
  //   1. GROW:   one random portal pixel turns gold (or white); then, every step, the next pixel ahead of it
  //              around the circle (in the spin direction) turns too, until the chain is 3-5 pixels long.
  //   2. RIDE:   the finished chain travels round and round with the portal's spin for a few seconds.
  //   3. SHRINK: it stops, and its pixels switch back one at a time, in the reverse order they appeared.
  const read = (name) => root.getPropertyValue(name).trim();
  const num = (name) => parseFloat(read(name));
  const hexToRgb = (hex) => { const n = parseInt(hex.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const splotchColors = [hexToRgb(read("--splotch-gold")), hexToRgb(read("--splotch-white"))];
  const S = {
    max: num("--splotch-max"),                    // most splotches on the portal at once
    perSecond: num("--splotch-per-second"),       // average new splotches per second
    minLength: num("--splotch-min-length"), maxLength: num("--splotch-max-length"),   // pixels in a chain
    stepMs: num("--splotch-step-ms"),             // time between one pixel appearing (or vanishing) and the next
    minRide: num("--splotch-min-ride"), maxRide: num("--splotch-max-ride"),           // seconds riding the spin
  };
  const rand = (a, b) => a + Math.random() * (b - a);
  const spinRate = still ? 0 : (2 * Math.PI) / spinSeconds;   // radians per second, same as the portal
  // Where a splotch sits: "dist" = distance from the portal's center as a share of its radius (0..1),
  // "angle" = direction from the center, in radians. Shares of the radius keep it right when the portal is resized.
  let splotches = [], lastTime = null;

  // Where a chain's pixels sit, in "radius units" (portal radius = 1), for spacing math.
  // Pixel k sits one square further along the ring than pixel k-1, in the spin direction.
  function chainPoints(dist, angle, count, R) {
    const step = size / Math.max(dist * R, size);   // radians that move one square along this ring
    return Array.from({ length: count }, (_, k) => [dist * Math.cos(angle - k * step), dist * Math.sin(angle - k * step)]);
  }

  // Spacing, in two steps:
  //  1. pick the ring (distance from the center) at random, spread evenly over the portal's area,
  //     so splotches land at every depth, not all on one circle;
  //  2. along that ring, try many spots and keep the one whose whole future chain sits farthest from
  //     every pixel of the splotches already on the portal.
  // (Choosing the ring by "farthest" too would push every splotch to the outer edge, where there's most room.)
  function spawn(now, R) {
    const length = Math.round(rand(S.minLength - 0.5, S.maxLength + 0.5));
    const dist = Math.sqrt(rand(0.2 ** 2, 0.85 ** 2));   // square root = even over area, not bunched at the center
    const taken = splotches.flatMap((o) => chainPoints(o.dist, o.angle, o.length, R));
    let best = null, bestGap = -1;
    for (let c = 0; c < (taken.length ? 120 : 1); c++) {
      const angle = Math.random() * 2 * Math.PI;
      let gap = Infinity;
      for (const [x, y] of chainPoints(dist, angle, length, R))
        for (const [tx, ty] of taken) gap = Math.min(gap, (x - tx) ** 2 + (y - ty) ** 2);
      if (gap > bestGap) { bestGap = gap; best = { dist, angle }; }
    }
    splotches.push({
      dist: best.dist, angle: best.angle, length,
      color: splotchColors[Math.random() < 0.5 ? 0 : 1],
      phase: "grow", shown: 1, nextStep: now + S.stepMs, rideUntil: 0,
    });
  }

  function updateSplotches(now, R) {
    const dt = lastTime === null ? 0 : Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    for (const s of splotches) {
      if (s.phase === "ride") {
        s.angle -= spinRate * dt;   // minus = counter-clockwise on screen, matching the portal
        if (now >= s.rideUntil) { s.phase = "shrink"; s.nextStep = now + S.stepMs; }
      } else if (now >= s.nextStep) {
        s.nextStep = now + S.stepMs;
        if (s.phase === "grow" && ++s.shown >= s.length) { s.phase = "ride"; s.rideUntil = now + rand(S.minRide, S.maxRide) * 1000; }
        else if (s.phase === "shrink") s.shown--;
      }
    }
    splotches = splotches.filter((s) => s.shown > 0);
    if (splotches.length < S.max && Math.random() < S.perSecond * dt) spawn(now, R);
  }

  // Turn each splotch's pixels into grid squares and recolor them (only squares that are part of the portal).
  function paintSplotches(px, cols, rows, x0, y0, r) {
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.width / 2;
    for (const s of splotches) {
      for (const [ux, uy] of chainPoints(s.dist, s.angle, s.shown, R)) {
        const i = Math.floor((cx + ux * R - x0) / size), j = Math.floor((cy + uy * R - y0) / size);
        if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
        const p = (j * cols + i) * 4;
        if (px.data[p + 3] === 0) continue;            // never on the background
        px.data[p] = s.color[0]; px.data[p + 1] = s.color[1]; px.data[p + 2] = s.color[2];
      }
    }
  }

  // ---- Zoom into the portal (starts when the portal is clicked) ----
  // The portal is redrawn bigger and bigger, and its center slides to the middle of the screen. Every square
  // samples the portal a little closer to its center than a moment before, so each ring takes on the colors
  // of the ring inside it and the green frontier spreads over the blue squares one ring at a time.
  // It ends with the whole portal filling the screen: its outermost ring at the screen's corners,
  // its center at the screen's center, every ring in between in proportion.
  const zoomSeconds = parseFloat(root.getPropertyValue("--zoom-seconds")) || 5;
  let zoomStart = null, zoomEnd = 1, startCenter = null;

  // The portal's edge is wobbly. Find the smallest distance from the center to the edge of the solid
  // drawing (as a share of the radius), so at the end that edge still covers every corner: no blue left.
  let rimShare = 0.85;
  function measureRim() {
    const c = document.createElement("canvas"), n = 200;
    c.width = c.height = n;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0, n, n);
    const a = g.getImageData(0, 0, n, n).data;
    let smallest = 1;
    for (let k = 0; k < 360; k += 2) {
      const ang = (k * Math.PI) / 180;
      let edge = 0;
      for (let d = 0; d < 1; d += 0.005) {
        const x = Math.round(n / 2 + d * (n / 2) * Math.cos(ang)), y = Math.round(n / 2 + d * (n / 2) * Math.sin(ang));
        if (x < 0 || y < 0 || x >= n || y >= n) break;
        if (a[(y * n + x) * 4 + 3] >= 128) edge = d;
      }
      smallest = Math.min(smallest, edge);
    }
    rimShare = Math.max(0.5, smallest - 0.01);
  }

  const progress = (now) => (zoomStart === null ? 0 : Math.min(1, Math.max(0, (now - zoomStart) / (zoomSeconds * 1000))));
  const ease = (t) => t * t * (3 - 2 * t);   // slow start, slow finish, for the slide to the screen's center

  // Enter the portal: zoom over zoomSeconds, or jump straight to the end (instant = true).
  function enterPortal(instant) {
    if (zoomStart !== null) return;
    const r = img.getBoundingClientRect();
    startCenter = [r.left + r.width / 2, r.top + r.height / 2];
    // at the end the center is the screen's middle; the rim has to reach a corner (half the screen's diagonal)
    zoomEnd = Math.hypot(innerWidth, innerHeight) / 2 / (rimShare * r.width / 2);
    zoomStart = performance.now();
    document.body.classList.add("portal-entered");   // lets the page fade the title out
    if (instant || still) { zoomStart -= zoomSeconds * 1000; draw(performance.now()); }   // jump to the end
  }
  view.addEventListener("click", () => enterPortal(false));

  function draw(now) {
    const r = img.getBoundingClientRect();
    if (!img.complete || r.width === 0) return;

    // The portal as currently drawn: scaled up (steady zoom rate) and sliding toward the screen's center
    const t = progress(now);
    if (t >= 1 && !document.body.classList.contains("portal-arrived")) document.body.classList.add("portal-arrived");   // show the page inside
    const z = Math.pow(zoomEnd, t);
    const home = [r.left + r.width / 2, r.top + r.height / 2];
    const from = startCenter || home, e = ease(t);
    const cx = from[0] + (innerWidth / 2 - from[0]) * e, cy = from[1] + (innerHeight / 2 - from[1]) * e;
    const v = { width: r.width * z, height: r.height * z };
    v.left = cx - v.width / 2; v.top = cy - v.height / 2; v.right = v.left + v.width; v.bottom = v.top + v.height;

    // 1. grid squares the portal covers, clipped to the screen (the background grid starts at 0,0)
    const left = Math.max(v.left, 0), top = Math.max(v.top, 0);
    const right = Math.min(v.right, innerWidth), bottom = Math.min(v.bottom, innerHeight);
    const x0 = Math.floor(left / size) * size, y0 = Math.floor(top / size) * size;
    const cols = Math.max(1, Math.ceil((right - x0) / size)), rows = Math.max(1, Math.ceil((bottom - y0) / size));

    // 2. rotated portal into the tiny canvas, one pixel per square
    tiny.width = cols; tiny.height = rows;
    tinyCtx.imageSmoothingEnabled = true; tinyCtx.imageSmoothingQuality = "high";
    tinyCtx.setTransform(1 / size, 0, 0, 1 / size, -x0 / size, -y0 / size);   // screen px -> tiny px
    tinyCtx.translate(cx, cy);
    tinyCtx.rotate(still ? 0 : -(now / 1000 / spinSeconds) * 2 * Math.PI);   // counter-clockwise, like before
    tinyCtx.drawImage(img, -v.width / 2, -v.height / 2, v.width, v.height);

    // 3. solid or see-through, nothing in between; then the splotches (they zoom with the portal)
    const px = tinyCtx.getImageData(0, 0, cols, rows);
    for (let i = 3; i < px.data.length; i += 4) px.data[i] = px.data[i] >= 128 ? 255 : 0;
    if (!still) { updateSplotches(now, v.width / 2); paintSplotches(px, cols, rows, x0, y0, v); }
    tinyCtx.putImageData(px, 0, 0);

    // 4. one tiny pixel -> one square, crisp, positioned on the background grid
    const dpr = window.devicePixelRatio || 1;
    const w = cols * size, h = rows * size;
    if (view.width !== Math.round(w * dpr) || view.height !== Math.round(h * dpr)) {
      view.width = Math.round(w * dpr); view.height = Math.round(h * dpr);
    }
    view.style.width = w + "px"; view.style.height = h + "px";
    view.style.left = (x0 - r.left) + "px"; view.style.top = (y0 - r.top) + "px";
    viewCtx.imageSmoothingEnabled = false;
    viewCtx.clearRect(0, 0, view.width, view.height);
    viewCtx.drawImage(tiny, 0, 0, view.width, view.height);
  }

  function loop(now) { draw(now); requestAnimationFrame(loop); }

  const start = () => {
    measureRim();
    if (window.SKIP_INTRO) enterPortal(true);   // dev shortcut set in index.html: open already inside the portal
    still ? draw(performance.now()) : requestAnimationFrame(loop);
  };
  if (img.complete) start(); else img.addEventListener("load", start);
  if (still) window.addEventListener("resize", () => draw(performance.now()));   // the moving version redraws every frame anyway
})();
