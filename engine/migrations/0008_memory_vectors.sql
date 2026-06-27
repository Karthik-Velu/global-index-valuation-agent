-- Optional best-mode: semantic retrieval via pgvector. Isolated in its own migration
-- because it depends on the `vector` extension being available (it is on Supabase).
-- If this migration fails on a given DB, the core memory (0007) still works — retrieval
-- just falls back to lexical (tsvector) + scope/recency ordering.
--
-- Embedding dim 768 matches the default free local model `ollama:nomic-embed-text`.
-- If you standardise on a different embedding model, change the dimension to match.

create extension if not exists vector;

alter table lessons add column if not exists embedding vector(768);

-- Cosine-distance ANN index. ivfflat needs ANALYZE/data to be effective; fine to
-- create empty. Switch to hnsw if your pgvector build supports it and you want recall.
create index if not exists ix_lessons_embedding
    on lessons using ivfflat (embedding vector_cosine_ops) with (lists = 100);
