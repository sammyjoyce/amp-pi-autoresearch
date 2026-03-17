# AGENTS.md — amp-pi-autoresearch

This is an Amp plugin that gives Amp a repeatable experiment loop (autoresearch). The plugin lives at `.amp/plugins/pi-autoresearch.ts`, the setup skill at `.agents/skills/autoresearch-create/SKILL.md`.

## Compounded Learnings

These learnings were extracted from real work sessions. They exist so future agents avoid repeating the same mistakes.

### Amp Plugin API

- **Commands cannot start agent turns.** `registerCommand` handlers can call `ui.*` methods but cannot synthesize agent turns. Use the `agent.start` hook to inject context into the next turn, and `agent.end` with `{ action: 'continue' }` for auto-continuation.
- **Use the "queued start message" pattern.** When a command gathers user input (e.g., via `ctx.ui.input`), store it in runtime state. On the next `agent.start` event, detect the queued data, inject it as a system message, and clear the queue.
- **Inline command arguments are not supported.** Amp's UI does not pass inline arguments like `/autoresearch <goal>` to the plugin handler. Use `ctx.ui.input` to gather parameters interactively instead.
- **Global plugins vs global skills live in different directories.** Plugins go in `~/.config/amp/plugins/`. Skills go in `~/.agents/skills/` (or the repo-local `.agents/skills/`). Do not nest skills inside the plugin directory.
- **TypeScript verification is not possible at dev time.** The `@ampcode/plugin` types are only available at Amp runtime. When working on this plugin, create an ambient declaration file (`ampcode-plugin-observed-api.d.ts`) to capture the observed API surface for editor support.
- **Tool `execute()` callbacks do not receive `ctx`.** Cache the `ui` handle from command or event context via a helper like `rememberUI(ctx)` and reuse it in tool handlers.
- **Feature-detect optional plugin APIs at runtime.** Guard calls like `registerShortcut` with `typeof api.registerShortcut === 'function'` rather than assuming they exist in every Amp build.
- **Use `ctx.ui.custom(factory, options)` for interactive TUI overlays.** This is the pattern for richer dashboard-style UI beyond plain `input` and `confirm` prompts.

### Shell and CI

- **Never pass complex strings directly to CLI commands.** Strings with single quotes, backticks, or parentheses cause shell syntax errors. Use a heredoc to capture the message body into a variable first:
  ```bash
  body=$(cat <<'EOF'
  Message with 'quotes' and (parens)
  EOF
  )
  gh api -X POST ... -f body="$body"
  ```
- **Avoid login shells inside `nix develop`.** Using `nix develop -c bash -lc '...'` re-initializes the environment and strips Nix-injected PATH entries. Use `nix develop --command bash -euo pipefail -c '...'` instead.
- **When all CI jobs fail simultaneously but pass locally, suspect infrastructure.** Retry before attempting code changes. Use `--retry-failed-now` as the first step.
- **Prefer `nix eval --json` for machine-readable output.** Plain `nix eval` can be polluted by `shellHook` banners or other shell startup output.
- **Do not embed Bash array expansions inside Nix strings.** Nix treats `${...}` as Nix interpolation; restructure so Bash expands `${arr[@]}` at runtime, not at Nix evaluation time.
- **Use `nix flake check --no-build` as a fast pre-commit gate.** It validates evaluation, modules, and formatting without triggering expensive builds.

### NixOS Runners

- **Do not combine `programs.X.enable` with `xdg.configFile` for the same tool.** Both attempt to manage the same config path, causing a collision. Instead, install the package via `home.packages` and use `xdg.configFile` for the symlink:
  ```nix
  home.packages = [ pkgs.tmux ];
  xdg.configFile."tmux/tmux.conf".source = config.lib.file.mkOutOfStoreSymlink "...";
  ```
- **Runner diagnostics live in `_diag/`.** Check `/var/lib/github-runner/<name>/_diag/Worker_*.log` for exact script literals and environment mappings sent by GitHub Actions.
- **Blanket state directory cleanup is fragile.** The upstream NixOS `services.github-runners` module runs `find "$STATE_DIRECTORY/" -mindepth 1 -delete` which fails if a legacy `work` directory is mounted or busy. Exclude known problematic paths or handle errors gracefully.
- **Systemd hardening affects shell behavior in runners.** Options like `ProtectHome` and minimal `PATH` change how login shells resolve commands compared to a standard user session. Test workflow commands under the same constraints as the service unit.

### Closed Review Loop

