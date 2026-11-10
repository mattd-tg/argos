import { beforeEach, describe, expect, it } from "vitest";

import { knex } from "@/database/knex";
import { Account, Plan, Project, TeamUser } from "@/database/models";
import { setupDatabase } from "@/database/testing";

import { bootstrapSelfHost, type SelfHostBootstrapResult } from "./bootstrap";

beforeEach(async () => {
  await setupDatabase();
});

describe("self-host bootstrap", () => {
  it("creates one initial graph across concurrent calls and replays", async () => {
    const poolConfig = knex.client.config.pool;
    if (!poolConfig) {
      throw new Error("Expected Knex pool configuration");
    }
    const originalPoolMax = poolConfig.max;
    poolConfig.max = 3;
    await knex.destroy();
    knex.client.initializePool();

    const input = {
      email: "administrator@example.test",
      name: "Argos administrator",
    };
    let credentials: SelfHostBootstrapResult;
    try {
      const results = await Promise.all([
        bootstrapSelfHost(input),
        bootstrapSelfHost(input),
        bootstrapSelfHost(input),
      ]);
      [credentials] = results;
      expect(results).toEqual([credentials, credentials, credentials]);
    } finally {
      await knex.destroy();
      poolConfig.max = originalPoolMax;
      knex.client.initializePool();
    }

    const { userId, teamAccountId, projectId } = credentials;
    await expect(bootstrapSelfHost(input)).resolves.toEqual(credentials);

    const { teamId, forcedPlanId } = await Account.query()
      .findById(teamAccountId)
      .throwIfNotFound();
    if (!teamId || !forcedPlanId) {
      throw new Error("Bootstrap did not create a team with a forced plan");
    }
    const plan = await Plan.query().findById(forcedPlanId).throwIfNotFound();
    expect(plan.fineGrainedAccessControlIncluded).toBe(true);
    await expect(
      TeamUser.query().findOne({ teamId, userId, userLevel: "owner" }),
    ).resolves.toBeTruthy();
    await expect(
      Project.query()
        .where({ accountId: teamAccountId })
        .whereNull("deletedAt")
        .select("id"),
    ).resolves.toEqual([{ id: projectId }]);

    await Project.query().findById(projectId).patch({
      defaultBaseBranch: "release",
    });
    await expect(bootstrapSelfHost(input)).resolves.toEqual(credentials);
    await expect(Project.query().findById(projectId)).resolves.toMatchObject({
      defaultBaseBranch: "release",
    });
  });
});
