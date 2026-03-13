# Pi Autoresearch Amp Plugin Design

## Summary

Convert `pi-autoresearch` into a workspace-local Amp plugin that preserves the original addon’s core behavior: autonomous experiment tools, persistent run history, resumable session files, dashboard-style visibility, and automatic continuation across agent turns. The port should live in the current workspace and work without publishing or packaging.

The implementation will use a local runtime plugin at `.amp/plugins/pi-autoresearch.ts` and a local skill at `.agents/skills/autoresearch-create/SKILL.md`. The plugin owns tools, lifecycle orchestration, UI state, and persistence. The skill owns the setup flow that creates experiment files and starts the loop.

## Goals

- Preserve the original three-tool experiment loop: `init_experiment`, `run_experiment`, and `log_experiment`.
- Preserve the durable file contract: `autoresearch.md`, `autoresearch.sh`, optional `autoresearch.checks.sh`, optional `autoresearch.ideas.md`, and `autoresearch.jsonl`.
- Preserve automatic continuation so the loop can keep running across agent turns.
- Preserve a compact status view and an expanded dashboard view as closely as Amp’s local plugin API allows.
- Preserve the original skill-driven setup experience for starting a new autoresearch session.

## Non-Goals

- Publishing a standalone marketplace plugin or external package.
- Changing the experiment data model or file formats unless Amp requires a small compatibility adjustment.
- Adding new experiment policy beyond what the original addon already enforces.

## Capability Ladder

The port should be designed around verified and optional runtime capabilities instead of assuming full pi parity.

### Required Capabilities

- local plugin loading from `.amp/plugins`
- slash-command registration for the `/autoresearch` command surface
- tool registration
- workspace file I/O
- shell execution in the workspace

### Optional Capabilities

- compact status rendering
- custom overlay or fullscreen dashboard rendering
- keyboard shortcut registration
- start-of-turn prompt injection
- end-of-turn automatic continuation messages

### Fallback Rules

- If compact status is unavailable, expose the same summary via `/autoresearch status`.
- If overlay rendering is unavailable, expose the dashboard via `/autoresearch dashboard` as formatted text.
- If keyboard shortcuts are unavailable, keep dashboard access command-driven.
- If prompt injection is unavailable, rely on the skill and command-triggered resume messages.
- If end-of-turn continuation is unavailable, preserve the loop through explicit resume commands instead of implicit follow-up messages.

If slash-command registration is unavailable, this v1 plugin is not supported because the command surface is the required fallback for the optional UI features.

## Workspace Layout

The port will add these files to the current workspace:

- `.amp/plugins/pi-autoresearch.ts` — local Amp runtime plugin.
- `.agents/skills/autoresearch-create/SKILL.md` — local skill adapted from the pi version.
- `docs/superpowers/specs/2026-03-13-pi-autoresearch-amp-plugin-design.md` — this design document.

The runtime plugin will operate against these user-session files in the workspace root:

- `autoresearch.md`
- `autoresearch.sh`
- `autoresearch.checks.sh` when needed
- `autoresearch.ideas.md` when needed
- `autoresearch.jsonl`

## Architecture

### Runtime Plugin

The local plugin in `.amp/plugins/pi-autoresearch.ts` will be the Amp-native replacement for the pi extension. It will:

- register the three experiment tools
- register the `/autoresearch` command surface
- rehydrate experiment state from `autoresearch.jsonl`
- manage compact status and expanded dashboard views
- inject short autoresearch reminders into agent turns when mode is active
- continue the loop automatically at the end of productive agent turns

The plugin will treat disk as the source of truth. In-memory state is only a cache for the active session, current overlay state, spinner state, and the most recent checks result.

### Setup Skill

The local skill in `.agents/skills/autoresearch-create/SKILL.md` will remain a prompt artifact. It will instruct the agent to:

- gather or infer the goal, command, metric, scope, and constraints
- verify `git rev-parse --is-inside-work-tree` succeeds before creating any session files
- verify an autoresearch branch can be created or checked out before activating the session
- study the relevant code before writing benchmark files
- create `autoresearch.md` and `autoresearch.sh`
- create `autoresearch.checks.sh` only when correctness constraints require it
- call `init_experiment`, run the baseline, log it, and start the loop immediately

This separation keeps runtime behavior out of the skill and preserves the original addon’s design.

## Git Policy

Full behavior requires a git repository because the original addon creates a branch, records commit hashes, and auto-commits kept results.

The Amp port will use this policy:

- If the workspace is a git repository, preserve original behavior: create or use an autoresearch branch, store commit hashes, and auto-commit `keep` results.
- If the workspace is not a git repository, fail early during setup before creating session files or activating mode, with a clear message that git is required for full autoresearch behavior.

Worktree rules for v1:

- setup requires a clean worktree before the session begins
- the setup skill may then create and commit the initial session files on the autoresearch branch
- `keep` commits experiment code changes and tracked session-document changes, but excludes transient files such as `autoresearch.jsonl` and `.amp/pi-autoresearch.pending.json`
- after `discard`, `crash`, or `checks_failed`, the agent must restore the worktree to the last kept commit before starting the next experiment

