// @i-know-the-amp-plugin-api-is-wip-and-very-experimental-right-now
import type {
  AgentEndEvent,
  AgentEndResult,
  AgentStartEvent,
  AgentStartResult,
  PluginAPI,
  PluginCommandContext,
  PluginEventContext,
} from '@ampcode/plugin'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

type Direction = 'lower' | 'higher'
type ExperimentStatus = 'keep' | 'discard' | 'crash' | 'checks_failed'
type SessionMode = 'active' | 'paused'

interface ConfigRecord {
  type: 'config'
  name: string
  metricName: string
  metricUnit: string
  bestDirection: Direction
  secondaryMetrics?: string[]
}

interface ExperimentRecord {
  run: number
  commit: string
  metric: number
  metrics: Record<string, number>
  status: ExperimentStatus
  description: string
  timestamp: number
  segment: number
}

interface PendingRun {
  runID: string
  command: string
  durationSeconds: number
  exitCode: number | null
  passed: boolean
  timedOut: boolean
  checksPass: boolean | null
  checksTimedOut: boolean
  tailOutput: string
  checksOutput: string
  timestamp: number
  headCommit: string
}

interface ExperimentState {
  name: string | null
  metricName: string
  metricUnit: string
  bestDirection: Direction
  secondaryMetricNames: string[]
  currentSegment: number
  results: ExperimentRecord[]
  warnings: string[]
}

interface RuntimeSession {
  mode: SessionMode
  lastAutoContinueAtMs: number
  autoContinueCount: number
  turnLoggedRunID?: string
  lastContinuedRunID?: string
}

interface ShellResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

interface UIApi {
  notify?: (message: string, level?: string) => Promise<void> | void
  setStatus?: (key: string, value?: string) => Promise<void> | void
  custom?: (...args: any[]) => Promise<void> | void
}

type AnyContext = {
  ui?: UIApi
}

type Directive =
  | { kind: 'none' }
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'dashboard' }
  | { kind: 'resume' }
  | { kind: 'pause' }
  | { kind: 'stop' }
  | { kind: 'start'; objective: string }

const STATUS_KEY = 'pi-autoresearch'
const AUTO_CONTINUE_MIN_INTERVAL_MS = 15 * 1000
const AUTO_CONTINUE_MAX_LOOPS = 200
const MAX_OUTPUT_LINES = 80
const MAX_NOTIFY_CHARS = 3500

const INIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: {
      type: 'string',
      description: 'Human-readable name for the current experiment session.',
    },
    metric_name: {
      type: 'string',
      description: 'Display name for the primary metric.',
    },
    metric_unit: {
      type: 'string',
      description: 'Unit for the primary metric. Leave empty for unitless metrics.',
    },
    direction: {
      type: 'string',
      enum: ['lower', 'higher'],
      description: 'Whether lower or higher values are better.',
    },
    secondary_metric_names: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional list of secondary metrics to freeze for this segment.',
    },
  },
  required: ['name', 'metric_name'],
} as const

const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: {
      type: 'string',
      description: 'Shell command to benchmark.',
    },
    timeout_seconds: {
      type: 'number',
      description: 'Benchmark timeout in seconds. Defaults to 600.',
    },
    checks_timeout_seconds: {
      type: 'number',
      description: 'Checks timeout in seconds. Defaults to 300.',
    },
  },
  required: ['command'],
} as const

const LOG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    run_id: {
      type: 'string',
      description: 'Run identifier returned by run_experiment.',
    },
    status: {
      type: 'string',
      enum: ['keep', 'discard', 'crash', 'checks_failed'],
      description: 'Outcome classification for the current pending run.',
    },
    description: {
      type: 'string',
      description: 'Short description of the experiment change.',
    },
    metrics: {
      type: 'object',
      additionalProperties: { type: 'number' },
      description: 'Optional secondary metric values keyed by metric name.',
    },
  },
  required: ['run_id', 'status', 'description'],
} as const

