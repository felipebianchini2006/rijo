import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EngineSupervisor,
  NodeEngineProcessFactory,
  type EngineRunStatus,
  type EngineSupervisorLedger,
  type EngineSupervisorReceipt,
} from '../src/supervisor/engineSupervisor.js';

class FileRunLedger implements EngineSupervisorLedger {
  receipts: EngineSupervisorReceipt[] = [];
  fenced: number[] = [];
  reconciled: number[] = [];
  generation = 0;

  constructor(private readonly readyFile: string) {}

  async acquireSupervisorLease(): Promise<boolean> {
    return true;
  }

  async releaseSupervisorLease(): Promise<void> {}

  async readRunStatus(): Promise<EngineRunStatus | null> {
    return fs.existsSync(this.readyFile) ? 'READY' : null;
  }

  async readProgress(): Promise<{ sequence: number; observed_at: string }> {
    return { sequence: this.receipts.length, observed_at: new Date().toISOString() };
  }

  async readLastEngineGeneration(): Promise<number> {
    return this.generation;
  }

  async appendSupervisorReceipt(receipt: EngineSupervisorReceipt): Promise<void> {
    this.receipts.push(receipt);
    if (receipt.type === 'engine.started') this.generation = receipt.generation;
  }

  async fenceEngineGeneration(generation: number): Promise<void> {
    this.fenced.push(generation);
  }

  async reconcileEngineGeneration(generation: number): Promise<{ engine_tree_gone: true }> {
    this.reconciled.push(generation);
    return { engine_tree_gone: true };
  }
}

describe('engine supervisor with real child processes', () => {
  it.runIf(process.platform !== 'win32')(
    'treats surviving descendants as a live engine tree after the engine leader exits',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-engine-tree-'));
      const descendantPidFile = path.join(root, 'descendant-pid');
      const script = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));`,
        'setTimeout(() => process.exit(31), 20);',
      ].join('\n');
      const processFactory = new NodeEngineProcessFactory({
        command: process.execPath,
        args: ['-e', script],
        cwd: root,
        termination_timeout_ms: 500,
      });

      try {
        const handle = await processFactory.start({ generation: 1, owner_id: 'tree-test' });
        expect(await handle.result).toMatchObject({ code: 31 });
        const descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'));
        expect(handle.isAlive(), 'the process group remains alive through its descendant').toBe(true);
        expect(await handle.terminate('kill')).toBe(true);
        expect(() => process.kill(descendantPid, 0), 'the descendant must be reaped').toThrow();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    5_000,
  );

  it.runIf(process.platform !== 'win32')(
    'restarts a crashed process, observes terminal ledger state, and leaves no engine alive',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-engine-supervisor-'));
      const readyFile = path.join(root, 'ready');
      const pidFile = path.join(root, 'pids');
      const script = [
        "const fs = require('node:fs');",
        "const generation = Number(process.env.RIJO_ENGINE_GENERATION);",
        `fs.appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + '\\n');`,
        'if (generation === 1) process.exit(23);',
        `fs.writeFileSync(${JSON.stringify(readyFile)}, 'READY');`,
        'setInterval(() => {}, 1000);',
      ].join('\n');
      const ledger = new FileRunLedger(readyFile);
      const processFactory = new NodeEngineProcessFactory({
        command: process.execPath,
        args: ['-e', script],
        cwd: root,
      });

      try {
        const result = await new EngineSupervisor({
          ledger,
          processFactory,
          config: {
            poll_interval_ms: 5,
            no_progress_timeout_ms: 2_000,
            hard_deadline_ms: 10_000,
            cancel_grace_ms: 100,
            kill_grace_ms: 500,
            max_restarts: 1,
          },
        }).run();

        expect(result).toMatchObject({ status: 'READY', generation: 2, restarts: 1 });
        expect(ledger.fenced).toEqual([1]);
        expect(ledger.reconciled).toEqual([1]);
        const pids = fs.readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
        expect(pids).toHaveLength(2);
        for (const pid of pids) {
          expect(() => process.kill(pid, 0), `engine pid ${pid} should be dead`).toThrow();
        }
        expect(
          ledger.receipts.filter((receipt) => receipt.type === 'engine.started').map((receipt) => receipt.generation),
        ).toEqual([1, 2]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it('passes the generation through a sanitized environment', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-engine-env-'));
    const output = path.join(root, 'generation');
    const processFactory = new NodeEngineProcessFactory({
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(output)}, process.env.RIJO_ENGINE_GENERATION)`],
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
    });

    try {
      const handle = await processFactory.start({ generation: 7, owner_id: 'test-owner' });
      await handle.result;
      expect(fs.readFileSync(output, 'utf8')).toBe('7');
      expect(execFileSync(process.execPath, ['-e', 'process.exit(0)']).toString()).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
