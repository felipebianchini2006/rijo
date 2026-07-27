/** Programmatic API: embed RIJO with your own AgentRunner. */
export { newWorkflow, type NewOptions, PlanExtractionSchema } from './workflows/new.js';
export { runWorkflow, runCore, type RunOptions } from './workflows/run.js';
export { uiWorkflow, uiCore, type UiOptions } from './workflows/ui.js';
export { fixWorkflow, type FixOptions } from './workflows/fix.js';
export { checkWorkflow, type CheckOptions } from './workflows/check.js';
export {
  mapWorkflow,
  mapCore,
  ensureCodebaseMap,
  queryCodebaseMap,
  readCodebaseMapStatus,
  type MapOptions,
  type MapCoreOptions,
  type CodebaseQueryResult,
} from './workflows/map.js';
export { runCli } from './cli/main.js';
export {
  requiresEngineSupervisor,
  runCliEntrypoint,
  type CliBootstrapDeps,
} from './cli/bootstrap.js';
export { serve } from './cli/serve.js';
export { StdioTransport, RpcAgentRunner, type RpcTransport } from './agents/rpc.js';
export type { WorkflowContext, WorkflowDeps, WorkflowOutcome } from './workflows/shared.js';
export type { AgentRunner, RunnerCapabilities } from './agents/runner.js';
export { FakeAgentRunner, UnboundAgentRunner } from './agents/runner.js';
export { AgentTaskSchema, AgentResultSchema, type AgentTask, type AgentResult } from './agents/protocol.js';
export { renderBrief } from './agents/prompts.js';
export { evaluateCommand, FakeShellRunner, SystemShellRunner, type ShellRunner, type CommandEvidence } from './core/commands.js';
export { FakeGit, SystemGit, type GitOps } from './core/git.js';
export { snapshotFiles, diffSnapshots, enforceScopeDelta, pathInScope } from './core/scope.js';
export { silentSink, consoleSink, readStatus, renderStatusLine } from './core/progress.js';
export { generateAdapters } from './adapters/index.js';
export { AttemptWorkspace, snapshotTree, diffTrees } from './core/workspace.js';
export { planCommand, buildEnv, nativeSandboxAvailable } from './security/execpolicy.js';
export { isSensitivePath, SENSITIVE_PATH_PATTERNS } from './security/sensitive.js';
export { buildInventory, MapPreflightError } from './codebase/inventory.js';
export {
  buildContextPacket,
  validatePlanMapReferences,
  type CodebaseContextPacket,
  type PlanMapReferenceIssue,
} from './codebase/context.js';
export { markCodebasePathsStale, readMapState } from './codebase/state.js';
export {
  DecisionProposalSchema,
  DecisionRecordSchema,
  DecisionBlockerCategorySchema,
  decisionPolicyBrief,
  resolveDecision,
} from './core/decisions.js';
export * as codebaseSchemas from './codebase/schemas.js';
export {
  buildHostEnv,
  HOST_ENV_BASE_ALLOWLIST,
  CLAUDE_HOST_ENV_ALLOWLIST,
  CODEX_HOST_ENV_ALLOWLIST,
  type HostEnvResult,
} from './security/hostEnv.js';
export * from './hosts/index.js';
export * from './durable/index.js';
export {
  EngineSupervisor,
} from './supervisor/engineSupervisor.js';
export type {
  EngineProcessFactory,
  EngineSupervisorConfig,
  EngineSupervisorLedger,
  EngineSupervisorResult,
  EngineSupervisorState,
} from './supervisor/engineTypes.js';
export * as schemas from './core/schemas/index.js';
