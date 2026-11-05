# Personal website (GitHub Pages, built locally first)

Preview: `python3 dev-server.py` in this folder, then http://localhost:8100.

## Layout
- Landing-page positions live in `layout.css`. The drag-and-resize editor (`editor.js`, "Edit layout" button) was switched off 2026-11-04 at Aaryan's request: its loader is gone from `index.html`, the file is kept. The portal's size is set by a fit-the-screen rule in `index.html` (`.scene #portal`), which overrides `layout.css`.
- Each draggable item is a `<div class="movable" id="...">` inside `.scene`. New images that should be draggable follow the same pattern.

## Color rule (Aaryan, 2026-11-04)
- Every color is a CSS variable, defined once and used everywhere as `var(--name)`. No raw color codes (hex, rgb, named colors) outside a palette block.
- Page colors: the `:root` block at the top of `index.html`. That is the one place.
- `waves.svg` (animated waves, its own palette at its top) is NOT used since 2026-11-04: the page is a solid `#0d293b`. Kept on disk in case it comes back; if re-added, its palette is a second place (a background image can't read the page's variables).
- Names say what the color paints, in plain words, so Aaryan can tell at a glance what changes: `--heading-text`, `--button-background`, `--link-hover`. Never names that describe the color itself (`--cyan`) or vague ones (`--accent`, `--color-2`).
- When adding anything new: add its variable to the palette first, with a one-line comment if the name isn't obvious, then use it.

## Content storage (2026-11-04)
- Each note is a folder: `notes/<box>/<note-id>/note.json` (title, created, added, tags, pinned, `layout.blocks` = title/text/image boxes as shares 0..1 of the note area, in reading order) + `body.html` + `images/`.
- `content.json` = bio + an INDEX of notes, rebuilt by `dev-server.py` from the folders on every save. Don't hand-edit the index; edit the folders.
- Deleted notes move to `notes/.trash/` (dot-folder: not published by GitHub Pages).
- Owner tools (editing, plus popup, arrange popup, pin, tags, trash) exist only on localhost; all saving goes through `dev-server.py` routes.

## Publishing (live since 2026-11-05)
- Live at https://gardinjardin.github.io (repo GardinJardin/gardinjardin.github.io, branch main, GitHub Pages). The old June repo of that name was renamed to `gardinjardin-old-june` (private).
- Edit on localhost (saves to disk), then `./publish` (commits everything + pushes; refuses if SKIP_INTRO is true). `.gitignore` keeps out the downloaded originals, `__pycache__`, `notes/.trash`.
