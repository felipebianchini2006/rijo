# Development plan: Simple Schedule

## Objective

Create a small web application for one professional to manage appointments.

## Functional requirements

1. Show a public weekly schedule with available times.
2. Let a customer reserve a time with a name and email address.
3. Send a reservation confirmation.
4. Provide an authenticated professional dashboard.
5. Let the professional block times and view reservations.

## Non-functional requirements

- Support desktop and mobile layouts.
- Do not write personal data to logs.

## Out of scope

- Payments.
- Text message notifications.
- Multiple professional accounts.

## Acceptance criteria

- The complete reservation journey works in the local environment.
- The professional dashboard requires authentication.

## Use this example

```bash
mkdir simple-schedule
cd simple-schedule
cp ../examples/greenfield/PLAN.md .
npx rijo install --project
```

Then use the native skill:

```text
$rijo new @PLAN.md
$rijo start
$rijo test
$rijo finish
```
