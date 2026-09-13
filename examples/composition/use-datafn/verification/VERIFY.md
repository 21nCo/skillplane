# Independently verify DataFn adoption

Resolve this skill with purpose=verify. Check out the exact repository commit recorded in the run. Operate with read-only repository and runtime permissions.

1. Build an independent inventory of every read and mutation: routes, loaders, components, server actions, jobs, exports, uploads and background processes. Include file paths, call sites, entrypoints, adapter boundaries and tenant/authorization handling. Do not accept only the executor's supplied list.
2. Search the entire repository for direct database, storage and parallel API clients. Trace each result and reconcile it against the inventory. Record approved adapter boundaries explicitly. Unaccounted surfaces are unknown, not pass.
3. Trace each surface statically to its DataFn client or mutation API. Record the exact revision and line references.
4. Capture representative runtime traces for every class of read and mutation. Test successful and failing mutations, authorization denial and cross-tenant isolation. Probe bypass paths and reconcile runtime behavior to the static inventory.
5. Attach redacted, immutable evidence references and SHA-256 digests for every required evidence type in claims.json. Evidence must refer to the attested commit and environment. A package presence check, import, scaffold, schema or unused mounted endpoint is insufficient.
6. Mark any observed bypass fail. Mark missing or inaccessible evidence and any unaccounted surface unknown. Complete the run only after reviewing all three blocking claims; Skillplane will prevent a successful attestation if any remains failed or unknown.
