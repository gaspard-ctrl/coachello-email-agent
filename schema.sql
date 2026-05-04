-- ============================================================
-- Coachello Email Agent — Schéma PostgreSQL (Neon)
-- À exécuter une seule fois dans la console Neon
-- ============================================================

-- Extension UUID
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Table principale : emails reçus + réponses générées
CREATE TABLE IF NOT EXISTS emails (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_id        VARCHAR(255) UNIQUE NOT NULL,
  thread_id       VARCHAR(255),
  message_id      VARCHAR(500),
  from_email      VARCHAR(255) NOT NULL,
  from_name       VARCHAR(255),
  to_email        VARCHAR(255),
  cc_emails       TEXT,
  subject         TEXT,
  body_text       TEXT,
  body_html       TEXT,
  received_at     TIMESTAMP NOT NULL,
  classification  VARCHAR(50) NOT NULL CHECK (classification IN ('URGENT','IMPORTANT','NORMAL','FAIBLE')),
  reasoning       TEXT,
  draft_response  TEXT,
  status          VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending','locked','validated','rejected','sent','draft_saved')),
  locked_by       VARCHAR(255),
  locked_at       TIMESTAMP,
  validated_at    TIMESTAMP,
  validated_by    VARCHAR(255),
  final_response  TEXT,
  attachments     JSONB DEFAULT '[]',
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- Table : guide de réponse (DOCX converti en texte)
CREATE TABLE IF NOT EXISTS guide (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content     TEXT NOT NULL,
  filename    VARCHAR(255),
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- Table : exemples d'emails avec réponses idéales
CREATE TABLE IF NOT EXISTS examples (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_subject    TEXT,
  email_from       VARCHAR(255),
  email_body       TEXT NOT NULL,
  ideal_response   TEXT NOT NULL,
  classification   VARCHAR(50) CHECK (classification IN ('URGENT','IMPORTANT','NORMAL','FAIBLE')),
  notes            TEXT,
  created_at       TIMESTAMP DEFAULT NOW()
);

-- Table : règles de classification automatique
CREATE TABLE IF NOT EXISTS classification_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type       VARCHAR(50) NOT NULL CHECK (rule_type IN ('sender','keyword','domain','subject_keyword')),
  value           VARCHAR(255) NOT NULL,
  classification  VARCHAR(50) NOT NULL CHECK (classification IN ('URGENT','IMPORTANT','NORMAL','FAIBLE')),
  created_at      TIMESTAMP DEFAULT NOW()
);

-- Table : paramètres globaux (clé-valeur)
CREATE TABLE IF NOT EXISTS settings (
  key         VARCHAR(100) PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- Table : log des appels à l'API Claude (coût)
CREATE TABLE IF NOT EXISTS claude_usage (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_name         VARCHAR(100) NOT NULL,
  model                 VARCHAR(100) NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd              NUMERIC(10, 6) NOT NULL DEFAULT 0,
  email_id              UUID,
  email_subject         TEXT,
  created_at            TIMESTAMP DEFAULT NOW()
);

-- Index pour accélérer les requêtes fréquentes
CREATE INDEX IF NOT EXISTS idx_emails_status       ON emails(status);
CREATE INDEX IF NOT EXISTS idx_emails_classification ON emails(classification);
CREATE INDEX IF NOT EXISTS idx_emails_received_at   ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_gmail_id      ON emails(gmail_id);
CREATE INDEX IF NOT EXISTS idx_claude_usage_created ON claude_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claude_usage_email   ON claude_usage(email_id);

-- Trigger : mise à jour automatique de updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER emails_updated_at
  BEFORE UPDATE ON emails
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Données de test (optionnel, à supprimer en prod)
-- INSERT INTO guide (content, filename) VALUES ('Ton : professionnel et chaleureux. Toujours signer avec "L'\''équipe Coachello".', 'guide_test.txt');
