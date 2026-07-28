import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DecisionProposalSchema,
  DecisionRecordSchema,
  decisionPolicyBrief,
  reconcileDecisionCommits,
  resolveDecision,
} from '../src/core/decisions.js';
import { defaultConfig } from '../src/core/config.js';
import { RijoPaths } from '../src/core/paths.js';
import { createWorkflowEpoch } from '../src/core/workflow-epoch.js';
import { FakeAgentRunner } from '../src/agents/runner.js';
import {
  commitDecisionProposals,
  completed,
  createContext,
  discardDecisionProposals,
  dispatch,
  prepareAttempt,
} from '../src/workflows/shared.js';
import { cleanup, tmpProject } from './helpers.js';

describe('autonomous decision policy', () => {
  let root: string;
  let paths: RijoPaths;

  beforeEach(() => {
    root = tmpProject('rijo-decisions-');
    paths = new RijoPaths(root);
  });

  afterEach(() => cleanup(root));

  it('defaults to autonomous, blockers-only behavior and is suitable for every agent brief', () => {
    const config = defaultConfig();
    expect(config.decisions).toMatchObject({
      mode: 'autonomous',
      ask_user: 'blockers_only',
      preserve_existing_architecture: true,
      prefer_reversible: true,
      record_material_decisions: true,
      confidence_threshold: 0.7,
      scale_horizon: 'current_scope_plus_next_milestone',
    });
    const brief = decisionPolicyBrief(config.decisions);
    expect(brief).toContain('Do not generate option menus');
    expect(brief).toContain('one factual question');
  });

  it('records a material reversible technical decision with real evidence', () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(`${root}/package.json`, '{"name":"fixture"}\n');
    const proposal = DecisionProposalSchema.parse({
      id: 'DEC-architecture-location',
      context: 'Choose where the new adapter belongs.',
      selected_option: 'Keep it in src/adapters.',
      rationale: 'The existing adapter boundary is dominant.',
      material: true,
      confidence: 0.84,
      reversible: true,
      consequences: ['No new framework or service.'],
      review_condition: 'Review if adapters stop sharing the same lifecycle.',
      evidence: [{ path: 'package.json', file_hash: expectHash(`${root}/package.json`) }],
    });
    const outcome = resolveDecision(paths, defaultConfig().decisions, proposal);
    expect(outcome.status).toBe('DECIDED');
    expect(DecisionRecordSchema.safeParse(outcome.record).success).toBe(true);
    expect(fs.readFileSync(paths.decisions, 'utf8')).toContain('DEC-architecture-location');
  });

  it('rejects a material decision without real evidence', () => {
    expect(() =>
      DecisionProposalSchema.parse({
        id: 'DEC-unproven-material-choice',
        context: 'Move the public API to a new module.',
        selected_option: 'Move it.',
        rationale: 'It looks cleaner.',
        material: true,
        confidence: 0.9,
        reversible: true,
        consequences: ['Public imports change.'],
        review_condition: 'Review after the next release.',
        evidence: [],
      }),
    ).toThrow(/material decisions require evidence/i);
  });

  it('rejects invented blocker categories and asks at most one factual question for a true blocker', () => {
    expect(() =>
      DecisionProposalSchema.parse({
        id: 'DEC-invalid',
        context: 'Naming preference',
        selected_option: null,
        rationale: 'Need user preference',
        material: true,
        confidence: 0.2,
        reversible: true,
        consequences: [],
        review_condition: 'never',
        evidence: [],
        blocker: { category: 'technical_preference', missing_fact: 'favorite name', question: 'A, B, or C?' },
      }),
    ).toThrow();

    const valid = DecisionProposalSchema.parse({
      id: 'DEC-production-destruction',
      context: 'Production migration may delete customer data.',
      selected_option: null,
      rationale: 'No safe data-loss authorization exists in code or history.',
      material: true,
      confidence: 0.4,
      reversible: false,
      consequences: ['Migration is not executed.'],
      review_condition: 'Proceed only with explicit production authorization.',
      evidence: [{ path: 'package.json', file_hash: 'a'.repeat(64) }],
      blocker: {
        category: 'production_destructive_operation',
        missing_fact: 'authorization to delete production customer rows',
        question: 'Do you authorize deleting the identified production customer rows?',
      },
    });
    expect(valid.blocker?.question).not.toMatch(/\n|;|(?:\bA\b.*\bB\b)/);
    expect((valid.blocker?.question.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it('rejects an option menu even when the blocker category is authorized', () => {
    expect(() =>
      DecisionProposalSchema.parse({
        id: 'DEC-menu',
        context: 'A destructive production migration needs authorization.',
        selected_option: null,
        rationale: 'The repository cannot establish production authorization.',
        material: true,
        confidence: 0.2,
        reversible: false,
        consequences: ['No production data is changed.'],
        review_condition: 'Review after factual authorization is supplied.',
        evidence: [{ path: 'package.json', file_hash: 'a'.repeat(64) }],
        blocker: {
          category: 'production_destructive_operation',
          missing_fact: 'authorization for the destructive production migration',
          question: 'Choose one: A) authorize B) cancel?',
        },
      }),
    ).toThrow(/option menu/i);
  });

  it('routes agent decision proposals through the core before a workflow can apply the result', async () => {
    fs.writeFileSync(`${root}/package.json`, '{"name":"fixture"}\n');
    const runner = new FakeAgentRunner().on(
      (task) => task.id === 'material-choice',
      (task) =>
        ({
          task_id: task.id,
          ok: true,
          summary: 'choice made',
          files_written: [],
          payload: null,
          scope_requests: [],
          decision_proposals: [
            {
              id: 'DEC-dispatched-location',
              context: 'Choose the module for a public adapter.',
              selected_option: 'Keep it in the existing adapter module.',
              rationale: 'The existing public boundary is evidenced.',
              material: true,
              impact: 'medium',
              confidence: 0.9,
              reversible: true,
              consequences: ['No new architectural boundary.'],
              review_condition: 'Review if the adapter lifecycle diverges.',
              evidence: [{ path: 'package.json', file_hash: expectHash(`${root}/package.json`) }],
              blocker: null,
            },
          ],
        }) as any,
    );
    const ctx = createContext(root, { runner });
    const result = await dispatch(ctx, {
      id: 'material-choice',
      role: 'planner',
      objective: 'Choose an evidenced adapter location.',
      return_format: 'AgentResult',
    });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(paths.decisions)).toBe(false);

    commitDecisionProposals(ctx, result);
    completed(ctx, 'workflow terminal');
    expect(fs.readFileSync(paths.decisions, 'utf8')).toContain('DEC-dispatched-location');
  });

  it('turns an invalid material proposal into a rejected agent result', async () => {
    const runner = new FakeAgentRunner().on(
      (task) => task.id === 'unproven-choice',
      (task) =>
        ({
          task_id: task.id,
          ok: true,
          summary: 'choice made',
          files_written: [],
          payload: null,
          scope_requests: [],
          decision_proposals: [
            {
              id: 'DEC-no-evidence',
              context: 'Replace the architecture.',
              selected_option: 'Replace it.',
              rationale: 'Preference.',
              material: true,
              impact: 'high',
              confidence: 0.9,
              reversible: false,
              consequences: ['Public contracts change.'],
              review_condition: 'Never.',
              evidence: [],
              blocker: null,
            },
          ],
        }) as any,
    );
    const ctx = createContext(root, { runner });
    const result = await dispatch(ctx, {
      id: 'unproven-choice',
      role: 'planner',
      objective: 'Make a material choice.',
      return_format: 'AgentResult',
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/decision proposal rejected|material decisions require evidence/i);
    expect(fs.existsSync(paths.decisions)).toBe(false);
  });

  it('does not persist a valid decision when the caller rejects the payload', async () => {
    fs.writeFileSync(`${root}/package.json`, '{"name":"fixture"}\n');
    const runner = decisionRunner(root, 'payload-rejected', { invalid: true });
    const ctx = createContext(root, { runner });
    const envelope = await dispatch(ctx, {
      id: 'payload-rejected',
      role: 'planner',
      objective: 'Return a payload for caller validation.',
      return_format: 'JSON payload',
    });
    expect(envelope.ok).toBe(true);
    expect(envelope.payload).toEqual({ invalid: true });
    discardDecisionProposals(ctx, envelope);
    expect(fs.existsSync(paths.decisions)).toBe(false);
  });

  it('does not persist a valid decision when workspace validation rejects the result', async () => {
    fs.writeFileSync(`${root}/package.json`, '{"name":"fixture"}\n');
    const runner = decisionRunner(root, 'workspace-rejected', { done: true }, (task) => {
      fs.mkdirSync(`${task.workspace!.root}/src`, { recursive: true });
      fs.writeFileSync(`${task.workspace!.root}/src/outside.ts`, 'outside\n');
    });
    const ctx = createContext(root, { runner });
    const attempt = prepareAttempt(ctx, {
      id: 'workspace-rejected',
      role: 'worker',
      objective: 'Write only the approved file.',
      write_scope: ['src/approved.ts'],
      return_format: 'JSON payload',
    });
    const envelope = await dispatch(ctx, attempt.task);
    expect(() => attempt.workspace.validate()).toThrow(/outside/i);
    discardDecisionProposals(ctx, envelope);
    attempt.workspace.discard();
    expect(fs.existsSync(paths.decisions)).toBe(false);
  });

  it('rejects decisions from a revoked generation', async () => {
    fs.writeFileSync(`${root}/package.json`, '{"name":"fixture"}\n');
    const ctx = createContext(root, { runner: decisionRunner(root, 'revoked-result', { done: true }) });
    const envelope = await dispatch(ctx, {
      id: 'revoked-result',
      role: 'planner',
      objective: 'Return a valid result.',
      return_format: 'JSON payload',
    });
    const taskFile = `${paths.runtimeDir}/tasks/revoked-result.json`;
    const taskRecord = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    taskRecord.revoked_leases = [...taskRecord.revoked_leases, envelope.lease_id];
    fs.writeFileSync(taskFile, `${JSON.stringify(taskRecord, null, 2)}\n`);
    expect(() => commitDecisionProposals(ctx, envelope)).toThrow(/stale or revoked/i);
    expect(fs.existsSync(paths.decisions)).toBe(false);
  });

  it('rejects decisions when the exact task record is missing', async () => {
    fs.writeFileSync(`${root}/package.json`, '{"name":"fixture"}\n');
    const ctx = createContext(root, {
      runner: decisionRunner(root, 'missing-task-record', { done: true }),
    });
    const envelope = await dispatch(ctx, {
      id: 'missing-task-record',
      role: 'planner',
      objective: 'Return a valid result.',
      return_format: 'JSON payload',
    });
    fs.rmSync(`${paths.runtimeDir}/tasks/missing-task-record.json`);

    expect(() => commitDecisionProposals(ctx, envelope)).toThrow(/missing.*cross-epoch/i);
    expect(fs.existsSync(paths.decisions)).toBe(false);
  });

  it('rejects decisions replayed through another workflow epoch', async () => {
    fs.writeFileSync(`${root}/package.json`, '{"name":"fixture"}\n');
    const first = createContext(root, {
      runner: decisionRunner(root, 'cross-epoch-result', { done: true }),
      workflowEpoch: createWorkflowEpoch(),
    });
    const envelope = await dispatch(first, {
      id: 'cross-epoch-result',
      role: 'planner',
      objective: 'Return a valid result.',
      return_format: 'JSON payload',
    });
    const second = createContext(root, {
      runner: decisionRunner(root, 'unused', { done: true }),
      workflowEpoch: createWorkflowEpoch(),
    });

    expect(() => commitDecisionProposals(second, envelope)).toThrow(/cross-epoch/i);
    expect(fs.existsSync(paths.decisions)).toBe(false);
  });

  it('recovers a crash after decision append without duplicating DECISIONS.md', async () => {
    fs.writeFileSync(`${root}/package.json`, '{"name":"fixture"}\n');
    let injected = false;
    const ctx = createContext(root, {
      runner: decisionRunner(root, 'decision-crash', { done: true }),
      decisionHooks: {
        afterAppend: () => {
          if (!injected) {
            injected = true;
            throw new Error('simulated crash after append');
          }
        },
      },
    });
    const envelope = await dispatch(ctx, {
      id: 'decision-crash',
      role: 'planner',
      objective: 'Return a valid result.',
      return_format: 'JSON payload',
    });
    expect(() => commitDecisionProposals(ctx, envelope)).toThrow(/simulated crash/);
    // Once DECISIONS.md was appended, recovery must finish the manifest
    // transaction even if the evidence file changes before restart. The
    // decision was already fully approved and must not be appended twice.
    fs.writeFileSync(`${root}/package.json`, '{"name":"fixture","revision":2}\n');
    expect(reconcileDecisionCommits(paths, ctx.config.decisions)).toHaveLength(1);
    const decisions = fs.readFileSync(paths.decisions, 'utf8');
    expect((decisions.match(/## DEC-decision-crash/g) ?? [])).toHaveLength(1);
    const journals = fs.readdirSync(`${paths.runtimeDir}/decision-commits`);
    expect(journals).toHaveLength(1);
    const journal = JSON.parse(fs.readFileSync(`${paths.runtimeDir}/decision-commits/${journals[0]}`, 'utf8'));
    expect(journal.status).toBe('MANIFESTED');
  });
});

function expectHash(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function decisionRunner(
  root: string,
  taskId: string,
  payload: unknown,
  mutate?: (task: { workspace: { root: string } | null }) => void,
): FakeAgentRunner {
  return new FakeAgentRunner().on(
    (task) => task.id === taskId,
    (task) => {
      mutate?.(task);
      return {
        task_id: task.id,
        ok: true,
        summary: 'valid result',
        files_written: [],
        payload,
        scope_requests: [],
        decision_proposals: [
          {
            id: `DEC-${taskId}`,
            context: 'Choose the evidenced implementation location.',
            selected_option: 'Keep the current module boundary.',
            rationale: 'The existing boundary is evidenced.',
            material: true,
            impact: 'medium',
            confidence: 0.9,
            reversible: true,
            consequences: ['No new architectural boundary.'],
            review_condition: 'Review if the module lifecycle diverges.',
            evidence: [{ path: 'package.json', file_hash: expectHash(`${root}/package.json`) }],
            blocker: null,
          },
        ],
      } as any;
    },
  );
}
