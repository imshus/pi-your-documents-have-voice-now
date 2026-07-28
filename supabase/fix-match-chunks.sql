-- Paste this whole file into Supabase -> SQL Editor -> Run.
-- Fixes: "Could not find the function public.match_chunks(...) in the schema cache"
-- Recreates the hybrid search function and reloads the API schema cache.
-- Idempotent — safe to run repeatedly.

create extension if not exists vector;

-- Make sure the full-text column/index exist (no-ops if already there).
alter table public.doc_chunks
  add column if not exists fts tsvector
  generated always as (to_tsvector('simple', content)) stored;

create index if not exists doc_chunks_fts_idx on public.doc_chunks using gin (fts);

-- Drop every known older signature so only the current one remains.
drop function if exists public.match_chunks (vector, int, uuid);
drop function if exists public.match_chunks (vector, text, int, uuid, float, float, int);

create function public.match_chunks (
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
  with sem as (
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
           row_number() over (order by ts_rank_cd(c.fts, q) desc) as rank
    from public.doc_chunks c,
         websearch_to_tsquery('simple', query_text) q
    where c.fts @@ q
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
  join public.doc_chunks c on c.id = coalesce(sem.id, lex.id)
  join public.documents d on d.id = c.document_id
  order by
    coalesce(1.0 / (rrf_k + sem.rank), 0) * semantic_weight +
    coalesce(1.0 / (rrf_k + lex.rank), 0) * full_text_weight
    desc
  limit match_count;
$$;

grant execute on function
  public.match_chunks (vector, text, int, uuid, float, float, int)
  to service_role, authenticated;

-- Force the REST layer to pick the function up immediately.
notify pgrst, 'reload schema';

select 'match_chunks recreated' as status;
