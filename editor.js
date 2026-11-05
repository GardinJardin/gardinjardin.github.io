// Layout editor. Loaded only on localhost (see the bottom of index.html), so the live site never runs it.
// Click "Edit layout", then drag any image to move it, or drag the square in its corner to resize it.
// Every change is sent to dev-server.py, which rewrites layout.css. Refresh-safe: the page reads layout.css.
(() => {
  const css = document.createElement("style");
  css.textContent = `
    .editing .movable { outline: 2px dashed var(--editor-outline); cursor: move; touch-action: none; }
    .editing .movable img { pointer-events: none; }
    .resize-handle { display: none; position: absolute; right: -7px; bottom: -7px; width: 14px; height: 14px;
                     background: var(--editor-handle); cursor: nwse-resize; }
    .editing .resize-handle { display: block; }
    #editor-bar { position: fixed; top: 12px; left: 12px; z-index: 10; display: flex; gap: 8px; align-items: center;
                  font: 14px system-ui, sans-serif; color: var(--editor-button-text); }
    #editor-bar button { background: var(--editor-button-background); color: var(--editor-button-text);
                         border: 0; border-radius: 6px; padding: 7px 12px; cursor: pointer; font: inherit; }
  `;
  document.head.appendChild(css);

  const bar = document.createElement("div");
  bar.id = "editor-bar";
  bar.innerHTML = '<button type="button">Edit layout</button><span></span>';
  document.body.appendChild(bar);
  const button = bar.querySelector("button"), status = bar.querySelector("span");
  button.onclick = () => {
    const on = document.body.classList.toggle("editing");
    button.textContent = on ? "Done editing" : "Edit layout";
  };

  const vw = () => window.innerWidth / 100, vh = () => window.innerHeight / 100;
  const round = (n) => Math.round(n * 10) / 10;

  async function save() {
    const layout = {};
    document.querySelectorAll(".movable").forEach((el) => {
      layout[el.id] = {
        left: round(el.offsetLeft / vw()),
        top: round(el.offsetTop / vh()),
        width: round(el.offsetWidth / vw()),
      };
    });
    try {
      const r = await fetch("save-layout", { method: "POST", body: JSON.stringify(layout) });
      status.textContent = r.ok ? "saved" : "save failed (is dev-server.py running?)";
    } catch {
      status.textContent = "save failed (is dev-server.py running?)";
    }
    setTimeout(() => (status.textContent = ""), 1500);
  }

  document.querySelectorAll(".movable").forEach((el) => {
    const handle = document.createElement("div");
    handle.className = "resize-handle";
    el.appendChild(handle);

    el.addEventListener("pointerdown", (e) => {
      if (!document.body.classList.contains("editing")) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const resizing = e.target === handle;
      const start = { x: e.clientX, y: e.clientY, left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth };

      const move = (m) => {
        const dx = m.clientX - start.x, dy = m.clientY - start.y;
        if (resizing) {
          el.style.width = Math.max(40, start.width + dx) / vw() + "vw";
        } else {
          el.style.left = (start.left + dx) / vw() + "vw";
          el.style.top = (start.top + dy) / vh() + "vh";
        }
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        save();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
  });
})();
