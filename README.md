# New Trendz Mobiles & Electronics — Inventory Lookup

Type a phone brand / model / model number → get the **box number**.
Excel / manual entry → SQLite database → backend search → box number.

## Run it
Requires Node.js 22.13 or newer.

    npm install
    ADMIN_PASSWORD='choose-a-password' npm start      # http://localhost:3000

If `ADMIN_PASSWORD` is not set, a random one is generated and printed **once** on first start.
Staff open the site and search (no login). Administrators sign in via "Admin sign in" (top right).
Set `SEARCH_REQUIRES_LOGIN=1` to require login for search too. Extra accounts:
`npm run create-user -- <name> <password> [admin|staff]`.
See `.env.example` for all settings. Back up `data/inventory.db` to back up everything.

## Your STGLASS.xlsx
It is a *compatibility chart* (one row per box, one column per brand, models separated by "/"), not a
one-row-per-phone list. The importer auto-detects this and splits every cell into one record per model
per box (e.g. 138 boxes → ~1,670 searchable records). Cleanups it applies: brand shorthand (SAM, R-ME, RM, 1+, IQ00, TECHNO…),
"A3(4G/5G)" → A3 / A3 4G / A3 5G, a lone "5G" continuing the previous model, bare numbers after
SPARK/HOT/CAMON inheriting the family, repeated brand names splitting glued entries.
Entries that look like several models joined without a "/" are imported but flagged **needs review**
(shown with a ⚠ in search and listed under Inventory → "Needs review only"). Records appear exactly as in the
file; the original box label ("POSTER MODEL") is stored as a custom field and shown as "Box card".

## How search decides
Normalises case, spaces, hyphens, brand shorthand and filler words ("Galaxy"). Order of preference:
1 exact model number → 2 exact model / brand+model → 3 starts-with → 4 partial.
Exact matches are shown first and large; everything else is labelled "Model Match", "Partial Match" or
"Brand Match". The same phone in several boxes appears once with **every** box. Different phones with the same
name (Samsung A12 vs Oppo A12) are never merged. No match ⇒ "No matching mobile found" — a box number is never guessed.

## Admin
Dashboard · Inventory (search, filter, sort, edit, delete, bulk move/delete with confirmation, add model with
custom fields) · Import/Export (template, column mapping, preview, validation, duplicate detection, undo an import)
· Duplicates (review only, nothing auto-deleted) · Audit log.

## Layout
    server.js          HTTP API, auth, audit            lib/search.js     tiered search
    lib/normalize.js   keys + brand aliases             lib/importer.js   Excel parsing / validation
    lib/db.js          schema (indexed key columns)     public/           the web app
    tests/app.test.js  `npm test`

Ready for later: `uid`, `branch_id`, `imei`, `quantity`, free-form `extra` JSON columns, roles table
(barcode/QR, stock in/out, shelf/rack, WhatsApp share can be added without schema rewrites).
