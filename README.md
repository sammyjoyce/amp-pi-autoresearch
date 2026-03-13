# amp-pi-autoresearch

This repo is a straight Amp port of [`davebcn87/pi-autoresearch`](https://github.com/davebcn87/pi-autoresearch).

The point is simple: give Amp a repeatable experiment loop so it can try a change, benchmark it, keep the wins, throw away the losers, and keep going without losing the thread.

## What you get

- A local Amp plugin at `.amp/plugins/pi-autoresearch.ts`
- A matching setup skill at `.agents/skills/autoresearch-create/SKILL.md`
- A durable experiment log in `autoresearch.jsonl`
- Pending-run recovery through `.amp/pi-autoresearch.pending.json`
- A `/autoresearch` control flow plus status and dashboard helpers

## Core tools

- `init_experiment` starts or re-initializes an experiment segment
- `run_experiment` runs the benchmark, times it, and runs optional checks
- `log_experiment` records the current pending run and auto-commits kept results

## How it works

The skill handles setup. The plugin handles the loop.

The expected flow looks like this:

1. Start with `/autoresearch <goal>` or use the `autoresearch-create` skill.
1. Create `autoresearch.md` and `autoresearch.sh`.
1. Call `init_experiment`.
1. Run the baseline with `run_experiment`.
1. Record it with `log_experiment`.
1. Keep iterating until you stop the session.

The plugin rebuilds state from `autoresearch.jsonl`, so reloads and context changes are annoying but not fatal.

## Requirements

- Amp with local plugin support
- A git worktree
- A clean worktree before starting a new session

This plugin is intentionally strict about git. If there is no repo, or the worktree is already dirty at setup time, it fails early instead of pretending the results are trustworthy.

## Install

For global use on this Amp setup, the right target is under `~/.config/amp/plugins`, not `~/.amp/plugins`.

### Option 1: symlink into the global Amp path

```bash
mkdir -p ~/.config/amp/plugins
mkdir -p ~/.config/amp/plugins/.agents/skills/autoresearch-create

ln -sf /path/to/amp-pi-autoresearch/.amp/plugins/pi-autoresearch.ts \
  ~/.config/amp/plugins/pi-autoresearch.ts

ln -sf /path/to/amp-pi-autoresearch/.agents/skills/autoresearch-create/SKILL.md \
  ~/.config/amp/plugins/.agents/skills/autoresearch-create/SKILL.md
```

### Option 2: copy the files into the global Amp path

```bash
mkdir -p ~/.config/amp/plugins
mkdir -p ~/.config/amp/plugins/.agents/skills/autoresearch-create

cp .amp/plugins/pi-autoresearch.ts ~/.config/amp/plugins/pi-autoresearch.ts
cp .agents/skills/autoresearch-create/SKILL.md ~/.config/amp/plugins/.agents/skills/autoresearch-create/SKILL.md
```

If you want to install it only for one workspace, you can still place the files under that workspace's local `.amp/plugins` and `.agents/skills` directories. The examples above are for global use.

## Usage

### Start a session

In Amp chat:

```text
/autoresearch speed up the test suite without changing test coverage
```

Or invoke the skill directly:

```text
/skill:autoresearch-create
```

### Inspect the session

Use these commands in chat when you want to see where the loop stands:

```text
/autoresearch status
/autoresearch dashboard
/autoresearch pause
/autoresearch resume
/autoresearch stop
```

### Files the loop uses

- `autoresearch.md` for the durable session brief
- `autoresearch.sh` for the benchmark command
- `autoresearch.checks.sh` for optional backpressure checks
- `autoresearch.ideas.md` for deferred ideas worth revisiting
- `autoresearch.jsonl` for the append-only run history
- `.amp/pi-autoresearch.pending.json` for the currently pending benchmark result

## Repo layout

```text
.
├── .amp/plugins/pi-autoresearch.ts
├── .agents/skills/autoresearch-create/SKILL.md
├── docs/superpowers/specs/2026-03-13-pi-autoresearch-amp-plugin-design.md
├── LICENSE
└── README.md
```

## Notes and limits

- The plugin expects a git-backed workflow and uses commits as the source of truth for kept runs.
- Optional UI features are feature-detected at runtime. If Amp does not expose status, overlay, or shortcut APIs, the core loop still works.
- The command surface is the main control path. If an Amp build does not support that command surface, this repo is probably not the right fit yet.
- This is a local plugin repo, not a published marketplace package.

## Why this exists

I wanted the original pi addon behavior in Amp without burying it inside one machine's dotfiles. So this repo keeps the plugin, the skill, and the design doc together in one place that is easy to share, review, and evolve.

## Origin

This project is based on the ideas and structure of [`davebcn87/pi-autoresearch`](https://github.com/davebcn87/pi-autoresearch), adapted for Amp's local plugin model.

## License

[MIT](LICENSE)
