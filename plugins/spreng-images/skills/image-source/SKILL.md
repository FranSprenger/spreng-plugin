---
name: image-source
description: Image step for Spreng in Claude Code. Use when a Spreng claim (claim_native_image with mayGenerate true) needs an image and this Claude Code session has no image tool of its own.
---

# Image source for Spreng (Claude Code)

Claude Code has no image tool of its own. The `spreng-images` tools make the image through a source the
user picks once; the choice is remembered on this computer.

1. Call `image_source_status`. If `choice` is set, go to step 3.
2. Ask the user once which source to use, and call `set_image_source` with it:
   - `codex`: their Codex CLI, signed in with their ChatGPT plan (`codex login`). Images come from Codex's
     own image tool on their plan.
   - `openai`: their own OpenAI API key, billed on their OpenAI account.
   - `kie`: their own KIE API key, billed on their KIE account.
   - `other`: another source they name (`otherName`).
   For `openai` or `kie`, the key goes in with `/plugin configure spreng-images@spreng` (masked, kept in
   the computer's secure storage). It is never typed into the chat or passed to a tool. Once it is set,
   the user restarts Claude Code so the add-on's server starts with it; `image_source_status` then shows
   the source as ready.
3. Call `make_image` with the claim's `brief.renderPrompt` as `prompt`, its reference links as
   `references` and the claim id as `operationId`. It saves the file in the project and returns its path.
   For `other`, follow the `next` text it returns.
4. Carry on with Spreng's own steps, the same for every source: `create_native_image_upload`, PUT the
   file to the `signedUrl` it returns, then `finalize_native_image` with the prompt you used.

One `operationId` buys at most one image in each project, with every source except other. `make_image` records the request
on this computer before calling Codex, OpenAI or KIE; the same `operationId` again returns the image already made, collects a KIE task already
accepted (as does `kieTaskId`), or repeats an unclear or failed outcome, and never pays again. When it
reports an unclear outcome, tell the user and do not ask for that image again without their go-ahead; a
new image needs a new `operationId`.
