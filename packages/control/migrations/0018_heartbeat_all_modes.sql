-- The heartbeat watchdog covers every enrolled launch, VM or container: container enroll sets
-- heartbeat_due_ms exactly as VM enroll does, and an enrolled pod whose heartbeats stop must end
-- like a VM. The due index no longer names a mode (it still holds enrolled launches only).
DROP INDEX launches_heartbeat_due;
CREATE INDEX launches_heartbeat_due ON launches (heartbeat_due_ms, machine_id, incarnation) WHERE outcome = 'enrolled';