export default function piAutoresearchPlugin(amp: PluginAPI) {
  let session: RuntimeSession | null = null
  let lastUI: UIApi | null = null

  amp.registerTool({
    name: 'init_experiment',
    description:
      'Initialize or reinitialize an autoresearch session. Writes a config header to autoresearch.jsonl and enables autoresearch mode.',
    inputSchema: INIT_SCHEMA,
    async execute(input) {
      const root = workspaceRoot()
      const params = parseInitInput(input)
      if (!params.ok) {
        return params.error
      }

      if (!isGitRepo(root)) {
        return fail('Autoresearch requires a git repository. Run setup inside a git worktree.')
      }

      if (loadPendingRun(root)) {
        return fail('A pending run exists. Log or clear it before reinitializing the experiment.')
      }

      const paths = workspacePaths(root)
      const logExists = existsSync(paths.log)
      if (!logExists && !isCleanWorktree(root)) {
        return fail('Setup requires a clean worktree before the first init_experiment call.')
      }

      const record: ConfigRecord = {
        type: 'config',
        name: params.value.name,
        metricName: params.value.metricName,
        metricUnit: params.value.metricUnit,
        bestDirection: params.value.direction,
        secondaryMetrics: params.value.secondaryMetricNames,
      }

      try {
        appendJSONL(paths.log, record)
      } catch (error) {
        return fail(`Failed to write autoresearch.jsonl: ${errorMessage(error)}`)
      }

      session = session ?? createSession('active')
      session.mode = 'active'
      await refreshUI()

      return ok({
        initialized: true,
        reinitialized: logExists,
        name: record.name,
        metric_name: record.metricName,
        metric_unit: record.metricUnit,
        direction: record.bestDirection,
        secondary_metric_names: record.secondaryMetrics ?? [],
        next: 'Run the baseline with run_experiment, then record it with log_experiment.',
      })
    },
  })

  amp.registerTool({
    name: 'run_experiment',
    description:
      'Run the current benchmark command, measure wall-clock duration, and execute optional autoresearch checks.',
    inputSchema: RUN_SCHEMA,
    async execute(input) {
      const root = workspaceRoot()
      const params = parseRunInput(input)
      if (!params.ok) {
        return params.error
      }

      if (!isGitRepo(root)) {
        return fail('Autoresearch requires a git repository before experiments can run.')
      }

      const state = loadExperimentState(root)
      if (!existsSync(workspacePaths(root).log) || !state.name) {
        return fail('No autoresearch session is initialized. Call init_experiment first.')
      }

      const headCommit = currentHeadCommit(root)
      if (!headCommit) {
        return fail('Failed to resolve HEAD before running the experiment.')
      }

      const benchmark = await execShell(params.value.command, root, params.value.timeoutSeconds * 1000)
      let checksPass: boolean | null = null
      let checksTimedOut = false
      let checksOutput = ''

      const checksPath = workspacePaths(root).checks
      if (benchmark.code === 0 && !benchmark.timedOut && existsSync(checksPath)) {
        const checks = await execShell(`bash ${shellQuote(checksPath)}`, root, params.value.checksTimeoutSeconds * 1000)
        checksPass = checks.code === 0 && !checks.timedOut
        checksTimedOut = checks.timedOut
        checksOutput = tailLines(joinOutput(checks.stdout, checks.stderr), MAX_OUTPUT_LINES)
      }

      const pending: PendingRun = {
        runID: randomUUID(),
        command: params.value.command,
        durationSeconds: benchmark.durationSeconds,
        exitCode: benchmark.code,
        passed: benchmark.code === 0 && !benchmark.timedOut,
        timedOut: benchmark.timedOut,
        checksPass,
        checksTimedOut,
        tailOutput: tailLines(joinOutput(benchmark.stdout, benchmark.stderr), MAX_OUTPUT_LINES),
        checksOutput,
        timestamp: Date.now(),
        headCommit,
      }

      try {
        savePendingRun(root, pending)
      } catch (error) {
        return fail(`Failed to persist pending run: ${errorMessage(error)}`)
      }
      await refreshUI()

      return ok({
        run_id: pending.runID,
        command: pending.command,
        duration_seconds: pending.durationSeconds,
        exit_code: pending.exitCode,
        passed: pending.passed,
        timed_out: pending.timedOut,
        checks_pass: pending.checksPass,
        checks_timed_out: pending.checksTimedOut,
        tail_output: pending.tailOutput,
        checks_output: pending.checksOutput,
        summary: buildRunSummary(pending),
      })
    },
  })

  amp.registerTool({
    name: 'log_experiment',
    description:
      'Record the current pending experiment result. keep auto-commits. Non-keep results do not commit and should be restored before the next run.',
    inputSchema: LOG_SCHEMA,
    async execute(input) {
      const root = workspaceRoot()
      const params = parseLogInput(input)
      if (!params.ok) {
        return params.error
      }

      const pending = loadPendingRun(root)
      if (!pending) {
        return fail('No pending run exists. Call run_experiment before log_experiment.')
      }

      if (pending.runID !== params.value.runID) {
        return fail('The provided run_id does not match the current pending run. Re-run the benchmark or log the current pending run.')
      }

      const state = loadExperimentState(root)
      const currentSegmentResults = resultsForSegment(state, state.currentSegment)
      const expectedSecondary = currentSegmentSecondaryMetrics(state)
      const providedSecondary = normalizeMetricRecord(params.value.metrics)

      const transitionError = validateStatusTransition(params.value.status, pending)
      if (transitionError) {
        return fail(transitionError)
      }

      const secondaryError = validateSecondaryMetrics(
        currentSegmentResults,
        expectedSecondary,
        providedSecondary,
      )
      if (secondaryError) {
        return fail(secondaryError)
      }

      const nextRunNumber = state.results.length + 1
      const metricsForRecord = materializeSecondaryMetrics(
        currentSegmentResults,
        expectedSecondary,
        providedSecondary,
      )

      let commit = pending.headCommit
      if (params.value.status === 'keep') {
        const commitResult = commitKeepResult(root, params.value.description, pending.durationSeconds, metricsForRecord, state.metricName)
        if (!commitResult.ok) {
          return fail(commitResult.error)
        }
        commit = commitResult.commit
      }

      const record: ExperimentRecord = {
        run: nextRunNumber,
        commit,
        metric: pending.durationSeconds,
        metrics: metricsForRecord,
        status: params.value.status,
        description: params.value.description,
        timestamp: Date.now(),
        segment: state.currentSegment,
      }

      try {
        appendJSONL(workspacePaths(root).log, record)
        clearPendingRun(root)
      } catch (error) {
        return fail(`Failed to persist experiment result: ${errorMessage(error)}`)
      }

      session = session ?? createSession('active')
      session.turnLoggedRunID = pending.runID
      session.mode = session.mode === 'paused' ? 'paused' : 'active'
      await refreshUI()

      return ok({
        logged: true,
        run_id: pending.runID,
        run: record.run,
        commit: record.commit,
        metric: record.metric,
        metrics: record.metrics,
        status: record.status,
        description: record.description,
        restore_hint:
          record.status === 'keep'
            ? ''
            : 'Restore the worktree to the last kept commit before the next experiment.',
        summary: buildLogSummary(loadExperimentState(root), record),
      })
    },
  })

  registerCommands(amp)
  registerOptionalShortcuts(amp)

  amp.on('agent.start', async (event, ctx) => {
    rememberUI(ctx)
    if (session) {
      session.turnLoggedRunID = undefined
    }
    return handleAgentStart(event, ctx)
  })

  amp.on('agent.end', async (event, ctx) => {
    rememberUI(ctx)
    return handleAgentEnd(event, ctx)
  })

  function registerCommands(plugin: PluginAPI) {
    plugin.registerCommand(
      'autoresearch',
      {
        category: 'Autoresearch',
        title: 'Autoresearch',
        description: 'Show autoresearch usage and available controls.',
      },
      async (ctx: PluginCommandContext) => {
        rememberUI(ctx)
        await safeNotify(ctx.ui, helpText())
      },
    )

    plugin.registerCommand(
      'autoresearch-help',
      {
        category: 'Autoresearch',
        title: 'Usage',
        description: 'Show autoresearch usage and controls.',
      },
      async (ctx: PluginCommandContext) => {
        rememberUI(ctx)
        await safeNotify(ctx.ui, helpText())
      },
    )

    plugin.registerCommand(
      'autoresearch-status',
      {
        category: 'Autoresearch',
        title: 'Status',
        description: 'Show the current autoresearch summary.',
      },
      async (ctx: PluginCommandContext) => {
        rememberUI(ctx)
        await safeNotify(ctx.ui, buildStatusReport(workspaceRoot(), session))
      },
    )

    plugin.registerCommand(
      'autoresearch-dashboard',
      {
        category: 'Autoresearch',
        title: 'Dashboard',
        description: 'Show the expanded autoresearch dashboard.',
      },
      async (ctx: PluginCommandContext) => {
        rememberUI(ctx)
        await showDashboard(ctx.ui)
      },
    )

    plugin.registerCommand(
      'autoresearch-resume',
      {
        category: 'Autoresearch',
        title: 'Resume',
        description: 'Resume an existing autoresearch session.',
      },
      async (ctx: PluginCommandContext) => {
        rememberUI(ctx)
        const message = activateRecoverableSession()
        await safeNotify(ctx.ui, message)
      },
    )

    plugin.registerCommand(
      'autoresearch-pause',
      {
        category: 'Autoresearch',
        title: 'Pause',
        description: 'Pause automatic continuation for the current session.',
      },
      async (ctx: PluginCommandContext) => {
        rememberUI(ctx)
        if (!session) {
          await safeNotify(ctx.ui, 'No active autoresearch session is running.')
          return
        }
        session.mode = 'paused'
        await refreshUI()
        await safeNotify(ctx.ui, 'Autoresearch is paused. Use /autoresearch resume to continue.')
      },
    )

    plugin.registerCommand(
      'autoresearch-stop',
      {
        category: 'Autoresearch',
        title: 'Stop',
        description: 'Stop the current autoresearch session.',
      },
      async (ctx: PluginCommandContext) => {
        rememberUI(ctx)
        session = null
        await refreshUI()
        await safeNotify(ctx.ui, 'Autoresearch stopped. Session files remain recoverable on disk.')
      },
    )
  }

  function registerOptionalShortcuts(plugin: PluginAPI) {
    const api = plugin as PluginAPI & {
      registerShortcut?: (key: string, options: { description: string; handler: (ctx: AnyContext) => Promise<void> | void }) => void
    }

    if (typeof api.registerShortcut !== 'function') {
      return
    }

    try {
      api.registerShortcut('ctrl+x', {
        description: 'Show autoresearch status',
        handler: async (ctx) => {
          rememberUI(ctx)
          await safeNotify(ctx.ui, buildStatusReport(workspaceRoot(), session))
        },
      })

      api.registerShortcut('ctrl+shift+x', {
        description: 'Show autoresearch dashboard',
        handler: async (ctx) => {
          rememberUI(ctx)
          await showDashboard(ctx.ui)
        },
      })
    } catch {
      return
    }
  }

  async function handleAgentStart(
    event: AgentStartEvent,
    ctx: PluginEventContext,
  ): Promise<AgentStartResult | void> {
    const directive = parseDirective(event.message)
    if (directive.kind === 'none') {
      await refreshUI()
      if (session?.mode === 'active') {
        return {
          message: {
            content: buildActiveModeReminder(workspaceRoot()),
            display: false,
          },
        }
      }
      return
    }

    switch (directive.kind) {
      case 'help': {
        const message = helpText()
        await safeNotify(ctx.ui, message)
        return commandHandledResult(message)
      }
      case 'status': {
        const message = buildStatusReport(workspaceRoot(), session)
        await safeNotify(ctx.ui, message)
        return commandHandledResult(message)
      }
      case 'dashboard': {
        const message = await showDashboard(ctx.ui)
        return commandHandledResult(message)
      }
      case 'pause': {
        if (!session) {
          const message = 'No active autoresearch session is running.'
          await safeNotify(ctx.ui, message)
          return commandHandledResult(message)
        }
        session.mode = 'paused'
        await refreshUI()
        const message = 'Autoresearch paused. Use /autoresearch resume to continue.'
        await safeNotify(ctx.ui, message)
        return commandHandledResult(message)
      }
      case 'stop': {
        session = null
        await refreshUI()
        const message = 'Autoresearch stopped. Session files remain recoverable on disk.'
        await safeNotify(ctx.ui, message)
        return commandHandledResult(message)
      }
      case 'resume': {
        const message = activateRecoverableSession()
        await safeNotify(ctx.ui, message)
        return commandHandledResult(message)
      }
      case 'start': {
        const root = workspaceRoot()
        if (!isGitRepo(root)) {
          const message = 'Autoresearch setup requires a git repository. Initialize or enter a git worktree first.'
          await safeNotify(ctx.ui, message)
          return commandHandledResult(message)
        }
        if (!isCleanWorktree(root)) {
          const message = 'Autoresearch setup requires a clean worktree before the session begins.'
          await safeNotify(ctx.ui, message)
          return commandHandledResult(message)
        }
        session = session ?? createSession('active')
        session.mode = 'active'
        await refreshUI()

        const paths = workspacePaths(root)
        const message = existsSync(paths.md)
          ? [
              'Autoresearch session requested.',
              'Read autoresearch.md, inspect the current autoresearch branch, and resume the loop.',
              directive.objective ? `Updated objective: ${directive.objective}` : '',
              'Use /autoresearch status or /autoresearch dashboard if you need the current summary.',
            ]
              .filter(Boolean)
              .join('\n')
          : [
              'Set up a new autoresearch session in this clean git worktree.',
              directive.objective ? `Objective: ${directive.objective}` : 'Gather the objective from the current conversation.',
              'Follow the local autoresearch-create skill instructions: create the autoresearch branch, write autoresearch.md and autoresearch.sh, commit the session files, call init_experiment, run the baseline, log it, and then keep looping.',
            ].join('\n')
        return {
          message: {
            content: message,
            display: true,
          },
        }
      }
      default:
        return
    }
  }

  async function handleAgentEnd(
    event: AgentEndEvent,
    ctx: PluginEventContext,
  ): Promise<AgentEndResult | void> {
    rememberUI(ctx)
    await refreshUI()

    if (!session || session.mode !== 'active' || !session.turnLoggedRunID) {
      return
    }

    if (event.status === 'error' || event.status === 'interrupted') {
      return
    }

    if (session.lastContinuedRunID === session.turnLoggedRunID) {
      return
    }

    const now = Date.now()
    if (session.autoContinueCount >= AUTO_CONTINUE_MAX_LOOPS) {
      session.mode = 'paused'
      await refreshUI()
      await safeNotify(ctx.ui, 'Autoresearch hit the auto-continue loop cap and is now paused.')
      return
    }

    if (now - session.lastAutoContinueAtMs < AUTO_CONTINUE_MIN_INTERVAL_MS) {
      return
    }

    session.lastAutoContinueAtMs = now
    session.autoContinueCount += 1
    session.lastContinuedRunID = session.turnLoggedRunID

    const ideasPath = workspacePaths(workspaceRoot()).ideas
    const continuation = [
      'Continue the autoresearch loop.',
      'Read autoresearch.md before choosing the next experiment.',
      existsSync(ideasPath)
        ? 'Check autoresearch.ideas.md for promising deferred ideas and prune stale entries.'
        : '',
      'Keep iterating until interrupted or blocked by a real external issue.',
    ]
      .filter(Boolean)
      .join(' ')

    return {
      action: 'continue',
      userMessage: continuation,
    }
  }

  function activateRecoverableSession(): string {
    const root = workspaceRoot()
    const paths = workspacePaths(root)
    if (!existsSync(paths.md) && !existsSync(paths.log)) {
      return 'No recoverable autoresearch session files were found in this workspace.'
    }
    session = session ?? createSession('active')
    session.mode = 'active'
    void refreshUI()
    return 'Autoresearch resumed. Read autoresearch.md and continue the loop.'
  }

  async function showDashboard(ui: UIApi | undefined): Promise<string> {
    const text = buildDashboardReport(workspaceRoot(), session)
    const custom = ui && typeof ui.custom === 'function' ? ui.custom.bind(ui) : null
    if (!custom) {
      await safeNotify(ui, text)
      return text
    }

    try {
      const lines = text.split('\n')
      await custom(
        (_tui: any, _theme: any, _kb: any, done: (value?: unknown) => void) => {
          let offset = 0
          return {
            render(width: number) {
              const height = Math.max(8, (process.stdout.rows || 40) - 2)
              const body = lines.slice(offset, offset + height)
              return body.map((line) => truncateText(line, width))
            },
            handleInput(data: string) {
              if (data === 'q' || data === '\u001b') {
                done(undefined)
                return
              }
              if (data === 'j' || data === '\u001b[B') {
                offset = Math.min(Math.max(0, lines.length - 1), offset + 1)
                return
              }
              if (data === 'k' || data === '\u001b[A') {
                offset = Math.max(0, offset - 1)
              }
            },
            invalidate() {},
            dispose() {},
          }
        },
        { overlay: true },
      )
    } catch {
      await safeNotify(ui, text)
    }

    return text
  }

  async function refreshUI() {
    if (!lastUI) {
      return
    }
    const status = buildCompactStatus(workspaceRoot(), session)
    if (typeof lastUI.setStatus === 'function') {
      try {
        await maybeAwait(lastUI.setStatus(STATUS_KEY, status || undefined))
      } catch {
        return
      }
    }
  }

  function rememberUI(ctx: AnyContext | undefined) {
    if (ctx?.ui) {
      lastUI = ctx.ui
    }
  }
}

