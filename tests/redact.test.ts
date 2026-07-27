import { describe, it, expect } from 'vitest';
import { redact } from '../src/security/redact.js';

describe('redact', () => {
  it('redacts sk- style API keys', () => {
    const input = 'key=sk-abcdef1234567890ABCDEF rest of line';
    const out = redact(input);
    expect(out).not.toContain('sk-abcdef1234567890ABCDEF');
    expect(out).toContain('[REDACTED:API_KEY]');
  });

  it('redacts GitHub ghp_ tokens', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const out = redact(`Authorization uses ${token} here`);
    expect(out).not.toContain(token);
    expect(out).toContain('[REDACTED:GITHUB_TOKEN]');
  });

  it('redacts JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
    const out = redact(`bearer ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('[REDACTED:JWT]');
  });

  it('redacts password assignments but keeps the key name', () => {
    const out = redact('password: hunter22secret');
    expect(out).toBe('password: [REDACTED]');
  });

  it('redacts the complete bearer credential rather than only the Bearer prefix', () => {
    const secret = 'secret-value-123456789';
    const out = redact(`Authorization: Bearer ${secret}`);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts credentials embedded in urls but keeps the host', () => {
    const out = redact('fetch https://admin:s3cretpw@example.com/path now');
    expect(out).toBe('fetch https://[REDACTED]@example.com/path now');
  });

  it('leaves normal text unchanged', () => {
    const text = 'The quick brown fox jumps over 12 lazy dogs near https://example.com/docs.';
    expect(redact(text)).toBe(text);
  });
});
