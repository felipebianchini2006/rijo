import { AgentResultSchema, type AgentTask, type AgentResult } from '../agents/protocol.js';
import { renderBrief } from '../agents/prompts.js';

/**
 * Compose the full prompt handed to a CLI host: the deterministic RIJO brief
 * (objective, files, scope, acceptance, commands, return format) plus the
 * host-contract that tells the agent to end its reply with a single JSON
 * AgentResult block. The block is how the driver recovers a structured result
 * from free-form CLI output.
 */
export function buildHostPrompt(task: AgentTask): string {
  const skeleton: AgentResult = {
    task_id: task.id,
    ok: true,
    summary: 'one-line confirmation or, if ok=false, the precise reason',
    files_written: [],
    payload: null,
    scope_requests: [],
    decision_proposals: [],
    workflow_epoch: task.attempt?.workflow_epoch ?? null,
    attempt_id: null,
    generation: null,
    lease_id: null,
  };
  return [
    renderBrief(task),
    '',
    '## Host response contract',
    'When you are done, the LAST thing in your reply MUST be one fenced JSON block',
    'matching this exact shape (no comments, no trailing text after it):',
    '',
    '```json',
    JSON.stringify(skeleton, null, 2),
    '```',
    '',
    '- `ok`: false if you could not complete the task; explain why in `summary`.',
    '- `summary`: a single line — never your reasoning or the full work product.',
    '- `files_written`: paths you actually wrote, relative to your working directory.',
    '- `payload`: the structured data the return format asks for, or null.',
    '- `scope_requests`: paths you needed to write but were outside your write scope.',
    '- `decision_proposals`: every material choice or true blocker; use [] when none. The core validates evidence, blocker category, confidence, reversibility, consequences and review condition.',
  ].join('\n');
}

/** Balanced-brace scan for top-level `{...}` objects embedded in free text. */
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      continue;
    }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

/** Collect JSON candidate strings: fenced code blocks first, then bare objects. */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) out.push(m[1]!.trim());
  out.push(...balancedObjects(text));
  return out;
}

function coerce(obj: unknown, taskId: string): AgentResult | null {
  let candidate = obj;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && !('task_id' in candidate)) {
    candidate = { task_id: taskId, ...(candidate as Record<string, unknown>) };
  }
  const parsed = AgentResultSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Recover an AgentResult from arbitrary host text. Tries every JSON candidate
 * from the last one backwards (the contract puts the real result last) and
 * returns the first that validates as an AgentResult. Returns null when none
 * do — the caller then produces an explicit ok:false diagnostic rather than
 * pretending success.
 */
export function extractAgentResult(text: string, taskId: string): AgentResult | null {
  const candidates = jsonCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    let obj: unknown;
    try {
      obj = JSON.parse(candidates[i]!);
    } catch {
      continue;
    }
    const result = coerce(obj, taskId);
    if (result) return result;
  }
  return null;
}

/** A short, safe diagnostic tail from a CLI run for ok:false summaries. */
export function diagnosticTail(stderr: string, stdout: string, max = 300): string {
  const raw = (stderr.trim() || stdout.trim()).replace(/\s+/g, ' ');
  if (!raw) return '(no output)';
  return raw.length > max ? `…${raw.slice(-max)}` : raw;
}

/** Build an ok:false AgentResult with a precise diagnostic. Never simulates work. */
export function failResult(taskId: string, summary: string): AgentResult {
  return {
    task_id: taskId,
    ok: false,
    summary,
    files_written: [],
    payload: null,
    scope_requests: [],
    workflow_epoch: null,
    attempt_id: null,
    generation: null,
    lease_id: null,
  };
}