function workspaceRoot(): string {
  return process.cwd()
}

function workspacePaths(root: string) {
  return {
    log: join(root, 'autoresearch.jsonl'),
    md: join(root, 'autoresearch.md'),
    script: join(root, 'autoresearch.sh'),
    checks: join(root, 'autoresearch.checks.sh'),
    ideas: join(root, 'autoresearch.ideas.md'),
    pending: join(root, '.amp', 'pi-autoresearch.pending.json'),
  }
}

function createSession(mode: SessionMode): RuntimeSession {
  return {
    mode,
    lastAutoContinueAtMs: 0,
    autoContinueCount: 0,
  }
}

function parseDirective(message: string): Directive {
  const trimmed = (message || '').trim()
  if (!trimmed.match(/^[/#]autoresearch\b/i)) {
    return { kind: 'none' }
  }

  const rest = trimmed.replace(/^[/#]autoresearch\b/i, '').trim()
  if (!rest || rest.toLowerCase() === 'help') {
    return { kind: 'help' }
  }

  const parts = rest.split(/\s+/)
  const command = parts[0].toLowerCase()
  const tail = rest.slice(parts[0].length).trim()

  if (command === 'status') return { kind: 'status' }
  if (command === 'dashboard') return { kind: 'dashboard' }
  if (command === 'resume') return { kind: 'resume' }
  if (command === 'pause') return { kind: 'pause' }
  if (command === 'stop' || command === 'off') return { kind: 'stop' }
  if (command === 'start') return { kind: 'start', objective: tail }
  return { kind: 'start', objective: rest }
}

function parseInitInput(input: Record<string, unknown> | unknown) {
  const value = isRecord(input) ? input : {}
  const name = asNonEmptyString(value.name)
  const metricName = asNonEmptyString(value.metric_name)
  if (!name || !metricName) {
    return { ok: false as const, error: fail('init_experiment requires name and metric_name.') }
  }
  const metricUnit = asString(value.metric_unit) ?? ''
  const direction = asDirection(value.direction) ?? 'lower'
  const secondaryMetricNames = normalizeSecondaryMetricNames(value.secondary_metric_names)
  return {
    ok: true as const,
    value: {
      name,
      metricName,
      metricUnit,
      direction,
      secondaryMetricNames,
    },
  }
}

function parseRunInput(input: Record<string, unknown> | unknown) {
  const value = isRecord(input) ? input : {}
  const command = asNonEmptyString(value.command)
  if (!command) {
    return { ok: false as const, error: fail('run_experiment requires a command string.') }
  }
  const timeoutSeconds = asPositiveNumber(value.timeout_seconds) ?? 600
  const checksTimeoutSeconds = asPositiveNumber(value.checks_timeout_seconds) ?? 300
  return {
    ok: true as const,
    value: {
      command,
      timeoutSeconds,
      checksTimeoutSeconds,
    },
  }
}

function parseLogInput(input: Record<string, unknown> | unknown) {
  const value = isRecord(input) ? input : {}
  const runID = asNonEmptyString(value.run_id)
  const status = asStatus(value.status)
  const description = asNonEmptyString(value.description)
  if (!runID || !status || !description) {
    return {
      ok: false as const,
      error: fail('log_experiment requires run_id, status, and description.'),
    }
  }
  return {
    ok: true as const,
    value: {
      runID,
      status,
      description,
      metrics: isRecord(value.metrics) ? value.metrics : {},
    },
  }
}

function loadExperimentState(root: string): ExperimentState {
  const paths = workspacePaths(root)
  const state: ExperimentState = {
    name: null,
    metricName: 'wall_clock',
    metricUnit: 's',
    bestDirection: 'lower',
    secondaryMetricNames: [],
    currentSegment: 0,
    results: [],
    warnings: [],
  }

  if (!existsSync(paths.log)) {
    return state
  }

  const text = readFileSync(paths.log, 'utf8')
  if (!text.trim()) {
    return state
  }

  const lines = text.split(/\r?\n/)
  let seenConfig = false
  let activeSegment = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) {
      continue
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line)
    } catch {
      state.warnings.push(`Malformed JSONL line ${index + 1}`)
      continue
    }

    if (parsed.type === 'config') {
      activeSegment = seenConfig ? activeSegment + 1 : 0
      seenConfig = true
      state.currentSegment = activeSegment
      state.name = asString(parsed.name) ?? state.name
      state.metricName = asString(parsed.metricName) ?? state.metricName
      state.metricUnit = asString(parsed.metricUnit) ?? state.metricUnit
      state.bestDirection = asDirection(parsed.bestDirection) ?? state.bestDirection
      state.secondaryMetricNames = normalizeSecondaryMetricNames(parsed.secondaryMetrics)
      continue
    }

    const status = asStatus(parsed.status)
    const description = asString(parsed.description)
    const metric = asNumber(parsed.metric)
    const commit = asString(parsed.commit)
    const timestamp = asPositiveInteger(parsed.timestamp)
    if (!status || description === null || metric === null || commit === null || timestamp === null) {
      state.warnings.push(`Malformed experiment record on line ${index + 1}`)
      continue
    }

    const record: ExperimentRecord = {
      run: asPositiveInteger(parsed.run) ?? state.results.length + 1,
      commit,
      metric,
      metrics: normalizeMetricRecord(parsed.metrics),
      status,
      description,
      timestamp,
      segment: asPositiveInteger(parsed.segment) ?? activeSegment,
    }
    state.results.push(record)
  }

  if (state.secondaryMetricNames.length === 0) {
    const baseline = resultsForSegment(state, state.currentSegment)[0]
    if (baseline) {
      state.secondaryMetricNames = Object.keys(baseline.metrics)
    }
  }

  return state
}

function resultsForSegment(state: ExperimentState, segment: number): ExperimentRecord[] {
  return state.results.filter((record) => record.segment === segment)
}

function currentSegmentSecondaryMetrics(state: ExperimentState): string[] {
  if (state.secondaryMetricNames.length > 0) {
    return state.secondaryMetricNames
  }
  const baseline = resultsForSegment(state, state.currentSegment)[0]
  return baseline ? Object.keys(baseline.metrics) : []
}

function loadPendingRun(root: string): PendingRun | null {
  const path = workspacePaths(root).pending
  if (!existsSync(path)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const runID = asNonEmptyString(parsed.runID)
    const command = asNonEmptyString(parsed.command)
    if (!runID || !command) {
      return null
    }
    return {
      runID,
      command,
      durationSeconds: asNumber(parsed.durationSeconds) ?? 0,
      exitCode: asNullableNumber(parsed.exitCode),
      passed: Boolean(parsed.passed),
      timedOut: Boolean(parsed.timedOut),
      checksPass: asNullableBoolean(parsed.checksPass),
      checksTimedOut: Boolean(parsed.checksTimedOut),
      tailOutput: asString(parsed.tailOutput) ?? '',
      checksOutput: asString(parsed.checksOutput) ?? '',
      timestamp: asPositiveInteger(parsed.timestamp) ?? 0,
      headCommit: asString(parsed.headCommit) ?? '',
    }
  } catch {
    return null
  }
}

function savePendingRun(root: string, pending: PendingRun) {
  const path = workspacePaths(root).pending
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(pending, null, 2) + '\n')
}

