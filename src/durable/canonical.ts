import { createHash } from 'node:crypto';
import { redact } from '../security/redact.js';

const SENSITIVE_KEY =
  /(?:^|_)(?:access_?token|api_?key|auth(?:orization)?|client_?secret|cookie|credential|database_?url|pass(?:word)?|private_?key|refresh_?token|secret|session|signing_?key|token)(?:$|_)/i;

const SENSITIVE_DOCUMENT =
  /(?:^|\/)(?:\.env(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|id_[^/]+|[^/]*private[^/]*key[^/]*)$/i;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function redacted(value: unknown): Record<string, unknown> {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    redacted: true,
    present: value !== null && value !== undefined && serialized.length > 0,
    hash: hash(serialized),
  };
}

function isRedactionMarker(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as Record<string, unknown>)['redacted'] === true &&
      typeof (value as Record<string, unknown>)['present'] === 'boolean' &&
      typeof (value as Record<string, unknown>)['hash'] === 'string',
  );
}

/**
 * Durable data crosses a stricter boundary than logs: likely secret-bearing
 * keys retain only presence and a one-way hash. Objects and arrays are copied,
 * so callers cannot mutate the persisted representation after validation.
 */
export function redactDurableValue(value: unknown, parentKey = ''): unknown {
  const normalizedKey = parentKey.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  if (SENSITIVE_KEY.test(normalizedKey)) {
    return isRedactionMarker(value) ? { ...value } : redacted(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactDurableValue(item));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const referencedPath = ['path', 'file', 'filename', 'name']
      .map((key) => record[key])
      .find((candidate): candidate is string => typeof candidate === 'string');
    const sensitiveDocument = referencedPath ? SENSITIVE_DOCUMENT.test(referencedPath) : false;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      output[key] =
        sensitiveDocument && /^(?:body|content|data|source|text|value)$/i.test(key)
          ? isRedactionMarker(child) ? { ...child } : redacted(child)
          : redactDurableValue(child, key);
    }
    return output;
  }
  if (typeof value === 'string') {
    return redact(value)
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(
        /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/@]+:[^\s@/]+@/gi,
        (match) => `${match.slice(0, match.indexOf('://') + 3)}[REDACTED]@`,
      );
  }
  return value;
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortCanonical(child)]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function computeEventHash(
  sequence: number,
  eventType: string,
  aggregateId: string,
  payload: unknown,
  previousEventHash: string,
): string {
  return sha256(
    `${sequence}${eventType}${aggregateId}${canonicalJson(payload)}${previousEventHash}`,
  );
}
