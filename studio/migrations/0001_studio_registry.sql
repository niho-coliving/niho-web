PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 1 AND 80),
  name TEXT NOT NULL
    CHECK (length(trim(name)) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE sites (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 1 AND 80),
  project_id TEXT NOT NULL UNIQUE
    REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  name TEXT NOT NULL
    CHECK (length(trim(name)) BETWEEN 1 AND 120),
  public_origin TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE project_members (
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  access_subject TEXT NOT NULL
    CHECK (length(access_subject) BETWEEN 1 AND 128 AND access_subject = trim(access_subject)),
  role TEXT NOT NULL
    CHECK (role IN ('owner', 'editor')),
  display_name TEXT NOT NULL
    CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, access_subject)
) STRICT;

CREATE INDEX project_members_by_subject
  ON project_members(access_subject, project_id);

CREATE TRIGGER projects_identity_is_immutable
BEFORE UPDATE OF id ON projects
BEGIN
  SELECT RAISE(ABORT, 'project identity is immutable');
END;

CREATE TRIGGER projects_cannot_be_deleted
BEFORE DELETE ON projects
BEGIN
  SELECT RAISE(ABORT, 'project registry entries cannot be deleted');
END;

CREATE TRIGGER site_relationship_is_immutable
BEFORE UPDATE OF id, project_id ON sites
BEGIN
  SELECT RAISE(ABORT, 'project/site relationship is immutable');
END;

CREATE TRIGGER sites_cannot_be_deleted
BEFORE DELETE ON sites
BEGIN
  SELECT RAISE(ABORT, 'project/site relationship is immutable');
END;

CREATE TRIGGER member_identity_is_immutable
BEFORE UPDATE OF project_id, access_subject ON project_members
BEGIN
  SELECT RAISE(ABORT, 'membership identity is immutable');
END;

CREATE TRIGGER final_owner_cannot_be_removed
BEFORE DELETE ON project_members
WHEN OLD.role = 'owner'
 AND (SELECT count(*) FROM project_members WHERE project_id = OLD.project_id AND role = 'owner') <= 1
BEGIN
  SELECT RAISE(ABORT, 'cannot remove the final owner');
END;

CREATE TRIGGER final_owner_cannot_be_demoted
BEFORE UPDATE OF role ON project_members
WHEN OLD.role = 'owner'
 AND NEW.role <> 'owner'
 AND (SELECT count(*) FROM project_members WHERE project_id = OLD.project_id AND role = 'owner') <= 1
BEGIN
  SELECT RAISE(ABORT, 'cannot demote the final owner');
END;

INSERT INTO projects (id, name) VALUES
  ('project-kamakura', 'NIHOkamakura'),
  ('project-experience', 'NIHO experience');

INSERT INTO sites (id, project_id, name, public_origin) VALUES
  ('kamakura', 'project-kamakura', 'Kamakura site', NULL),
  ('experience', 'project-experience', 'Experience site', NULL);