function clearPendingRun(root: string) {
  const path = workspacePaths(root).pending
  if (existsSync(path)) {
    rmSync(path)
  }
}

function appendJSONL(path: string, record: ConfigRecord | ExperimentRecord) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(record) + '\n')
}

function buildCompactStatus(root: string, session: RuntimeSession | null): string {
  const state = loadExperimentState(root)
  const current = resultsForSegment(state, state.currentSegment)
  const pending = loadPendingRun(root)
  if (current.length === 0 && !pending && !state.name && !session) {
    return ''
  }

  const baseline = current[0]?.metric ?? null
  const best = bestKeepResult(state)
  const keptCount = current.filter((record) => record.status === 'keep').length
  const crashCount = current.filter((record) => record.status === 'crash').length
  const checksFailedCount = current.filter((record) => record.status === 'checks_failed').length
  const mode = session ? session.mode : existsSync(workspacePaths(root).md) || existsSync(workspacePaths(root).log) ? 'recoverable' : ''
  const parts = ['AR']
  if (mode) {
    parts.push(mode)
  }
  if (state.name) {
    parts.push(state.name)
  }
  if (current.length > 0) {
    parts.push(`${current.length} run${current.length === 1 ? '' : 's'}`)
    parts.push(`${keptCount} kept`)
  }
  if (crashCount > 0) {
    parts.push(`${crashCount} crash`)
  }
  if (checksFailedCount > 0) {
    parts.push(`${checksFailedCount} checks_failed`)
  }
  if (best) {
    parts.push(`best ${formatMetric(best.metric, state.metricUnit)}`)
    if (baseline !== null && baseline !== 0 && best.metric !== baseline) {
      parts.push(formatDelta(best.metric, baseline, state.bestDirection))
    }
  } else if (baseline !== null) {
    parts.push(`baseline ${formatMetric(baseline, state.metricUnit)}`)
  }
  if (pending) {
    parts.push(`pending ${shortID(pending.runID)}`)
  }
  const baselineRecord = current[0]
  if (baselineRecord) {
    for (const name of currentSegmentSecondaryMetrics(state)) {
      const currentValue = best?.metrics[name] ?? baselineRecord.metrics[name]
      if (currentValue !== undefined) {
        parts.push(`${name} ${currentValue}`)
      }
    }
  }
  return parts.join(' | ')
}

