PRAGMA foreign_keys = ON;

ALTER TABLE project_members ADD COLUMN email TEXT
  CHECK (
    email IS NULL OR (
      length(email) BETWEEN 3 AND 254
      AND email = trim(email)
      AND email = lower(email)
      AND instr(email, '@') > 1
    )
  );

CREATE UNIQUE INDEX project_members_by_project_email
  ON project_members(project_id, email)
  WHERE email IS NOT NULL;

CREATE TABLE project_invitations (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 16 AND 64),
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  email TEXT NOT NULL
    CHECK (
      length(email) BETWEEN 3 AND 254
      AND email = trim(email)
      AND email = lower(email)
      AND instr(email, '@') > 1
    ),
  role TEXT NOT NULL
    CHECK (role IN ('owner', 'editor')),
  token_hash TEXT NOT NULL UNIQUE
    CHECK (length(token_hash) = 64 AND token_hash = lower(token_hash)),
  invited_by_subject TEXT NOT NULL
    CHECK (length(invited_by_subject) BETWEEN 1 AND 128 AND invited_by_subject = trim(invited_by_subject)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  accepted_subject TEXT,
  revoked_at INTEGER,
  revoked_by_subject TEXT,
  CHECK (expires_at > created_at AND expires_at <= created_at + 604800),
  CHECK (accepted_subject IS NULL OR (length(accepted_subject) BETWEEN 1 AND 128 AND accepted_subject = trim(accepted_subject))),
  CHECK (revoked_by_subject IS NULL OR (length(revoked_by_subject) BETWEEN 1 AND 128 AND revoked_by_subject = trim(revoked_by_subject))),
  CHECK ((used_at IS NULL) = (accepted_subject IS NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_by_subject IS NULL)),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
) STRICT;

CREATE INDEX project_invitations_by_project
  ON project_invitations(project_id, created_at DESC);

CREATE INDEX project_invitations_by_email
  ON project_invitations(email, project_id);

CREATE TABLE studio_audit_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_subject TEXT NOT NULL
    CHECK (length(actor_subject) BETWEEN 1 AND 128 AND actor_subject = trim(actor_subject)),
  action TEXT NOT NULL
    CHECK (action IN (
      'invitation.created.editor',
      'invitation.created.owner',
      'invitation.revoked',
      'invitation.accepted.editor',
      'invitation.accepted.owner',
      'member.promoted',
      'member.demoted',
      'member.removed'
    )),
  target TEXT NOT NULL
    CHECK (length(target) BETWEEN 1 AND 254),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE INDEX studio_audit_records_by_project
  ON studio_audit_records(project_id, created_at DESC, id DESC);

CREATE TRIGGER invitation_identity_is_immutable
BEFORE UPDATE OF id, project_id, email, role, token_hash, invited_by_subject, created_at, expires_at
ON project_invitations
BEGIN
  SELECT RAISE(ABORT, 'invitation identity is immutable');
END;

CREATE TRIGGER invitation_cannot_be_deleted
BEFORE DELETE ON project_invitations
BEGIN
  SELECT RAISE(ABORT, 'invitation history cannot be deleted');
END;

CREATE TRIGGER audit_records_are_immutable
BEFORE UPDATE ON studio_audit_records
BEGIN
  SELECT RAISE(ABORT, 'audit records are immutable');
END;

CREATE TRIGGER audit_records_cannot_be_deleted
BEFORE DELETE ON studio_audit_records
BEGIN
  SELECT RAISE(ABORT, 'audit records cannot be deleted');
END;
