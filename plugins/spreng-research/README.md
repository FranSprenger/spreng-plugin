# Spreng Research Collectors (add-on)

Small Node scripts that run on your own computer and collect public research for the Spreng research
method, logged out, with no account, key or paid service: the Meta Ad Library's first batch of ads for
a brand (with the ad images and videos saved straight away, because Meta's links expire after about
four days), Reddit posts and comments from Reddit's public feeds, the first page of YouTube comments,
and transcripts of the saved ad videos made by speech-to-text on your own computer. Each script writes
one source file into your project. This add-on is offered only through Spreng's own marketplace.

## Install

```
claude plugin marketplace add FranSprenger/spreng-plugin
claude plugin install spreng-research@spreng
```

Codex: `codex plugin marketplace add FranSprenger/spreng-plugin`, then install Spreng Research
Collectors from the `spreng` marketplace in the Plugins directory.

## Everything it runs, fetches and writes

| Script | Fetches (logged out) | Sends | Writes |
|---|---|---|---|
| `scripts/ad-library.mjs` | `https://www.facebook.com/ads/library/` in a headless browser (Playwright, which you install), and the ad images and videos from Meta's `fbcdn.net` links | Nothing beyond those page and file requests; optional cookies are declined | `meta-ads.json`, `meta-ads-raw.json`, `media/` |
| `scripts/transcribe.mjs` | Nothing | Nothing: runs your own `whisper-cli` and `ffmpeg` on the saved videos | transcripts inside `meta-ads.json` |
| `scripts/collect.mjs reddit` | `https://www.reddit.com/search.rss` and each thread's `.rss` feed, one read a minute | Nothing | `reddit.json` |
| `scripts/collect.mjs youtube` | `https://www.youtube.com/results`, each watch page, and the first page of comments from `https://www.youtube.com/youtubei/v1/next` (the request the YouTube page itself makes) | The search words and the page's own comment token, to YouTube | `youtube-comments.json` |

No script installs anything, downloads models or sends your research to Spreng. Saving research to your
Spreng account is a separate step your assistant does with the Spreng connector.

Speech-to-text needs `whisper-cli` and `ffmpeg` (on a Mac: `brew install whisper-cpp ffmpeg`) and a
whisper model file such as `ggml-base.en.bin` (148 MB, from https://huggingface.co/ggerganov/whisper.cpp)
in `~/.cache/whisper-cpp-models/`, or `SPRENG_WHISPER_MODEL` pointing at one.

`scripts/sources/reddit.mjs` and `scripts/sources/youtube-comments.mjs` are the collectors from the Spreng
Studio research recipe.
