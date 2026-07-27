import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../core/fsx.js';
import { canonicalJson, sha256 } from './canonical.js';
import type { StateStore, StoredDomainEvent } from './types.js';

export interface EventSegment {
  path: string;
  first_sequence: number;
  last_sequence: number;
  hash: string;
  events: StoredDomainEvent[];
}

export async function exportFinalizedEventSegment(
  projectRoot: string,
  store: StateStore,
  afterSequence = 0,
): Promise<EventSegment | null> {
  const events = await store.readEvents(afterSequence);
  if (events.length === 0) return null;
  const content = `${events.map((event) => canonicalJson(event)).join('\n')}\n`;
  const hash = sha256(content);
  const first = events[0]!.sequence;
  const last = events.at(-1)!.sequence;
  const target = path.join(
    projectRoot,
    '.rijo',
    'ledger',
    'event-segments',
    `${String(first).padStart(12, '0')}-${String(last).padStart(12, '0')}-${hash}.jsonl`,
  );
  writeFileAtomic(target, content);
  if (sha256(fs.readFileSync(target)) !== hash) {
    throw new Error(`Event segment verification failed for ${target}`);
  }
  return { path: target, first_sequence: first, last_sequence: last, hash, events };
}

export function readEventSegments(
  projectRoot: string,
  afterSequence = 0,
): StoredDomainEvent[] {
  const dir = path.join(projectRoot, '.rijo', 'ledger', 'event-segments');
  if (!fs.existsSync(dir)) return [];
  const events: StoredDomainEvent[] = [];
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.jsonl')).sort()) {
    const target = path.join(dir, name);
    const content = fs.readFileSync(target, 'utf8');
    const expectedHash = name.match(/-([a-f0-9]{64})\.jsonl$/)?.[1];
    if (!expectedHash || sha256(content) !== expectedHash) {
      throw new Error(`Invalid or tampered event segment: ${name}`);
    }
    for (const line of content.split('\n').filter(Boolean)) {
      const event = JSON.parse(line) as StoredDomainEvent;
      if (event.sequence > afterSequence) events.push(event);
    }
  }
  const bySequence = new Map<number, StoredDomainEvent>();
  for (const event of events) {
    const prior = bySequence.get(event.sequence);
    if (prior && canonicalJson(prior) !== canonicalJson(event)) {
      throw new Error(`Conflicting duplicate event sequence ${event.sequence} across segments`);
    }
    bySequence.set(event.sequence, event);
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

