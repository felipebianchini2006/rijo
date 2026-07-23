import * as fs from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProgressBus, renderStatusLine, readStatus, silentSink } from '../src/core/progress.js';
import { RijoPaths } from '../src/core/paths.js';
import { StatusSchema, type StatusSnapshot } from '../src/core/schemas/index.js';
import { tmpProject, cleanup } from './helpers.js';

const FIXED_ISO = '2026-07-23T12:00:00.000Z';
const fixedNow = () => new Date(FIXED_ISO);

describe('progress', () => {
  let root: string;
  let paths: RijoPaths;

  beforeEach(() => {
    root = tmpProject();
    paths = new RijoPaths(root);
  });

  afterEach(() => {
    cleanup(root);
  });

  describe('ProgressBus.emit', () => {
    it('appends one event line and atomically rewrites a schema-valid status.json', () => {
      const bus = new ProgressBus(paths, 'run-1', silentSink, fixedNow);

      bus.emit('stage_started', {
        status: 'running',
        milestone: { id: 'M001', name: 'Initial' },
        stage: 'PLAN',
        message: 'planning',
      });

      // 1 line in events.jsonl
      const lines = fs.readFileSync(paths.events, 'utf8').split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      const event = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(event).toEqual({ ts: FIXED_ISO, run_id: 'run-1', type: 'stage_started', data: {} });

      // status.json rewritten and valid against StatusSchema
      const rawStatus = JSON.parse(fs.readFileSync(paths.status, 'utf8')) as unknown;
      const snapshot = StatusSchema.parse(rawStatus);
      expect(snapshot.run_id).toBe('run-1');
      expect(snapshot.status).toBe('running');
      expect(snapshot.milestone).toEqual({ id: 'M001', name: 'Initial' });
      expect(snapshot.stage).toBe('PLAN');
      expect(snapshot.message).toBe('planning');
      expect(snapshot.updated_at).toBe(FIXED_ISO);

      // no atomic-write temp files left behind
      const leftovers = fs.readdirSync(paths.runtimeDir).filter((n) => n.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    });

    it('appends one line per emit and keeps status.json at the latest snapshot', () => {
      const bus = new ProgressBus(paths, 'run-2', silentSink, fixedNow);
      bus.emit('a', { message: 'first' }, { detail: 1 });
      bus.emit('b', { message: 'second' });

      const lines = fs.readFileSync(paths.events, 'utf8').split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
      expect((JSON.parse(lines[0]!) as { type: string; data: unknown }).data).toEqual({ detail: 1 });
      expect((JSON.parse(lines[1]!) as { type: string }).type).toBe('b');

      const snapshot = StatusSchema.parse(JSON.parse(fs.readFileSync(paths.status, 'utf8')));
      expect(snapshot.message).toBe('second');
      expect(bus.current.message).toBe('second');
    });
  });

  describe('renderStatusLine', () => {
    it('renders the full crafted snapshot exactly', () => {
      const snapshot: StatusSnapshot = StatusSchema.parse({
        schema_version: 1,
        run_id: 'run-x',
        status: 'running',
        milestone: { id: 'M002', name: 'Milestone two' },
        phase: { id: '03', index: 3, total: 5, name: 'Phase three' },
        stage: 'EXECUTE',
        task: { id: 'T02', index: 2, total: 4, name: 'Task two' },
        agent: null,
        completed_units: 1,
        total_units: 4,
        last_checkpoint: null,
        started_at: FIXED_ISO,
        updated_at: FIXED_ISO,
        message: 'message',
      });
      expect(renderStatusLine(snapshot)).toBe('[RIJO M002 F03/05] EXECUTE T02/04  message');
    });

    it('renders a minimal snapshot without milestone/phase/task', () => {
      const snapshot: StatusSnapshot = StatusSchema.parse({
        schema_version: 1,
        run_id: 'run-x',
        status: 'idle',
        milestone: null,
        phase: null,
        stage: null,
        task: null,
        agent: null,
        completed_units: 0,
        total_units: 0,
        last_checkpoint: null,
        started_at: FIXED_ISO,
        updated_at: FIXED_ISO,
        message: '',
      });
      expect(renderStatusLine(snapshot)).toBe('[RIJO]');
    });
  });

  describe('readStatus', () => {
    it('returns null when status.json does not exist', () => {
      expect(readStatus(paths)).toBeNull();
    });

    it('returns the snapshot written by the bus', () => {
      const bus = new ProgressBus(paths, 'run-3', silentSink, fixedNow);
      bus.emit('tick', { status: 'running', message: 'hi' });
      const status = readStatus(paths);
      expect(status).not.toBeNull();
      expect(status!.run_id).toBe('run-3');
      expect(status!.message).toBe('hi');
    });
  });
});
