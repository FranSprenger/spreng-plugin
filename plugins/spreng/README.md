# Spreng

Spreng connects your assistant (Claude Code, Codex, claude.ai or ChatGPT) to your Spreng account. Your
account keeps each client's offer, saved research, angles and Prompt Plates. When you ask for ads, Spreng
prepares a plan from what you saved: the plate, the angle and the reference files for each image. Your
assistant makes each image with its own image tool. You can also ask for a research read or new angles
from saved research: Spreng prepares each step, your assistant writes the answer, and Spreng saves it to
your account.

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
| `https://app.spreng.io/mcp` | Each tool call: the client and run ids, the text answers your assistant writes for a research read or angles, the prompt each image was made from, and image details | Every time your assistant uses a Spreng tool |
| `https://app.spreng.io` (browser) and Spreng's sign-in service `https://kkwbfbsokgefebizzkpt.supabase.co/auth/v1` | Your sign-in | When you connect |
| Spreng's file storage, `https://kkwbfbsokgefebizzkpt.supabase.co/storage/v1/...` | Reference images are read from links the connector returns. When the connector's steps include an upload, the finished image goes to the one-time upload link it returns | When an ad image is made |

Nothing else. The plugin reads no files on your computer beyond the images your assistant made for the
run, collects no keys and runs no programs.

## Images by assistant

Codex and ChatGPT have an image tool built in. Claude Code has none built in: without an image tool in
the session, Spreng keeps the plan saved so you can finish it in Codex or ChatGPT, or connect an image
tool of your own.

## Support

https://spreng.io/support. Privacy policy: https://spreng.io/privacy. Terms: https://spreng.io/terms.
