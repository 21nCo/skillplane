function addResourceSelectors(value: unknown, found: Set<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (typeof record.resource === "string") found.add(record.resource);
  if (Array.isArray(record.resources)) {
    for (const resource of record.resources) {
      if (typeof resource === "string") found.add(resource);
    }
  }
}

/**
 * Returns only DataFn protocol resource selectors. Application records and
 * filters may legitimately contain fields named `resource` or `resources`;
 * recursively inspecting arbitrary payload data would treat those values as
 * routing or authorization input.
 */
export function collectDatafnStructuralResources(payload: unknown): Set<string> {
  const found = new Set<string>();
  if (Array.isArray(payload)) {
    for (const entry of payload) addResourceSelectors(entry, found);
    return found;
  }
  addResourceSelectors(payload, found);
  if (!payload || typeof payload !== "object") return found;

  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.steps)) {
    for (const step of record.steps) {
      addResourceSelectors(step, found);
      if (!step || typeof step !== "object" || Array.isArray(step)) continue;
      const structuralStep = step as Record<string, unknown>;
      addResourceSelectors(structuralStep.query, found);
      addResourceSelectors(structuralStep.mutation, found);
    }
  }
  if (Array.isArray(record.mutations)) {
    for (const mutation of record.mutations) {
      addResourceSelectors(mutation, found);
    }
  }
  return found;
}
