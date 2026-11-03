# Proposal — add-photoshelf

> Build PhotoShelf: marketing uploads raw product photos, sometimes a whole shoot of 200 at once; each one is resized to WebP sizes for the web shop, whose pages load them on a public URL without signing in. A catalog manager can take a photo off the shop.

## Why

Brief v1, brief-check 5/5 after round 1.

## Personas

- **marketing** — uploads raw product photos for a product SKU and publishes them to the shop
- **catalog-manager** — takes photos off the shop and puts them back; also uploads like marketing

## Needs a test can check

- **R1** (marketing) — Marketing uploads raw product photos, up to 200 in one batch; each one is resized to WebP sizes 320, 800 and 1600 pixels wide.
- **R2** (marketing) — The resized WebP images of the uploaded photos are served on a public URL for the shop pages; an anonymous browser loads them without signing in.
- **R3** (catalog-manager) — A catalog manager takes a photo off the shop and can put it back; a photo taken off the shop is no longer listed and its public URLs stop answering.
- **R4** (marketing) — Marketing and catalog managers sign in once with their company account; each persona only performs the actions of its role.

## Data

- products (SKUs): about 3000 SKUs
- raw photos: about 1000 a week, in batches of up to 200 · up to 20 MB, JPEG or PNG
- resized sizes: 3 WebP sizes per photo (320 · 20 to 400 KB each

## Must never happen

- a photo resized twice into the same size (a batch is processed exactly once, even with several workers)
- a size wider than its original (no upscaling)
- a photo taken off the shop still listed or still answering on its public URL
- the upload request waiting for the resizing

## Out of scope

- editing photos (cropping, colour, background removal)
- video
- the web shop itself (it only reads the listing and the public URLs)
- keeping the raw originals secret from anyone who knows their key (the bucket is public-read as a whole)
- a native mobile app

## Answers from the brief loop

- `R2-blob-size`: binary WebP files, 20 to 400 KB each, many per photo → s3, public-read
- `R3-blob-size`: the same WebP files as R2 (taking a photo off removes its objects) → s3

## What changes

A **media** app: 13 / 17 ops points. See design.md for every brick bought or refused.
