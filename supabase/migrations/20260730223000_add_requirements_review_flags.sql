-- ============================================================
-- requirements.needs_review / requirements.classification_error
-- ============================================================
-- A quota-exhausted run wrote 46 rows with role = null, department = null,
-- confidence = 0. Once persisted, those were indistinguishable from a
-- legitimate "the model looked at this and could not classify it" — the
-- reason string was computed in memory and discarded.
--
-- needs_review is stored rather than derived because confidence alone cannot
-- express the difference: confidence = 0 from a fallback means "never
-- classified", not "classified with low certainty". A query-time threshold on
-- confidence would silently conflate the two.
--
-- classification_error holds the reason a row was degraded (rate limit, parse
-- failure, invalid role, ...) and stays null for successfully classified rows,
-- including low-confidence ones.

alter table public.requirements
  add column needs_review boolean not null default false,
  add column classification_error text;

comment on column public.requirements.needs_review is
  'True when a human should check this row: either the classifier was uncertain, or it never successfully classified it. See classification_error to tell those apart.';

comment on column public.requirements.classification_error is
  'Why this row was degraded (e.g. api-error:429..., batch:unparseable, invalid-role:...). Null when classification succeeded.';
