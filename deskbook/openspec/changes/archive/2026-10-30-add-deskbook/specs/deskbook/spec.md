## ADDED Requirements

### Requirement: R1 An employee books one free desk per half-day

The system SHALL an employee books one free desk per half-day; a desk already taken is refused and two free desks nearby are offered.

#### Scenario: R1 desk-taken

- **WHEN** an employee books a desk that is taken
- **THEN** the booking is refused and two free desks nearby on the same floor are offered

#### Scenario: R1 one-per-half-day

- **WHEN** an employee who already holds a desk books a second one for the same half-day
- **THEN** the booking is refused

#### Scenario: R1 no-double-booking

- **WHEN** two employees book the same free desk at the same instant
- **THEN** exactly one booking is accepted

### Requirement: R2 Employees sign in once with their company account

The system SHALL employees sign in once with their company account; each persona only performs the actions of its role.

#### Scenario: R2 sso-login

- **WHEN** an employee signs in through the company IdP
- **THEN** the app knows the employee and their role

#### Scenario: R2 anonymous-refused

- **WHEN** someone calls the API without signing in
- **THEN** the API answers 401 in the error envelope

### Requirement: R3 An office manager opens and closes meeting rooms

The system SHALL an office manager opens and closes meeting rooms; a closed room cannot be booked.

#### Scenario: R3 manager-closes-room

- **WHEN** an office manager closes a room and an employee books it
- **THEN** the booking is refused

#### Scenario: R3 employee-cannot-close

- **WHEN** an employee tries to close a room
- **THEN** the API answers 403

### Requirement: R4 An office manager uploads a floor-plan image for a floor

The system SHALL an office manager uploads a floor-plan image for a floor; plans stay visible to signed-in employees only.

#### Scenario: R4 upload-plan

- **WHEN** an office manager uploads a floor plan
- **THEN** a signed-in employee downloads the same bytes

#### Scenario: R4 plan-private

- **WHEN** an employee uploads a plan or an anonymous browser reads the bucket
- **THEN** both are refused

### Requirement: R5 A booking can repeat every week until an end date chosen at booking, at most 26 weeks

The system SHALL a booking can repeat every week until an end date chosen at booking, at most 26 weeks.

#### Scenario: R5 weekly-until

- **WHEN** an employee books a desk every week until a date
- **THEN** the desk is taken on each of those weeks and free after the end date

#### Scenario: R5 weekly-conflict

- **WHEN** another employee books that desk on one of the repeated weeks
- **THEN** the booking is refused
