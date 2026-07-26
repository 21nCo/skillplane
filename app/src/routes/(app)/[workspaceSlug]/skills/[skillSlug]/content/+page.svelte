<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Badge, Button, Select } from "@skillplane/ui";
  import { SafeMarkdown } from "@skillplane/ui";
  import SkillEditor from "$lib/skills/SkillEditor.svelte";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { getSkillFile } from "$lib/skills/api.js";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
  import type { SkillManifestFile, SkillVersion } from "$lib/skills/types.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import {
    DownloadSimpleIcon,
    FileCodeIcon,
    FileIcon,
    NotePencilIcon,
  } from "phosphor-svelte";

  const detail = useSkillDetailStore();
  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
  const requestedVersionId = $derived(page.url.searchParams.get("version"));
  const selectedVersion = $derived(
    detail.versions.find((version) => version.id === requestedVersionId) ??
      detail.currentVersion,
  );
  const requestedPath = $derived(page.url.searchParams.get("file"));
  const selectedFile = $derived(
    selectedVersion?.manifest.files.find((file) => file.path === requestedPath) ??
      selectedVersion?.manifest.files.find((file) => file.path === "SKILL.md") ??
      selectedVersion?.manifest.files.at(0) ??
      null,
  );
  const canEdit = $derived(
    Boolean(
      workspace &&
      workspace.role !== "viewer" &&
      detail.skill &&
      !detail.skill.archivedAt &&
      selectedVersion?.id === detail.currentVersion?.id &&
      selectedFile?.path === "SKILL.md",
    ),
  );

  let fileText = $state<string | null>(null);
  let imageUrl = $state<string | null>(null);
  let fileError = $state<string | null>(null);
  let loadingFile = $state(false);
  let loadedKey = $state<string | null>(null);
  let view = $state<"rendered" | "source">("rendered");
  let editing = $state(false);
  let requestSequence = 0;

  function isText(file: SkillManifestFile): boolean {
    return (
      file.mediaType.startsWith("text/") ||
      file.mediaType === "application/json" ||
      file.mediaType === "application/yaml"
    );
  }

  function isImage(file: SkillManifestFile): boolean {
    return file.mediaType.startsWith("image/");
  }

  async function loadFile() {
    if (!workspace || !detail.skill || !selectedVersion || !selectedFile) return;
    const sequence = ++requestSequence;
    loadingFile = true;
    fileError = null;
    fileText = null;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = null;
    try {
      const response = await getSkillFile({
        workspaceId: workspace.id,
        skillId: detail.skill.id,
        versionId: selectedVersion.id,
        path: selectedFile.path,
      });
      if (sequence !== requestSequence) return;
      if (isText(selectedFile)) {
        fileText = await response.text();
      } else if (isImage(selectedFile)) {
        imageUrl = URL.createObjectURL(await response.blob());
      }
    } catch (cause) {
      if (sequence !== requestSequence) return;
      fileError =
        cause instanceof Error ? cause.message : "The file could not be loaded.";
    } finally {
      if (sequence === requestSequence) loadingFile = false;
    }
  }

  async function chooseFile(path: string, versionId = selectedVersion?.id) {
    if (!workspace || !detail.skill || !versionId) return;
    const query = new URLSearchParams({ version: versionId, file: path });
    // The pathname is route-safe via resolve(); only encoded query parameters are appended.
    /* eslint-disable svelte/no-navigation-without-resolve */
    await goto(
      `${resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/content", {
        workspaceSlug: workspace.slug,
        skillSlug: detail.skill.slug,
      })}?${query.toString()}`,
      { keepFocus: true, noScroll: true },
    );
    /* eslint-enable svelte/no-navigation-without-resolve */
  }

  async function chooseVersion(versionId: string) {
    const version = detail.versions.find((entry) => entry.id === versionId);
    const path = version?.manifest.files.some(
      (file) => file.path === selectedFile?.path,
    )
      ? selectedFile?.path
      : "SKILL.md";
    if (path) await chooseFile(path, versionId);
  }

  async function download() {
    if (!workspace || !detail.skill || !selectedVersion || !selectedFile) return;
    try {
      const response = await getSkillFile({
        workspaceId: workspace.id,
        skillId: detail.skill.id,
        versionId: selectedVersion.id,
        path: selectedFile.path,
      });
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = selectedFile.path.split("/").at(-1) ?? "skill-file";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      fileError =
        cause instanceof Error ? cause.message : "The file could not be downloaded.";
    }
  }

  function candidateCreated(version: SkillVersion) {
    detail.replaceVersion(version);
    if (!workspace || !detail.skill) return;
    // The pathname is route-safe via resolve(); the static candidate flag is appended.
    /* eslint-disable svelte/no-navigation-without-resolve */
    void goto(
      `${resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/versions/[versionId]", {
        workspaceSlug: workspace.slug,
        skillSlug: detail.skill.slug,
        versionId: version.id,
      })}?candidate=true`,
    );
    /* eslint-enable svelte/no-navigation-without-resolve */
  }

  $effect(() => {
    const key =
      selectedVersion && selectedFile
        ? `${selectedVersion.id}:${selectedFile.path}`
        : null;
    if (key && key !== loadedKey) {
      loadedKey = key;
      view = selectedFile?.path === "SKILL.md" ? "rendered" : "source";
      editing = false;
      void loadFile();
    }
  });
