import { describe, expect, it } from 'vitest';
import {
  MemoryStateStore,
  canonicalJson,
  computeEventHash,
  redactDurableValue,
  type DomainEvent,
} from '../src/durable/index.js';

function runCreated(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    event_id: 'evt-run-created',
    run_id: 'run-1',
    aggregate_type: 'run',
    aggregate_id: 'run-1',
    event_type: 'run.created',
    schema_version: 1,
    payload: {
      plan_hash: 'plan-hash',
      host: 'codex',
      status: 'RUNNING',
      started_commit: 'abc123',
    },
    created_at: '2026-07-27T12:00:00.000Z',
    idempotency_key: 'run-1:create',
    ...overrides,
  };
}

describe('MemoryStateStore', () => {
  it('redacts values idempotently so outbox hashes survive a second persistence boundary', () => {
    const once = redactDurableValue({
      apiKey: 'customer-api-key-123456',
      file: { path: '.env', content: 'TOKEN=opaque' },
    });
    expect(redactDurableValue(once)).toEqual(once);
  });

  it('commits an event, updates the run projection and enqueues its projection exactly once', async () => {
    const store = new MemoryStateStore();
    await store.initialize();

    await store.appendEvent(runCreated());
    await store.appendEvent(runCreated({ event_id: 'duplicate-event-id' }));

    const run = await store.getRun('run-1');
    expect(run).toMatchObject({
      id: 'run-1',
      plan_hash: 'plan-hash',
      host: 'codex',
      status: 'RUNNING',
      last_event_sequence: 1,
    });
    expect(await store.readEvents()).toHaveLength(1);
    expect(await store.readPendingOutbox()).toHaveLength(1);
    expect((await store.integrityCheck()).ok).toBe(true);
  });

  it('rolls back event, projection and outbox when a transaction throws', async () => {
    const store = new MemoryStateStore();
    await store.initialize();

    await expect(
      store.transaction(async (tx) => {
        await tx.appendEvent(runCreated());
        throw new Error('crash after event');
      }),
    ).rejects.toThrow('crash after event');

    expect(await store.getRun('run-1')).toBeNull();
    expect(await store.readEvents()).toEqual([]);
    expect(await store.readPendingOutbox()).toEqual([]);
  });

  it('builds a deterministic global hash chain', async () => {
    const store = new MemoryStateStore();
    await store.initialize();
    await store.appendEvent(runCreated());
    await store.appendEvent({
      ...runCreated({
        event_id: 'evt-phase-started',
        aggregate_type: 'phase',
        aggregate_id: '01',
        event_type: 'phase.started',
        idempotency_key: 'phase-01:start',
        payload: { phase_id: '01' },
      }),
    });

    const [first, second] = await store.readEvents();
    expect(first!.previous_event_hash).toBe('');
    expect(first!.event_hash).toBe(
      computeEventHash(1, first!.event_type, first!.aggregate_id, first!.payload, ''),
    );
    expect(second!.sequence).toBe(2);
    expect(second!.previous_event_hash).toBe(first!.event_hash);
    expect((await store.integrityCheck()).last_event_sequence).toBe(2);
  });

  it('redacts sensitive values before events and outbox content become durable', async () => {
    const store = new MemoryStateStore();
    await store.initialize();
    await store.appendEvent(
      runCreated({
        payload: {
          plan_hash: 'plan-hash',
          host: 'claude',
          token: 'sk-do-not-persist',
          nested: {
            password: 'hunter2',
            apiKey: 'customer-api-key-123456',
            clientSecret: 'client-secret-opaque',
            safe_name: 'DATABASE_URL',
            file: {
              path: '.env.production',
              content: 'CUSTOM_CREDENTIAL=opaque-value-987654',
            },
            summary:
              'failed with Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature and sk-proj-abcdefghijklmnop',
          },
        },
      }),
    );

    const serialized = canonicalJson({
      events: await store.readEvents(),
      outbox: await store.readPendingOutbox(),
    });
    expect(serialized).not.toContain('sk-do-not-persist');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('customer-api-key-123456');
    expect(serialized).not.toContain('client-secret-opaque');
    expect(serialized).not.toContain('opaque-value-987654');
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(serialized).not.toContain('sk-proj-abcdefghijklmnop');
    expect(serialized).toContain('DATABASE_URL');
    expect(serialized).toContain('"redacted":true');
  });

  it('marks outbox items projected idempotently', async () => {
    const store = new MemoryStateStore();
    await store.initialize();
    await store.appendEvent(runCreated());
    const [item] = await store.readPendingOutbox();

    await store.markOutboxProjected(item!.id);
    await store.markOutboxProjected(item!.id);

    expect(await store.readPendingOutbox()).toEqual([]);
  });
});