function buildStatusReport(root: string, session: RuntimeSession | null): string {
  const state = loadExperimentState(root)
  const current = resultsForSegment(state, state.currentSegment)
  const pending = loadPendingRun(root)
  const lines: string[] = []
  lines.push('Autoresearch Status')
  lines.push(`Mode: ${session ? session.mode : current.length > 0 || pending ? 'recoverable' : 'inactive'}`)
  lines.push(`Session: ${state.name ?? '(not initialized)'}`)
  lines.push(`Metric: ${state.metricName} (${state.metricUnit || 'unitless'}, ${state.bestDirection} is better)`)
  lines.push(`Current segment runs: ${current.length}`)
  lines.push(`Total logged runs: ${state.results.length}`)

  const baseline = current[0]?.metric ?? null
  const best = bestKeepResult(state)
  if (baseline !== null) {
    lines.push(`Baseline: ${formatMetric(baseline, state.metricUnit)}`)
  }
  if (best) {
    lines.push(`Best keep: ${formatMetric(best.metric, state.metricUnit)} on run #${best.run}`)
  }
  if (pending) {
    lines.push(`Pending run: ${shortID(pending.runID)} | ${pending.command}`)
  }
  if (state.warnings.length > 0) {
    lines.push(`Warnings: ${state.warnings.join('; ')}`)
  }
  lines.push('Commands: /autoresearch status | /autoresearch dashboard | /autoresearch pause | /autoresearch resume | /autoresearch stop')
  return lines.join('\n')
}

