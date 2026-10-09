# Spreng

For images, the connector always sends the Prompt Plate plus your own inputs. The web app keeps its own Creative rules setting. Prompt handling still lets you choose AI art direction or exact template.

Spreng connects your assistant (Claude Code, Codex, claude.ai or ChatGPT) to your Spreng account. Your
account keeps each client's offer, saved research, angles and Prompt Plates. When you ask for ads, Spreng
prepares a plan from what you saved: the plate, the angle and the reference files for each image. Your
assistant makes each image with its own image tool. You can also ask for a research read or new angles
from saved research: Spreng prepares each step, your assistant writes the answer, and Spreng saves it to
your account.

For accounts that keep no generated images, including the reviewer account, your assistant keeps the
image files. Spreng records completion with `finalize_native_image`; there is no generated-image upload
or Gallery copy. Earlier plans and completion status are available through `list_native_runs` and
`get_native_run`. The assistant follows the account's served next step; it uploads a generated image
only when that step provides a signed upload URL.

`studio_start` returns the next setup step. You can update offer details and brand basics with
`update_client`, or upload a logo or product photo with `create_brand_asset_upload`, then save the
uploaded file with `save_brand_asset`. These brand inputs are separate from generated images.

Spreng does not make images itself, does not run or pay for ads, and this plugin contains no scripts.

## What is in this plugin

| File | What it does |
|---|---|
| `.claude-plugin/plugin.json` | Claude Code manifest: declares the `spreng` connector, `https://app.spreng.io/mcp` |
| `plugin.json`, `mcp.json` | The same plugin in the Agent Plugins format, for Codex and ChatGPT |
| `skills/spreng/SKILL.md` | Names the Spreng tools and the order to call them. The methods themselves come from the connector when it runs |
| `assets/` | Icon and logo |

## Install

Claude Code:

```
claude plugin marketplace add FranSprenger/spreng-plugin
claude plugin install spreng@spreng
```

Codex:

```
codex plugin marketplace add FranSprenger/spreng-plugin
```

Then open the Plugins directory in Codex and install Spreng from the `spreng` marketplace.

Installing from a marketplace downloads this plugin's files from its repository, https://github.com/FranSprenger/spreng-plugin.

## Sign in

The first time a Spreng tool runs, your assistant asks you to sign in. In Claude Code run `/mcp`, pick
`spreng` and sign in; in Codex run `codex mcp login spreng`. Your browser opens app.spreng.io, you approve
the connection, and the assistant receives a sign-in token for your account only. No key is stored in
this plugin.

## What it sends, and where

| Destination | What goes there | When |
|---|---|---|
| `https://app.spreng.io/mcp` | Tool calls: client and run ids, offer and brand edits, text answers, and image completion details including the actual prompt and host. Receipt-only completion keeps the completion record, not the submitted prompt, host, model or references | Every time your assistant uses a Spreng tool |
| `https://app.spreng.io` (browser) and Spreng's sign-in service `https://kkwbfbsokgefebizzkpt.supabase.co/auth/v1` | Your sign-in | When you connect |
| Spreng's file storage, `https://kkwbfbsokgefebizzkpt.supabase.co/storage/v1/...` | Reference images are read from returned links. User-supplied logos and product photos go to signed brand upload links. Generated images go to storage only when the served steps return a generated-image upload URL; the reviewer account has no such step | When reading references or following a served upload step |

The assistant reads the reference files and any logo or product photo you ask it to upload. This plugin
contains no file-reading code, collects no keys and runs no programs.

## Images by assistant

Check that your current Codex or ChatGPT session has an image tool available. Your AI account's usage
limits still apply. Claude Code has none built in. To use your existing Codex account from Claude Code,
run `claude plugin install spreng-images@spreng`, restart Claude Code and choose Codex in the add-on's
image-source setup. The Codex CLI must be installed and signed in by you with `codex login`. The assistant
checks the image source before claiming an image. You can also keep the plan saved and finish it in an
image-capable Codex or ChatGPT session using `list_native_runs` and `get_native_run`.

## Support

https://app.spreng.io/support. Privacy policy: https://app.spreng.io/privacy. Terms: https://app.spreng.io/terms.
Plugin docs: https://app.spreng.io/docs/plugin.
