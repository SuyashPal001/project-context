import type { BackgroundTaskManagerConfig } from '@mastra/core/background-tasks'

/**
 * Long-running delegations (video generation above all) must not block the
 * parent's turn. This is the one config block the harness was missing —
 * storage, scheduler, editor and observability were already registered.
 *
 * mode 'full' is the monolithic shape: this process both dispatches and
 * executes. The orchestrator runs as a single pm2 process, so producer and
 * worker are the same process.
 *
 * Verified before writing this (see task-8-report.md): the Mastra instance
 * in index.ts passes no `pubsub`, so Mastra defaults to `EventEmitterPubSub`
 * — an in-process implementation declaring `supportedModes: ['pull', 'push']`
 * — and Mastra itself calls `backgroundTaskManager.init(this.#pubsub)`
 * automatically inside `#ensureBackgroundTaskManager()`, with the returned
 * promise's rejection caught and logged via `this.#logger?.error(...)`, not
 * thrown and not left as an unhandled rejection. 'full' mode is exactly the
 * shape the manager's own doc comment calls out as suitable for "monolithic
 * deployments where the producer and worker live in the same process."
 *
 * `BackgroundTaskManagerConfig` is imported from `@mastra/core/background-tasks`,
 * not the `@mastra/core` package root — the root only re-exports `Mastra` and
 * `Config` (dist/index.d.ts), matching this codebase's existing convention of
 * importing from `@mastra/core/<subpath>` (agent.js, tools.js, etc.).
 */
export const BACKGROUND_TASKS: BackgroundTaskManagerConfig = {
  enabled: true,
  mode: 'full',
  globalConcurrency: 10,
  perAgentConcurrency: 5,
}

export const BACKGROUND_TASKS_ENABLED = BACKGROUND_TASKS.enabled
