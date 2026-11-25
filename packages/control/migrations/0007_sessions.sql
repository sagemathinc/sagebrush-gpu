-- Sign-in moves to WorkOS AuthKit (WorkOS sends its own mail): our email sign-in links
-- are gone, and their table with them. Sessions stay ours; the scheduled prune
-- (src/jobs.ts) reads them by expiry through this index.
DROP TABLE sign_in_links;
CREATE INDEX sessions_by_expiry ON sessions (expires_ms);
