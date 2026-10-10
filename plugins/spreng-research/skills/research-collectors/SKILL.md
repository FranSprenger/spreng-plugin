---
name: research-collectors
description: Local research collectors for Spreng. Use when a Spreng research run needs Meta Ad Library ads (with their images and videos saved before the links expire), Reddit posts, YouTube comments or transcripts of saved ad videos.
---

# Research collectors (Spreng add-on)

SCRIPTS is this plugin's `scripts/` folder: `${CLAUDE_PLUGIN_ROOT}/scripts` in Claude Code; elsewhere
the `scripts/` folder two levels above this file. Each script reads public pages logged out and writes
one source file into the folder given as `--out`, normally `<project>/research/sources/`. The Spreng
connector does not read these files: save the findings for the client with its `save_record` with kind
research (`studio_get` with kind sop and slug research-vault lists the fields): one `sources[]` entry per
feed or page read; full transcripts as `documents[]` with `kind: "transcript"` and that `sourceId`;
posts, comments and transcript excerpts as `quotes[]` with that `sourceId`; ads as `competitors[].ads[]`.
Long quotes are labelled excerpts; their full posts and comments are retained in `documents[]` with
`kind: "other"`. Long ad text and diagnostic reasons are labelled excerpts too; full ad text and
full diagnostics are retained in `documents[]`. Save those documents with that `sourceId` too. If the served schema's document or
record limits require a split, save consecutive text parts with the same `part.group`, sequential
`part.index` and complete `part.total`, keeping the `sourceId`, URL and text order in every part.
In Codex the scripts need network access: ask the user to allow it.

| Source | Command | Notes |
|---|---|---|
| Meta Ad Library | `node SCRIPTS/ad-library.mjs fetch --page-id <page id> --out <dir>` (or `--query "<words>"`) | Needs Playwright on this computer (the script says how when it is missing). Reads the first batch only, about 30 ads; saves each ad's images and videos to `<dir>/media/` straight away, because Meta's links expire after about four days. Without Playwright: save the Ad Library page from the browser, then `node SCRIPTS/ad-library.mjs parse --html <file> --out <dir>` |
| Ad video transcripts | `node SCRIPTS/transcribe.mjs --dir <dir>` | After the Ad Library step. Uses the user's own `whisper-cli`, `ffmpeg` and a model file; uploads nothing. When one is missing, the source file says so and the run goes on |
| Reddit | `node SCRIPTS/collect.mjs reddit --query "<words>" --out <dir>` | Public feeds, one read a minute, so a few minutes per run |
| YouTube comments | `node SCRIPTS/collect.mjs youtube --query "<words>" --out <dir>` | First page of comments on the most viewed videos the search finds |

A source that fails writes its file with `status` and `reason` and the run goes on to the next one.
