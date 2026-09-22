-- Counting one kind of audit entry over a window (SR-X.22).
--
-- `audit_log` has indexes on `at` and on `actor_id`, which suit "what happened lately" and
-- "what did this account do". The security summary asks a third question — "how many failed
-- sign-ins in the last hour?" — and answering it with the `at` index means reading every
-- entry in the window and discarding almost all of them. Cheap today, at a few thousand rows;
-- exactly the query that stops working on the night it matters, when a flood of failures is
-- both the thing being counted and the reason the table is suddenly large.
CREATE INDEX audit_log_action_at_idx ON "app"."audit_log" (action, at DESC);