function buildDashboardReport(root: string, session: RuntimeSession | null): string {
  const state = loadExperimentState(root)
  const current = resultsForSegment(state, state.currentSegment)
  const pending = loadPendingRun(root)
  const lines: string[] = []

  lines.push('Autoresearch Dashboard')
  lines.push('')
  lines.push(buildStatusReport(root, session))
  lines.push('')
  lines.push('Recent Runs')
  lines.push('run | status | metric | commit | description')
  lines.push('----|--------|--------|--------|------------')

  const recent = current.slice(-10)
  for (const record of recent) {
    lines.push(
      [
        String(record.run),
        record.status,
        formatMetric(record.metric, state.metricUnit),
        record.commit || '(none)',
        truncateText(record.description, 72),
      ].join(' | '),
    )
  }

  if (pending) {
    lines.push('')
    lines.push('Pending Run')
    lines.push(`id: ${pending.runID}`)
    lines.push(`command: ${pending.command}`)
    lines.push(`duration: ${formatMetric(pending.durationSeconds, 's')}`)
    lines.push(`benchmark: ${renderPendingOutcome(pending)}`)
    if (pending.checksPass !== null || pending.checksTimedOut) {
      lines.push(`checks: ${renderChecksOutcome(pending)}`)
    }
  }

  if (state.warnings.length > 0) {
    lines.push('')
    lines.push('Warnings')
    for (const warning of state.warnings) {
      lines.push(`- ${warning}`)
    }
  }

  return lines.join('\n')
}

