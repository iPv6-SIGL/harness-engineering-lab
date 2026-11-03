## ADDED Requirements

### Requirement: R1 An employee asks for a laptop or other gear from the catalog

The system SHALL an employee asks for a laptop or other gear from the catalog; the manager has 3 days to approve, with a reminder after 2 days; without an answer the request expires and nothing is ordered.

#### Scenario: R1 ask-waits

- **WHEN** an employee asks for a laptop
- **THEN** the request waits for the manager, with a reminder due 2 days later and an expiry 3 days later

#### Scenario: R1 survives-restart

- **WHEN** the worker is restarted while a request waits for the manager
- **THEN** the manager's approval afterwards still orders it

#### Scenario: R1 one-open-per-item

- **WHEN** an employee asks for the same item while an earlier request for it is still waiting
- **THEN** the second request is refused with 409

### Requirement: R2 The manager approves or rejects the request

The system SHALL the manager approves or rejects the request; an approved request is ordered from the supplier and its price is taken from the team budget; a request above the remaining budget cannot be approved.

#### Scenario: R2 approve-orders

- **WHEN** the manager approves a waiting request
- **THEN** the request is ordered and the team budget drops by the item's price

#### Scenario: R2 reject-closes

- **WHEN** the manager rejects a waiting request
- **THEN** the request is closed as rejected and the budget is unchanged

#### Scenario: R2 over-budget

- **WHEN** the manager approves a request whose price is above the remaining team budget
- **THEN** the approval is refused with 409 and the request keeps waiting

#### Scenario: R2 employee-cannot-approve

- **WHEN** an employee tries to approve a request
- **THEN** the API answers 403

### Requirement: R3 When the supplier fails the order is cancelled and the budget refunded

The system SHALL when the supplier fails the order is cancelled and the budget refunded.

#### Scenario: R3 supplier-fails

- **WHEN** the manager approves a request for an item the supplier cannot deliver
- **THEN** the order is cancelled, the request ends as cancelled, and the team budget is back to its amount before the approval

#### Scenario: R3 refund-once

- **WHEN** the supplier failure is retried
- **THEN** the budget is refunded exactly once

### Requirement: R4 Employees and managers sign in once with their company account

The system SHALL employees and managers sign in once with their company account; each persona only performs the actions of its role.

#### Scenario: R4 sso-login

- **WHEN** an employee signs in through the company IdP
- **THEN** the app knows the employee and their role

#### Scenario: R4 anonymous-refused

- **WHEN** someone calls the API without signing in
- **THEN** the API answers 401 in the error envelope
