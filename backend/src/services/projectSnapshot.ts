import postgres from "postgres";
import type { AuthenticatedAccount } from "./account";
import * as dockerService from "./docker";
import * as fileService from "./file";

export type ProjectSnapshotFileTree = fileService.FileContentItem[];

export interface ProjectRecord {
  id: string;
  teamId: number;
  userId: number | null;
  activeContainerId: string | null;
  title: string | null;
  prompt: string | null;
}

export interface ProjectSnapshotRecord {
  id: number;
  projectId: string;
  containerId: string | null;
  files: ProjectSnapshotFileTree;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

const PROJECT_LOAD_ERROR =
  "Proje yüklenirken bir hata oluştu, lütfen tekrar dene.";

let sqlClient: postgres.Sql | null = null;
let schemaReady = false;

function getPostgresClient() {
  if (sqlClient) return sqlClient;

  const postgresUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!postgresUrl) {
    throw new Error("POSTGRES_URL is required for project snapshots");
  }

  sqlClient = postgres(postgresUrl, {
    max: Number(process.env.POSTGRES_MAX_CONNECTIONS || "5"),
    prepare: false,
  });

  return sqlClient;
}

async function ensureProjectSnapshotSchema() {
  if (schemaReady) return;

  const sql = getPostgresClient();
  await sql.begin(async (tx) => {
    await tx`
      create table if not exists projects (
        id uuid primary key,
        team_id integer not null references teams(id),
        user_id integer references users(id),
        active_container_id text,
        title text,
        prompt text,
        created_at timestamp not null default now(),
        updated_at timestamp not null default now()
      )
    `;
    await tx`
      create table if not exists project_snapshots (
        id serial primary key,
        project_id uuid not null references projects(id) on delete cascade,
        container_id text,
        team_id integer not null references teams(id),
        user_id integer references users(id),
        files jsonb not null,
        metadata jsonb,
        created_at timestamp not null default now()
      )
    `;
    await tx`
      create index if not exists projects_team_updated_idx
      on projects (team_id, updated_at desc)
    `;
    await tx`
      create index if not exists projects_active_container_idx
      on projects (active_container_id)
    `;
    await tx`
      create index if not exists project_snapshots_project_created_idx
      on project_snapshots (project_id, created_at desc)
    `;
  });

  schemaReady = true;
}

function normalizeTitle(value?: string | null) {
  const title = value?.replace(/\s+/g, " ").trim();
  if (!title) return null;
  return title.slice(0, 140);
}

function normalizePrompt(value?: string | null) {
  const prompt = value?.replace(/\s+/g, " ").trim();
  if (!prompt) return null;
  return prompt.slice(0, 4_000);
}

export function getProjectLoadErrorMessage() {
  return PROJECT_LOAD_ERROR;
}

export async function ensureProjectForContainer({
  projectId,
  containerId,
  account,
  title,
  prompt,
}: {
  projectId: string;
  containerId: string;
  account: AuthenticatedAccount;
  title?: string | null;
  prompt?: string | null;
}): Promise<ProjectRecord> {
  await ensureProjectSnapshotSchema();
  const sql = getPostgresClient();
  const [project] = await sql<
    {
      id: string;
      team_id: number;
      user_id: number | null;
      active_container_id: string | null;
      title: string | null;
      prompt: string | null;
    }[]
  >`
    insert into projects (
      id,
      team_id,
      user_id,
      active_container_id,
      title,
      prompt
    )
    values (
      ${projectId},
      ${account.teamId},
      ${account.localUserId},
      ${containerId},
      ${normalizeTitle(title)},
      ${normalizePrompt(prompt)}
    )
    on conflict (id) do update
    set active_container_id = excluded.active_container_id,
        title = coalesce(projects.title, excluded.title),
        prompt = coalesce(projects.prompt, excluded.prompt),
        updated_at = now()
    where projects.team_id = ${account.teamId}
    returning id, team_id, user_id, active_container_id, title, prompt
  `;

  if (!project) {
    throw new Error(PROJECT_LOAD_ERROR);
  }

  return {
    id: project.id,
    teamId: project.team_id,
    userId: project.user_id,
    activeContainerId: project.active_container_id,
    title: project.title,
    prompt: project.prompt,
  };
}

export async function resolveProjectForContainer({
  containerId,
  account,
}: {
  containerId: string;
  account: AuthenticatedAccount;
}): Promise<ProjectRecord | null> {
  await ensureProjectSnapshotSchema();
  const sql = getPostgresClient();
  const [project] = await sql<
    {
      id: string;
      team_id: number;
      user_id: number | null;
      active_container_id: string | null;
      title: string | null;
      prompt: string | null;
    }[]
  >`
    select id, team_id, user_id, active_container_id, title, prompt
    from projects
    where team_id = ${account.teamId}
      and active_container_id = ${containerId}
    order by updated_at desc
    limit 1
  `;

  if (!project) return null;

  return {
    id: project.id,
    teamId: project.team_id,
    userId: project.user_id,
    activeContainerId: project.active_container_id,
    title: project.title,
    prompt: project.prompt,
  };
}

