# amp-pi-autoresearch

An Amp-native port of `davebcn87/pi-autoresearch` as a shareable repository.

## Contents

- `.amp/plugins/pi-autoresearch.ts` - local Amp plugin runtime
- `.agents/skills/autoresearch-create/SKILL.md` - local setup skill
- `docs/superpowers/specs/2026-03-13-pi-autoresearch-amp-plugin-design.md` - approved design spec

## What It Does

This plugin adds an autonomous experiment loop to Amp with:

- `init_experiment`
- `run_experiment`
- `log_experiment`
- `/autoresearch` chat control flow
- status and dashboard helpers when the runtime supports them
- resumable state through `autoresearch.jsonl` and `.amp/pi-autoresearch.pending.json`

## Install For Local Use

Copy or symlink these paths into a workspace or home directory that Amp reads:

- `.amp/plugins/pi-autoresearch.ts`
- `.agents/skills/autoresearch-create/SKILL.md`

In this machine's current setup, the live files under `/home/sammy/.amp/plugins` and `/home/sammy/.agents/skills` are symlinked back to this repo.

## Notes

- The plugin requires a git worktree for real autoresearch sessions.
- Optional UI features such as status, overlay dashboard, and shortcuts are feature-detected at runtime.
- This repo is derived from the ideas and structure of `https://github.com/davebcn87/pi-autoresearch`.