This keeps behavior explicit and avoids silently degrading provenance or loop semantics.

## Data Model

### Session Log

`autoresearch.jsonl` remains append-only. It stores:

- `config` records that mark a new segment and define the current experiment name, metric name, metric unit, and optimization direction
- experiment result records with commit, primary metric, optional secondary metrics, status, description, timestamp, and segment index

Example records:

```json
{"type":"config","name":"Vitest speed","metricName":"wall_clock","metricUnit":"s","bestDirection":"lower","secondaryMetrics":["test_count"]}
{"run":1,"commit":"abc1234","metric":12.42,"metrics":{"test_count":184},"status":"keep","description":"baseline","timestamp":1773369600000,"segment":0}
```

Each new `config` record starts a new baseline segment. The first experiment in a segment is the baseline for delta calculations.

### Pending Run State

The plugin will persist a small pending-run record between `run_experiment` and `log_experiment` at `.amp/pi-autoresearch.pending.json`. This prevents reloads or context transitions from losing the latest benchmark and checks outcome before the result is logged.

The pending record should include:

- run identifier
- command
- benchmark duration
- benchmark exit state
- checks exit state when checks ran
- tail output
- timestamp

Pending-run rules:

- only one pending run may exist at a time
- each `run_experiment` replaces the prior pending run
- `log_experiment` must reference the current pending `run_id`
- successful `log_experiment` clears the pending record
- if the pending record is missing, stale, or mismatched, `log_experiment` fails with a repair message
- `pause` and `stop` do not silently delete pending-run state
- `init_experiment` rejects when a pending run exists unless the user clears it intentionally

### In-Memory State

The plugin will keep a derived state object that includes:

- all parsed results
- current segment index
- experiment name
- primary metric definition
- secondary metric definitions frozen at `init_experiment` when `secondary_metric_names` is provided, otherwise frozen from the first logged baseline result in the current segment
- baseline value for the current segment
- current UI mode such as collapsed or expanded dashboard
- current run information for spinner and overlay rendering

The plugin will rebuild this state from `autoresearch.jsonl` whenever it needs to recover from reloads or session changes.

## Command And Tool Behavior

### Command Surface

The plugin will expose these commands, with graceful degradation if Amp supports only a subset of command types:

- `/autoresearch start <goal>` or `/autoresearch <goal>` — begin or resume setup
- `/autoresearch status` — show compact status in text form
- `/autoresearch dashboard` — show the expanded dashboard
- `/autoresearch resume` — resume a paused active session
- `/autoresearch pause` — pause automatic continuation while keeping session files intact
- `/autoresearch stop` — end active mode for the current workspace session

### `init_experiment`

This tool sets the current experiment name, primary metric name, primary metric unit, and optimization direction. It writes a `config` line into `autoresearch.jsonl`, clears current-segment derived state, and enables autoresearch mode.

Input contract:

- `name: string`
- `metric_name: string`
- `metric_unit?: string`
- `direction?: "lower" | "higher"`
- `secondary_metric_names?: string[]`

Behavior matches the original addon:

- first initialization creates the log file
- reinitialization appends a new `config` line and starts a new baseline segment
- the response tells the agent to run the baseline next

### `run_experiment`

This tool runs the provided shell command in the workspace, measures wall-clock duration, captures tail output, and classifies the result.

Input contract:

- `command: string`
- `timeout_seconds?: number` with default `600`
- `checks_timeout_seconds?: number` with default `300`

Output contract:

- `run_id: string`
- `command: string`
- `duration_seconds: number`
- `exit_code: number | null`
- `passed: boolean`
- `timed_out: boolean`
- `checks_pass: boolean | null`
- `checks_timed_out: boolean`
- `tail_output: string`
- `checks_output: string`

If `autoresearch.checks.sh` exists and the benchmark itself passes, the tool runs checks separately. Checks do not affect the primary metric timing. The tool reports:

- benchmark pass or failure
- timeout state
- checks pass, failure, or timeout
- recent benchmark output
- recent checks output when checks fail

The primary metric for v1 is the measured wall-clock duration from `run_experiment`. Secondary metrics are supplied later to `log_experiment`. This keeps metric collection explicit and aligned with the original runtime behavior.

The tool also writes the pending-run record so `log_experiment` can validate the final status even after a plugin reload.

### `log_experiment`

This tool records the result of the latest experiment. It will:

Input contract:

- `run_id: string`
- `status: "keep" | "discard" | "crash" | "checks_failed"`
- `description: string`
- `metrics?: Record<string, number>`

- reject `keep` when the latest checks failed or timed out
- validate consistency of secondary metrics across runs
- append the final record to `autoresearch.jsonl`
- auto-commit on `keep` with a `Result:` trailer that includes the primary and secondary metrics
- skip commit for `discard`, `crash`, and `checks_failed`
- update the visible status and dashboard

The primary metric comes from the current pending run’s measured wall-clock duration. `log_experiment` does not accept an explicit primary metric input in v1.

