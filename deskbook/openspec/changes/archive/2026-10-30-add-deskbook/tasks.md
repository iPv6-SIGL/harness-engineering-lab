# Tasks — add-deskbook

Done means the named scenario passes (the harness flips `.harness/ledger.json`), not that code exists.

- [ ] 1.1 APP=deskbook ./bootstrap.sh — owner: harness · proves: `C1 ready`
- [ ] 1.2 OIDC client + 2 test personas (employee, office-manager) — owner: harness · proves: `C1 oidc`
- [ ] 2.1 Data model and seed (migrations in api/src/db.ts) — owner: builder · proves: `C1 ready`
- [ ] 3.1 R1 · An employee books one free desk per half-day; a desk already taken is refused and two free desks nearby are offered. — owner: builder · proves: `R1 desk-taken`, `R1 one-per-half-day`, `R1 no-double-booking`
- [ ] 3.2 R2 · Employees sign in once with their company account; each persona only performs the actions of its role. — owner: builder · proves: `R2 sso-login`, `R2 anonymous-refused`
- [ ] 3.3 R3 · An office manager opens and closes meeting rooms; a closed room cannot be booked. — owner: builder · proves: `R3 manager-closes-room`, `R3 employee-cannot-close`
- [ ] 3.4 R4 · An office manager uploads a floor-plan image for a floor; plans stay visible to signed-in employees only. — owner: builder · proves: `R4 upload-plan`, `R4 plan-private`
- [ ] 3.5 R5 · A booking can repeat every week until an end date chosen at booking, at most 26 weeks. — owner: builder · proves: `R5 weekly-until`, `R5 weekly-conflict`
- [ ] 4.1 Screens: the persona journeys in frontend/ — owner: builder · proves: `C1 frontend`
- [ ] 5.1 Contracts: /health, /ready, ports 8010–8011, SIGTERM < 10 s — owner: builder · proves: `C1 health`, `C1 ready`
- [ ] 5.2 Stateless API: no state in the process — a session survives an API restart, so a second replica can serve it — owner: builder · proves: `C1 stateless`
