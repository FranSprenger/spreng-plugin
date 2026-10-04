# Spreng Images (Claude Code add-on)

Claude Code has no image tool of its own. This add-on lets Claude Code make the images for a Spreng ad
run through an image source you choose once and that this computer remembers: your Codex CLI signed in
with your ChatGPT plan, your own OpenAI API key, your own KIE API key, or another source you name. After
the image exists, the normal Spreng steps upload it to your Spreng account, the same as in Codex or
ChatGPT. This add-on is separate from the Spreng plugin and is offered only through Spreng's own
marketplace.

## Install

```
claude plugin marketplace add FranSprenger/spreng-plugin
claude plugin install spreng-images@spreng
```

Keys: `/plugin configure spreng-images@spreng`. Claude Code keeps them in your computer's secure
storage and passes them only to this add-on's local server. They are never typed into the chat, never
written into a file by this add-on, never sent to Spreng and never shown in a tool answer.

## What it runs, sends and fetches

| Source | What runs or is sent | Destination |
|---|---|---|
| codex | Runs your own `codex` program (`codex exec`, read-only sandbox) with the prompt and reference images; copies the new image from `~/.codex/generated_images/` into your project | OpenAI, through your Codex sign-in |
| openai | One request per image with your key, the prompt and any reference images | `https://api.openai.com/v1/images/generations` or `/v1/images/edits` |
| kie | One task per image with your key, the prompt and reference links, then status checks and the result download | `https://api.kie.ai/api/v1/jobs/createTask` and `/api/v1/jobs/recordInfo`, then the result link KIE returns |
| other | Nothing | none |

Reference images given as links are downloaded first (from the links Spreng's claim returns). Files it
writes: the image in your project (default `spreng-images/` in the project), your remembered choice in
Claude Code's plugin data folder (`image-source.json`), and downloaded references in a `work/` folder
there. Images made with the openai or kie source are paid for on your own account with that provider.

Files: `server/server.mjs` (the local MCP server, Node only, no packages), `server/routes.mjs` (the four
sources), `skills/image-source/SKILL.md`.
