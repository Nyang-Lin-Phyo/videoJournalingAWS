# Memory Books

Memory Books lets an authenticated owner collect completed journals, edit and approve book text, add exact transcript quotations and private photos, and request a designed PDF. Book metadata and immutable narrative revisions live in the existing DynamoDB journal table under a separate `memory-book#<owner>` GSI namespace. Source journals and transcripts remain in the existing private storage. Photos are uploaded through short-lived presigned POSTs, checked and normalized to JPEG by the renderer, then served with short-lived private URLs. PDF rendering runs asynchronously in a Lambda container; export links are owner-checked and expire.

The editor supports date ranges and time zones, month chapters, chapter and memory ordering, favorites and meaningful flags, suggested exact transcript quotes with per-quote placement, personal annotations, page navigation, captions and focal points, cover photos, optional “Year in My Own Words,” and generated monthly/year reflections. The Year section displays selected original quotes with their local dates; the optional personal note is a separate annotation. Rewrites and reflections remain editable and require explicit approval before inclusion/export. Each book references immutable narrative revisions, so its edits do not overwrite narrative text used by another book. Selected quotations are revalidated against the owner's saved transcript on the server.

### Page-first journal collections

The page-first editor accepts completed video journals. A journal is page-ready whenever its owned transcript has been persisted, including while later analysis is still running or after analysis has failed.

`GET /journals/{upload_id}/page` returns the immutable original in `originalText` and the current editable page. Before the first explicit save, it returns revision 0 as deterministic text blocks split at blank lines and modest sentence boundaries without dropping whitespace or words. `PUT /journals/{upload_id}/page` takes `{revision, blocks, highlightPage}` and atomically writes a new immutable page version plus a conditionally advanced latest pointer. Text highlights must be exact substrings; image blocks must reference complete private photos owned by the same account. Journal deletion removes its page pointer and revisions while retaining separately reusable uploaded photos.

The active editor uses a shared daily canvas. `GET /journal-days/{day}?timezone=<IANA>` composes all ready video transcripts for that local date in recording order. `PUT /journal-days/{day}?timezone=<IANA>` saves layout and added content with optimistic revisions. Source text is reconstructed from the owned transcript files and never copied into daily layout revisions. New recordings appear when the page is refreshed; deleted sources are omitted from future reads. Upload and History open this same editor. Journal-page Memory Books snapshots each selected local date once and the renderer uses its saved daily revision, starting each date on a new sheet while allowing the day to continue across sheets.

A book with `contentMode: "journal-pages"` stores an ordered collection of `{id,title,date,included}` entries and optional `includeHighlights`. Its save/export path is separate from the original narrative/slot templates. Starting an export resolves each included journal to its saved page revision or revision-0 source and stores those references in the immutable job snapshot. The renderer reads those exact revisions, embeds selected private images, starts each journal on its own A4 page, preserves block order/width and normal text reflow, and adds a Highlights appendix only when selected highlights exist. Saving the collection increments the existing book revision, which gives each explicit PDF generation a distinct export identity.

Each Memory Book uses a fixed, versioned page template. Users may fill, replace, or leave individual image/text/writing areas blank; blank areas stay in the page structure and print as white space with light guides. The primary editor exposes exactly three global design controls: paper color, material, and typography. Those controls do not change template structure.

### Adding a Memory Book template

`infra/lambda/memory-book-templates.json` is the catalog and fixture entry point shared by the web editor, authenticated save validation, and PDF renderer. Add a new object to `templates` with a new stable ID ending in a version (for example `family-album-v1`), `templateVersion`, `name`, `identity`, `legacyTheme`, page width/height/margin, and an ordered `slots` list. Keep existing IDs and slot IDs unchanged once books use them. Slots use stable IDs and a supported `kind` (`date`, `title`, `narrative`, `quote`, `image-or-text`, `writing`); editable image/writing slots can set `heightMm`, quote slots can set `minHeightMm`, writing and quote slots can set `guide` to `ruled`, `dot`, or `open`, and image slots can set `imageTreatment` to `frame`, `mount`, or `open`. Reorder slots or tune those dimensions and treatments to create a distinct page structure without changing renderer code. Reuse canonical interactive IDs (`image`, `writing`) across templates so a user's selections remain attached when they switch templates. Existing books without `templateId` are mapped from their old theme name when next saved or exported.

The frontend imports this file directly. The API package includes `journal_pages.py` for deterministic revision-0 page blocks; the renderer image includes the same module so worker snapshots use identical source splitting. `infra/deploy-memory-book-v1.sh` packages this helper and catalog beside `auth_results.py`, and the renderer Dockerfile copies them beside `memory_export_worker.py`. The offline renderer fixture reads the same catalog. A new template can be reviewed by adding it to this JSON and running the local Memory Books, renderer, and UI checks; no production/AWS deployment is needed.

`notebook-v1` is the dated journal-entry template. It intentionally skips month divider pages, keeps each entry in its saved order, uses a 12.5pt body with 1.5 line spacing, and includes a ruled personal area without an on-screen drawing canvas. Its fixed content is measured in one Weasy layout pass; the remaining printable height sets the blank ruled area, which collapses to zero near the page footer. The final PDF is then rendered once. Built-in sticker IDs are a fixed allowlist in the catalog, and optional personal stickers use the same private, owner-checked photo upload records as journal photos.

## Reusable models and presets

A reusable memory is owner-wide: its latest narrative revision plus favorite/meaningful flags can be selected into multiple books. Book-specific ordering, annotations, quote placement, reserved areas, photos, and reflection approval stay with each book configuration. The versioned template catalog preserves the five prior identities: `Minimalist`, `Vintage`, `Scrapbook`, `Classic diary`, and `Editorial`. Paper material, paper color, typography, date range, and timezone are validated per-book settings.

