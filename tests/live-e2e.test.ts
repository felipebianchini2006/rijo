import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ClaudeCliRunner } from '../src/hosts/claudeCli.js';
import { CodexCliRunner } from '../src/hosts/codexCli.js';
import { detectClaudeCli, detectCodexCli } from '../src/hosts/detect.js';
import { ConfigSchema } from '../src/core/schemas/index.js';
import type { AgentTask } from '../src/agents/protocol.js';

/**
 * LIVE end-to-end tests against the real CLIs. These are GATED twice:
 *   1. RIJO_LIVE_E2E=1 must be set (opt-in — real model calls cost money).
 *   2. The CLI must be genuinely detected on PATH (honest detection, never faked).
 *
 * Run only these, only when you mean to:
 *   RIJO_LIVE_E2E=1 npx vitest run tests/live-e2e.test.ts
 *
 * A tiny, deterministic task is used per host so a pass is unambiguous.
 */

const LIVE = process.env.RIJO_LIVE_E2E === '1';
const LIVE_TIMEOUT_MS = 180_000;

// Detection runs at module load (top-level await) so describe.runIf can gate on it.
const claude = LIVE ? await detectClaudeCli() : { available: false, version: null };
const codex = LIVE ? await detectCodexCli() : { available: false, version: null };

const config = ConfigSchema.parse({});

function pingTask(): AgentTask {
  return {
    id: 'live-ping',
    role: 'researcher',
    tier: 'economical-research',
    objective:
      'Do not use any tools. Return exactly this JSON payload as your `payload`: {"ping":"pong"}. Set summary to "pong".',
    canonical_files: [],
    code_files: [],
    write_scope: [],
    acceptance_criteria: ['payload equals {"ping":"pong"}'],
    verification_commands: [],
    return_format: 'A JSON object exactly: {"ping":"pong"}',
    notes: '',
    workspace: null,
    canonical_baseline: null,
  };
}

function tmpRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe.runIf(LIVE && claude.available)('LIVE: Claude Code CLI', () => {
  it(
    'returns a parsed AgentResult for a trivial task',
    async () => {
      const root = tmpRoot('rijo-live-claude-');
      try {
        const runner = new ClaudeCliRunner({ projectRoot: root, config });
        const result = await runner.runTask(pingTask());
        expect(result.task_id).toBe('live-ping');
        expect(result.ok, result.summary).toBe(true);
        expect(JSON.stringify(result.payload ?? '')).toContain('pong');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

describe.runIf(LIVE && codex.available)('LIVE: Codex CLI', () => {
  it(
    'returns a parsed AgentResult for a trivial task',
    async (ctx) => {
      const root = tmpRoot('rijo-live-codex-');
      try {
        const runner = new CodexCliRunner({ projectRoot: root, config, sandbox: 'read-only' });
        const result = await runner.runTask(pingTask());
        expect(result.task_id).toBe('live-ping');
        // Host-side capacity exhaustion (quota/rate limit) is BLOCKED, not a
        // driver failure: the host was reached and answered, but cannot run a
        // turn. The skip message carries the exact diagnostic for evidence.
        if (!result.ok && /usage limit|rate limit|quota/i.test(result.summary)) {
          ctx.skip(`BLOCKED (host capacity): ${result.summary.slice(0, 300)}`);
          return;
        }
        expect(result.ok, result.summary).toBe(true);
        expect(JSON.stringify(result.payload ?? '')).toContain('pong');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

// When LIVE is off, keep a visible, always-passing marker so the file is not
// reported as "no tests" and the gating is self-documenting.
describe.skipIf(LIVE)('LIVE e2e (skipped unless RIJO_LIVE_E2E=1)', () => {
  it('is intentionally skipped without RIJO_LIVE_E2E=1', () => {
    expect(LIVE).toBe(false);
  });
});
