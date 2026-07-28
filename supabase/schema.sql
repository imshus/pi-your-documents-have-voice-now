-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- It creates the RAG store: one row per ingested document + one row per embedded chunk.

create extension if not exists vector;
create extension if not exists "pgcrypto";
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- documents
create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  file_name     text not null,
  mime_type     text,
  storage_path  text,                    -- path inside the `documents` storage bucket
  doc_type      text,                    -- e.g. "bank_statement", "aadhaar_card"
  title         text,
  summary       text,
  data          jsonb not null default '{}'::jsonb  -- the generated JSON schema payload
);

create index if not exists documents_created_at_idx on public.documents (created_at desc);
create index if not exists documents_data_idx on public.documents using gin (data);

-- -------------------------------------------------------------- doc_chunks
-- 1536 dims == text-embedding-3-large at dimensions=1536 (Matryoshka-shortened;
-- beats small@1536 outright). Change here AND in lib/openai.ts together, and
-- re-embed everything — vectors from different models are not comparable.
--
-- `fts` uses the 'simple' config, NOT 'english': callers speak Hinglish and
-- search identifiers, and English stemming/stopwording mangles both.
create table if not exists public.doc_chunks (
  id           bigserial primary key,
  document_id  uuid not null references public.documents (id) on delete cascade,
  chunk_index  int  not null default 0,
  section      text,                     -- which part of the JSON this came from
  content      text not null,
  embedding    vector(1536),
  fts          tsvector generated always as (to_tsvector('simple', content)) stored
);

create index if not exists doc_chunks_document_id_idx on public.doc_chunks (document_id);
create index if not exists doc_chunks_embedding_idx
  on public.doc_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists doc_chunks_fts_idx on public.doc_chunks using gin (fts);
create index if not exists doc_chunks_trgm_idx on public.doc_chunks using gin (content gin_trgm_ops);

-- ------------------------------------------------------------ match_chunks
-- HYBRID retrieval: semantic (pgvector cosine) + lexical (full-text) fused with
-- reciprocal rank fusion. Dense embeddings are near-blind to exact digit
-- strings — adjacent account numbers embed almost identically — so the lexical
-- arm is what makes "account number 5432..." queries land on the right chunk.
-- Callers bump full_text_weight when the query contains a long digit run.
--
-- ef_search=100 buys near-exhaustive HNSW recall at this scale for negligible
-- latency; it is the only index knob worth touching (keep build defaults).
drop function if exists public.match_chunks (vector, int, uuid);

create or replace function public.match_chunks (
  query_embedding    vector(1536),
  query_text         text,
  match_count        int   default 8,
  filter_document_id uuid  default null,
  full_text_weight   float default 1,
  semantic_weight    float default 1,
  rrf_k              int   default 50
)
returns table (
  id          bigint,
  document_id uuid,
  section     text,
  content     text,
  file_name   text,
  doc_type    text,
  similarity  float
)
language sql stable
set hnsw.ef_search = 100
as $$
  with q as (
    -- OR-joined lexemes: one matching word should score, not require ALL words
    -- (websearch_to_tsquery ANDs terms — fatal for code-switched queries where
    -- only some words appear in the document). Null when nothing tokenizes.
    select to_tsquery('simple',
      nullif(array_to_string(tsvector_to_array(to_tsvector('simple', query_text)), ' | '), '')
    ) as tsq
  ),
  sem as (
    select c.id,
           row_number() over (order by c.embedding <=> query_embedding) as rank,
           1 - (c.embedding <=> query_embedding) as similarity
    from public.doc_chunks c
    where c.embedding is not null
      and (filter_document_id is null or c.document_id = filter_document_id)
    order by c.embedding <=> query_embedding
    limit greatest(match_count * 2, 16)
  ),
  lex as (
    select c.id,
           row_number() over (order by ts_rank_cd(c.fts, q.tsq) desc) as rank
    from public.doc_chunks c, q
    where q.tsq is not null
      and c.fts @@ q.tsq
      and (filter_document_id is null or c.document_id = filter_document_id)
    limit greatest(match_count * 2, 16)
  ),
  fuz as (
    -- Trigram word-similarity: catches near-miss proper nouns and codes the
    -- STT transcribed approximately ("MISTI" -> MISTHI, partial bill numbers).
    select c.id,
           row_number() over (order by word_similarity(query_text, c.content) desc) as rank
    from public.doc_chunks c
    where query_text <% c.content
      and (filter_document_id is null or c.document_id = filter_document_id)
    limit greatest(match_count * 2, 16)
  )
  select
    c.id,
    c.document_id,
    c.section,
    c.content,
    d.file_name,
    d.doc_type,
    coalesce(sem.similarity, 0) as similarity
  from sem
  full outer join lex on lex.id = sem.id
  full outer join fuz on fuz.id = coalesce(sem.id, lex.id)
  join public.doc_chunks c on c.id = coalesce(sem.id, lex.id, fuz.id)
  join public.documents d on d.id = c.document_id
  order by
    coalesce(1.0 / (rrf_k + sem.rank), 0) * semantic_weight +
    coalesce(1.0 / (rrf_k + lex.rank), 0) * full_text_weight +
    coalesce(1.0 / (rrf_k + fuz.rank), 0) * full_text_weight * 0.8
    desc
  limit match_count;
$$;

-- MIGRATING an existing database (schema run before this version)?
--   alter table public.doc_chunks add column if not exists fts tsvector
--     generated always as (to_tsvector('simple', content)) stored;
--   create index if not exists doc_chunks_fts_idx on public.doc_chunks using gin (fts);
-- then re-run the drop/create function above, and re-ingest (or re-embed) all
-- documents — the embedding model changed from small to large.

-- --------------------------------------------------------------------- RLS
-- The app talks to Supabase with the service-role key from server-side routes
-- only, which bypasses RLS. Enabling RLS with no permissive policy means the
-- anon key cannot read these tables even if it leaks.
alter table public.documents  enable row level security;
alter table public.doc_chunks enable row level security;

-- --------------------------------------------------------------- storage
-- Create a PRIVATE bucket named `documents` for the original files:
--   Dashboard -> Storage -> New bucket -> name: documents, Public: OFF
-- Or uncomment:
-- insert into storage.buckets (id, name, public) values ('documents', 'documents', false)
--   on conflict (id) do nothing;
