import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { migrateDatabase } from "../../../db/src/migrate.js";
import { seedTenantFixture } from "../../../testing/src/fixtures.js";
import { SkillGroupService } from "../../src/skill-groups.js";
import { SkillService } from "../../src/skills.js";
import { SkillSearchService } from "../../src/search.js";
import { R2BundleRepository } from "@skillplane/storage";
import { TestObjectStorage } from "../../../testing/src/runtime.js";
import type { Principal } from "../../src/principal.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("workspace skill groups", () => {
  const pool = new Pool({ connectionString: url, max: 4 }),
    groups = new SkillGroupService(pool);
  let owner: Principal, other: Principal, skillId: string, otherSkillId: string;
  const mutation = () => ({
    principal: owner,
    requestId: crypto.randomUUID(),
    fencingEpoch: 1,
  });
  beforeAll(async () => {
    await migrateDatabase(url ?? "");
    const a = await seedTenantFixture(url ?? "", `groups-a-${crypto.randomUUID()}`),
      b = await seedTenantFixture(url ?? "", `groups-b-${crypto.randomUUID()}`);
    owner = {
      kind: "user",
      role: "owner",
      actorId: a.userId,
      userId: a.userId,
      sessionId: "s",
      workspaceId: a.workspaceId,
    };
    other = {
      ...owner,
      actorId: b.userId,
      userId: b.userId,
      workspaceId: b.workspaceId,
    };
    skillId = a.skillId;
    otherSkillId = b.skillId;
  }, 60000);
  afterAll(() => pool.end());
  it("keeps assignments idempotent, tenant isolated, archived and audited", async () => {
    const key = crypto.randomUUID();
    const [g, replay] = await Promise.all([
      groups.create({ ...mutation(), name: "Design", idempotencyKey: key }),
      groups.create({ ...mutation(), name: "Design", idempotencyKey: key }),
    ]);
    expect(replay.id).toBe(g.id);
    await expect(
      groups.create({ ...mutation(), name: "Marketing", idempotencyKey: key }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(
      groups.create({
        ...mutation(),
        name: "design",
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await groups.association({
      ...mutation(),
      groupId: g.id,
      kind: "skill",
      targetId: skillId,
      add: true,
    });
    expect(
      await groups.association({
        ...mutation(),
        groupId: g.id,
        kind: "skill",
        targetId: skillId,
        add: true,
      }),
    ).toEqual({ changed: false });
    await groups.association({
      ...mutation(),
      groupId: g.id,
      kind: "member",
      targetId: owner.actorId,
      add: true,
    });
    expect((await groups.members(owner, g.id)).members).toHaveLength(1);
    await pool.query(
      "DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
      [owner.workspaceId, owner.actorId],
    );
    expect((await groups.members(owner, g.id)).members[0]?.role).toBe("removed");
    await groups.association({
      ...mutation(),
      groupId: g.id,
      kind: "member",
      targetId: owner.actorId,
      add: false,
    });
    await pool.query(
      "INSERT INTO workspace_memberships(id,workspace_id,user_id,role) VALUES($1,$2,$3,'owner')",
      [`membership:${crypto.randomUUID()}`, owner.workspaceId, owner.actorId],
    );
    await groups.association({
      ...mutation(),
      groupId: g.id,
      kind: "member",
      targetId: owner.actorId,
      add: true,
    });

    await expect(
      groups.association({
        ...mutation(),
        groupId: g.id,
        kind: "skill",
        targetId: otherSkillId,
        add: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      groups.association({
        ...mutation(),
        groupId: g.id,
        kind: "member",
        targetId: other.actorId,
        add: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(groups.get(other, g.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const storage = new R2BundleRepository(new TestObjectStorage());
    const skills = new SkillService(pool, storage, pool);
    expect(
      (
        await skills.listPage({
          workspaceId: owner.workspaceId,
          principal: owner,
          groupId: g.id,
        })
      ).skills.map((s) => s.id),
    ).toContain(skillId);
    const search = new SkillSearchService(pool, "a".repeat(40), pool);
    expect(
      (
        await search.search({ query: "review", principal: owner, groupId: g.id })
      ).skills.map((s) => s.id),
    ).toContain(skillId);
    expect((await groups.skills(owner, g.id)).skills[0]?.id).toBe(skillId);
    const archived = await groups.update({
      ...mutation(),
      groupId: g.id,
      expectedRevision: g.revision,
      name: g.name,
      description: g.description,
      archived: true,
    });
    expect((await groups.list(owner)).groups).toHaveLength(0);
    expect((await groups.list(owner, { archived: true })).groups).toHaveLength(1);
    expect(
      (
        await skills.listPage({
          workspaceId: owner.workspaceId,
          principal: owner,
          groupId: g.id,
        })
      ).skills,
    ).toHaveLength(0);
    await expect(
      groups.association({
        ...mutation(),
        groupId: g.id,
        kind: "skill",
        targetId: skillId,
        add: false,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      groups.update({
        ...mutation(),
        groupId: g.id,
        expectedRevision: g.revision,
        name: g.name,
        archived: false,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await groups.update({
      ...mutation(),
      groupId: g.id,
      expectedRevision: archived.revision,
      name: g.name,
      description: g.description,
      archived: false,
    });
    expect((await groups.members(owner, g.id)).members).toHaveLength(1);
    await pool.query(
      "DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
      [owner.workspaceId, owner.actorId],
    );
    expect((await groups.members(owner, g.id)).members[0]?.role).toBe("removed");
    await groups.association({
      ...mutation(),
      groupId: g.id,
      kind: "member",
      targetId: owner.actorId,
      add: false,
    });
    await pool.query(
      "INSERT INTO workspace_memberships(id,workspace_id,user_id,role) VALUES($1,$2,$3,'owner')",
      [`membership:${crypto.randomUUID()}`, owner.workspaceId, owner.actorId],
    );
    await groups.association({
      ...mutation(),
      groupId: g.id,
      kind: "member",
      targetId: owner.actorId,
      add: true,
    });

    await groups.association({
      ...mutation(),
      groupId: g.id,
      kind: "skill",
      targetId: skillId,
      add: false,
    });
    expect(
      await groups.association({
        ...mutation(),
        groupId: g.id,
        kind: "skill",
        targetId: skillId,
        add: false,
      }),
    ).toEqual({ changed: false });
    const audit = await pool.query(
      "SELECT event_type FROM audit_events WHERE workspace_id=$1 AND resource_id=$2",
      [owner.workspaceId, g.id],
    );
    expect(audit.rows.map((r) => r.event_type)).toContain("skill_group.member.added");
    expect(
      audit.rows.filter((r) => r.event_type === "skill_group.skill.added"),
    ).toHaveLength(1);
  });
  it("fences writes during migration and retains ungrouped skills", async () => {
    await pool.query(
      "INSERT INTO regional_workspace_migration_fences(workspace_id,source_epoch) VALUES($1,1) ON CONFLICT(workspace_id) DO UPDATE SET source_epoch=1",
      [owner.workspaceId],
    );
    try {
      await expect(
        groups.create({
          ...mutation(),
          name: "Fenced",
          idempotencyKey: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await pool.query(
        "UPDATE regional_workspace_migration_fences SET source_epoch=0 WHERE workspace_id=$1",
        [owner.workspaceId],
      );
    }
    const storage = new R2BundleRepository(new TestObjectStorage());
    expect(
      (
        await new SkillService(pool, storage, pool).listPage({
          workspaceId: other.workspaceId,
          principal: other,
        })
      ).skills.map((s) => s.id),
    ).toContain(otherSkillId);
  });
});
