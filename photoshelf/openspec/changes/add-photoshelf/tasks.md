# Tasks — add-photoshelf

Done means the named scenario passes (the harness flips `.harness/ledger.json`), not that code exists.

- [ ] 1.1 PUBLIC_BUCKET=1 APP=photoshelf ./bootstrap.sh — owner: harness · proves: `C1 ready`
- [ ] 1.2 OIDC client + 2 test personas (marketing, catalog-manager) — owner: harness · proves: `C1 oidc`
- [ ] 2.1 Data model and seed (migrations in api/src/db.ts) — owner: builder · proves: `R1 upload-resized`
- [ ] 3.1 R1 · Marketing uploads raw product photos, up to 200 in one batch; each one is resized to WebP sizes 320, 800 and 1600 pixels wide. — owner: builder · proves: `R1 upload-resized`, `R1 batch-200`, `R1 never-upscaled`, `R1 not-an-image`
- [ ] 3.2 R2 · The resized WebP images of the uploaded photos are served on a public URL for the shop pages; an anonymous browser loads them without signing in. — owner: builder · proves: `R2 public-url`, `R2 shop-listing`
- [ ] 3.3 R3 · A catalog manager takes a photo off the shop and can put it back; a photo taken off the shop is no longer listed and its public URLs stop answering. — owner: builder · proves: `R3 take-off`, `R3 put-back`, `R3 marketing-cannot-take-off`
- [ ] 3.4 R4 · Marketing and catalog managers sign in once with their company account; each persona only performs the actions of its role. — owner: builder · proves: `R4 sso-login`, `R4 anonymous-refused`
- [ ] 4.1 Screens: the persona journeys in frontend/ — owner: builder · proves: `C1 frontend`
- [ ] 5.1 Contracts: /health, /ready, ports 8020–8021, SIGTERM < 10 s — owner: builder · proves: `C1 health`, `C1 ready`
- [ ] 5.2 Stateless API: no state in the process — a session survives an API restart, so a second replica can serve it — owner: builder · proves: `C1 stateless`
