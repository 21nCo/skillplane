<script lang="ts">
  import { apiRequest, jsonBody, SkillplaneApiError } from "$lib/api/client.js";
  import {
    useWorkspaceStore,
    type WorkspaceRole,
  } from "$lib/workspaces/store.svelte.js";
  import {
    Button,
    Dialog,
    EmptyState,
    ErrorState,
    IconButton,
    Input,
    Select,
    Skeleton,
  } from "@skillplane/ui";
  import {
    CheckCircleIcon as CheckCircle,
    EnvelopeSimpleIcon as EnvelopeSimple,
    TrashIcon as Trash,
    UserPlusIcon as UserPlus,
    UsersThreeIcon as UsersThree,
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
  const inviteRoleOptions = [
    { value: "viewer", label: "Viewer" },
    { value: "editor", label: "Editor" },
    { value: "admin", label: "Admin" },
  ] as const;
  const memberRoleOptions = $derived(
    store.active?.role === "owner"
      ? [...inviteRoleOptions, { value: "owner", label: "Owner" }]
      : [...inviteRoleOptions],
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
    if (!workspaceId || sending) return;
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
    if (!workspaceId || revokingId) return;
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
      <Button variant="primary" onclick={() => (inviteOpen = true)}>
        {#snippet leading()}<UserPlus size={16} weight="bold" />{/snippet}
        Invite member
      </Button>
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
        <IconButton label="Close invitation form" onclick={() => (inviteOpen = false)}>
          <X size={16} weight="bold" />
        </IconButton>
      </div>
      <form class="invite-form" onsubmit={invite}>
        <div class="field">
          <Input
            label="Email address"
            type="email"
            required
            maxlength={254}
            autocomplete="email"
            placeholder="teammate@company.com"
            bind:value={inviteEmail}
            error={inviteError ?? undefined}
          />
        </div>
        <div class="field">
          <Select label="Role" options={inviteRoleOptions} bind:value={inviteRole} />
        </div>
        <Button type="submit" variant="primary" loading={sending} disabled={sending}>
          Send invitation
        </Button>
      </form>
    </section>
  {/if}

  {#if loading}
    <section class="panel" aria-label="Loading workspace members" aria-busy="true">
      <Skeleton height="3.8rem" />
      <Skeleton height="3.8rem" />
      <Skeleton height="3.8rem" />
    </section>
  {:else if error}
    <ErrorState
      title="Member access could not be loaded"
      description={error}
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
              <div class="role-field">
                <Select
                  label="Role"
                  options={memberRoleOptions}
                  value={member.role}
                  aria-label={`Role for ${member.email ?? member.userId}`}
                  onchange={(event) =>
                    void changeRole(
                      member.userId,
                      event.currentTarget.value as WorkspaceRole,
                    )}
                />
              </div>
              <IconButton
                variant="danger"
                label={`Remove ${member.email ?? "member"}`}
                onclick={() => (removeTarget = member)}
              >
                <Trash size={15} weight="bold" />
              </IconButton>
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
          <div class="empty-wrap">
            <EmptyState
              compact
              title="No pending invitations"
              description="New invitations will appear here until accepted or revoked."
            >
              {#snippet icon()}<EnvelopeSimple size={24} weight="duotone" />{/snippet}
            </EmptyState>
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
                  <Button
                    size="sm"
                    loading={revokingId === invitation.id}
                    disabled={revokingId === invitation.id}
                    onclick={() => void revoke(invitation)}
                  >
                    Revoke
                  </Button>
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
  <Dialog
    open
    title="Remove this member?"
    onOpenChange={(open) => {
      if (!open) removeTarget = null;
    }}
  >
    <p class="dialog-copy">
      {removeTarget.email ?? "This member"} will immediately lose workspace access. Their
      historical activity and attribution will be preserved.
    </p>
    {#snippet footer()}
      <Button onclick={() => (removeTarget = null)}>Cancel</Button>
      <Button variant="danger" onclick={() => void removeMember()}>Remove member</Button
      >
    {/snippet}
  </Dialog>
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
  .avatar {
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

  .invite-form {
    display: grid;
    grid-template-columns: minmax(12rem, 1fr) 9rem auto;
    gap: 0.65rem;
    align-items: end;
  }

  .field,
  .role-field {
    min-width: 0;
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

  .role-field {
    width: 7.5rem;
  }

  .role {
    color: var(--text-secondary);
    font-size: 0.7rem;
    text-transform: capitalize;
  }

  .empty-wrap {
    padding: 0.75rem;
  }

  .dialog-copy {
    color: var(--text-secondary);
    font-size: 0.76rem;
    line-height: 1.6;
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

    .invite-form {
      grid-template-columns: 1fr;
    }

    .member-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
    }

    .member-row .role-field {
      grid-column: 2 / 3;
      width: 100%;
    }

    .member-row :global(button[data-variant="danger"]) {
      grid-row: 1;
      grid-column: 3;
    }
  }
</style>
