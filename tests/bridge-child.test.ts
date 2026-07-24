import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { tmpProject, cleanup, writePlanFile, EXTRACTION_PAYLOAD } from './helpers.js';

/**
 * Real child-process bridge test: spawns the built CLI (`node dist/cli/index.js
 * serve`) as a separate process and speaks the line-delimited JSON-RPC protocol
 * over its stdin/stdout exactly as a real host (Claude Code / Codex) would. No
 * in-process transport — this proves the wire protocol, the process lifecycle,
 * and a clean shutdown on stdin end.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');

/** Phase plan payload covering the phase's requirement (mirrors tests/bridge.test.ts). */
function localPlanPayload(phaseId: string) {
  const reqId = `M001-REQ-${phaseId === '02' ? '002' : '001'}`;
  return {
    phase: phaseId,
    tasks: [
      {
        id: 'T01',
        name: 'Implementar módulo',
        requirement_ids: [reqId],
        technical_justification: 'infra da fase',
        files: ['src/a.ts'],
        write_scope: ['src/a.ts'],
        depends_on: [],
        parallel: false,
        tdd: true,
        tests: ['echo test-a'],
        evidence_expected: 'testes passam',
        done: false,
      },
      {
        id: 'T02',
        name: 'Integrar módulo',
        requirement_ids: [reqId],
        technical_justification: 'integração',
        files: ['src/b.ts'],
        write_scope: ['src/b.ts'],
        depends_on: ['T01'],
        parallel: false,
        tdd: false,
        tests: [],
        evidence_expected: 'build passa',
        done: false,
      },
    ],
  };
}

interface AgentTaskWire {
  id: string;
  role: string;
  write_scope: string[];
  workspace: { id: string; root: string } | null;
}

/** The fake HOST's agent runtime: answers each agent.runTask with a minimal valid AgentResult. */
function fakeHostResult(task: AgentTaskWire, root: string) {
  const base = task.workspace?.root ?? root;
  const okResult = (extra: Record<string, unknown> = {}) => ({
    task_id: task.id,
    ok: true,
    summary: `host done ${task.id}`,
    files_written: [],
    payload: null,
    scope_requests: [],
    ...extra,
  });

  if (task.role === 'worker' && task.id.startsWith('exec-')) {
    const written: string[] = [];
    for (const scope of task.write_scope) {
      if (scope.includes('*')) continue;
      const target = path.join(base, scope);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `// ${task.id}\n`, 'utf8');
      written.push(scope);
    }
    return okResult({ files_written: written, payload: { done: true, notes: 'implemented' } });
  }
  if (task.role === 'reviewer') return okResult({ payload: { approved: true, findings: [] } });
  if (task.id.startsWith('plan-') && !task.id.startsWith('plan-review')) {
    const phaseId = task.id.match(/plan-(\d{2})/)?.[1] ?? '01';
    return okResult({ payload: localPlanPayload(phaseId) });
  }
  if (task.id.startsWith('spec-')) {
    const specPath = path.isAbsolute(task.write_scope[0]!)
      ? task.write_scope[0]!
      : path.join(base, task.write_scope[0]!);
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, `# Spec\n\nCenários observáveis de aceite.\n`, 'utf8');
    return okResult({ files_written: [task.write_scope[0]!] });
  }
  if (task.id.startsWith('new-research')) {
    return okResult({
      payload: {
        summary: 'Node 24 é o Active LTS.',
        sources: [
          {
            claim: 'Node.js 24 é Active LTS',
            source: 'nodejs.org previous releases',
            url: 'https://nodejs.org/en/about/previous-releases',
            checked_at: '2026-07-23T00:00:00.000Z',
            version: '24.x',
            confidence: 'high',
            tier: 'official',
          },
        ],
      },
    });
  }
  if (task.id === 'new-extract') return okResult({ payload: EXTRACTION_PAYLOAD });
  return okResult();
}

/** Drives the child over stdio: answers agent.runTask, resolves workflow responses. */
class ChildHost {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private readonly pending = new Map<number, (msg: any) => void>();
  public readonly seenTasks: string[] = [];
  public readonly progress: string[] = [];
  public stderr = '';
  public exitCode: number | null = null;
  public exitSignal: NodeJS.Signals | null = null;
  private readonly exited: Promise<void>;

  constructor(private readonly root: string) {
    this.child = spawn(process.execPath, [cliEntry, 'serve'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
    });
    this.exited = new Promise<void>((resolve) => {
      this.child.on('close', (code, signal) => {
        this.exitCode = code;
        this.exitSignal = signal;
        resolve();
      });
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.handle(msg);
    }
  }

  private handle(msg: any): void {
    if (msg.type === 'notification' && msg.method === 'progress') {
      this.progress.push(msg.params.line);
      return;
    }
    if (msg.type === 'response' && this.pending.has(msg.id)) {
      const resolve = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      resolve(msg);
      return;
    }
    if (msg.type === 'request' && msg.method === 'agent.runTask') {
      const task = msg.params as AgentTaskWire;
      this.seenTasks.push(task.id);
      const result = fakeHostResult(task, this.root);
      this.send({ type: 'response', id: msg.id, result });
      return;
    }
  }

  private send(msg: unknown): void {
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  callWorkflow(id: number, method: string, params: Record<string, unknown>): Promise<any> {
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ type: 'request', method, id, params });
    });
  }

  async endAndWait(): Promise<void> {
    this.child.stdin.end();
    await this.exited;
  }

  /** Close stdin without awaiting — the caller awaits `waitExit()` under a bound. */
  endStdin(): void {
    this.child.stdin.end();
  }

  /** SIGKILL the child and wait for the OS to reap it. */
  async killAndWait(): Promise<void> {
    if (this.exitCode === null && this.exitSignal === null) this.child.kill('SIGKILL');
    await this.exited;
  }

  waitExit(): Promise<void> {
    return this.exited;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return this.exitCode === null && this.exitSignal === null;
  }

  /** Hold a workflow request open: never answers agent.runTask, so the child
   *  stays mid-workflow until we kill it or close its stdin. */
  beginWorkflowNoAnswer(id: number, method: string, params: Record<string, unknown>): void {
    // Deliberately do NOT register a pending resolver — we never expect a reply.
    this.send({ type: 'request', method, id, params });
  }

  /** True once at least one agent.runTask has crossed the wire (workflow underway). */
  get sawAgentTask(): boolean {
    return this.seenTasks.length > 0;
  }

  kill(): void {
    if (this.exitCode === null) this.child.kill('SIGKILL');
  }
}

