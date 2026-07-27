import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  lintControlledEnglish,
  lintRepositoryEnglish,
  type LanguagePolicy,
} from '../src/language/policy.js';

const root = path.resolve(import.meta.dirname, '..');
const policy = JSON.parse(
  fs.readFileSync(path.join(root, 'config', 'language-policy.json'), 'utf8'),
) as LanguagePolicy;

describe('repository language policy', () => {
  it('detects Portuguese content in runtime and documentation text', () => {
    const findings = lintRepositoryEnglish(
      `The ${policy.portuguese_terms[25]} has one ${policy.portuguese_terms[12]}.`,
      'sample.md',
      policy,
    );
    expect(findings.map((finding) => finding.rule)).toEqual([
      'english-portuguese-term',
      'english-portuguese-term',
    ]);
  });

  it('accepts concise English content', () => {
    expect(
      lintRepositoryEnglish(
        'Read the current state. Run the required test. Record the evidence.',
        'sample.md',
        policy,
      ),
    ).toEqual([]);
  });

  it('rejects contractions, configured idioms, and long procedural sentences', () => {
    const findings = lintControlledEnglish(
      "Do not cut corners. You can't run this very long procedural sentence because it contains far too many words and combines several separate actions that should each use a short sentence for clear technical instructions.",
      'sample.md',
      policy,
    );
    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([
        'controlled-english-contraction',
        'controlled-english-idiom',
        'controlled-english-sentence-length',
      ]),
    );
  });

  it('rejects compound numbered actions, undefined abbreviations, and invalid public commands', () => {
    const findings = lintControlledEnglish(
      [
        '1. Read the state and run the test.',
        '2. Record the XYZ result.',
        'Use `$rijo launch` now.',
      ].join('\n'),
      'sample.md',
      policy,
    );
    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([
        'controlled-english-numbered-action',
        'controlled-english-undefined-abbreviation',
        'controlled-english-command-name',
      ]),
    );
  });

  it('passes all repository English and canonical controlled-English checks', () => {
    const repositoryFiles = [
      'README.md',
      ...listFiles('docs'),
      ...listFiles('skills'),
      ...listFiles('templates'),
      ...listFiles('src'),
      ...listFiles('tests'),
      ...listFiles('examples'),
      ...listFiles('.rijo'),
    ].filter((file) => /\.(?:md|ts|json|ya?ml|jsonl)$/.test(file));

    const englishFindings = repositoryFiles.flatMap((file) =>
      lintRepositoryEnglish(fs.readFileSync(path.join(root, file), 'utf8'), file, policy),
    );
    expect(format(englishFindings)).toEqual([]);

    const controlledFiles = [
      ...listFiles('skills/rijo'),
      ...listFiles('templates'),
    ].filter((file) => file.endsWith('.md'));
    const controlledFindings = controlledFiles.flatMap((file) =>
      lintControlledEnglish(fs.readFileSync(path.join(root, file), 'utf8'), file, policy),
    );
    expect(format(controlledFindings)).toEqual([]);
  });
});

function listFiles(relative: string): string[] {
  const start = path.join(root, relative);
  if (!fs.existsSync(start)) return [];
  const results: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist', 'coverage', 'artifacts', 'state', 'runtime', 'archive'].includes(entry.name)) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else results.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  };
  if (fs.statSync(start).isDirectory()) visit(start);
  else results.push(relative);
  return results;
}

function format(
  findings: Array<{ path: string; line: number; rule: string; text: string }>,
): string[] {
  return findings.map(
    (finding) => `${finding.path}:${finding.line} ${finding.rule} ${finding.text}`,
  );
}
