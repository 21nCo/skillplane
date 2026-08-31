import { describe, expect, it, vi } from "vitest";
import type { RuntimeBindings } from "@skillplane/config";
import type { ApiServices } from "./context.js";
import { createApiServiceProvider } from "./services.js";

function disposableServices() {
  const datafnClose = vi.fn(async () => undefined);
  const emailClose = vi.fn(async () => undefined);
  const databaseClose = vi.fn(async () => undefined);
  const controlDatabaseClose = vi.fn(async () => undefined);
  const services = {
    datafn: { close: datafnClose },
    email: { close: emailClose },
    database: { close: databaseClose },
    controlDatabase: { close: controlDatabaseClose },
  } as unknown as ApiServices;
  return {
    services,
    datafnClose,
    emailClose,
    databaseClose,
    controlDatabaseClose,
  };
}

describe("createApiServiceProvider", () => {
  it("reuses one worker-lifetime service graph across requests", async () => {
    const first = disposableServices();
    const build = vi.fn(async () => first.services);
    const provider = createApiServiceProvider({}, build);
    const bindings = {} as RuntimeBindings;

    const [left, right] = await Promise.all([provider(bindings), provider(bindings)]);
    await provider.release?.(left);

    expect(left).toBe(first.services);
    expect(right).toBe(first.services);
    expect(build).toHaveBeenCalledOnce();
    expect(first.datafnClose).not.toHaveBeenCalled();
    expect(first.controlDatabaseClose).not.toHaveBeenCalled();
  });

  it("closes cached services explicitly and rebuilds after shutdown", async () => {
    const first = disposableServices();
    const second = disposableServices();
    const build = vi
      .fn<() => Promise<ApiServices>>()
      .mockResolvedValueOnce(first.services)
      .mockResolvedValueOnce(second.services);
    const provider = createApiServiceProvider({}, build);
    const bindings = {} as RuntimeBindings;

    await provider(bindings);
    await provider.close?.();
    expect(first.datafnClose).toHaveBeenCalledOnce();
    expect(first.emailClose).toHaveBeenCalledOnce();
    expect(first.databaseClose).toHaveBeenCalledOnce();
    expect(first.controlDatabaseClose).toHaveBeenCalledOnce();

    await expect(provider(bindings)).resolves.toBe(second.services);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("allows a failed initialization to be retried", async () => {
    const ready = disposableServices();
    const build = vi
      .fn<() => Promise<ApiServices>>()
      .mockRejectedValueOnce(new Error("temporary startup failure"))
      .mockResolvedValueOnce(ready.services);
    const provider = createApiServiceProvider({}, build);
    const bindings = {} as RuntimeBindings;

    await expect(provider(bindings)).rejects.toThrow("temporary startup failure");
    await expect(provider(bindings)).resolves.toBe(ready.services);
    expect(build).toHaveBeenCalledTimes(2);
  });
});
