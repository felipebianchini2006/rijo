/**
 * Redact secrets and tokens from any text destined for prompts, logs or
 * reports. Pattern-based; conservative (prefers false positives).
 */
const PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(sk|pk|rk)-[a-zA-Z0-9_-]{16,}/g, label: 'API_KEY' },
  { re: /gh[pousr]_[A-Za-z0-9_]{20,}/g, label: 'GITHUB_TOKEN' },
  { re: /AKIA[0-9A-Z]{16}/g, label: 'AWS_KEY' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, label: 'SLACK_TOKEN' },
  { re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, label: 'JWT' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: 'PRIVATE_KEY' },
  {
    re: /((?:password|passwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*)(["']?)[^\s"']{6,}\2/gi,
    label: 'CREDENTIAL',
  },
  { re: /(https?:\/\/)[^\s:/@]+:[^\s@/]+@/g, label: 'URL_CREDENTIAL' },
];

export function redact(text: string): string {
  let out = text;
  for (const { re, label } of PATTERNS) {
    out = out.replace(re, (match, ...groups) => {
      // keep the key name for CREDENTIAL-style matches
      if (label === 'CREDENTIAL' && typeof groups[0] === 'string') return `${groups[0]}[REDACTED]`;
      if (label === 'URL_CREDENTIAL' && typeof groups[0] === 'string') return `${groups[0]}[REDACTED]@`;
      void match;
      return `[REDACTED:${label}]`;
    });
  }
  return out;
}
