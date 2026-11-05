// Bubbling background. Draws a grid of squares on the #bubbles canvas behind the page.
// Every square holds one shade, then after its own random wait jumps to another random shade.
// All settings (colors, how many shades, square size, wait times) live in the :root block of index.html.
(() => {
  const canvas = document.getElementById("bubbles");
  const ctx = canvas.getContext("2d");
  const root = getComputedStyle(document.documentElement);
  const read = (name) => root.getPropertyValue(name).trim();

  // Settings from the palette
  const hexToRgb = (hex) => {
    const n = parseInt(hex.replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const dark = hexToRgb(read("--bubble-darkest"));
  const bright = hexToRgb(read("--bubble-brightest"));
  const steps = Math.max(2, parseInt(read("--bubble-shades"), 10));
  const size = parseFloat(read("--bubble-size"));
  const minWait = parseFloat(read("--bubble-min-wait"));
  const maxWait = parseFloat(read("--bubble-max-wait"));
  const minFlickers = parseInt(read("--bubble-min-flickers"), 10);
  const maxFlickers = parseInt(read("--bubble-max-flickers"), 10);
  const flickerMin = parseFloat(read("--bubble-flicker-min"));
  const flickerMax = parseFloat(read("--bubble-flicker-max"));

  // The shades: evenly spaced in a straight line from darkest to brightest
  const shades = Array.from({ length: steps }, (_, i) => {
    const t = i / (steps - 1);
    const c = dark.map((d, k) => Math.round(d + (bright[k] - d) * t));
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  });

  const randomShade = () => Math.floor(Math.random() * steps);
  const randomWait = () => minWait + Math.random() * (maxWait - minWait);
  const randomFlicker = () => flickerMin + Math.random() * (flickerMax - flickerMin);
  // Flickers are counted as individual swaps, so an even number would end on the old shade: force it odd
  const randomFlickerCount = () => {
    const n = minFlickers + Math.floor(Math.random() * (maxFlickers - minFlickers + 1));
    return n === 0 ? 0 : n * 2 - 1;
  };

  // Per square: shadeOf = color showing now, otherShade = the color it's flickering against,
  // flickersLeft = swaps remaining in the current stutter (0 = settled), nextChange = when it acts next
  let cols, rows, shadeOf, otherShade, flickersLeft, nextChange;

  // Start each square at a random point in its cycle (bubble, then hold), so the grid never moves in sync.
  // The chance of starting mid-bubble matches the share of the cycle spent bubbling.
  const avgBubbleTime = ((minFlickers + maxFlickers) - 1) * (flickerMin + flickerMax) / 2;
  const avgHold = (minWait + maxWait) / 2;
  const bubbleShare = avgBubbleTime / (avgBubbleTime + avgHold);

  function startAtRandomStage(i, now) {
    if (maxFlickers > 0 && Math.random() < bubbleShare) {
      // mid-bubble: flickering against another shade, some swaps already done
      let other = randomShade();
      while (other === shadeOf[i]) other = randomShade();
      otherShade[i] = other;
      flickersLeft[i] = 1 + Math.floor(Math.random() * randomFlickerCount());
      if (flickersLeft[i] % 2 === 0) {   // keep the stutter ending on the shade it's moving to
        const t = shadeOf[i]; shadeOf[i] = otherShade[i]; otherShade[i] = t;
      }
      nextChange[i] = now + Math.random() * randomFlicker();
    } else {
      // holding: anywhere from "just started the 2 s wait" to "about to change"
      flickersLeft[i] = 0;
      nextChange[i] = now + Math.random() * randomWait();
    }
  }

  function drawSquare(i) {
    ctx.fillStyle = shades[shadeOf[i]];
    ctx.fillRect((i % cols) * size, Math.floor(i / cols) * size, size, size);
  }

  // Build the grid to cover the screen (rebuilt when the window changes size)
  function setup() {
    const dpr = window.devicePixelRatio || 1;   // sharp squares on high-resolution screens
    canvas.width = Math.ceil(window.innerWidth * dpr);
    canvas.height = Math.ceil(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(window.innerWidth / size);
    rows = Math.ceil(window.innerHeight / size);
    const now = performance.now();
    shadeOf = new Uint8Array(cols * rows);
    otherShade = new Uint8Array(cols * rows);
    flickersLeft = new Uint8Array(cols * rows);
    nextChange = new Float64Array(cols * rows);
    for (let i = 0; i < cols * rows; i++) {
      shadeOf[i] = randomShade();
      startAtRandomStage(i, now);
      drawSquare(i);
    }
  }

  // Each frame: only squares whose timer ran out act and get redrawn.
  // A settled square picks a new shade and starts a stutter: old, new, old, new... ending on new.
  function tick(now) {
    for (let i = 0; i < shadeOf.length; i++) {
      if (now < nextChange[i]) continue;
      if (flickersLeft[i] === 0) {
        let next = randomShade();
        while (next === shadeOf[i]) next = randomShade();   // a change has to be a visible change
        otherShade[i] = shadeOf[i];
        shadeOf[i] = next;
        flickersLeft[i] = randomFlickerCount();
        if (flickersLeft[i] === 0) { nextChange[i] = now + randomWait(); drawSquare(i); continue; }
      } else {
        const t = shadeOf[i]; shadeOf[i] = otherShade[i]; otherShade[i] = t;   // swap: one flicker
      }
      flickersLeft[i]--;
      nextChange[i] = now + (flickersLeft[i] === 0 ? randomWait() : randomFlicker());
      drawSquare(i);
    }
    requestAnimationFrame(tick);
  }

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(setup, 150);
  });

  setup();
  // People whose system asks for reduced motion get a still grid
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) requestAnimationFrame(tick);
})();
