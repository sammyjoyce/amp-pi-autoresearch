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

### Closed Review Loop

- **Always write terminal statuses.** When a PR is merged, closed, or cancelled, automation must explicitly write `SUCCESS` or `NEUTRAL` for all its commit status contexts. Stale `PENDING` statuses create misleading UI.
- **Deduplicate reviews before posting.** Check if the `(session_id, base_sha, head_sha)` triplet has already been reviewed. Posting "no actionable findings" on duplicate runs is noise.
- **Use GraphQL for bulk GitHub queries.** `gh search prs` triggers secondary rate limits under high-churn patterns. Switch to `gh api graphql` for batch data retrieval.
- **Commit status `targetUrl` must never be null.** Always set `targetUrl` to a useful link (session timeline, logs, or at minimum the check run page). A null URL makes the "Details" link useless for debugging.
- **Short-circuit review when there is no diff.** If `base_sha == head_sha` or the computed diff is empty, exit early instead of posting redundant "no actionable findings" reviews.
- **Use `gh pr merge --match-head-commit <sha>` in automation.** This prevents merging the wrong head if new commits land between review and merge.
- **Verify remote PR state before babysitting.** Run `gh pr view` first; the PR may already be merged/closed remotely, making babysitting actions unnecessary.

### Git Workflow

- **Use `git worktree add` for isolated PRs.** When the local repo has unrelated changes, create a clean worktree for the specific fix. This avoids including unrelated edits in `nix flake check` or PR diffs.

### Autoresearch Loop

- **Read `autoresearch.md` before every iteration.** It is the durable handoff document. Skipping it leads to repeated dead-end experiments.
- **`keep` only when the primary metric improved and the run is valid.** Do not keep runs that only improve secondary metrics.
- **After `discard`/`crash`/`checks_failed`, restore the worktree to the last kept commit before the next run.** Forgetting this contaminates subsequent experiments.
