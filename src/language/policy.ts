export interface LanguagePolicy {
  policy_name: string;
  maximum_procedural_sentence_words: number;
  portuguese_terms: string[];
  idioms: string[];
  public_commands: string[];
  abbreviations: Record<string, string>;
  controlled_terms?: string[];
}

export interface LanguageFinding {
  path: string;
  line: number;
  rule: string;
  text: string;
}

export function lintRepositoryEnglish(
  source: string,
  filePath: string,
  policy: LanguagePolicy,
): LanguageFinding[] {
  const findings: LanguageFinding[] = [];
  const normalizedTerms = policy.portuguese_terms.map(normalize);
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const normalizedLine = normalize(line);
    for (let termIndex = 0; termIndex < normalizedTerms.length; termIndex += 1) {
      const term = normalizedTerms[termIndex]!;
      if (!new RegExp(`(^|[^a-z])${escapeRegex(term)}([^a-z]|$)`, 'i').test(normalizedLine)) {
        continue;
      }
      findings.push({
        path: filePath,
        line: index + 1,
        rule: 'english-portuguese-term',
        text: policy.portuguese_terms[termIndex]!,
      });
    }
  }
  return findings;
}

export function lintControlledEnglish(
  source: string,
  filePath: string,
  policy: LanguagePolicy,
): LanguageFinding[] {
  const findings: LanguageFinding[] = [];
  const procedural = stripNonProceduralText(source);

  for (const [index, line] of procedural.split(/\r?\n/).entries()) {
    const contractions = line.match(/\b(?:can(?:no)?'t|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|it's|we're|you're|they're|shouldn't|wouldn't|couldn't|mustn't|haven't|hasn't|hadn't)\b/gi) ?? [];
    for (const contraction of contractions) {
      findings.push({
        path: filePath,
        line: index + 1,
        rule: 'controlled-english-contraction',
        text: contraction,
      });
    }

    const normalizedLine = normalize(line);
    for (const idiom of policy.idioms) {
      if (!normalizedLine.includes(normalize(idiom))) continue;
      findings.push({
        path: filePath,
        line: index + 1,
        rule: 'controlled-english-idiom',
        text: idiom,
      });
    }

    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const plain = sentence.replace(/[`*_#[\]()>|{}]/g, ' ').trim();
      if (!plain || !/[.!?]$/.test(plain)) continue;
      const wordCount = plain.split(/\s+/).filter((word) => /[A-Za-z]/.test(word)).length;
      if (wordCount <= policy.maximum_procedural_sentence_words) continue;
      findings.push({
        path: filePath,
        line: index + 1,
        rule: 'controlled-english-sentence-length',
        text: `${wordCount} words`,
      });
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const numberedAction = numbered?.[1]?.replace(/`.*`/g, '') ?? '';
    if (
      numbered &&
      !/\bto\b.*\b(?:and|then)\b/i.test(numberedAction) &&
      /\b(?:and|then)\s+(?:read|write|run|record|create|update|check|verify|load|use|open|start|stop|return|ask|delegate|inspect|capture|install|build|select|refresh|mark|continue)\b/i.test(
        numberedAction,
      )
    ) {
      findings.push({
        path: filePath,
        line: index + 1,
        rule: 'controlled-english-numbered-action',
        text: numbered[1]!,
      });
    }

    const prose = line.replace(/`.*`/g, '');
    const controlledTerms = new Set(policy.controlled_terms ?? []);
    for (const match of prose.matchAll(/\b[A-Z][A-Z0-9]{1,}\b/g)) {
      const abbreviation = match[0];
      if (policy.abbreviations[abbreviation] || controlledTerms.has(abbreviation)) continue;
      findings.push({
        path: filePath,
        line: index + 1,
        rule: 'controlled-english-undefined-abbreviation',
        text: abbreviation,
      });
    }

    for (const match of line.matchAll(/(?:\$|\/)rijo\s+([a-z][a-z-]*)/g)) {
      const command = match[1]!;
      if (policy.public_commands.includes(command) || command === 'internal') continue;
      findings.push({
        path: filePath,
        line: index + 1,
        rule: 'controlled-english-command-name',
        text: command,
      });
    }
  }

  return findings;
}

function stripNonProceduralText(source: string): string {
  let inFence = false;
  let inFrontmatter = false;
  return source
    .split(/\r?\n/)
    .map((line, index) => {
      if (index === 0 && line.trim() === '---') {
        inFrontmatter = true;
        return '';
      }
      if (inFrontmatter && line.trim() === '---') {
        inFrontmatter = false;
        return '';
      }
      if (line.trim().startsWith('```')) {
        inFence = !inFence;
        return '';
      }
      if (inFence || inFrontmatter) return '';
      return line.replace(/https?:\/\/\S+/g, '');
    })
    .join('\n');
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
