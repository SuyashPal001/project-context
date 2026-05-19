CREATE TYPE task_dependency_relation AS ENUM ('blocks', 'blocked_by', 'start_before', 'finish_before');

CREATE TABLE task_dependencies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  from_task_id  uuid NOT NULL REFERENCES agent_tasks(id),
  to_task_id    uuid NOT NULL REFERENCES agent_tasks(id),
  relation_type task_dependency_relation NOT NULL,
  created_by    uuid REFERENCES users(id),
  created_at    timestamp NOT NULL DEFAULT now(),
  deleted_at    timestamp
);

CREATE INDEX task_dependencies_from_task_idx ON task_dependencies(from_task_id);
CREATE INDEX task_dependencies_to_task_idx  ON task_dependencies(to_task_id);
CREATE INDEX task_dependencies_tenant_idx   ON task_dependencies(tenant_id);