function bestKeepResult(state: ExperimentState): ExperimentRecord | null {
  const current = resultsForSegment(state, state.currentSegment).filter((record) => record.status === 'keep')
  if (current.length === 0) {
    return null
  }
  return current.reduce((best, record) => {
    if (!best) {
      return record
    }
    if (state.bestDirection === 'lower') {
      return record.metric < best.metric ? record : best
    }
    return record.metric > best.metric ? record : best
  }, null as ExperimentRecord | null)
}

function buildRunSummary(pending: PendingRun): string {
  const parts = []
  if (pending.timedOut) {
    parts.push(`Benchmark timed out after ${formatMetric(pending.durationSeconds, 's')}.`)
  } else if (!pending.passed) {
    parts.push(`Benchmark failed with exit code ${pending.exitCode ?? 'unknown'} after ${formatMetric(pending.durationSeconds, 's')}.`)
  } else {
    parts.push(`Benchmark passed in ${formatMetric(pending.durationSeconds, 's')}.`)
  }

  if (pending.checksTimedOut) {
    parts.push('Checks timed out. Only checks_failed or discard is valid.')
  } else if (pending.checksPass === false) {
    parts.push('Checks failed. Only checks_failed or discard is valid.')
  } else if (pending.checksPass === true) {
    parts.push('Checks passed.')
  }
  return parts.join(' ')
}

function buildLogSummary(state: ExperimentState, record: ExperimentRecord): string {
  const baseline = resultsForSegment(state, state.currentSegment)[0]?.metric ?? record.metric
  const parts = [
    `Logged run #${record.run} as ${record.status}.`,
    `Metric: ${formatMetric(record.metric, state.metricUnit)}.`,
    `Commit: ${record.commit || '(none)'}.`,
  ]
  if (baseline !== 0 && record.metric !== baseline) {
    parts.push(`Delta vs baseline: ${formatDelta(record.metric, baseline, state.bestDirection)}.`)
  }
  return parts.join(' ')
}

function validateStatusTransition(status: ExperimentStatus, pending: PendingRun): string | null {
  if ((!pending.passed || pending.timedOut) && status !== 'crash') {
    return 'Failed or timed-out benchmarks must be logged as crash.'
  }
  if ((pending.checksPass === false || pending.checksTimedOut) && status === 'keep') {
    return 'keep is invalid when checks failed or timed out.'
  }
  if ((pending.checksPass === false || pending.checksTimedOut) && status !== 'checks_failed' && status !== 'discard') {
    return 'Checks failures may only be logged as checks_failed or discard.'
  }
  return null
}

function validateSecondaryMetrics(
  currentSegmentResults: ExperimentRecord[],
  expectedSecondary: string[],
  providedSecondary: Record<string, number>,
): string | null {
  const providedNames = Object.keys(providedSecondary)
  if (currentSegmentResults.length === 0 && expectedSecondary.length === 0) {
    return null
  }
  const expected = expectedSecondary.length > 0 ? expectedSecondary : Object.keys(currentSegmentResults[0]?.metrics ?? {})
  const missing = expected.filter((name) => !(name in providedSecondary))
  const extra = providedNames.filter((name) => !expected.includes(name))
  if (missing.length > 0 || extra.length > 0) {
    return `Secondary metrics must match the current segment schema. Expected: ${expected.join(', ') || '(none)'}. Got: ${providedNames.join(', ') || '(none)'}.`
  }
  return null
}

function materializeSecondaryMetrics(
  currentSegmentResults: ExperimentRecord[],
  expectedSecondary: string[],
  providedSecondary: Record<string, number>,
): Record<string, number> {
  if (currentSegmentResults.length === 0 && expectedSecondary.length === 0) {
    return providedSecondary
  }
  const expected = expectedSecondary.length > 0 ? expectedSecondary : Object.keys(currentSegmentResults[0]?.metrics ?? {})
  const materialized: Record<string, number> = {}
  for (const name of expected) {
    materialized[name] = providedSecondary[name]
  }
  return materialized
}

function commitKeepResult(
  root: string,
  description: string,
  metric: number,
  metrics: Record<string, number>,
  metricName: string,
): { ok: true; commit: string } | { ok: false; error: string } {
  const addResult = runGit(
    [
      'add',
      '-A',
      '--',
      '.',
      ':(exclude)autoresearch.jsonl',
      ':(exclude).amp/pi-autoresearch.pending.json',
    ],
    root,
  )
  if (addResult.code !== 0) {
    return { ok: false, error: `Failed to stage keep result: ${joinOutput(addResult.stdout, addResult.stderr)}` }
  }

  const diffResult = runGit(['diff', '--cached', '--quiet', '--exit-code'], root)
  if (diffResult.code === 0) {
    return { ok: false, error: 'keep requires a real commit, but there was nothing to commit.' }
  }

  const trailer = JSON.stringify({ status: 'keep', [metricName]: metric, ...metrics })
  const commitMessage = `${description}\n\nResult: ${trailer}`
  const commitResult = runGit(['commit', '-m', commitMessage], root)
  if (commitResult.code !== 0) {
    return {
      ok: false,
      error: `Git commit failed during keep: ${joinOutput(commitResult.stdout, commitResult.stderr)}`,
    }
  }

  const shaResult = runGit(['rev-parse', '--short=7', 'HEAD'], root)
  const commit = shaResult.code === 0 ? shaResult.stdout.trim() : ''
  if (!commit) {
    return { ok: false, error: 'Git commit succeeded but HEAD could not be resolved afterwards.' }
  }

  return { ok: true, commit }
}

