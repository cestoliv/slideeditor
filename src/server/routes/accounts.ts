import type { FastifyInstance } from "fastify";
import { asFields, field } from "./input.js";

interface IdParams {
  id: string;
}

export function accountRoutes(app: FastifyInstance): void {
  app.get("/api/accounts", () => ({ accounts: app.accounts.list() }));

  app.post("/api/accounts", (request) => {
    const body = asFields(request.body);
    return {
      account: app.accounts.create({
        name: field(body, "name"),
        defaults: body["defaults"],
      }),
    };
  });

  app.get<{ Params: IdParams }>("/api/accounts/:id", (request) => ({
    account: app.accounts.require(request.params.id),
  }));

  app.put<{ Params: IdParams }>("/api/accounts/:id", (request) => {
    const body = asFields(request.body);
    return {
      account: app.accounts.update(request.params.id, {
        name: field(body, "name"),
        defaults: body["defaults"],
      }),
    };
  });

  app.delete<{ Params: IdParams }>("/api/accounts/:id", (request) => {
    app.accounts.remove(request.params.id);
    return { removed: request.params.id };
  });
}
