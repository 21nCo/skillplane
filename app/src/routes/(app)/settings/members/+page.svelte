<script lang="ts">
  import { apiRequest, jsonBody, SkillplaneApiError } from "$lib/api/client.js";
  import AsyncState from "$lib/components/AsyncState.svelte";
  import {
    useWorkspaceStore,
    type WorkspaceRole,
  } from "$lib/workspaces/store.svelte.js";
  import {
    CheckCircleIcon as CheckCircle,
    EnvelopeSimpleIcon as EnvelopeSimple,
    TrashIcon as Trash,
    UserPlusIcon as UserPlus,
    UsersThreeIcon as UsersThree,
    WarningCircleIcon as WarningCircle,
    XIcon as X,
  } from "phosphor-svelte";

  interface Member {
    readonly userId: string;
    readonly role: WorkspaceRole;
    readonly email: string | null;
    readonly displayName: string | null;
    readonly joinedAt: string;
  }

  interface Invitation {
    readonly id: string;
    readonly email: string;
    readonly role: Exclude<WorkspaceRole, "owner">;
    readonly expiresAt: string;
    readonly acceptedAt: string | null;
    readonly revokedAt: string | null;
    readonly createdAt: string;
  }

  const store = useWorkspaceStore();
  let members = $state<Member[]>([]);
  let invitations = $state<Invitation[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let inviteOpen = $state(false);
  let inviteEmail = $state("");
  let inviteRole = $state<Exclude<WorkspaceRole, "owner">>("editor");
  let inviteError = $state<string | null>(null);
  let sending = $state(false);
  let notice = $state<string | null>(null);
  let removeTarget = $state<Member | null>(null);
  let revokingId = $state<string | null>(null);

  const canManage = $derived(
    store.active?.role === "owner" || store.active?.role === "admin",
  );

  $effect(() => {
    if (store.activeId) void load();
  });

  async function load() {
    const workspaceId = store.activeId;
    if (!workspaceId) return;
    loading = true;
    error = null;
    try {
      const [memberData, invitationData] = await Promise.all([
        apiRequest<{ members: Member[] }>(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members`,
        ),
        apiRequest<{ invitations: Invitation[] }>(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
        ),
      ]);
      if (workspaceId !== store.activeId) return;
      members = memberData.members;
      invitations = invitationData.invitations;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Members could not be loaded.";
    } finally {
      loading = false;
    }
  }

  async function invite(event: SubmitEvent) {
    event.preventDefault();
    const workspaceId = store.activeId;
    if (!workspaceId) return;
    sending = true;
    inviteError = null;
    try {
      await apiRequest(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
        {
          method: "POST",
          ...jsonBody({ email: inviteEmail, role: inviteRole }),
        },
      );
      notice = `Invitation sent to ${inviteEmail.trim().toLowerCase()}.`;
      inviteEmail = "";
      inviteOpen = false;
      await load();
    } catch (caught) {
      inviteError =
        caught instanceof SkillplaneApiError
          ? caught.message
          : "The invitation could not be sent.";
    } finally {
      sending = false;
    }
  }

  async function changeRole(userId: string, role: WorkspaceRole) {
    const workspaceId = store.activeId;
    if (!workspaceId) return;
    error = null;
    try {
      await apiRequest(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
        { method: "PATCH", ...jsonBody({ role }) },
      );
      notice = "Member role updated.";
      await load();
    } catch (caught) {
      error =
        caught instanceof Error ? caught.message : "The role could not be updated.";
      await load();
    }
  }

  async function removeMember() {
    const workspaceId = store.activeId;
    const target = removeTarget;
    if (!workspaceId || !target) return;
    try {
      await apiRequest(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(target.userId)}`,
        { method: "DELETE" },
      );
      notice = `${target.email ?? "Member"} was removed. Their historical activity remains attributable.`;
      removeTarget = null;
      await load();
    } catch (caught) {
      error =
        caught instanceof Error ? caught.message : "The member could not be removed.";
      removeTarget = null;
    }
  }

  async function revoke(invitation: Invitation) {
    const workspaceId = store.activeId;
    if (!workspaceId) return;
    revokingId = invitation.id;
    try {
      await apiRequest(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitation.id)}`,
        { method: "DELETE" },
      );
      notice = `Invitation for ${invitation.email} was revoked.`;
      await load();
    } catch (caught) {
      error =
        caught instanceof Error
          ? caught.message
          : "The invitation could not be revoked.";
    } finally {
      revokingId = null;
    }
  }
</script>

<svelte:head>
  <title>Members · Skillplane</title>
</svelte:head>

<main class="page">
  <header class="page-header">
    <div>
      <p class="eyebrow">Workspace settings</p>
      <h1>Members</h1>
      <p>Manage access, roles, and pending invitations for {store.active?.name}.</p>
    </div>
    {#if canManage && store.active?.kind === "organization"}
      <button class="primary" type="button" onclick={() => (inviteOpen = true)}>
        <UserPlus size={16} weight="bold" aria-hidden="true" /> Invite member
      </button>
    {/if}
  </header>

  {#if notice}
    <div class="notice" role="status">
      <CheckCircle size={17} weight="fill" aria-hidden="true" />
      {notice}
      <button type="button" aria-label="Dismiss message" onclick={() => (notice = null)}
        ><X size={14} weight="bold" aria-hidden="true" /></button
      >
    </div>
  {/if}

  {#if inviteOpen}
    <section class="invite-card" aria-labelledby="invite-title">
      <div class="invite-heading">
        <div class="icon">
          <EnvelopeSimple size={19} weight="duotone" aria-hidden="true" />
        </div>
        <div>
          <h2 id="invite-title">Invite to {store.active?.name}</h2>
          <p>The link expires in seven days and works only for this email.</p>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label="Close invitation form"
          onclick={() => (inviteOpen = false)}
          ><X size={16} weight="bold" aria-hidden="true" /></button
        >
      </div>
      <form onsubmit={invite}>
        <label>
          <span>Email address</span>
          <input
            type="email"
            required
            maxlength="254"
            autocomplete="email"
            placeholder="teammate@company.com"
            bind:value={inviteEmail}
            aria-describedby={inviteError ? "invite-error" : undefined}
          />
        </label>
        <label>
          <span>Role</span>
          <select bind:value={inviteRole}>
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button class="primary" type="submit" disabled={sending}>
          {sending ? "Sending…" : "Send invitation"}
        </button>
      </form>
      {#if inviteError}
        <p class="form-error" id="invite-error" role="alert">
          <WarningCircle size={16} weight="fill" aria-hidden="true" />
          {inviteError}
        </p>
      {/if}
    </section>
  {/if}

  {#if loading}
    <section class="panel" aria-label="Loading workspace members" aria-busy="true">
      <div class="skeleton"></div>
      <div class="skeleton"></div>
      <div class="skeleton"></div>
    </section>
  {:else if error}
    <AsyncState
      title="Member access could not be loaded"
      message={error}
      retry={() => void load()}
    />
  {:else}
    <section class="panel" aria-labelledby="members-title">
      <div class="panel-heading">
        <div>
          <h2 id="members-title">Workspace members</h2>
          <p>{members.length} {members.length === 1 ? "person" : "people"}</p>
        </div>
        <UsersThree size={20} weight="duotone" aria-hidden="true" />
      </div>
      <div class="rows">
        {#each members as member (member.userId)}
          <article class="member-row">
            <div class="avatar" aria-hidden="true">
              {(member.displayName ?? member.email ?? "M").slice(0, 1).toUpperCase()}
            </div>
            <div class="identity">
              <strong>{member.displayName ?? member.email ?? "Workspace member"}</strong
              >
              {#if member.displayName && member.email}<span>{member.email}</span>{/if}
            </div>
            {#if canManage}
              <select
                value={member.role}
                aria-label={`Role for ${member.email ?? member.userId}`}
                onchange={(event) =>
                  void changeRole(
                    member.userId,
                    event.currentTarget.value as WorkspaceRole,
                  )}
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="admin">Admin</option>
                {#if store.active?.role === "owner"}
                  <option value="owner">Owner</option>
                {/if}
              </select>
              <button
                class="icon-button danger"
                type="button"
                aria-label={`Remove ${member.email ?? "member"}`}
                onclick={() => (removeTarget = member)}
              >
                <Trash size={15} weight="bold" aria-hidden="true" />
              </button>
            {:else}
              <span class="role">{member.role}</span>
            {/if}
          </article>
        {/each}
      </div>
    </section>

    {#if store.active?.kind === "organization"}
      <section class="panel invitations" aria-labelledby="pending-title">
        <div class="panel-heading">
          <div>
            <h2 id="pending-title">Pending invitations</h2>
            <p>Single-use links awaiting acceptance</p>
          </div>
          <EnvelopeSimple size={20} weight="duotone" aria-hidden="true" />
        </div>
        {#if invitations.filter((item) => !item.acceptedAt && !item.revokedAt).length === 0}
          <div class="empty">
            <EnvelopeSimple size={24} weight="duotone" aria-hidden="true" />
            <strong>No pending invitations</strong>
            <span>New invitations will appear here until accepted or revoked.</span>
          </div>
        {:else}
          <div class="rows">
            {#each invitations.filter((item) => !item.acceptedAt && !item.revokedAt) as invitation (invitation.id)}
              <article class="invite-row">
                <div>
                  <strong>{invitation.email}</strong>
                  <span>
                    {invitation.role} · expires {new Date(
                      invitation.expiresAt,
                    ).toLocaleDateString()}
                  </span>
                </div>
                {#if canManage}
                  <button
                    class="secondary danger-text"
                    type="button"
                    disabled={revokingId === invitation.id}
                    onclick={() => void revoke(invitation)}
                  >
                    {revokingId === invitation.id ? "Revoking…" : "Revoke"}
                  </button>
                {/if}
              </article>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  {/if}
</main>

{#if removeTarget}
  <div class="dialog-backdrop" role="presentation">
    <dialog
      open
      class="dialog"
      aria-labelledby="remove-title"
      aria-describedby="remove-description"
    >
      <div class="danger-icon">
        <Trash size={20} weight="duotone" aria-hidden="true" />
      </div>
      <h2 id="remove-title">Remove this member?</h2>
      <p id="remove-description">
        {removeTarget.email ?? "This member"} will immediately lose workspace access. Their
        historical activity and attribution will be preserved.
      </p>
      <div class="dialog-actions">
        <button class="secondary" type="button" onclick={() => (removeTarget = null)}
          >Cancel</button
        >
        <button class="danger-button" type="button" onclick={() => void removeMember()}
          >Remove member</button
        >
      </div>
    </dialog>
  </div>
{/if}

<style>
  .page {
    width: min(100% - 2.5rem, 72rem);
    margin: 0 auto;
    padding: 3.25rem 0 5rem;
  }

  .page-header,
  .panel-heading,
  .invite-heading,
  .member-row,
  .invite-row,
  .notice {
    display: flex;
    align-items: center;
  }

  .page-header,
  .panel-heading {
    justify-content: space-between;
  }

  .page-header {
    align-items: flex-end;
    margin-bottom: 1.5rem;
  }

  .eyebrow {
    margin: 0 0 0.45rem;
    color: var(--text-tertiary);
    font-size: 0.66rem;
    font-weight: 720;
    letter-spacing: 0.075em;
    text-transform: uppercase;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    font-size: clamp(1.65rem, 4vw, 2.15rem);
    font-weight: 640;
    letter-spacing: -0.035em;
  }

  h2 {
    font-size: 0.9rem;
  }

  .page-header p:last-child,
  .panel-heading p,
  .invite-heading p {
    margin-top: 0.35rem;
    color: var(--text-secondary);
    font-size: 0.75rem;
  }

  button {
    cursor: pointer;
  }

  .primary,
  .secondary,
  .danger-button {
    display: inline-flex;
    min-height: 2.3rem;
    gap: 0.45rem;
    align-items: center;
    justify-content: center;
    padding: 0 0.85rem;
    border-radius: 0.45rem;
    font-size: 0.76rem;
    font-weight: 650;
  }

  .primary {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--sp-color-surface);
  }

  .secondary {
    border: 1px solid var(--border);
    background: var(--surface-subtle);
    color: var(--text);
  }

  .danger-button {
    border: 1px solid var(--danger);
    background: var(--danger);
    color: var(--sp-color-surface);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .notice {
    gap: 0.5rem;
    margin-bottom: 1rem;
    padding: 0.75rem 0.9rem;
    border: 1px solid color-mix(in srgb, var(--success) 35%, var(--border));
    border-radius: 0.55rem;
    background: color-mix(in srgb, var(--success) 8%, var(--surface));
    color: var(--success);
    font-size: 0.77rem;
  }

  .notice button {
    display: grid;
    margin-left: auto;
    border: 0;
    background: transparent;
    color: inherit;
  }

  .invite-card,
  .panel {
    border: 1px solid var(--border);
    border-radius: 0.7rem;
    background: var(--surface);
  }

  .invite-card {
    margin-bottom: 1rem;
    padding: 1rem;
    box-shadow: 0 1rem 3rem var(--shadow);
  }

  .invite-heading {
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .invite-heading > div:nth-child(2) {
    flex: 1;
  }

  .icon,
  .avatar,
  .danger-icon {
    display: grid;
    place-items: center;
    border-radius: 0.5rem;
  }

  .icon {
    width: 2.25rem;
    height: 2.25rem;
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  form {
    display: grid;
    grid-template-columns: minmax(12rem, 1fr) 9rem auto;
    gap: 0.65rem;
    align-items: end;
  }

  label > span {
    display: block;
    margin-bottom: 0.35rem;
    color: var(--text-secondary);
    font-size: 0.7rem;
    font-weight: 620;
  }

  input,
  select {
    width: 100%;
    height: 2.3rem;
    border: 1px solid var(--border);
    border-radius: 0.45rem;
    outline: 0;
    background: var(--background);
    color: var(--text);
    padding: 0 0.65rem;
    font-size: 0.75rem;
  }

  input:focus,
  select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .form-error {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    margin-top: 0.7rem;
    color: var(--danger);
    font-size: 0.73rem;
  }

  .panel {
    overflow: hidden;
    margin-bottom: 1rem;
  }

  .panel-heading {
    padding: 1rem;
    border-bottom: 1px solid var(--border);
  }

  .rows {
    display: grid;
  }

  .member-row,
  .invite-row {
    min-height: 3.85rem;
    gap: 0.75rem;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--border);
  }

  .member-row:last-child,
  .invite-row:last-child {
    border-bottom: 0;
  }

  .avatar {
    width: 2rem;
    height: 2rem;
    background: var(--surface-subtle);
    color: var(--text-secondary);
    font-size: 0.7rem;
    font-weight: 720;
  }

  .identity,
  .invite-row > div {
    min-width: 0;
    flex: 1;
  }

  .identity strong,
  .identity span,
  .invite-row strong,
  .invite-row span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .identity strong,
  .invite-row strong {
    font-size: 0.75rem;
    font-weight: 620;
  }

  .identity span,
  .invite-row span {
    margin-top: 0.22rem;
    color: var(--text-tertiary);
    font-size: 0.67rem;
    text-transform: capitalize;
  }

  .member-row select {
    width: 7.5rem;
  }

  .icon-button {
    display: grid;
    width: 2rem;
    height: 2rem;
    place-items: center;
    border: 0;
    border-radius: 0.4rem;
    background: transparent;
    color: var(--text-secondary);
  }

  .icon-button:hover {
    background: var(--surface-subtle);
  }

  .icon-button.danger:hover,
  .danger-text {
    color: var(--danger);
  }

  .role {
    color: var(--text-secondary);
    font-size: 0.7rem;
    text-transform: capitalize;
  }

  .empty {
    display: grid;
    justify-items: center;
    padding: 2.5rem 1rem;
    color: var(--text-tertiary);
    text-align: center;
  }

  .empty strong {
    margin-top: 0.65rem;
    color: var(--text-secondary);
    font-size: 0.78rem;
  }

  .empty span {
    margin-top: 0.3rem;
    font-size: 0.7rem;
  }

  .skeleton {
    height: 3.8rem;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(
      90deg,
      var(--surface) 20%,
      var(--surface-subtle) 50%,
      var(--surface) 80%
    );
    background-size: 200% 100%;
    animation: shimmer 1.3s infinite linear;
  }

  .dialog-backdrop {
    position: fixed;
    z-index: 50;
    inset: 0;
    display: grid;
    padding: 1rem;
    place-items: center;
    background: rgba(0, 0, 0, 0.65);
  }

  .dialog {
    position: static;
    width: min(100%, 26rem);
    margin: 0;
    padding: 1.25rem;
    border: 1px solid var(--border-strong);
    border-radius: 0.75rem;
    background: var(--surface-raised);
    box-shadow: 0 2rem 6rem rgba(0, 0, 0, 0.4);
  }

  .danger-icon {
    width: 2.4rem;
    height: 2.4rem;
    margin-bottom: 0.9rem;
    background: var(--danger-soft);
    color: var(--danger);
  }

  .dialog h2 {
    font-size: 1rem;
  }

  .dialog p {
    margin-top: 0.55rem;
    color: var(--text-secondary);
    font-size: 0.76rem;
    line-height: 1.6;
  }

  .dialog-actions {
    display: flex;
    gap: 0.6rem;
    justify-content: flex-end;
    margin-top: 1.25rem;
  }

  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }

  @media (max-width: 760px) {
    .page {
      width: min(100% - 1.5rem, 72rem);
      padding-top: 1.5rem;
    }

    .page-header {
      display: grid;
      gap: 1rem;
      align-items: start;
    }

    .page-header .primary {
      width: max-content;
    }

    form {
      grid-template-columns: 1fr;
    }

    .member-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
    }

    .member-row select {
      grid-column: 2 / 3;
      width: 100%;
    }

    .member-row .danger {
      grid-row: 1;
      grid-column: 3;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton {
      animation: none;
    }
  }
</style>