## Prerequisites

Use the existing API, JWT authorizer, results Lambda, journal DynamoDB table and private upload bucket described by the other `infra` deployment docs. The table must have the active `userId-createdAt-index` owner index. Prepare a Lambda execution role and ECR repository for the renderer; the role trust policy must allow `lambda.amazonaws.com`. Set the existing resource IDs and these values in local infra environment files; do not commit credentials:

- `MEMORY_RENDERER_NAME`, `MEMORY_RENDERER_ROLE_NAME`, `MEMORY_RENDERER_ROLE_ARN`, `MEMORY_RENDERER_REPOSITORY`
- `GEMINI_SECRET_ARN` for the existing Gemini API secret
- Existing `AWS_ACCOUNT`, `AWS_REGION`, `API_ID`, `AUTHORIZER_ID`, `RESULT_FUNC`, `RESULT_ROLE`, `JOURNAL_TABLE`, `JOURNAL_TABLE_ARN`, `UPLOAD_BUCKET`, and `HTTPS_SITE_ORIGIN`

The renderer image uses `infra/lambda/memory-renderer/Dockerfile`, built with `infra/lambda` as its context. It includes WeasyPrint and Pillow. Ensure the renderer execution role has standard Lambda logging permissions and VPC/network access to AWS APIs if the account requires a VPC.

## Deploy

Review the scripts and environment values first. These commands change AWS infrastructure and require an explicit confirmation variable; they do not alter user book data.

```bash
CONFIRM_MEMORY_RENDERER=YES bash infra/deploy-memory-renderer.sh
CONFIRM_MEMORY_BOOKS_V1=YES bash infra/deploy-memory-book-v1.sh
```

Both scripts source the three resource-id files and optionally `.cognito.env`, `.auth-api.env`, and `.auth-hosting.env` when present. The renderer deployment builds/pushes the image and creates or updates the async function. The API deployment packages the results handler, preserves its environment values, adds renderer/Gemini settings and IAM permissions, and attaches the memory routes to the existing API integration. It extends existing API and bucket CORS rules only when the trusted site origin is already present. If the upload bucket has no suitable CORS rule, configure that origin explicitly and rerun.

Every memory and journal-page route dispatched by `auth_results.handler` is registered with the existing HTTP API JWT authorizer. After deployment, inspect `get-routes` and confirm each route has `AuthorizationType=JWT` and the expected authorizer ID. Results IAM signs writes only under `uploads/*/memory-photos/*`; it reads staged/normalized photos, exports, and transcripts, and has scoped page-write transactions and transcript rollback access. The renderer policy grants owner-scoped DynamoDB reads, updates, and export-job cleanup, plus exact exports-prefix version deletion for a renderer that loses a deletion fence. Export snapshots are immutable owner-scoped job records; journal page revisions are pinned by key inside each snapshot.

## Local checks

From `apps/web`, run `npm run build`, `npm test`, and `npm run lint`. Run Python checks from the repository root:

```bash
python -m py_compile infra/lambda/auth_results.py infra/lambda/memory_export_worker.py infra/lambda/journal_pages.py
python infra/test-memory-books.py
python infra/test-memory-pages.py
python infra/test-memory-photos.py
python infra/test-memory-renderer.py
```

These checks use mock AWS clients and local image bytes; they do not deploy or call AWS. The ignored `tmp/render-memory-book-fixture.py` creates a synthetic HTML fixture from the actual worker template. When the downloaded WeasyPrint v70 CLI is available, render it locally with:

```bash
python tmp/render-memory-book-fixture.py
tmp/weasyprint-v70/onedir/weasyprint/weasyprint.exe tmp/memory-book-fixture.html tmp/memory-book-fixture.pdf
```

## Operational notes

Journal History also provides a Quick PDF export. It accepts an inclusive date range (up to one year), IANA time zone, and one of the five shared page presets. The `POST /journal-exports` and `GET /journal-exports/{job_id}` routes use the existing JWT results API and async renderer. Quick job snapshots contain eligible journal IDs, titles, timestamps, validated transcript keys, and export settings; transcript text is read only by the worker. Runtime limits are 500 journals, 256 KiB per transcript, 5 MiB aggregate transcript input, and the existing 900-second/2 GiB renderer ceiling. The same request key safely reuses an active or failed job; the POST requeues failed jobs. Account deletion scans the shared `memory-book#<owner>` namespace and removes `exports/<owner>/` as before.

- Exports and photo processing are asynchronous. Poll the corresponding status route; failed or expired work can be retried.
- Exported PDFs and normalized photos are private S3 objects. The API returns short-lived signed URLs only after checking the authenticated owner.
- Account deletion waits for active memory render/photo leases, then removes private exports, photos, and memory records before deleting the owner's remaining account data.
- Reflection generation returns an explicit size-limit error rather than silently dropping source journals.
- The Gemini rewrite and reflection endpoints are synchronous HTTP API routes. HTTP API integrations have a maximum response window of 30 seconds; the handlers cap Gemini network waits at 18 seconds to leave time for response processing. If model latency exceeds this budget, move generation behind the existing async worker and add owner-checked job polling. Do not assume API Gateway can wait for the Lambda's full configured timeout.
- A queued export renders the private snapshot stored on its revision's job, so a later book edit does not change an in-flight export.
- Browser print and session-only demo storage are available only in the preview environment; production accounts use the private async export service.
- Live deployment and smoke checks are separate operations. During an approved deployment window, verify JWT route settings and Lambda role policies, then exercise save, reflection, photo upload/finalize, export polling/download, and account deletion against the configured API.
