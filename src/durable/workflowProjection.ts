import * as fs from 'node:fs';
import * as path from 'node:path';
import { activeMilestone } from '../core/milestones.js';
import { readPlan } from '../core/plan.js';
import { RijoPaths } from '../core/paths.js';
import { readRequirements, readRoadmap } from '../core/roadmap.js';
import { readJsonIfExists } from '../core/fsx.js';
import { TaskRecordSchema } from '../core/schemas/index.js';

export interface WorkflowProjectionPacket {
  milestone: Record<string, unknown> | null;
  phases: Array<Record<string, unknown>>;
  requirements: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  attempts: Array<Record<string, unknown>>;
  map_state: Record<string, unknown> | null;
}

/**
 * Reads only canonical/runtime projections at a checkpoint boundary. The
 * packet is committed as an event; SQLite tables are then derived from that
 * event, so filesystem documents are never written before the ledger.
 */
export function collectWorkflowProjection(projectRoot: string): WorkflowProjectionPacket {
  const paths = new RijoPaths(projectRoot);
  const milestone = activeMilestone(paths);
  const packet: WorkflowProjectionPacket = {
    milestone: null,
    phases: [],
    requirements: [],
    tasks: [],
    attempts: [],
    map_state:
      readJsonIfExists<Record<string, unknown>>(path.join(paths.codebaseDir, 'map-state.json')),
  };
  if (!milestone) return packet;

  const roadmap = fs.existsSync(milestone.paths.roadmap)
    ? readRoadmap(milestone.paths.roadmap)
    : null;
  const requirements = fs.existsSync(milestone.paths.requirements)
    ? readRequirements(milestone.paths.requirements)
    : null;
  packet.milestone = {
    id: milestone.id,
    slug: milestone.slug,
    status: roadmap?.phases.every((phase) => phase.status === 'DONE') ? 'COMPLETE' : 'ACTIVE',
  };
  packet.phases = roadmap?.phases.map((phase) => ({ ...phase })) ?? [];
  packet.requirements = requirements?.requirements.map((requirement) => ({ ...requirement })) ?? [];

  if (roadmap) {
    for (const phase of roadmap.phases) {
      const entry = fs.existsSync(milestone.paths.phasesDir)
        ? fs.readdirSync(milestone.paths.phasesDir).find((name) => name.startsWith(`${phase.id}-`))
        : undefined;
      const planPath = entry
        ? path.join(milestone.paths.phasesDir, entry, 'PLAN.md')
        : null;
      if (!planPath || !fs.existsSync(planPath)) continue;
      const plan = readPlan(planPath);
      packet.tasks.push(
        ...plan.tasks.map((task) => ({
          ...task,
          logical_task_id: `${milestone.id}:${phase.id}:${task.id}`,
          milestone_id: milestone.id,
          phase_id: phase.id,
        })),
      );
    }
  }

  const taskDir = path.join(paths.runtimeDir, 'tasks');
  if (fs.existsSync(taskDir)) {
    for (const name of fs.readdirSync(taskDir).filter((entry) => entry.endsWith('.json')).sort()) {
      const parsed = TaskRecordSchema.safeParse(
        readJsonIfExists<unknown>(path.join(taskDir, name)),
      );
      if (parsed.success) {
        const suffix = `:${parsed.data.logical_task_id}`;
        const candidates = packet.tasks.filter((task) =>
          String(task['logical_task_id'] ?? '').endsWith(suffix),
        );
        const active = candidates.find((task) => {
          const phaseId = String(task['phase_id'] ?? '');
          return roadmap?.phases.find((phase) => phase.id === phaseId)?.status !== 'DONE';
        });
        const qualified = active ?? candidates.at(-1);
        packet.attempts.push({
          ...parsed.data,
          logical_task_id:
            String(qualified?.['logical_task_id'] ?? '') ||
            `${milestone.id}:runtime:${parsed.data.logical_task_id}`,
        });
      }
    }
  }
  return packet;
}
