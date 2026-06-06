create table if not exists projects (
  id uuid primary key,
  team_id integer not null references teams(id),
  user_id integer references users(id),
  active_container_id text,
  title text,
  prompt text,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);

create table if not exists project_snapshots (
  id serial primary key,
  project_id uuid not null references projects(id) on delete cascade,
  container_id text,
  team_id integer not null references teams(id),
  user_id integer references users(id),
  files jsonb not null,
  metadata jsonb,
  created_at timestamp not null default now()
);

create index if not exists projects_team_updated_idx
  on projects (team_id, updated_at desc);

create index if not exists projects_active_container_idx
  on projects (active_container_id);

create index if not exists project_snapshots_project_created_idx
  on project_snapshots (project_id, created_at desc);

