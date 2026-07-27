import * as path from 'node:path';

/** Canonical layout of the .rijo directory inside a managed project. */
export class RijoPaths {
  constructor(public readonly projectRoot: string) {}

  get root(): string {
    return path.join(this.projectRoot, '.rijo');
  }
  get config(): string {
    return path.join(this.root, 'config.yml');
  }
  get manifest(): string {
    return path.join(this.root, 'manifest.json');
  }
  get project(): string {
    return path.join(this.root, 'PROJECT.md');
  }
  get rules(): string {
    return path.join(this.root, 'RULES.md');
  }
  get stack(): string {
    return path.join(this.root, 'STACK.md');
  }
  get milestonesIndex(): string {
    return path.join(this.root, 'MILESTONES.md');
  }
  get state(): string {
    return path.join(this.root, 'STATE.md');
  }
  get decisions(): string {
    return path.join(this.root, 'DECISIONS.md');
  }
  get codebaseDir(): string {
    return path.join(this.root, 'codebase');
  }
  get codebaseMapState(): string {
    return path.join(this.codebaseDir, 'map-state.json');
  }
  /** Volatile delta marker written after verified phases/fixes; consumed by the next map/new. */
  get codebaseStale(): string {
    return path.join(this.runtimeDir, 'codebase-stale.json');
  }
  get researchDir(): string {
    return path.join(this.root, 'research');
  }
  get researchCache(): string {
    return path.join(this.researchDir, 'cache.json');
  }
  get researchSources(): string {
    return path.join(this.researchDir, 'sources.json');
  }
  get milestonesDir(): string {
    return path.join(this.root, 'milestones');
  }
  get fixesDir(): string {
    return path.join(this.root, 'fixes');
  }
  get importsDir(): string {
    return path.join(this.root, 'imports');
  }
  get runtimeDir(): string {
    return path.join(this.root, 'runtime');
  }
  /** Local transactional state. Database, WAL/SHM and backups are never committed. */
  get durableStateDir(): string {
    return path.join(this.root, 'state');
  }
  get durableDb(): string {
    return path.join(this.durableStateDir, 'rijo.db');
  }
  get durableBackupsDir(): string {
    return path.join(this.durableStateDir, 'backups');
  }
  get durableMigrationsDir(): string {
    return path.join(this.durableStateDir, 'migrations');
  }
  /** Portable, commit-safe recovery material exported from the local database. */
  get ledgerDir(): string {
    return path.join(this.root, 'ledger');
  }
  get eventSegmentsDir(): string {
    return path.join(this.ledgerDir, 'event-segments');
  }
  get snapshotsDir(): string {
    return path.join(this.ledgerDir, 'snapshots');
  }
  get latestSnapshot(): string {
    return path.join(this.ledgerDir, 'latest.json');
  }
  get checkpointsDir(): string {
    return path.join(this.root, 'checkpoints');
  }
  get status(): string {
    return path.join(this.runtimeDir, 'status.json');
  }
  get supervisorStatus(): string {
    return path.join(this.runtimeDir, 'supervisor.json');
  }
  get run(): string {
    return path.join(this.runtimeDir, 'run.json');
  }
  get lock(): string {
    return path.join(this.runtimeDir, 'lock.json');
  }
  /** Durable phase-finalization marker (crash-safe, resumable). */
  get finalize(): string {
    return path.join(this.runtimeDir, 'finalize.json');
  }
  get archiveDir(): string {
    return path.join(this.root, 'archive');
  }
  get events(): string {
    return path.join(this.root, 'events.jsonl');
  }
  get adaptersDir(): string {
    return path.join(this.root, 'adapters');
  }

  milestoneDir(id: string, slug?: string): string {
    return path.join(this.milestonesDir, slug ? `${id}-${slug}` : id);
  }

  /** Resolve a milestone directory by ID prefix (e.g. "M001" -> "M001-initial-scope"). */
  static milestoneDirName(id: string, slug: string): string {
    return `${id}-${slug}`;
  }
}

export interface MilestonePaths {
  dir: string;
  scope: string;
  requirements: string;
  roadmap: string;
  research: string;
  summary: string;
  closeout: string;
  phasesDir: string;
  qaDir: string;
  readiness: string;
}

export function milestonePaths(dir: string): MilestonePaths {
  return {
    dir,
    scope: path.join(dir, 'SCOPE.md'),
    requirements: path.join(dir, 'REQUIREMENTS.md'),
    roadmap: path.join(dir, 'ROADMAP.md'),
    research: path.join(dir, 'RESEARCH.md'),
    summary: path.join(dir, 'SUMMARY.md'),
    closeout: path.join(dir, 'CLOSEOUT.md'),
    phasesDir: path.join(dir, 'phases'),
    qaDir: path.join(dir, 'qa'),
    readiness: path.join(dir, 'qa', 'production-readiness.md'),
  };
}

export interface PhasePaths {
  dir: string;
  spec: string;
  plan: string;
  summary: string;
  review: string;
  verification: string;
}

export function phasePaths(dir: string): PhasePaths {
  return {
    dir,
    spec: path.join(dir, 'SPEC.md'),
    plan: path.join(dir, 'PLAN.md'),
    summary: path.join(dir, 'SUMMARY.md'),
    review: path.join(dir, 'REVIEW.md'),
    verification: path.join(dir, 'VERIFICATION.md'),
  };
}
