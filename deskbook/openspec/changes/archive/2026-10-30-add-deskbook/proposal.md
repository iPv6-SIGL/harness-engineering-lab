# Proposal — add-deskbook

> Build DeskBook: employees book a desk or a meeting room on the floor plan; office managers upload floor plans and open or close rooms; a booking can repeat every week.

## Why

Brief v2, brief-check 5/5 after round 2.

## Personas

- **employee** — books a desk or a room for a half-day
- **office-manager** — opens and closes rooms, uploads floor plans; also books like an employee

## Needs a test can check

- **R1** (employee) — An employee books one free desk per half-day; a desk already taken is refused and two free desks nearby are offered.
- **R2** (employee) — Employees sign in once with their company account; each persona only performs the actions of its role.
- **R3** (office-manager) — An office manager opens and closes meeting rooms; a closed room cannot be booked.
- **R4** (office-manager) — An office manager uploads a floor-plan image for a floor; plans stay visible to signed-in employees only.
- **R5** (employee) — A booking can repeat every week until an end date chosen at booking, at most 26 weeks.

## Data

- desks: about 200 desks on 3 floors
- meeting rooms: 2 per floor
- bookings: about 400 a day
- floor plans: 1 per floor · up to 2 MB, PNG or SVG

## Must never happen

- two bookings on the same desk and half-day
- an employee holding two desks on the same half-day
- a floor plan readable without signing in

## Out of scope

- payments and charge-back
- a native mobile app
- e-mail or chat notifications
- visitor badges

## Answers from the brief loop

- `R5-horizon`: until an end date chosen at booking, at most 26 weeks
- `R4-uploader`: office managers only
- `data-desks-volume`: about 200 desks on 3 floors

## What changes

A **crud** app: 9 / 10 ops points. See design.md for every brick bought or refused.