async function execShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult & { durationSeconds: number }> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        child.kill('SIGKILL')
      }, 500).unref()
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })

    child.on('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({
        code: null,
        stdout,
        stderr: joinOutput(stderr, error.message),
        timedOut,
        durationSeconds: (Date.now() - startedAt) / 1000,
      })
    })

    child.on('close', (code) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        durationSeconds: (Date.now() - startedAt) / 1000,
      })
    })
  })
}

function runGit(args: string[], cwd: string) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
  })
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

function isGitRepo(root: string): boolean {
  const result = runGit(['rev-parse', '--is-inside-work-tree'], root)
  return result.code === 0 && result.stdout.trim() === 'true'
}

function isCleanWorktree(root: string): boolean {
  const result = runGit(['status', '--porcelain'], root)
  return result.code === 0 && result.stdout.trim() === ''
}

function currentHeadCommit(root: string): string {
  const result = runGit(['rev-parse', '--short=7', 'HEAD'], root)
  return result.code === 0 ? result.stdout.trim() : ''
}

function helpText(): string {
  return [
    'Autoresearch Usage',
    '/autoresearch <goal>        start or resume setup',
    '/autoresearch status        show the compact summary',
    '/autoresearch dashboard     show the expanded dashboard',
    '/autoresearch resume        resume an existing session',
    '/autoresearch pause         pause automatic continuation',
    '/autoresearch stop          stop the current session',
    '',
    'For setup, the workspace must be a clean git worktree.',
  ].join('\n')
}

function buildActiveModeReminder(root: string): string {
  const paths = workspacePaths(root)
  const lines = [
    'Autoresearch mode is active.',
    'Read autoresearch.md before choosing the next experiment.',
  ]
  if (existsSync(paths.checks)) {
    lines.push('autoresearch.checks.sh exists. keep is invalid when checks fail or time out.')
  }
  if (existsSync(paths.ideas)) {
    lines.push('Check autoresearch.ideas.md for deferred ideas before repeating old work.')
  }
  lines.push('Use run_experiment and log_experiment as the main loop tools.')
  return lines.join(' ')
}

function commandHandledResult(message: string): AgentStartResult {
  return {
    message: {
      content: `The plugin handled the user's autoresearch command. Reply with this result only:\n\n${message}`,
      display: true,
    },
  }
}

function renderPendingOutcome(pending: PendingRun): string {
  if (pending.timedOut) {
    return `timed out after ${formatMetric(pending.durationSeconds, 's')}`
  }
  if (!pending.passed) {
    return `failed with exit ${pending.exitCode ?? 'unknown'}`
  }
  return `passed in ${formatMetric(pending.durationSeconds, 's')}`
}

function renderChecksOutcome(pending: PendingRun): string {
  if (pending.checksTimedOut) {
    return 'timed out'
  }
  if (pending.checksPass === false) {
    return 'failed'
  }
  if (pending.checksPass === true) {
    return 'passed'
  }
  return 'not run'
}

function formatMetric(value: number, unit: string): string {
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(2)
  return `${formatted}${unit}`
}

function formatDelta(current: number, baseline: number, direction: Direction): string {
  const percent = ((current - baseline) / baseline) * 100
  const signed = percent > 0 ? `+${percent.toFixed(1)}%` : `${percent.toFixed(1)}%`
  const verdict = direction === 'lower' ? (current < baseline ? 'better' : 'worse') : current > baseline ? 'better' : 'worse'
  return `${signed} ${verdict}`
}

function shortID(id: string): string {
  return id.slice(0, 8)
}

function truncateText(text: string, width: number): string {
  if (text.length <= width) {
    return text
  }
  if (width <= 3) {
    return text.slice(0, width)
  }
  return `${text.slice(0, width - 3)}...`
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/)
  return lines.slice(-maxLines).join('\n').trim()
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function joinOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
}

function normalizeMetricRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {}
  }
  const output: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!key.trim()) {
      continue
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      output[key.trim()] = raw
    }
  }
  return output
}

function normalizeSecondaryMetricNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const names = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue
    }
    const trimmed = entry.trim()
    if (trimmed) {
      names.add(trimmed)
    }
  }
  return [...names]
}

async function safeNotify(ui: UIApi | undefined, message: string) {
  if (!ui || typeof ui.notify !== 'function') {
    return
  }
  try {
    await maybeAwait(ui.notify(truncateText(message, MAX_NOTIFY_CHARS)))
  } catch {
    return
  }
}

async function maybeAwait<T>(value: Promise<T> | T): Promise<T> {
  return await value
}

function ok(payload: Record<string, unknown>) {
  return { ok: true, ...payload }
}

function fail(error: string) {
  return { ok: false, error }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function asDirection(value: unknown): Direction | null {
  return value === 'lower' || value === 'higher' ? value : null
}

function asStatus(value: unknown): ExperimentStatus | null {
  return value === 'keep' || value === 'discard' || value === 'crash' || value === 'checks_failed'
    ? value
    : null
}

function asPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asNullableNumber(value: unknown): number | null {
  if (value === null) {
    return null
  }
  return asNumber(value)
}

function asNullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) {
    return null
  }
  return typeof value === 'boolean' ? value : null
}

function asPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}
