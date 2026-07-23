/**
 * Fail-loud template rendering: any unresolved {{placeholder}} throws.
 * Never a silent empty substitution.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const rendered = template.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`Unresolved template variable: {{${key}}}`);
    return vars[key]!;
  });
  return rendered;
}
