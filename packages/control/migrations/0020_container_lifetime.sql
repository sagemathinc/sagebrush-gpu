-- The hard lifetime of a container launch: enroll sets max_end_ms (enroll time plus the
-- project's maximum session), and the lifetime job marks every enrolled container launch past
-- it to terminate (max-session). Its search is a range scan of this index, in its own order.
CREATE INDEX launches_container_lifetime ON launches (max_end_ms, machine_id, incarnation) WHERE outcome = 'enrolled' AND mode = 'container';
