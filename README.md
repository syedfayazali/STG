# Smart Tempered Glass

Tempered-glass compatibility finder: type a brand, model or model number → get the **box number**.
Static website (no build step) + Supabase (Postgres, Auth, row-level security).

## What is where
- `index.html`, `css/styles.css`, `js/` — the website (glassmorphism design, search, admin, import/export).
- `vendor/` — supabase-js and SheetJS 0.20.3 (Excel), bundled locally (no CDN needed).
- `js/config.js` — Supabase URL + **publishable** key (safe to ship; security is enforced by the database).
- Database (Supabase project **stg**, `ekviqmjuiusxtzdqwrvu`, Mumbai): tables `inventory`, `import_batches`, `audit_log`, `admins`;
  functions `search_inventory`, `public_brands` (public) and `dashboard_stats`, `duplicate_groups`, `existing_keys`, `is_admin` (admin only).

## Who can do what (enforced in Postgres, not just the UI)
| | Visitors / staff | Admin (row in `admins`) |
|---|---|---|
| Search, see box numbers, browse brands | ✅ | ✅ |
| Read/write tables directly | ❌ | ✅ |
| Dashboard, add/edit/delete, bulk actions, import/export, duplicates, audit log | ❌ | ✅ |

## Deploy
Any static host works. On **Vercel**: import the GitHub repo → Framework "Other" → no build command → output directory `.` (root).
Then in Supabase → Authentication → URL Configuration, set **Site URL** to your live address and add it under **Redirect URLs**
(needed for the "Forgot password?" email link).

## Admin tasks
- Sign in at `#/login` (the site's "Sign in" link). Forgot password → "Forgot password?" on that screen, or Admin → Account to change it.
- Add another admin: sign them up in Supabase → Authentication → Users, then run in the SQL editor:
  `insert into public.admins (user_id) select id from auth.users where email = 'person@example.com';`
- Recommended: Supabase → Authentication → Providers/Policies → enable **Leaked password protection**.

## How search decides
Query is normalised in the browser (`js/normalize.js`: case, spaces, hyphens, shorthand like SAM/R-ME/RM/1+, filler "Galaxy"), then
`search_inventory` ranks: exact model number → exact model / brand+model → starts-with → partial. Exact matches are shown first and
big; the same phone in several boxes appears once with every box; different phones with the same name (Samsung A12 vs Oppo A12)
are never merged; no match ⇒ "No matching mobile found" — a box number is never guessed.

## Data
STGLASS.xlsx is a compatibility chart (row = box, column = brand, models separated by "/"). Import → "Compatibility chart" splits each cell into one
record per model per box. 1,670 records are loaded (76 repeats skipped, 27 flagged "needs review" where several models look glued together).
Imports can be undone from the dashboard.
