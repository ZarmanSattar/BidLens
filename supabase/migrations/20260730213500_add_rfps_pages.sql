-- ============================================================
-- rfps.pages — page-tracked document text
-- ============================================================
-- rfps.raw_text stores cleanText(pdfParse().text), which joins pages with
-- the same "\n\n" that separates paragraphs and collapses runs of spaces.
-- Page boundaries and table-column gaps are both unrecoverable from it
-- (measured on a 44-page RFP: 213 "\n\n" breaks for 43 real page joins, and
-- 4,836 column gaps reduced to zero).
--
-- This column stores the same document as one string per page, in document
-- order, with intra-line spacing preserved. The page number is the 1-based
-- array index, so it is not stored separately.
--
-- text[] rather than jsonb: the payload is genuinely an ordered list of page
-- strings, and the per-element "page" key would only ever restate the index.
-- text[] also gives cheaper storage and simpler access (pages[3],
-- array_length(pages, 1)).
--
-- Nullable with no default and no backfill. RFPs uploaded before this column
-- existed keep pages = null; /api/shredder/run falls back to flat raw_text
-- for those, which is exactly what it does today.
--
-- No RLS change is needed: the existing rfps policies are row-level, so they
-- already govern this column.

alter table public.rfps
  add column pages text[];

comment on column public.rfps.pages is
  'Document text as one entry per page, in order. Array index + 1 is the page number. Null for RFPs uploaded before page tracking existed.';
