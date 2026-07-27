# Engineering review

Use an independent native reviewer.
Give the reviewer the goal, specification, plan, diff, rules, and verification evidence.
Do not give the reviewer author reasoning.

Check:

- Correctness.
- Simplicity.
- Cohesion.
- Coupling.
- Duplication.
- Error handling.
- Security.
- Data integrity.
- Performance risks.
- Test quality.
- Code smells.
- Unnecessary abstractions.
- Scope drift.

Classify each finding.
Require a path, evidence, severity, and repair condition.
Reject unsupported findings.

The framework runs UI smoke after engineering review.
Do not reject a phase only because future UI smoke evidence is absent.
Check that the requested smoke journey can prove the UI acceptance criteria.
