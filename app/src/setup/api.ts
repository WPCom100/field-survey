/**
 * The server side of project setup (T41, PLAN §8): `GET /projects` to learn which projects
 * exist and `POST /projects` to create one. A project is only ever created on the server
 * (numbering groups must exist before any op); the app then remembers the id so the sync
 * engine pulls the project, its levels and copies (`rememberProjects`, D127).
 */

import { HttpClient, rememberProjects, type Store } from '@field-survey/core';

import type { Identity } from '../identity/api';

export type ServerLevel = {
  id: string;
  level: string;
  floor_order: number | null;
  in_scope: boolean;
  numbering_group_id: string;
  numbering_group_label: string | null;
  split_of_id: string | null;
  state: string;
};

export type ServerProject = {
  id: string;
  name: string;
  site: string | null;
  parties: Record<string, string> | null;
  settings: Record<string, string> | null;
  copied_from_id: string | null;
  created_at: string | null;
  levels: ServerLevel[];
};

export type NewLevel = { level: string; in_scope?: boolean; share_with?: string; split_of?: string };

export type NewProjectBody = {
  name: string;
  site?: string;
  parties?: { ec?: string; etc?: string; gc?: string };
  settings?: { export_title?: string; disclaimer?: string };
  copy_from?: { project_id: string; vocabulary: boolean; library: boolean; rulings: boolean; placeholders: boolean };
  levels: NewLevel[];
};

export type CreatedProject = ServerProject & { server_seq: number; copied: Record<string, number> };

function client(identity: Identity): HttpClient {
  return new HttpClient({ serverUrl: identity.serverUrl, token: identity.token, userName: identity.user?.name });
}

/** Every project on the server; also records their ids locally so they are pulled. */
export async function fetchProjects(identity: Identity, store: Store): Promise<ServerProject[]> {
  const list = await client(identity).json<ServerProject[]>('GET', '/projects');
  await rememberProjects(
    store,
    list.map((p) => p.id),
  );
  return list;
}

/** `POST /projects`; the new id is remembered locally so the next sync pulls it. */
export async function createProject(identity: Identity, store: Store, body: NewProjectBody): Promise<CreatedProject> {
  const created = await client(identity).json<CreatedProject>('POST', '/projects', body);
  await rememberProjects(store, [created.id]);
  return created;
}
