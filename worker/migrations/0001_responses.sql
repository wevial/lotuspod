-- One row per deliberate submission by the verified maintainer. Rows are
-- immutable apart from the acknowledgement columns, and a newer answer to
-- the same question points back at the one it replaces.
CREATE TABLE responses (
  id TEXT PRIMARY KEY,
  idempotencyKey TEXT NOT NULL UNIQUE,
  page TEXT NOT NULL,
  question TEXT NOT NULL,
  version TEXT NOT NULL,
  selected TEXT NOT NULL,
  note TEXT,
  actor TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  supersedes TEXT REFERENCES responses (id),
  ackedAt TEXT,
  ackedBy TEXT
);

CREATE INDEX responses_by_question ON responses (actor, page, question);
