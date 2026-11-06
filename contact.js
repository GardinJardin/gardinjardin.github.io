// Message box: the round speech-bubble button (bottom right menu) opens a popup where a visitor writes to you.
// The message goes to Web3Forms (a free service, 250 messages a month), which emails it to the address you
// signed up with. Your email never appears in the page: only the access key below does.
// Setup: sign up at https://web3forms.com with YOUR email, copy the access key it emails you, paste it here.
(() => {
  const ACCESS_KEY = "62a59ae0-f048-4c06-8738-3af147fe8fe0";
  const SUBJECT = "New message from gardinjardin.github.io";

  const button = document.querySelector(".menu-message");
  if (!button) return;

  // The popup: same look as the add-note popup (np-* styles in index.html)
  const overlay = document.createElement("div");
  overlay.className = "np-overlay contact-overlay";
  overlay.innerHTML = `
    <form class="np-modal contact-modal" novalidate>
      <div class="np-header">
        <div class="np-header-title"><h2>Send me a message(note that after 250 messages the email service auto shuts off)</h2></div>
        <button type="button" class="np-btn np-btn-secondary contact-style" aria-pressed="false">Make it boring</button>
        <button type="button" class="np-close" aria-label="Close">✕</button>
      </div>
      <div class="np-body">
        <div class="np-field">
          <label for="contact-name">Name</label>
          <input type="text" id="contact-name" name="name" maxlength="120" placeholder="Your name" autocomplete="name">
        </div>
        <div class="np-field">
          <label for="contact-email">Your email (optional, so I can reply)</label>
          <input type="text" id="contact-email" name="email" inputmode="email" maxlength="200" placeholder="you@example.com" autocomplete="email">
        </div>
        <div class="np-field np-body-field">
          <label for="contact-message">Message</label>
          <textarea id="contact-message" name="message" maxlength="5000" placeholder="What's on your mind?"></textarea>
        </div>
        <!-- spam trap: hidden from people, bots tick it, Web3Forms drops anything that has it ticked -->
        <input type="checkbox" name="botcheck" class="contact-trap" tabindex="-1" autocomplete="off" aria-hidden="true">
        <p class="np-error contact-status" role="status"></p>
      </div>
      <div class="np-footer">
        <button type="button" class="np-btn np-btn-secondary contact-cancel">Cancel</button>
        <button type="submit" class="np-btn np-btn-primary contact-send">Send</button>
      </div>
    </form>`;
  document.body.appendChild(overlay);

  const form = overlay.querySelector("form");
  const status = overlay.querySelector(".contact-status");
  const send = overlay.querySelector(".contact-send");
  // Look: the site's pixel font and neon colors by default; "Make it boring" switches to the plain popup look.
  // The visitor's choice is remembered in their browser (if the browser allows it).
  const styleButton = overlay.querySelector(".contact-style");
  function setBoring(boring) {
    overlay.classList.toggle("contact-fun", !boring);
    styleButton.textContent = boring ? "Make it fun" : "Make it boring";
    styleButton.setAttribute("aria-pressed", String(boring));
    try { localStorage.setItem("contact-boring", boring ? "1" : "0"); } catch (e) {}
  }
  let startBoring = false;
  try { startBoring = localStorage.getItem("contact-boring") === "1"; } catch (e) {}
  setBoring(startBoring);
  styleButton.addEventListener("click", () => setBoring(overlay.classList.contains("contact-fun")));

  const say = (text, ok) => { status.textContent = text; status.classList.add("show"); status.classList.toggle("contact-ok", !!ok); };

  function open() {
    overlay.classList.add("open");
    status.classList.remove("show");
    setTimeout(() => form.elements.name.focus(), 0);
  }
  function close() { overlay.classList.remove("open"); }

  button.addEventListener("click", open);
  overlay.querySelector(".np-close").addEventListener("click", close);
  overlay.querySelector(".contact-cancel").addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });   // click outside closes
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay.classList.contains("open")) close(); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    const email = form.elements.email.value.trim();
    const message = form.elements.message.value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return say("That email doesn't look right. Fix it, or leave it empty.");
    if (!message) return say("Please write a message.");
    if (ACCESS_KEY.startsWith("PASTE")) return say("The message box isn't switched on yet. Try again soon.");

    send.disabled = true; send.textContent = "Sending...";
    try {
      const res = await fetch("https://api.web3forms.com/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          access_key: ACCESS_KEY, subject: SUBJECT, from_name: name || "Website visitor",
          name, ...(email ? { email } : {}), message, botcheck: form.elements.botcheck.checked,   // no email = no reply-to
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.message || res.status);
      form.reset();
      say("Sent! Too late for takebacks.", true);
      setTimeout(close, 1800);
    } catch (err) {
      say("Send failed, for some reason idk");
    } finally {
      send.disabled = false; send.textContent = "Send";
    }
  });
})();
