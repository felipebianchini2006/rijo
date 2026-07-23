import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../src/core/templates.js';

describe('renderTemplate', () => {
  it('substitutes provided variables', () => {
    const out = renderTemplate('Hello {{name}}, welcome to {{project.name}}!', {
      name: 'Rijo',
      'project.name': 'Loja',
    });
    expect(out).toBe('Hello Rijo, welcome to Loja!');
  });

  it('substitutes repeated placeholders everywhere they appear', () => {
    const out = renderTemplate('{{x}} + {{x}} = 2{{x}}', { x: 'a' });
    expect(out).toBe('a + a = 2a');
  });

  it('leaves text without placeholders unchanged', () => {
    expect(renderTemplate('no placeholders here', {})).toBe('no placeholders here');
  });

  it('allows empty-string values (explicit, not silent)', () => {
    expect(renderTemplate('[{{gap}}]', { gap: '' })).toBe('[]');
  });

  it('throws loudly on an unresolved placeholder', () => {
    expect(() => renderTemplate('Hello {{missing}}', {})).toThrow(
      'Unresolved template variable: {{missing}}',
    );
  });

  it('throws even when other variables resolve', () => {
    expect(() => renderTemplate('{{a}} {{b}}', { a: 'ok' })).toThrow(
      'Unresolved template variable: {{b}}',
    );
  });
});