</script>

<svelte:head>
  <title>Content · {detail.skill?.name ?? "Skillplane"}</title>
</svelte:head>

{#if detail.skill && workspace && selectedVersion}
  <section class="content-toolbar">
    <div>
      <p>Verified bundle content</p>
      <h2>Browse exact version files</h2>
    </div>
    <Select
      label="Version"
      options={detail.versions.map((version) => ({
        value: version.id,
        label: version.semanticVersion
          ? `v${version.semanticVersion} · revision ${String(version.revision)}`
          : `Revision ${String(version.revision)} · ${version.status.replace("_", " ")}`,
      }))}
      value={selectedVersion.id}
      onchange={(event) =>
        void chooseVersion((event.currentTarget as HTMLSelectElement).value)}
    />
  </section>

  {#if editing && fileText !== null}
    <section class="editor-panel">
      <SkillEditor
        workspaceId={workspace.id}
        skill={detail.skill}
        baseVersion={selectedVersion}
        initialMarkdown={fileText}
        onCreated={candidateCreated}
      />
      <div class="cancel-edit">
        <Button variant="ghost" onclick={() => (editing = false)}>
          Cancel editing
        </Button>
      </div>
    </section>
  {:else}
    <section class="browser">
      <aside aria-label="Bundle files">
        <header>
          <span>{selectedVersion.manifest.fileCount} files</span>
          <small>{(selectedVersion.byteSize / 1024).toFixed(1)} KiB ZIP</small>
        </header>
        <nav>
          {#each selectedVersion.manifest.files as file (file.path)}
            <button
              type="button"
              class:active={file.path === selectedFile?.path}
              aria-pressed={file.path === selectedFile?.path}
              onclick={() => void chooseFile(file.path)}
            >
              {#if isText(file)}
                <FileCodeIcon weight="duotone" aria-hidden="true" />
              {:else}
                <FileIcon weight="duotone" aria-hidden="true" />
              {/if}
              <span>
                <strong>{file.path}</strong>
                <small>{(file.byteSize / 1024).toFixed(1)} KiB</small>
              </span>
            </button>
          {/each}
        </nav>
      </aside>

      <div class="viewer">
        {#if selectedFile}
          <header>
            <div>
              <code>{selectedFile.path}</code>
              <span title={selectedFile.sha256}>
                sha256:{selectedFile.sha256.slice(0, 12)}…
              </span>
            </div>
            <div class="viewer-actions">
              {#if selectedFile.path === "SKILL.md" && fileText !== null}
                <Button
                  size="sm"
                  variant={view === "rendered" ? "primary" : "secondary"}
                  aria-pressed={view === "rendered"}
                  onclick={() => (view = "rendered")}
                >
                  Rendered
                </Button>
                <Button
                  size="sm"
                  variant={view === "source" ? "primary" : "secondary"}
                  aria-pressed={view === "source"}
                  onclick={() => (view = "source")}
                >
                  Source
                </Button>
              {/if}
              {#if canEdit && fileText !== null}
                <Button size="sm" variant="secondary" onclick={() => (editing = true)}>
                  {#snippet leading()}<NotePencilIcon weight="bold" />{/snippet}
                  Edit
                </Button>
              {/if}
              <Button size="sm" variant="secondary" onclick={() => void download()}>
                {#snippet leading()}<DownloadSimpleIcon weight="bold" />{/snippet}
                Download
              </Button>
            </div>
          </header>

          {#if loadingFile}
            <div class="state-wrap">
              <SkillState
                kind="loading"
                title="Loading verified file"
                message="Reading the bundle and checking its digest."
              />
            </div>
          {:else if fileError}
            <div class="state-wrap">
              <SkillState
                kind="error"
                title="File could not be loaded"
                message={fileError}
                retry={() => void loadFile()}
              />
            </div>
          {:else if fileText !== null}
            {#if selectedFile.path === "SKILL.md" && view === "rendered"}
              <div class="rendered"><SafeMarkdown source={fileText} /></div>
            {:else}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex (A focusable scroll region lets keyboard users inspect long source files.) -->
              <pre tabindex="0" aria-label={`${selectedFile.path} source`}><code
                  >{fileText}</code
                ></pre>
            {/if}
          {:else if imageUrl}
            <div class="image-preview">
              <img src={imageUrl} alt={`Preview of ${selectedFile.path}`} />
            </div>
          {:else}
            <div class="binary-state">
              <Badge tone="neutral">{selectedFile.mediaType}</Badge>
              <p>
                This file is not rendered inline. Download the digest-verified artifact
                to inspect it safely.
              </p>
            </div>
          {/if}
        {/if}
      </div>
    </section>
  {/if}
{/if}

<style>
  .content-toolbar {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: var(--sp-space-4);
    margin-bottom: var(--sp-space-4);
  }

  .content-toolbar p,
  h2 {
    margin: 0;
  }

  .content-toolbar p {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  h2 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-5);
  }

  .content-toolbar > :global(div:last-child) {
    width: 19rem;
  }

  .browser {
    display: grid;
    min-height: 36rem;
    grid-template-columns: 18rem minmax(0, 1fr);
    overflow: hidden;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface);
  }

  .browser > aside {
    min-width: 0;
    border-right: 1px solid var(--sp-color-border);
    background: var(--sp-color-surface-muted);
  }

  .browser > aside > header,
  .viewer > header {
    display: flex;
    min-height: 3rem;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-2);
    padding: var(--sp-space-2) var(--sp-space-3);
    border-bottom: 1px solid var(--sp-color-border);
  }

  .browser > aside header {
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
  }

  .browser nav {
    display: grid;
    gap: 1px;
    padding: var(--sp-space-2);
  }

  .browser nav button {
    display: grid;
    min-width: 0;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-space-2);
    align-items: center;
    border: 0;
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-2);
    background: transparent;
    color: var(--sp-color-text-muted);
    cursor: pointer;
    text-align: left;
  }

  .browser nav button:hover,
  .browser nav button.active {
    background: var(--sp-color-surface-hover);
    color: var(--sp-color-text);
  }

  .browser nav strong,
  .browser nav small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .browser nav strong {
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-2);
    font-weight: var(--sp-weight-medium);
  }

  .browser nav small {
    margin-top: 2px;
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }

  .viewer {
    min-width: 0;
  }

  .viewer > header > div:first-child {
    min-width: 0;
  }

  .viewer > header code,
  .viewer > header span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .viewer > header code {
    font-size: var(--sp-font-size-3);
  }

  .viewer > header span {
    margin-top: 2px;
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
  }

  .viewer-actions {
    display: flex;
    flex: none;
    gap: var(--sp-space-1);
  }

  .rendered,
  .state-wrap {
    padding: var(--sp-space-5);
  }

  pre {
    overflow: auto;
    min-height: 33rem;
    max-height: 62rem;
    margin: 0;
    padding: var(--sp-space-4);
    background: var(--sp-color-canvas);
    color: var(--sp-color-text-muted);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-2);
    line-height: 1.6;
    white-space: pre-wrap;
  }

  .image-preview,
  .binary-state {
    display: grid;
    min-height: 30rem;
    place-items: center;
    align-content: center;
    gap: var(--sp-space-3);
    padding: var(--sp-space-5);
  }

  .image-preview img {
    max-width: 100%;
    max-height: 40rem;
  }

  .binary-state p {
    max-width: 28rem;
    margin: 0;
    color: var(--sp-color-text-muted);
    text-align: center;
  }

  .editor-panel {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-5);
    background: var(--sp-color-surface);
  }

  .cancel-edit {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--sp-space-2);
  }

  @media (max-width: 60rem) {
    .browser {
      grid-template-columns: 14rem minmax(0, 1fr);
    }
  }

  @media (max-width: 48rem) {
    .content-toolbar {
      display: grid;
      align-items: start;
    }

    .content-toolbar > :global(div:last-child) {
      width: 100%;
    }

    .browser {
      grid-template-columns: 1fr;
    }

    .browser > aside {
      max-height: 16rem;
      overflow: auto;
      border-right: 0;
      border-bottom: 1px solid var(--sp-color-border);
    }

    .viewer > header {
      align-items: flex-start;
    }

    .viewer-actions {
      flex-wrap: wrap;
      justify-content: flex-end;
    }
  }
</style>
