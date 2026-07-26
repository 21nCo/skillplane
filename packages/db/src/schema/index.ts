import { authfnSchema } from "./authfn.js";
import { domainSchema } from "./domain.js";

export * from "./authfn.js";
export * from "./domain.js";

export const schema = {
  ...authfnSchema,
  ...domainSchema,
};

export type SkillplaneSchema = typeof schema;
