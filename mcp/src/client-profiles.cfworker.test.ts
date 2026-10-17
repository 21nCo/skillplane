import { vi } from "vitest";
import { describeDiagnosticContract } from "../tests/support/client-profile-contract.js";

// @mcpfn/core selects @cfworker/json-schema, the engine production Workers
// use, when WebSocketPair exists. Vitest runs this before any import.
vi.hoisted(() => {
  Object.assign(globalThis, { WebSocketPair: {} });
});

describeDiagnosticContract("cfworker");
