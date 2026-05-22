-- Document sensitivity classification for data governance (RBI FREE-AI Sutra 7 / Section 3)
-- Levels: public (unrestricted), internal (default), confidential, restricted (CASA/KYC — private model only)

DO $$ BEGIN
  CREATE TYPE sensitivity_level AS ENUM ('public', 'internal', 'confidential', 'restricted');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS sensitivity_level sensitivity_level NOT NULL DEFAULT 'internal';

ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS sensitivity_level sensitivity_level NOT NULL DEFAULT 'internal';

CREATE INDEX IF NOT EXISTS idx_docs_sensitivity ON documents (tenant_id, sensitivity_level);
CREATE INDEX IF NOT EXISTS idx_chunks_sensitivity ON document_chunks (tenant_id, sensitivity_level);
