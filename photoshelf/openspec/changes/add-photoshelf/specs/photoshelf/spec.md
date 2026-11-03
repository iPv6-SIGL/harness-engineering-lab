## ADDED Requirements

### Requirement: R1 Marketing uploads raw product photos, up to 200 in one batch

The system SHALL marketing uploads raw product photos, up to 200 in one batch; each one is resized to WebP sizes 320, 800 and 1600 pixels wide.

#### Scenario: R1 upload-resized

- **WHEN** marketing uploads one JPEG photo 2000 pixels wide for a SKU
- **THEN** the upload is accepted at once (202) and, within 30 seconds, the photo has three WebP sizes 320, 800 and 1600 pixels wide

#### Scenario: R1 batch-200

- **WHEN** marketing uploads a batch of 200 photos in one action
- **THEN** every photo of the batch gets its WebP sizes exactly once and the batch reports 200 done

#### Scenario: R1 never-upscaled

- **WHEN** marketing uploads a photo 500 pixels wide
- **THEN** only the 320 size is made; no size is wider than the original

#### Scenario: R1 not-an-image

- **WHEN** marketing uploads a file that is not a JPEG or PNG image
- **THEN** the upload is refused with 422 in the error envelope and nothing is queued

### Requirement: R2 The resized WebP images of the uploaded photos are served on a public URL for the shop pages

The system SHALL the resized WebP images of the uploaded photos are served on a public URL for the shop pages; an anonymous browser loads them without signing in.

#### Scenario: R2 public-url

- **WHEN** an anonymous browser opens the public URL of a resized photo
- **THEN** it receives the WebP bytes (200

#### Scenario: R2 shop-listing

- **WHEN** an anonymous shop page asks for the photos of a SKU
- **THEN** it gets the public URLs of every resized photo of that SKU and none of another SKU

### Requirement: R3 A catalog manager takes a photo off the shop and can put it back

The system SHALL a catalog manager takes a photo off the shop and can put it back; a photo taken off the shop is no longer listed and its public URLs stop answering.

#### Scenario: R3 take-off

- **WHEN** a catalog manager takes a photo off the shop
- **THEN** the shop listing no longer shows it and its public URLs answer 404

#### Scenario: R3 put-back

- **WHEN** a catalog manager puts that photo back on the shop
- **THEN** its WebP sizes are made again and the public URLs answer 200

#### Scenario: R3 marketing-cannot-take-off

- **WHEN** a marketing user tries to take a photo off the shop
- **THEN** the API answers 403

### Requirement: R4 Marketing and catalog managers sign in once with their company account

The system SHALL marketing and catalog managers sign in once with their company account; each persona only performs the actions of its role.

#### Scenario: R4 sso-login

- **WHEN** a marketing user signs in through the company IdP
- **THEN** the app knows the user and their role

#### Scenario: R4 anonymous-refused

- **WHEN** someone calls the upload API without signing in
- **THEN** the API answers 401 in the error envelope
