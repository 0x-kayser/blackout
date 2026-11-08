-- Local email-code sign-in (development / self-hosted demos without Supabase).
-- Only hashes are stored: never the email address or the code itself.
CREATE TABLE IF NOT EXISTS email_codes (
  email_hash TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
