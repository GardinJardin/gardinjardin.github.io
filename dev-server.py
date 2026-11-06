"""Local preview server with saving. Only for your computer; GitHub Pages just serves the files.

Run in this folder:  python3 dev-server.py   then open http://localhost:8100

Storage (what gets published):
  notes/<box>/<note-id>/note.json   title, dates, tags, pin, and the note's layout (positions as shares of the frame)
  notes/<box>/<note-id>/body.html   the note's (first) text box, formatting kept; more boxes = text-xxxx.html
  notes/<box>/<note-id>/images/     the note's pictures
  content.json                      your bio + an INDEX of every note (rebuilt from the folders on every save;
                                    the live site needs it because a static site can't list a folder)
  layout.css                        positions from the landing-page drag editor (editor.js)
Deleted notes are moved to notes/.trash/ (never published: GitHub Pages skips dot-folders), not erased.

Routes (POST, localhost only):
  /save-layout   landing-page positions -> layout.css
  /save-bio      {"bio": "..."} -> content.json
  /save-note     {"section", "note": {...note.json...}, "texts": {"body.html": "..", ..}} -> the note's folder; replies with the new index
  (the Bio is the note section "about", id "bio": notes/about/bio/)
  /save-page     {"section", "page": {"layout", "textFiles"}, "texts"} -> notes/<box>/page/ (the box's own page)
  /delete-note   {"section", "id"} -> moves the folder to notes/.trash/; replies with the new index
  /upload-image?section=..&id=..&name=..   raw image bytes -> notes/<box>/<id>/images/; replies {"src": "images/<file>"}
"""
import http.server
import json
import os
import re
import secrets
import shutil
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
NOTES = HERE / "notes"
INDEX = HERE / "content.json"
PORT = 8100  # not 8000: another project (ConceptTimeTracking) uses that one
SECTIONS = ("built", "experiments", "blogs", "my-system")  # the four ribbon boxes, left to right
PIN_LIMIT = 3
MAX_IMAGE = 1024 * 1024 * 1024  # 1 GB: just a guard against a broken upload, not a real limit
MAX_JSON = 512 * 1024 * 1024  # 512 MB of text per save: same, a guard, not a limit
def image_type(data):
    """What kind of picture the bytes really are (whatever the file is called), or None if not a picture."""
    if data.startswith(b"\x89PNG"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "webp"
    if data[4:12] in (b"ftypavif", b"ftypavis"):
        return "avif"
    if data.startswith(b"BM"):
        return "bmp"
    return None
ID_RE = re.compile(r"[a-z0-9-]{1,80}")
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
STAMP_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")
SRC_RE = re.compile(r"images/[a-z0-9][a-z0-9._-]{0,90}\.(png|jpe?g|gif|webp|avif|bmp)")
TEXT_RE = re.compile(r"body\.html|text-[a-z0-9]{1,12}\.html")  # one file per text box; body.html is the first
LAYOUT_HEADER = (
    "/* Written by the layout editor (editor.js + dev-server.py). Drag and resize on localhost instead of editing by hand.\n"
    "   left/top = the image's top-left corner, as % of the screen's width/height. width = % of screen width. */\n"
)


class Bad(ValueError):
    pass


def write_atomic(path, text):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def note_dir(section, note_id):
    if section == "about" and note_id == "bio":  # the Bio is a note too, kept out of the four boxes' lists
        return NOTES / "about" / "bio"
    if section not in SECTIONS or not (isinstance(note_id, str) and ID_RE.fullmatch(note_id)):
        raise Bad("section/id")
    return NOTES / section / note_id


def read_index():
    try:
        return json.loads(INDEX.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"bio": "", "sections": {}}


def read_order(section):
    """Your hand-made order of a box's notes (list of note ids), or [] if you never dragged any."""
    f = NOTES / section / "order.json"
    try:
        order = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [i for i in order if isinstance(i, str)] if isinstance(order, list) else []


def rebuild_index():
    """content.json = bio + one short entry per note folder (what the lists on the page need)."""
    data = read_index()
    sections = {}
    for section in SECTIONS:
        entries = []
        folder = NOTES / section
        if folder.is_dir():
            for d in sorted(folder.iterdir()):
                meta_file = d / "note.json"
                if not meta_file.is_file():
                    continue
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
                entry = {k: meta[k] for k in ("id", "title", "created", "added", "tags", "pinned") if k in meta}
                entries.append(entry)
        # Order on the page: newest first, unless you dragged notes into your own order (order.json).
        # Notes added after the last drag aren't in order.json yet, so they go on top, newest first.
        entries.sort(key=lambda e: e.get("added") or e["created"] + "T00:00", reverse=True)
        order = read_order(section)
        place = {nid: i for i, nid in enumerate(order)}
        new = [e for e in entries if e["id"] not in place]
        old = sorted((e for e in entries if e["id"] in place), key=lambda e: place[e["id"]])
        sections[section] = new + old
    index = {"bio": data.get("bio", ""), "sections": sections}
    write_atomic(INDEX, json.dumps(index, indent=2, ensure_ascii=False) + "\n")
    return index


NOTE_KINDS = ("title", "text", "image", "link")
PAGE_KINDS = ("list", "pins", "line", "text", "image", "link")  # a box's page: notes list, pinned list, the white line, extras


# ---------- checks ----------
# Only two kinds of checks can refuse a save, both to protect your files:
#   1. names: box, note id and file names must be plain (a-z, 0-9, dashes), so nothing can be written
#      outside notes/ (e.g. "../../somewhere");
#   2. pictures must really be pictures (so no script can be uploaded and served from your site).
# Everything else (lengths, counts, sizes, positions, angles) is cleaned up and saved, never refused.

def _num(v, default):
    try:
        v = float(v)
        return default if v != v else v  # v != v: not a number
    except (TypeError, ValueError):
        return default


def check_block(b, page):
    """One part of a layout, cleaned up. Returns None (the part is skipped) only if its kind is unknown
    or its file name isn't a plain one."""
    if not isinstance(b, dict):
        return None
    kind = b.get("kind")
    if kind not in (PAGE_KINDS if page else NOTE_KINDS):
        return None
    least = 0.001 if kind == "line" else 0.005
    w = min(1.0, max(least, _num(b.get("w"), 0.3)))
    h = min(1.0, max(least, _num(b.get("h"), 0.3)))
    x = min(1.0 - w, max(0.0, _num(b.get("x"), 0)))
    y = min(1.0 - h, max(0.0, _num(b.get("y"), 0)))
    entry = {"kind": kind, "x": round(x, 4), "y": round(y, 4), "w": round(w, 4), "h": round(h, 4)}
    if kind == "image":
        src = b.get("src")
        if not (isinstance(src, str) and SRC_RE.fullmatch(src)):
            return None
        entry["src"] = src
        rot = _num(b.get("rotate"), 0) % 360  # degrees, clockwise; any value is folded into -180..180
        if rot > 180:
            rot -= 360
        if rot:
            entry["rotate"] = round(rot, 1)
        ratio = _num(b.get("ratio"), 0)  # the picture's width / height
        if ratio > 0:
            entry["ratio"] = round(ratio, 5)
        cap = b.get("caption")
        if cap is not None and str(cap).strip():
            entry["caption"] = str(cap).strip()
    if kind in ("text", "link"):  # text and link boxes can be turned, like pictures
        rot = _num(b.get("rotate"), 0) % 360
        if rot > 180:
            rot -= 360
        if rot:
            entry["rotate"] = round(rot, 1)
    if kind == "link":  # a link box: the words shown + where a click goes
        entry["display"] = str(b.get("display") or "").strip()[:120]
        url = str(b.get("url") or "").strip()[:2000]
        # only web and email addresses: a "javascript:" address would run code on click (same rule as safeUrl in content.js)
        entry["url"] = url if re.match(r"(?i)(https?:|mailto:)", url) else ""
    if kind in ("text", "title", "link"):
        size = min(1.08, max(0.3, _num(b.get("size"), 1)))  # letter size vs the default (1); same range as SIZE_MIN/MAX in content.js
        if abs(size - 1) > 0.005:
            entry["size"] = round(size, 2)  # 1 = the default look, so it isn't stored
    if kind == "text":
        f = b.get("file", "body.html")
        if not (isinstance(f, str) and TEXT_RE.fullmatch(f)):
            return None
        entry["file"] = f
    return entry


def check_layout(layout, page=False):
    """blocks: the parts shown, in reading order. x, w: shares (0..1) of the area's width; y, h: shares of the
    frame's height. hidden: parts trashed from the frame but kept to put back. aspect = frame height / width.
    Extra copies of a one-of-a-kind part (title / notes list / pinned list / line) or of a text box are dropped."""
    if not isinstance(layout, dict):
        return None
    seen, out = set(), {}

    def clean(items):
        result = []
        for b in items if isinstance(items, list) else []:
            e = check_block(b, page)
            if not e:
                continue
            key = e["kind"] if e["kind"] in ("title", "list", "pins", "line") else ("text", e["file"]) if e["kind"] == "text" else None
            if key is not None:
                if key in seen:
                    continue
                seen.add(key)
            result.append(e)
        return result

    out["blocks"] = clean(layout.get("blocks"))
    parked = clean(layout.get("hidden"))
    if parked:
        out["hidden"] = parked
    if layout.get("aspect") is not None:
        out["aspect"] = round(min(100.0, max(0.05, _num(layout.get("aspect"), 0.6))), 4)
    return out


def clean_tags(tags):
    out = []
    for t in tags if isinstance(tags, list) else []:
        t = re.sub(r"\s+", "-", str(t).strip())
        if t and t not in out:
            out.append(t)
    return out


def check_note(section, note, others_pinned):
    """note.json, cleaned up. Returns (meta, pin_refused)."""
    note_id = note.get("id")
    note_dir(section, note_id)  # the only refusal: a note id that isn't a plain name
    title = str(note.get("title") or "").strip() or "Untitled"
    created = note.get("created")
    if not (isinstance(created, str) and DATE_RE.fullmatch(created)):
        created = time.strftime("%Y-%m-%d")
    meta = {"id": note_id, "title": title, "created": created}
    added = note.get("added")
    if isinstance(added, str) and STAMP_RE.fullmatch(added):
        meta["added"] = added
    meta["tags"] = clean_tags(note.get("tags"))
    pin_refused = False
    if note.get("pinned") is True and section != "about":
        if others_pinned >= PIN_LIMIT:
            pin_refused = True  # your 3-pins-per-box rule: the note still saves, just not pinned
        else:
            meta["pinned"] = True
    layout = check_layout(note.get("layout"))
    if layout:
        meta["layout"] = layout
    files = [f for f in (note.get("textFiles") or []) if isinstance(f, str) and TEXT_RE.fullmatch(f)]
    meta["textFiles"] = list(dict.fromkeys(files)) or ["body.html"]
    return meta, pin_refused


def clean_texts(texts):
    """{file name: html}; entries whose file name isn't a plain one are skipped, everything else is kept."""
    out = {}
    for f, html in (texts.items() if isinstance(texts, dict) else []):
        if isinstance(f, str) and TEXT_RE.fullmatch(f):
            out[f] = html if isinstance(html, str) else str(html or "")
    return out


def pinned_count(section, except_id):
    n = 0
    folder = NOTES / section
    if folder.is_dir():
        for d in folder.iterdir():
            f = d / "note.json"
            if d.name != except_id and f.is_file() and json.loads(f.read_text(encoding="utf-8")).get("pinned"):
                n += 1
    return n


def migrate_old_index():
    """Before folders, every note lived inside content.json. Move any such note into its own folder (once)."""
    data = read_index()
    moved = 0
    for section, items in (data.get("sections") or {}).items():
        if section not in SECTIONS:
            continue
        for item in items:
            if "bodyHtml" not in item and "body" not in item:
                continue  # already an index entry
            d = note_dir(section, item["id"])
            if (d / "note.json").is_file():
                continue
            if moved == 0:
                (NOTES / ".trash").mkdir(parents=True, exist_ok=True)
                shutil.copy2(INDEX, NOTES / ".trash" / f"content-before-folders-{time.strftime('%Y%m%d-%H%M%S')}.json")
            d.mkdir(parents=True, exist_ok=True)
            body = item.get("bodyHtml")
            if body is None:  # very old plain-text body
                esc = item.get("body", "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                body = esc.replace("\n", "<br>")
            meta = {k: item[k] for k in ("id", "title", "created", "added", "tags", "pinned") if k in item}
            meta.setdefault("tags", [])
            write_atomic(d / "body.html", body)
            write_atomic(d / "note.json", json.dumps(meta, indent=2, ensure_ascii=False) + "\n")
            moved += 1
    # the Bio used to be plain text in content.json: give it its own note folder (once)
    bio_dir = NOTES / "about" / "bio"
    if not (bio_dir / "note.json").is_file():
        bio_dir.mkdir(parents=True, exist_ok=True)
        esc = data.get("bio", "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        write_atomic(bio_dir / "body.html", esc.replace("\n", "<br>"))
        meta = {"id": "bio", "title": "Bio", "created": time.strftime("%Y-%m-%d"), "tags": [], "textFiles": ["body.html"]}
        write_atomic(bio_dir / "note.json", json.dumps(meta, indent=2, ensure_ascii=False) + "\n")
        moved += 1
    if moved or not INDEX.exists():
        rebuild_index()
    return moved


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always show the latest saved files
        super().end_headers()

    def reply_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, limit):
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0 or n > limit:
            raise Bad("size")
        return self.rfile.read(n)

    def do_POST(self):
        url = urlparse(self.path)
        routes = {
            "/save-layout": self.save_layout, "/save-bio": self.save_bio, "/save-note": self.save_note,
            "/delete-note": self.delete_note, "/upload-image": self.upload_image, "/save-page": self.save_page,
            "/save-order": self.save_order,
        }
        handler = routes.get(url.path)
        if not handler:
            self.send_error(404)
            return
        try:
            handler(url)
        except (Bad, KeyError, TypeError, ValueError, json.JSONDecodeError) as e:
            self.reply_json({"error": str(e)}, 400)

    def save_layout(self, url):
        data = json.loads(self.read_body(MAX_JSON))
        lines = []
        for el_id, box in data.items():
            if not re.fullmatch(r"[a-z0-9-]+", el_id):
                raise Bad(el_id)
            left, top, width = (float(box[k]) for k in ("left", "top", "width"))
            lines.append(f"#{el_id} {{ left: {left}vw; top: {top}vh; width: {width}vw; }}")
        write_atomic(HERE / "layout.css", LAYOUT_HEADER + "\n".join(lines) + "\n")
        self.reply_json({"ok": True})

    def save_bio(self, url):
        bio = json.loads(self.read_body(MAX_JSON)).get("bio", "")
        bio = bio if isinstance(bio, str) else str(bio)
        data = read_index()
        data["bio"] = bio
        write_atomic(INDEX, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        self.reply_json({"ok": True})

    def save_note(self, url):
        data = json.loads(self.read_body(MAX_JSON))
        section, note = data["section"], data["note"]
        texts = data.get("texts")
        if texts is None:  # older pages sent one body
            texts = {"body.html": data.get("bodyHtml", "")}
        texts = clean_texts(texts)
        meta, pin_refused = check_note(section, note, pinned_count(section, note.get("id")))
        d = note_dir(section, meta["id"])
        d.mkdir(parents=True, exist_ok=True)
        for f, html in texts.items():  # text files are only ever added or rewritten, never removed here
            write_atomic(d / f, html)
        write_atomic(d / "note.json", json.dumps(meta, indent=2, ensure_ascii=False) + "\n")
        self.reply_json({"index": rebuild_index(), "pinRefused": pin_refused})

    def save_page(self, url):
        """A box's page (the view with the notes list): notes/<box>/page/page.json + its text boxes.
        page.json, not note.json, so the page never shows up as a note in the lists."""
        data = json.loads(self.read_body(MAX_JSON))
        section, page = data["section"], data.get("page") or {}
        if section not in SECTIONS:
            raise Bad("section")
        texts = clean_texts(data.get("texts", {}))
        meta = {"id": "page"}
        layout = check_layout(page.get("layout"), page=True)
        if layout:
            meta["layout"] = layout
        files = [f for f in (page.get("textFiles") or []) if isinstance(f, str) and TEXT_RE.fullmatch(f)]
        meta["textFiles"] = list(dict.fromkeys(files))
        d = NOTES / section / "page"
        d.mkdir(parents=True, exist_ok=True)
        for f, html in texts.items():
            write_atomic(d / f, html)
        write_atomic(d / "page.json", json.dumps(meta, indent=2, ensure_ascii=False) + "\n")
        self.reply_json({"index": rebuild_index()})

    def save_order(self, url):
        """The order you dragged a box's notes into: notes/<box>/order.json (list of note ids, top first)."""
        data = json.loads(self.read_body(MAX_JSON))
        section = data["section"]
        if section not in SECTIONS:
            raise Bad("section")
        ids = [i for i in (data.get("order") or []) if isinstance(i, str) and ID_RE.fullmatch(i)]
        d = NOTES / section
        d.mkdir(parents=True, exist_ok=True)
        write_atomic(d / "order.json", json.dumps(list(dict.fromkeys(ids)), indent=2) + "\n")
        self.reply_json({"index": rebuild_index()})

    def delete_note(self, url):
        data = json.loads(self.read_body(MAX_JSON))
        if data["section"] == "about":
            raise Bad("the Bio can't be deleted")
        d = note_dir(data["section"], data["id"])
        if d.is_dir():
            trash = NOTES / ".trash"
            trash.mkdir(parents=True, exist_ok=True)
            shutil.move(str(d), str(trash / f"{time.strftime('%Y%m%d-%H%M%S')}-{data['section']}-{data['id']}"))
        self.reply_json({"index": rebuild_index()})

    def upload_image(self, url):
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        d = note_dir(q["section"], q["id"])
        if q["id"] == "page" and q["section"] in SECTIONS:
            d.mkdir(parents=True, exist_ok=True)  # a box's page folder is made on its first picture
        else:
            d.mkdir(parents=True, exist_ok=True)  # works even if the note hasn't been saved yet
        raw_name = q.get("name", "image")
        data = self.read_body(MAX_IMAGE)
        ext = image_type(data)  # judged by the bytes, not the name: a .HEIC renamed .png is still refused
        if not ext:
            raise Bad("that file isn't a picture a browser can show (png, jpg, gif, webp, avif or bmp)")
        stem = re.sub(r"[^a-z0-9]+", "-", raw_name.rsplit(".", 1)[0].lower()).strip("-")[:50] or "image"
        images = d / "images"
        images.mkdir(exist_ok=True)
        name = f"{stem}.{ext}"
        while (images / name).exists():
            name = f"{stem}-{secrets.token_hex(2)}.{ext}"
        (images / name).write_bytes(data)
        self.reply_json({"src": f"images/{name}"})


if __name__ == "__main__":
    moved = migrate_old_index()
    if moved:
        print(f"Moved {moved} note(s) into their own folders under notes/ (old content.json copied to notes/.trash/)")
    print(f"Serving {HERE} at http://localhost:{PORT}  (Ctrl+C to stop)")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