/** Poll a predicate under a real-time bound (child-process timing is not fake-able). */
async function waitUntil(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((res) => setTimeout(res, 10));
  }
}

/** True while a pid is still a live process (ESRCH once reaped). */
function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('host↔core JSON-RPC bridge (real child process)', () => {
  let root: string;

  beforeAll(() => {
    // Build the CLI so dist/cli/index.js is current; idempotent and CI-safe.
    // tsc is invoked through the current Node binary — spawning "npm" fails on
    // Windows (.cmd shim, ENOENT without a shell).
    const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [tsc, '-p', path.join(repoRoot, 'tsconfig.json')], { cwd: repoRoot, stdio: 'pipe' });
    expect(fs.existsSync(cliEntry)).toBe(true);
  }, 120_000);

  beforeEach(() => {
    root = tmpProject('rijo-bridge-child-');
    writePlanFile(root);
  });
  afterEach(() => cleanup(root));

  it(
    'drives rijo new over stdio, creates .rijo, and shuts down cleanly on stdin end',
    async () => {
      const host = new ChildHost(root);
      try {
        const resp = await host.callWorkflow(1, 'workflow.new', { planFile: '@PLANO.md' });

        expect(resp.error, JSON.stringify(resp)).toBeUndefined();
        expect(resp.result.ok).toBe(true);
        expect(resp.result.status).toBe('completed');

        // the real child actually answered agent.runTask requests over the pipe
        expect(host.seenTasks).toContain('new-extract');
        expect(host.seenTasks.some((id) => id.startsWith('new-research'))).toBe(true);
        expect(host.progress.length).toBeGreaterThan(0);

        // .rijo was created on disk by the child process
        expect(fs.existsSync(path.join(root, '.rijo', 'manifest.json'))).toBe(true);
        const manifest = JSON.parse(fs.readFileSync(path.join(root, '.rijo', 'manifest.json'), 'utf8'));
        expect(manifest.active_milestone).toBe('M001');

        // now drive a run through the first phase over the same child
        const before = host.seenTasks.length;
        const runResp = await host.callWorkflow(2, 'workflow.run', { target: 'all' });
        expect(runResp.id).toBe(2);
        expect('result' in runResp || 'error' in runResp).toBe(true);
        const runTasks = host.seenTasks.slice(before);
        expect(runTasks).toContain('spec-01');
        expect(runTasks.some((id) => id.startsWith('exec-01-'))).toBe(true);

        // clean shutdown: stdin end resolves serve() and the process exits 0
        await host.endAndWait();
        expect(host.exitCode, host.stderr).toBe(0);
        expect(host.exitSignal).toBeNull();
      } finally {
        host.kill();
      }
    },
    60_000,
  );

  it(
    'killing the child mid-workflow surfaces termination to the host',
    async () => {
      const host = new ChildHost(root);
      try {
        // Start a workflow but never answer its agent.runTask calls: the child
        // is now blocked mid-workflow with an in-flight agent task.
        host.beginWorkflowNoAnswer(1, 'workflow.new', { planFile: '@PLANO.md' });
        await waitUntil(() => host.sawAgentTask);
        expect(host.alive).toBe(true);
        const pid = host.pid;

        // Kill it hard. The host observes the pipe closing (child terminated).
        await host.killAndWait();
        expect(host.alive).toBe(false);
        expect(host.exitSignal).toBe('SIGKILL');
        // The OS reaped it: no orphaned child process remains.
        await waitUntil(() => !pidAlive(pid));
        expect(pidAlive(pid)).toBe(false);
      } finally {
        host.kill();
      }
    },
    60_000,
  );

  it(
    'closing stdin mid-workflow shuts the child down cleanly within the grace window',
    async () => {
      const host = new ChildHost(root);
      try {
        // Block the child mid-workflow (no agent answers), then close its stdin.
        host.beginWorkflowNoAnswer(1, 'workflow.new', { planFile: '@PLANO.md' });
        await waitUntil(() => host.sawAgentTask);
        const pid = host.pid;

        host.endStdin();
        // Coordinated shutdown resolves serve() → the process exits 0, well
        // within the 5s grace (plus generous CI slack), never left hanging.
        await Promise.race([
          host.waitExit(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('child did not exit after stdin close')), 30_000)),
        ]);
        expect(host.alive).toBe(false);
        expect(host.exitCode, host.stderr).toBe(0);
        expect(host.exitSignal).toBeNull();
        // Nothing left alive.
        await waitUntil(() => !pidAlive(pid));
        expect(pidAlive(pid)).toBe(false);
      } finally {
        host.kill();
      }
    },
    60_000,
  );
});