- **Always write terminal statuses.** When a PR is merged, closed, or cancelled, automation must explicitly write `SUCCESS` or `NEUTRAL` for all its commit status contexts. Stale `PENDING` statuses create misleading UI.
- **Deduplicate reviews before posting.** Check if the `(session_id, base_sha, head_sha)` triplet has already been reviewed. Posting "no actionable findings" on duplicate runs is noise.
- **Use GraphQL for bulk GitHub queries.** `gh search prs` triggers secondary rate limits under high-churn patterns. Switch to `gh api graphql` for batch data retrieval.
- **Commit status `targetUrl` must never be null.** Always set `targetUrl` to a useful link (session timeline, logs, or at minimum the check run page). A null URL makes the "Details" link useless for debugging.
- **Short-circuit review when there is no diff.** If `base_sha == head_sha` or the computed diff is empty, exit early instead of posting redundant "no actionable findings" reviews.
- **Use `gh pr merge --match-head-commit <sha>` in automation.** This prevents merging the wrong head if new commits land between review and merge.
- **Verify remote PR state before babysitting.** Run `gh pr view` first; the PR may already be merged/closed remotely, making babysitting actions unnecessary.
- **Treat empty reviewer output as a structured failure.** When the reviewer produces no response, log it as a loop failure with links to session logs rather than posting a benign "no findings" comment.

### Git Workflow

- **Use `git worktree add` for isolated PRs.** When the local repo has unrelated changes, create a clean worktree for the specific fix. This avoids including unrelated edits in `nix flake check` or PR diffs.

### Upstream Research Methodology

- **Separate "consumer guarantee" from "incidental detail" in every spec.** When researching upstream code for porting, classify each behavior as either a stable product contract (what consumers rely on) or an implementation detail (what happens to be true today). Over-specifying internals creates brittle specs that break during cross-language ports.
- **Use the "one-sentence-without-'and'" test for topic boundaries.** If you cannot describe a spec topic in one sentence without the conjunction "and," the topic is too broad and should be split. This prevents unstable "junk drawer" specs.
- **Group specs by stage boundaries, not package boundaries.** For cross-language ports, organize by semantic phases (e.g., builder → planner → runtime) rather than source-package structure. Package boundaries are an artifact of the original language's module system and may not apply in the target.
- **Exclude timing constants from product specs.** Retry intervals, timeout values, debounce durations, and ping/pong cadences are tuning parameters, not contractual guarantees. Document them as "implementation notes" rather than required behavior.
- **Verify Oracle findings against source code.** When using the Oracle for architectural analysis, always ground its conclusions by reading the actual upstream files. The Oracle can overclaim behaviors that tests don't actually prove.

### Zero Upstream Architecture (Key Discoveries)

- **SQLite NULL + OR = full table scan.** When building `OR` queries with bound parameters in SQLite, if any branch involves a `NULL` value, SQLite abandons its `MULTI-INDEX OR` optimization and falls back to a full table scan (320x slowdown observed). Filter out NULL conditions before building OR queries.
- **The "record-then-delegate" pattern is a semantic seam.** In `Connection.send()`, the timestamp update is unconditional while the actual transport is conditional on socket state. This is not mere utility extraction — the boundary dictates which effects are unconditional vs. gated. Respect these boundaries when porting.
- **Poke delivery is coalesced, not 1:1.** Multiple completed pokes received before a scheduled callback are merged into a single local apply. Do not assume a 1:1 mapping between server pokes and client listener calls.
- **`got` is a protocol marker, not a hydration signal.** The `got` callback tracks whether the server has marked a query in the `gotQueries` set, not whether data has been loaded. Materialized views deliver data independently via their own listener mechanism.
- **`needs-auth` and `error` are "paused" states, not terminal.** They halt the auto-retry run loop but are resumable via `connect()`. Only `closed` is truly terminal.
- **Auth revision uses a watermark pattern.** The committed auth revision (`#lastAuthRevision`) is separate from the live session revision. The watermark only advances after successful query re-evaluation, preventing stale auth from being considered "applied."
- **Mutation retry is error-persistence, not recovery.** On transaction failure, the server retries once but skips the mutator — it only bumps the LMID and writes the error. This ensures mutation ordering is preserved even on failure.
- **`disconnected` still auto-retries.** Unlike `needs-auth`/`error`, the `disconnected` state keeps the run loop active with backoff. Do not treat it as a paused state.

### Autoresearch Loop

- **Read `autoresearch.md` before every iteration.** It is the durable handoff document. Skipping it leads to repeated dead-end experiments.
- **`keep` only when the primary metric improved and the run is valid.** Do not keep runs that only improve secondary metrics.
- **After `discard`/`crash`/`checks_failed`, restore the worktree to the last kept commit before the next run.** Forgetting this contaminates subsequent experiments.
