# Superfunctions change log policy

This directory is append-only evidence for every Skillplane-motivated edit made in a Superfunctions worktree.

Before modifying Superfunctions, create a dated log containing:

- worktree label and branch;
- clean or dirty status;
- pre-existing changed paths;
- intended files and symbols;
- why the change cannot remain Skillplane-local;
- expected tests.

After the edit, append:

- actual diff scope;
- verification commands and results;
- compatibility impact;
- rollback instructions;
- whether any pre-existing user change overlapped.

If the relevant external path is already modified, implementation MUST stop unless the new change can be proven non-overlapping or the user explicitly authorizes the overlap.
