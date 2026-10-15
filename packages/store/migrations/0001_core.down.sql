drop function if exists erase_user(uuid);
drop function if exists run_retention(timestamptz);
drop table if exists deletion_receipts, secret_refs, outbox, jobs, assignment_evidence, assignments, alerts, gaps,
  evidence_packets, evidence, packets, capture_sources, sessions, retention_policies, users cascade;
drop function if exists require_children();
drop function if exists sessions_terminal_is_final();
drop function if exists bump_version();
drop function if exists forbid_identity_change();
drop function if exists app_current_user();
-- Roles are cluster-wide and may be shared: they are intentionally NOT dropped.
