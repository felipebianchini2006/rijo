import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectCodexCli } from '../src/hosts/detect.js';
import {
  assertScenarioAOutcome,
  assertPhaseConsumedMap,
  commitExternalCounterChange,
  createBrownfieldMapFixture,
  createFixture,
  haikuConfigYaml,
  packTarball,
  quotaBlocked,
  rmFixture,
  runRijo,
  trackedDirty,
} from './live-workflow-harness.js';

/**
 * LIVE full-workflow E2E — Scenario C: the SAME Scenario-A flow driven turnkey
 * against the REAL Codex CLI (gpt-5.6-* models via the economical tier).
 *
 * GATED twice:
 *   1. RIJO_LIVE_CODEX_E2E=1 (opt-in — real, paid model calls);
 *   2. the Codex CLI must be genuinely detected on PATH.
 * Without the env, or without the binary, the test SKIPS EXPLICITLY (labelled).
 *
 *   RIJO_LIVE_CODEX_E2E=1 npx vitest run tests/workflow-live-codex.e2e.test.ts
 *
 * Host-side capacity exhaustion (usage/quota/rate limit) is not a product
 * failure: the host was reached but cannot run a turn. That case is recorded as
 * a labelled `BLOCKED_BY_QUOTA` skip carrying the host's exact message — the
 * same ctx.skip discipline tests/live-e2e.test.ts uses for Codex.
 */

const LIVE = process.env['RIJO_LIVE_CODEX_E2E'] === '1';
const codex = LIVE ? await detectCodexCli() : { available: false, version: null };
const TEST_TIMEOUT_MS = 1_200_000;

let tarball: string | null = null;

beforeAll(() => {
  if (LIVE && codex.available) tarball = packTarball();
});

afterAll(() => {
  if (tarball) fs.rmSync(tarball, { force: true });
});

describe('LIVE full-workflow E2E (Codex)', () => {
  it(
    'Scenario C — turnkey `rijo new --run --host codex` finalizes a phase (or records BLOCKED_BY_QUOTA)',
    async (ctx) => {
      if (!LIVE) {
        ctx.skip('SKIPPED: set RIJO_LIVE_CODEX_E2E=1 to run the live Codex full-workflow E2E (real paid model calls).');
        return;
      }
      if (!codex.available) {
        ctx.skip('SKIPPED: the Codex CLI is not detected on PATH (honest gate — nothing is faked).');
        return;
      }

      const fixture = createFixture(tarball!, 'rijo-wf-c-', haikuConfigYaml('codex'));
      try {
        const run = runRijo(fixture, ['new', '@PLANO.md', '--host', 'codex', '--run'], { timeoutMs: TEST_TIMEOUT_MS - 60_000 });

        // Capacity exhaustion → labelled skip with the host's exact diagnostic.
        if (run.status !== 0 && quotaBlocked(run.combined)) {
          const tail = run.combined.replace(/\s+/g, ' ').trim().slice(-400);
          ctx.skip(`BLOCKED_BY_QUOTA (Codex host capacity): ${tail}`);
          return;
        }

        expect(run.status, `rijo new --run --host codex did not exit 0:\n${run.combined}`).toBe(0);
        assertScenarioAOutcome(fixture);
      } finally {
        rmFixture(fixture);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Scenario MAP — brownfield map, phase, external change, incremental remap, then fresh next phase',
    async (ctx) => {
      if (!LIVE) {
        ctx.skip('SKIPPED: set RIJO_LIVE_CODEX_E2E=1 to run the live Codex brownfield map E2E.');
        return;
      }
      if (!codex.available) {
        ctx.skip('SKIPPED: the Codex CLI is not detected on PATH (honest gate — nothing is faked).');
        return;
      }
      const fixture = createBrownfieldMapFixture(tarball!, 'rijo-wf-map-codex-', haikuConfigYaml('codex'));
      try {
        const execute = (args: string[], label: string) => {
          const result = runRijo(fixture, [...args, '--host', 'codex'], { timeoutMs: TEST_TIMEOUT_MS });
          if (result.status !== 0 && quotaBlocked(result.combined)) {
            throw new Error(`BLOCKED_BY_QUOTA during ${label}: ${result.combined.replace(/\s+/g, ' ').slice(-500)}`);
          }
          expect(result.status, `${label} failed:\n${result.combined}`).toBe(0);
          return result;
        };
        execute(['map'], 'initial Codex map');
        execute(['new', '@PLANO.md'], 'Codex new');
        execute(['run', '01'], 'Codex phase 01');
        const externalCommit = commitExternalCounterChange(fixture);
        execute(['map'], 'Codex incremental map');
        const mapState = JSON.parse(
          fs.readFileSync(path.join(fixture.root, '.rijo', 'codebase', 'map-state.json'), 'utf8'),
        );
        expect(mapState.last_operation).toBe('incremental');
        expect(mapState.mapped_commit).toBe(externalCommit);
        expect(mapState.changed_paths_since_map).toContain('src/counter.mjs');
        execute(['run', '02'], 'Codex phase 02');
        const phaseTwoMapState = JSON.parse(
          fs.readFileSync(path.join(fixture.root, '.rijo', 'codebase', 'map-state.json'), 'utf8'),
        );
        expect(
          execFileSync(
            'git',
            ['merge-base', '--is-ancestor', externalCommit, phaseTwoMapState.mapped_commit],
            { cwd: fixture.root },
          ),
        ).toBeDefined();
        assertPhaseConsumedMap(fixture, '02', phaseTwoMapState.mapped_commit);
        execFileSync('npm', ['test'], { cwd: fixture.root, encoding: 'utf8' });
        expect(trackedDirty(fixture)).toEqual([]);
      } finally {
        rmFixture(fixture);
      }
    },
    2_400_000,
  );
});
