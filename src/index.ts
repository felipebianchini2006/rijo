/** Programmatic API: embed RIJO with your own AgentRunner. */
export { newWorkflow, type NewOptions, PlanExtractionSchema } from './workflows/new.js';
export { runWorkflow, type RunOptions } from './workflows/run.js';
export { uiWorkflow, type UiOptions } from './workflows/ui.js';
export { fixWorkflow, type FixOptions } from './workflows/fix.js';
export { checkWorkflow, type CheckOptions } from './workflows/check.js';
export { runCli } from './cli/main.js';
export type { WorkflowDeps, WorkflowOutcome } from './workflows/shared.js';
export type { AgentRunner, RunnerCapabilities } from './agents/runner.js';
export { FakeAgentRunner, UnboundAgentRunner } from './agents/runner.js';
export { AgentTaskSchema, AgentResultSchema, type AgentTask, type AgentResult } from './agents/protocol.js';
export { renderBrief } from './agents/prompts.js';
export { FakeShellRunner, SystemShellRunner, type ShellRunner } from './core/commands.js';
export { FakeGit, SystemGit, type GitOps } from './core/git.js';
export { silentSink, consoleSink, readStatus, renderStatusLine } from './core/progress.js';
export { generateAdapters } from './adapters/index.js';
export * as schemas from './core/schemas/index.js';
