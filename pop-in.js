// After the portal zoom: every part of the page pops onto the screen in a random order (new every visit),
// following the beats below: one pop, a second pop, one more, then three in a quick burst, then all the rest.
(() => {
  // Each beat: how many parts pop at once ("rest" = everything left), then how long (ms) until the next beat.
  const BEATS = [
    { pop: 1, wait: 350 },       // one pop
    { pop: 1, wait: 350 },       // a second
    { pop: 1, wait: 300 },       // one more...
    { pop: 1, wait: 70 },        // ...then three, rapidly
    { pop: 1, wait: 70 },
    { pop: 1, wait: 220 },
    { pop: "rest", wait: 0 },    // then the rest, all at once
  ];
  const PARTS = ".icon-ribbon .social-link, #home-title, .section-tab, .divider-horizontal, " +
    ".note-view:not([hidden]) .note-block:not([hidden]), .page-view .note-block:not([hidden]), .note-edit-bar, .note-tags, .menu";

  const visible = (el) => el.getClientRects().length > 0;
  function popIn() {
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const parts = [...document.querySelectorAll(PARTS)].filter(visible);
    for (let i = parts.length - 1; i > 0; i--) {   // shuffle: a random order every time
      const j = Math.floor(Math.random() * (i + 1));
      [parts[i], parts[j]] = [parts[j], parts[i]];
    }
    parts.forEach((el) => el.classList.add("pop-wait"));   // hidden until its turn (set before the page is painted)
    let at = 0, i = 0;
    for (const beat of BEATS) {
      if (i >= parts.length) break;
      const batch = parts.slice(i, beat.pop === "rest" ? parts.length : i + beat.pop);
      setTimeout(() => batch.forEach((el) => {
        el.classList.remove("pop-wait");
        el.classList.add("pop");
        el.addEventListener("animationend", () => el.classList.remove("pop"), { once: true });
      }), at);
      i += batch.length; at += beat.wait;
    }
    if (i < parts.length) setTimeout(() => parts.slice(i).forEach((el) => el.classList.remove("pop-wait")), at);   // safety: nothing stays hidden
  }
  // portal-pixels.js adds "portal-arrived" when the zoom ends; this runs before the browser paints that frame
  new MutationObserver((_, obs) => {
    if (document.body.classList.contains("portal-arrived")) { obs.disconnect(); popIn(); }
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
})();
