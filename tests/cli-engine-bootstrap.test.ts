import { describe, expect, it, vi } from 'vitest';
import {
  requiresEngineSupervisor,
  runCliEntrypoint,
  type CliBootstrapDeps,
} from '../src/cli/bootstrap.js';
import type { EngineSupervisorLedger } from '../src/supervisor/engineTypes.js';
import { cleanup, tmpProject } from './helpers.js';

function fakeLedger(): EngineSupervisorLedger & { close(): Promise<void> } {
  return {
    acquireSupervisorLease: async () => true,
    releaseSupervisorLease: async () => {},
    readRunStatus: async () => null,
    readProgress: async () => ({ sequence: 0, observed_at: new Date(0).toISOString() }),
    readLastEngineGeneration: async () => 0,
    appendSupervisorReceipt: async () => {},
    fenceEngineGeneration: async () => {},
    reconcileEngineGeneration: async () => ({ engine_tree_gone: true }),
    close: vi.fn(async () => {}),
  };
}

describe('CLI engine bootstrap', () => {
  it('supervises only autonomous run entrypoints and never recursively supervises the child', () => {
    expect(requiresEngineSupervisor(['new', '@PLAN.md', '--host', 'codex', '--run'], {})).toBe(true);
    expect(requiresEngineSupervisor(['run', '--host=claude'], {})).toBe(true);
    expect(requiresEngineSupervisor(['run', 'all', '--host=claude'], {})).toBe(true);
    expect(requiresEngineSupervisor(['run', 'next', '--host=claude'], {})).toBe(false);
    expect(requiresEngineSupervisor(['run', '01', '--host=claude'], {})).toBe(false);
    expect(requiresEngineSupervisor(['new', '@PLAN.md'], {})).toBe(false);
    expect(requiresEngineSupervisor(['check', '--production'], {})).toBe(false);
    expect(
      requiresEngineSupervisor(['run'], { RIJO_ENGINE_CHILD: '1' }),
    ).toBe(false);
  });

  it('routes new --run through the parent supervisor and closes its ledger', async () => {
    const root = tmpProject('rijo-cli-bootstrap-');
    const ledger = fakeLedger();
    const direct = vi.fn(async () => 99);
    const supervise = vi.fn(async () => ({
      status: 'READY' as const,
      state: 'READY' as const,
      generation: 1,
      restarts: 0,
      reason: 'done',
    }));
    const deps: CliBootstrapDeps = {
      runCli: direct,
      openLedger: async () => ledger,
      supervise,
    };

    try {
      const code = await runCliEntrypoint(
        ['new', '@PLAN.md', '--host', 'codex', '--run'],
        root,
        { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
        deps,
      );

      expect(code).toBe(0);
      expect(direct).not.toHaveBeenCalled();
      expect(supervise).toHaveBeenCalledOnce();
      expect(supervise.mock.calls[0]![0]).toMatchObject({
        projectRoot: root,
        args: ['new', '@PLAN.md', '--host', 'codex', '--run'],
        ledger,
      });
      expect(supervise.mock.calls[0]![0].env).toMatchObject({
        RIJO_ENGINE_CHILD: '1',
      });
      expect(ledger.close).toHaveBeenCalledOnce();
    } finally {
      cleanup(root);
    }
  });

  it('keeps non-autonomous commands in the current process', async () => {
    const root = tmpProject('rijo-cli-direct-');
    const direct = vi.fn(async () => 7);
    const openLedger = vi.fn(async () => fakeLedger());
    try {
      expect(
        await runCliEntrypoint(['--status', '--json'], root, {}, {
          runCli: direct,
          openLedger,
          supervise: vi.fn(),
        }),
      ).toBe(7);
      expect(direct).toHaveBeenCalledWith(['--status', '--json'], {}, root);
      expect(openLedger).not.toHaveBeenCalled();
    } finally {
      cleanup(root);
    }
  });
});
