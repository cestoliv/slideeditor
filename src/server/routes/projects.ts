import type { FastifyInstance } from "fastify";
import type { ProjectListOptions } from "../services/projects.js";
import { asFields, field, queryValue } from "./input.js";

interface IdParams {
  id: string;
}

export function projectRoutes(app: FastifyInstance): void {
  app.get("/api/projects", (request) => ({
    projects: app.projects.list(projectListOptions(request.query)),
  }));

  app.post("/api/projects", (request) => {
    const body = asFields(request.body);
    return {
      project: app.projects.create({
        name: field(body, "name"),
        document: body["document"],
        description: field(body, "description"),
        hashtags: field(body, "hashtags"),
        accountId: field(body, "accountId"),
      }),
    };
  });

  app.get<{ Params: IdParams }>("/api/projects/:id", (request) => ({
    project: app.projects.require(request.params.id),
  }));

  app.put<{ Params: IdParams }>("/api/projects/:id", (request) => {
    const body = asFields(request.body);
    return {
      project: app.projects.save(request.params.id, {
        name: field(body, "name"),
        document: body["document"],
        version: field(body, "version"),
        description: field(body, "description"),
        hashtags: field(body, "hashtags"),
      }),
    };
  });

  app.delete<{ Params: IdParams }>("/api/projects/:id", (request) =>
    app.projects.remove(request.params.id),
  );

  app.patch<{ Params: IdParams }>("/api/projects/:id/status", (request) => ({
    project: app.projects.setStatus(
      request.params.id,
      field(asFields(request.body), "status"),
    ),
  }));
}

/** An absent status leaves the service on its default filter, the way `?? undefined` did. */
export function statusFilter(query: unknown): ProjectListOptions {
  const status = queryValue(query, "status");
  return status === null ? {} : { status };
}

/** statusFilter plus the `?account=` filter, shared with /api/slideshows. */
export function projectListOptions(query: unknown): ProjectListOptions {
  const account = queryValue(query, "account");
  return { ...statusFilter(query), ...(account === null ? {} : { accountId: account }) };
}
