import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../core/fsx.js';
import { canonicalJson, sha256 } from './canonical.js';
import type { OutboxItem, StateStore } from './types.js';

export interface ProjectorHooks {
  beforeProject?: (item: OutboxItem) => void;
  afterRename?: (item: OutboxItem) => void;
  beforeAck?: (item: OutboxItem) => void;
}

export class DurableOutboxProjector {
  constructor(
    private readonly projectRoot: string,
    private readonly store: StateStore,
    private readonly hooks: ProjectorHooks = {},
  ) {}

  async flush(): Promise<number> {
    let projected = 0;
    for (const item of await this.store.readPendingOutbox()) {
      this.hooks.beforeProject?.(item);
      const destination = this.resolveDestination(item.destination);
      if (item.projection_type === 'EVENTS_JSONL') {
        this.projectJsonLine(destination, item);
      } else {
        this.projectCanonicalFile(destination, item);
      }
      this.hooks.beforeAck?.(item);
      await this.store.markOutboxProjected(item.id);
      projected++;
    }
    return projected;
  }

  private resolveDestination(destination: string): string {
    const target = path.resolve(this.projectRoot, destination);
    const relative = path.relative(this.projectRoot, target);
    if (path.isAbsolute(relative) || relative.startsWith('..')) {
      throw new Error(`Outbox destination escapes project root: ${destination}`);
    }
    return target;
  }

  private projectJsonLine(target: string, item: OutboxItem): void {
    if (item.content === undefined) throw new Error(`Outbox item ${item.id} has no projection content`);
    const line = canonicalJson(item.content);
    if (sha256(line) !== item.content_hash) {
      throw new Error(`Outbox item ${item.id} content hash mismatch`);
    }
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const alreadyProjected = existing
      .split('\n')
      .filter(Boolean)
      .some((candidate) => {
        try {
          return canonicalJson(JSON.parse(candidate)) === line;
        } catch {
          return false;
        }
      });
    if (!alreadyProjected) {
      const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
      writeFileAtomic(target, `${prefix}${line}\n`);
      this.hooks.afterRename?.(item);
    }
    const reopened = fs.readFileSync(target, 'utf8');
    if (!reopened.split('\n').some((candidate) => candidate === line)) {
      throw new Error(`Outbox projection verification failed for ${item.destination}`);
    }
  }

  private projectCanonicalFile(target: string, item: OutboxItem): void {
    if (item.content === undefined) throw new Error(`Outbox item ${item.id} has no projection content`);
    const desired =
      typeof item.content === 'string' ? item.content : `${canonicalJson(item.content)}\n`;
    if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === item.content_hash) return;
    if (sha256(desired) !== item.content_hash) {
      throw new Error(`Outbox item ${item.id} content hash mismatch`);
    }
    writeFileAtomic(target, desired);
    this.hooks.afterRename?.(item);
    if (sha256(fs.readFileSync(target)) !== item.content_hash) {
      throw new Error(`Outbox projection verification failed for ${item.destination}`);
    }
  }
}

