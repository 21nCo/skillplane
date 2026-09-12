import type { AuthFnServer } from "authfn";
import { Hono } from "hono";

export interface CreateAuthApplicationInput {
  readonly authfn: AuthFnServer;
}

/** Bridges AuthFn's released router to Hono without redeclaring its routes. */
export function createAuthApplication(input: CreateAuthApplicationInput) {
  const app = new Hono();
  app.all("/auth/*", (context) => input.authfn.router.handle(context.req.raw));
  return app;
}
