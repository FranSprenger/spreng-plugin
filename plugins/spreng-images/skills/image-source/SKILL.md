---
name: image-source
description: Check image readiness before claim_native_image, then make the claimed image for Spreng when this Claude Code session has no image tool of its own.
---

# Image source for Spreng (Claude Code)

For images, the connector always sends the Prompt Plate plus your own inputs. Prompt handling still lets you choose AI art direction or exact template.

Claude Code has no image tool of its own. The `spreng-images` tools make the image through a source the
user picks once; the choice is remembered on this computer.

For Spreng onboarding, guide the user to their existing Codex account first. Explain its usage limits.
Do not offer a billed API source by default; the OpenAI and KIE setup below is for a user who explicitly
asks to use their own source. Keep an existing source choice unless the user asks to change it.

1. Call `image_source_status` for the remembered choice and configuration. If `choice` is set, go to step 3.
2. For a new Spreng setup, guide the user to Codex and call `set_image_source` once chosen. Use the other options below only when the user explicitly requests their own source:
   - `codex`: their Codex CLI, signed in with their ChatGPT plan (`codex login`). Images come from Codex's
     own image tool on their plan.
   - `openai`: their own OpenAI API key, billed on their OpenAI account.
   - `kie`: their own KIE API key, billed on their KIE account.
   - `other`: another source they name (`otherName`).
   For `openai` or `kie`, the key goes in with `/plugin configure spreng-images@spreng` (masked, kept in
   the computer's secure storage). It is never typed into the chat or passed to a tool. Once it is set,
   the user restarts Claude Code so the add-on's server starts with it; `image_source_status` then shows
   the source as configured.
3. Before `claim_native_image`, call `check_image_readiness`.
   For not_installed, not_signed_in or no_image_capability, show its `reason` and `next`, keep the plan unclaimed, and stop.
   For ready, claim normally. For could_not_tell, claim normally and tell the user: "The image tool could not be checked in advance."
   Do not generate an image as a readiness probe.
4. Generate only when the claim returns `mayGenerate: true`. Follow the claim's `promptHandling` for the creative text, including its existing art-direction step
   when requested. Call `make_image` with that text as `prompt`, the claim's reference links as
   `references`, its `imageToolSettings.requestedSize` as `requestedSize`, and the claim's `assetId` as `operationId`.
   The Codex route carries the approved format-only suffix and returns `actualPrompt`, the file path,
   and `dimensionCheck` from the returned image header. Report any mismatch; do not generate a replacement automatically.
   For `other`, follow the `next` text it returns.
5. Follow the Spreng claim's `next`: if it names `create_native_image_upload`, call it and PUT the file
   only when it returns `signedUrl`. If the claim goes straight to `finalize_native_image`, or upload
   answers `uploadNeeded: false`, skip the upload and keep the file here. Call `finalize_native_image`
   with `assetId`, `actualPrompt` and `host`; use the add-on's returned `actualPrompt` when present. A receipt records completion without a Gallery copy.

After a dropped reply, call `recover_image` with the claim's `assetId` as `operationId` in the same project.
It restores an already-made image from its local receipt: no prompt, reference links or provider call
is needed. Do not replay `make_image` with refreshed reference links to recover that image. If there is
no completed receipt, recovery reports the saved state and sends nothing.

One `operationId` buys at most one image in each project, with every source except other. `make_image` records the request
on this computer before calling Codex, OpenAI or KIE; an identical request can return the completed image,
collect a KIE task already accepted (as does `kieTaskId`), or repeat an unclear or failed outcome. When it
reports an unclear outcome, tell the user and do not ask for that image again without their go-ahead; a
new image needs a new `operationId`.
