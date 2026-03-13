---
name: autoresearch-create
description: Set up and run an autonomous experiment loop for any optimization target. Use when asked to run autoresearch, optimize something in a loop, set up an experiment harness, or keep iterating until performance improves.
---

# Autoresearch

Autonomous experiment loop: try ideas, keep what works, discard what does not, and keep going until interrupted.

## Tools

- `init_experiment` configures the session and freezes the primary metric definition.
- `run_experiment` runs the benchmark command, measures wall-clock time, and runs optional checks.
- `log_experiment` records the current pending run. The primary metric comes from `run_experiment`; do not invent or override it.

## Preconditions

1. Verify the workspace is a git repository with `git rev-parse --is-inside-work-tree`.
1. Verify the worktree is clean before setup starts.
1. Create or switch to an `autoresearch/<goal>-<date>` branch before writing session files.

If any precondition fails, stop and tell the user exactly what needs to be fixed.

## Setup

1. Ask or infer the goal, benchmark command, primary metric direction, files in scope, and hard constraints.
1. Read the relevant source files before writing anything.
1. Write `autoresearch.md` and `autoresearch.sh`.
1. Write `autoresearch.checks.sh` only when the user requires correctness backpressure such as tests, lint, or type checks.
1. Commit the initial session files on the autoresearch branch.
1. Call `init_experiment`.
1. Run the baseline with `run_experiment`.
1. Record the baseline with `log_experiment`.
1. Start looping immediately.

## Session Files

### `autoresearch.md`

Make this the durable handoff document for a fresh agent.

```markdown
# Autoresearch: <goal>

## Objective
<What is being optimized and why.>

## Metrics
- Primary: <name> (<unit>, lower or higher is better)
- Secondary: <name>, <name>

## How To Run
`./autoresearch.sh`

## Files In Scope
<Files the loop may edit, with short notes.>

## Off Limits
<Files or areas that must not change.>

## Constraints
<Tests, compatibility, dependency, or rollout constraints.>

## What's Been Tried
<Key wins, dead ends, and architectural notes. Keep this current.>
```

### `autoresearch.sh`

Write a fast bash script with `set -euo pipefail`. It should run any lightweight pre-checks, execute the benchmark, and keep output lean.

### `autoresearch.checks.sh`

This is optional. Only create it when correctness constraints matter. It also uses `set -euo pipefail` and should emit minimal output.

### `autoresearch.ideas.md`

When you find promising ideas you are not ready to try yet, append them as bullets to `autoresearch.ideas.md` so they survive context loss.

## Loop Rules

1. Read `autoresearch.md` at the start of the session and again after compaction or resume.
1. Use `run_experiment` instead of ad hoc shell timing.
1. Call `log_experiment` after every completed `run_experiment`.
1. `keep` only when the primary metric improved and the run is valid.
1. `discard` when the run passed but did not improve enough to keep.
1. `crash` when the benchmark failed or timed out.
1. `checks_failed` when the benchmark passed but `autoresearch.checks.sh` failed or timed out.
1. After `discard`, `crash`, or `checks_failed`, restore the worktree to the last kept commit before the next run. Use a safe restore sequence for tracked files and remove any known untracked experiment artifacts individually if needed.
1. Keep secondary metrics consistent across the current segment.
1. Update `autoresearch.md` periodically so a new agent can resume cleanly.

## Practical Guidance

1. Primary metric first. Secondary metrics are there to catch tradeoffs, not to block every improvement.
1. Prefer simpler wins over tiny gains with heavy complexity.
1. If you keep revisiting the same failed idea, stop and change approach.
1. If a run crashes for a trivial reason, fix it quickly. If not, log it and move on.
1. Think before thrashing. The best ideas usually come from understanding the workload, not random edits.
1. If the plugin exposes `/autoresearch status` or `/autoresearch dashboard`, use them to inspect the current state.

## Resume Behavior

If the loop resumes after interruption, read:

1. `autoresearch.md`
1. `autoresearch.ideas.md` when present
1. recent git history on the autoresearch branch

Then continue the loop without asking whether to proceed.
