# Tasks — add-gearup

Done means the named scenario passes (the harness flips `.harness/ledger.json`), not that code exists.

- [ ] 1.1 TEMPORAL_NS=1 APP=gearup ./bootstrap.sh — owner: harness · proves: `C1 ready`
- [ ] 1.2 OIDC client + 2 test personas (employee, manager) — owner: harness · proves: `C1 oidc`
- [ ] 2.1 Data model and seed (migrations in api/src/db.ts) — owner: builder · proves: `R1 ask-waits`
- [ ] 3.1 R1 · An employee asks for a laptop or other gear from the catalog; the manager has 3 days to approve, with a reminder after 2 days; without an answer the request expires and nothing is ordered. — owner: builder · proves: `R1 ask-waits`, `R1 survives-restart`, `R1 one-open-per-item`
- [ ] 3.2 R2 · The manager approves or rejects the request; an approved request is ordered from the supplier and its price is taken from the team budget; a request above the remaining budget cannot be approved. — owner: builder · proves: `R2 approve-orders`, `R2 reject-closes`, `R2 over-budget`, `R2 employee-cannot-approve`
- [ ] 3.3 R3 · When the supplier fails the order is cancelled and the budget refunded. — owner: builder · proves: `R3 supplier-fails`, `R3 refund-once`
- [ ] 3.4 R4 · Employees and managers sign in once with their company account; each persona only performs the actions of its role. — owner: builder · proves: `R4 sso-login`, `R4 anonymous-refused`
- [ ] 4.1 Screens: the persona journeys in frontend/ — owner: builder · proves: `C1 frontend`
- [ ] 5.1 Contracts: /health, /ready, ports 8030–8031, SIGTERM < 10 s — owner: builder · proves: `C1 health`, `C1 ready`
- [ ] 5.2 Stateless API: no state in the process — a session survives an API restart, so a second replica can serve it — owner: builder · proves: `C1 stateless`
