# Proposal — add-gearup

> Build GearUp: an employee asks for a laptop or other gear from the catalog; their manager has 3 days to approve it, with a reminder after 2 days. An approved request is ordered from the supplier and paid from the team budget; when the supplier fails, the order is cancelled and the budget refunded.

## Why

Brief v1, brief-check 5/5 after round 1.

## Personas

- **employee** — asks for gear from the catalog and follows their requests
- **manager** — approves or rejects the requests of the team, within the team budget; also asks like an employee

## Needs a test can check

- **R1** (employee) — An employee asks for a laptop or other gear from the catalog; the manager has 3 days to approve, with a reminder after 2 days; without an answer the request expires and nothing is ordered.
- **R2** (manager) — The manager approves or rejects the request; an approved request is ordered from the supplier and its price is taken from the team budget; a request above the remaining budget cannot be approved.
- **R3** (manager) — When the supplier fails the order is cancelled and the budget refunded.
- **R4** (employee) — Employees and managers sign in once with their company account; each persona only performs the actions of its role.

## Data

- employees: about 300 in 30 teams
- catalog items: about 20 (laptops
- requests: about 40 a week
- team budgets: one per team

## Must never happen

- an order placed without the manager's approval
- an order placed after its request expired or was rejected
- a team budget below zero
- a budget charged twice or refunded twice for the same request

## Out of scope

- a real supplier API (the supplier is simulated by a seeded stock list)
- e-mail or chat notifications (the reminder shows in the manager's list)
- delivery tracking after the order
- several approval levels (only the direct manager approves)
- a native mobile app

## What changes

A **process** app: 13 / 17 ops points. See design.md for every brick bought or refused.
