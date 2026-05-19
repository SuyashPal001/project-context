-- knowledge_chunks: codebase knowledge base chunks for RAG
-- Follows same pattern as document_chunks (0009_rag_pipeline.sql)
-- No FK constraints on tenant_id or task_id (matches document_chunks)

CREATE TABLE knowledge_chunks (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL,

  -- classification
  layer           TEXT        NOT NULL,
  file_type       TEXT        NOT NULL,
  file_path       TEXT        NOT NULL,
  task_id         UUID,
  event_type      TEXT        NOT NULL,

  -- content
  content         TEXT        NOT NULL,
  embedding       VECTOR(768),
  tsv             TSVECTOR    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,

  -- chunk position
  chunk_index     INTEGER     NOT NULL DEFAULT 0,
  total_chunks    INTEGER     NOT NULL DEFAULT 1,

  -- lifecycle
  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invalidated_at  TIMESTAMPTZ
);

-- Vector similarity search (HNSW — same ops class as document_chunks)
CREATE INDEX idx_knowledge_hnsw
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

-- Full-text search
CREATE INDEX idx_knowledge_tsv
  ON knowledge_chunks USING GIN (tsv);

-- Btree indexes for common filter columns
CREATE INDEX idx_knowledge_tenant     ON knowledge_chunks (tenant_id);
CREATE INDEX idx_knowledge_file_path  ON knowledge_chunks (file_path);
CREATE INDEX idx_knowledge_task_id    ON knowledge_chunks (task_id);
CREATE INDEX idx_knowledge_layer      ON knowledge_chunks (layer);
CREATE INDEX idx_knowledge_event_type ON knowledge_chunks (event_type);