export async function getLatestProjectSnapshot({
  projectId,
  account,
}: {
  projectId: string;
  account: AuthenticatedAccount;
}): Promise<ProjectSnapshotRecord | null> {
  await ensureProjectSnapshotSchema();
  const sql = getPostgresClient();
  const [snapshot] = await sql<
    {
      id: number;
      project_id: string;
      container_id: string | null;
      files: ProjectSnapshotFileTree;
      metadata: Record<string, unknown> | null;
      created_at: Date;
    }[]
  >`
    select id, project_id, container_id, files, metadata, created_at
    from project_snapshots
    where project_id = ${projectId}
      and team_id = ${account.teamId}
    order by created_at desc
    limit 1
  `;

  if (!snapshot) return null;

  return {
    id: snapshot.id,
    projectId: snapshot.project_id,
    containerId: snapshot.container_id,
    files: snapshot.files,
    metadata: snapshot.metadata,
    createdAt: snapshot.created_at.toISOString(),
  };
}

export async function saveProjectSnapshot({
  projectId,
  containerId,
  account,
  files,
  metadata,
}: {
  projectId: string;
  containerId: string;
  account: AuthenticatedAccount;
  files: ProjectSnapshotFileTree;
  metadata?: Record<string, unknown>;
}): Promise<ProjectSnapshotRecord> {
  await ensureProjectSnapshotSchema();
  const sql = getPostgresClient();
  const [snapshot] = await sql<
    {
      id: number;
      project_id: string;
      container_id: string | null;
      files: ProjectSnapshotFileTree;
      metadata: Record<string, unknown> | null;
      created_at: Date;
    }[]
  >`
    insert into project_snapshots (
      project_id,
      container_id,
      team_id,
      user_id,
      files,
      metadata
    )
    values (
      ${projectId},
      ${containerId},
      ${account.teamId},
      ${account.localUserId},
      ${JSON.stringify(files)}::jsonb,
      ${metadata ? JSON.stringify(metadata) : null}::jsonb
    )
    returning id, project_id, container_id, files, metadata, created_at
  `;

  await sql`
    update projects
    set active_container_id = ${containerId},
        updated_at = now()
    where id = ${projectId}
      and team_id = ${account.teamId}
  `;

  if (!snapshot) {
    throw new Error("Project snapshot could not be saved");
  }

  return {
    id: snapshot.id,
    projectId: snapshot.project_id,
    containerId: snapshot.container_id,
    files: snapshot.files,
    metadata: snapshot.metadata,
    createdAt: snapshot.created_at.toISOString(),
  };
}

function flattenSnapshotFiles(
  items: ProjectSnapshotFileTree,
  output: Array<{ path: string; content: string }> = []
) {
  for (const item of items) {
    if (item.type === "file" && typeof item.content === "string") {
      output.push({
        path: item.path,
        content: item.content,
      });
    }

    if (item.children?.length) {
      flattenSnapshotFiles(item.children, output);
    }
  }

  return output;
}

export async function restoreProjectSnapshotToContainer({
  containerId,
  snapshot,
}: {
  containerId: string;
  snapshot: ProjectSnapshotRecord;
}): Promise<{ restoredFiles: number }> {
  const files = flattenSnapshotFiles(snapshot.files);
  let restoredFiles = 0;

  try {
    for (const file of files) {
      await fileService.writeFile(containerId, file.path, file.content);
      restoredFiles += 1;
    }
  } catch (error) {
    console.error("Project snapshot restore failed:", {
      containerId,
      projectId: snapshot.projectId,
      snapshotId: snapshot.id,
      error: error instanceof Error ? error.message : error,
    });
    throw new Error(PROJECT_LOAD_ERROR);
  }

  return { restoredFiles };
}

export async function snapshotContainerFiles({
  containerId,
  account,
  projectId,
  metadata,
}: {
  containerId: string;
  account: AuthenticatedAccount;
  projectId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<ProjectSnapshotRecord | null> {
  const project =
    projectId && projectId.trim()
      ? await ensureProjectForContainer({
          projectId,
          containerId,
          account,
        })
      : await resolveProjectForContainer({ containerId, account });

  if (!project) return null;

  const files = await fileService.getFileContentTree(
    dockerService.docker,
    containerId
  );

  return saveProjectSnapshot({
    projectId: project.id,
    containerId,
    account,
    files,
    metadata,
  });
}