The plugin derives commit hashes internally. In the JSONL record, `commit` means the commit associated with the workspace after logging:

- on `keep`, `commit` is the new auto-commit hash
- on `discard`, `crash`, and `checks_failed`, `commit` is the evaluated pre-log `HEAD` hash

Allowed status transitions are strict:

- failed or timed-out benchmark → only `crash`
- passed benchmark with failed or timed-out checks → `checks_failed` or `discard`, but never `keep`
- passed benchmark and passed or absent checks → `keep` or `discard`

`keep` is atomic in v1. If the auto-commit fails, `log_experiment` fails and does not write a `keep` record to `autoresearch.jsonl`.

The tool response should be concise but explicit about baseline, metric deltas, git commit outcome, and total experiment count.

## UI Behavior

### Compact Status

The plugin should show a compact status line that mirrors the original widget as closely as the Amp plugin API allows. The compact view should summarize:

- run count
- kept run count
- crash and checks-failed counts when non-zero
- best or baseline primary metric
- percent delta from the baseline when available
- secondary metric summaries when available
- current experiment name

### Expanded Dashboard

The plugin should expose an expanded dashboard view that lists recent experiment rows, highlights the baseline and best result, and shows primary and secondary metric deltas. If Amp’s local plugin API supports a custom overlay view, the plugin should use it. If not, the same content should be available through a command-driven text view.

### Keyboard Shortcuts

Keyboard shortcut parity is the one uncertain area. If the local Amp runtime supports shortcut registration, the plugin should mirror the original bindings for expand and fullscreen dashboard views. If the runtime does not support shortcuts, the plugin should preserve behavior through commands and status-driven messaging rather than dropping the dashboard entirely.

## Lifecycle Behavior

### Mode Detection

The plugin supports one active autoresearch session per workspace. Session files on disk are recoverable state, not automatic perpetual activation.

Autoresearch mode becomes active when:

- the user invokes `/autoresearch start`, `/autoresearch <goal>`, or `/autoresearch resume`
- or `init_experiment` completes successfully for the current workspace session

Autoresearch mode becomes paused when the user invokes `/autoresearch pause`.

Autoresearch mode stops when the user invokes `/autoresearch stop`.

Mode persistence rules for v1:

- active, paused, and stopped state is runtime state, not durable project state
- plugin reload or a fresh Amp session rehydrates experiment data from disk but does not automatically reactivate active mode
- after reload, the session is recoverable through `/autoresearch resume`

When the mode is active, the plugin injects a short reminder into the agent start flow that points the agent back to `autoresearch.md`, the loop contract, the checks file if present, and the ideas backlog if present.

### Rehydration

On relevant plugin lifecycle boundaries, the plugin reconstructs current state from `autoresearch.jsonl`. This keeps the loop resumable even if the plugin reloads or the agent context resets.

### Auto-Continuation

At the end of a productive agent turn, if autoresearch mode is active and the session actually logged an experiment result, the plugin sends a follow-up continuation message when the runtime supports it. That message tells the agent to resume from `autoresearch.md` and to consult `autoresearch.ideas.md` when present. A rate limit and a loop cap should prevent rapid accidental loops.

If post-turn continuation is unavailable in the runtime, the plugin should preserve the session and require explicit `/autoresearch resume` commands instead of pretending the loop is still autonomous.

## Error Handling

The plugin should fail soft where possible:

- persistence errors should produce a clear tool result instead of crashing the plugin
- git commit failures should be surfaced in the tool result and should prevent a `keep` record from being written
- malformed JSONL lines should be skipped during rehydration
- missing secondary metrics and unexpected new metrics should be rejected with exact repair guidance

The loop should preserve forward progress while protecting result integrity.

Malformed JSONL lines should be skipped during rehydration, but the plugin should also surface a warning that includes the affected line number so silent corruption is easier to debug.

## Testing Strategy

### Pure Logic Checks

Extract and verify small helpers for:

- JSONL reconstruction
- current-segment selection
- baseline calculation
- best-run comparison logic
- secondary metric validation
- delta formatting

### Runtime Verification

Manually verify the full loop in a disposable workspace:

1. invoke the skill and create a fresh session
2. initialize and log a baseline
3. log a kept improvement and confirm auto-commit
4. log a discarded regression and confirm no commit
5. trigger a checks failure and confirm `keep` is rejected
6. verify state survives plugin reload from `autoresearch.jsonl`
7. verify compact status, expanded dashboard, and auto-continuation behavior

## Risks

- Amp’s local plugin API may differ from the observed example for status or overlay behavior.
- Keyboard shortcuts may require a graceful command-based fallback.
- The current workspace is not a git repository, so the design document itself cannot be committed here without moving the work into a repo.

## Implementation Plan

1. Create the local skill by adapting the original `autoresearch-create` skill to Amp’s skill format and language.
2. Implement the runtime plugin with shared helper functions for parsing, formatting, and validation.
3. Wire lifecycle hooks, mode injection, auto-resume, and dashboard behavior.
4. Run end-to-end validation in the workspace and adjust any API mismatches.
