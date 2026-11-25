ALTER TABLE companions ADD COLUMN effort TEXT;
ALTER TABLE companions ADD COLUMN slug TEXT;
ALTER TABLE companions ADD COLUMN archetype TEXT;
ALTER TABLE companions ADD COLUMN claude_md_path TEXT;
ALTER TABLE companions ADD COLUMN mcp_json_path TEXT;
ALTER TABLE companions ADD COLUMN model_autonomous TEXT;
ALTER TABLE companions ADD COLUMN avatar_url TEXT;
ALTER TABLE companions ADD COLUMN is_primary INTEGER DEFAULT 0;
ALTER TABLE companions ADD COLUMN updated_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companions_slug ON companions(slug);
