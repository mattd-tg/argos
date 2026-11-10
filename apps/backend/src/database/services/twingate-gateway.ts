import { randomBytes } from "node:crypto";
import { ACCOUNT_NAME_MAX_LENGTH } from "@argos/schemas/account";
import type { TransactionOrKnex } from "objection";

import type { VerifiedGatewayIdentity } from "@/auth/twingate-gateway";
import { boom } from "@/util/error";

import { Account } from "../models/Account";
import { Project } from "../models/Project";
import { ProjectUser } from "../models/ProjectUser";
import { TeamUser } from "../models/TeamUser";
import { TwingateGatewayIdentity } from "../models/TwingateGatewayIdentity";
import { User } from "../models/User";
import { transaction } from "../transaction";
import { parseAccountName } from "./account";

export interface GatewayIdentityKey {
  tenantHost: string;
  twingateUserId: string;
}

export interface GatewayMappedUser {
  user: User;
  account: Account;
}

interface GatewayEnrollmentPolicy {
  teamAccountId: string;
  reviewerProjectIds: readonly string[];
}

const identityNotProvisioned = () =>
  boom(403, "Forbidden", { code: "GATEWAY_IDENTITY_NOT_PROVISIONED" });

class GatewayEnrollmentRaceLost extends Error {
  constructor() {
    super("Twingate Gateway identity claim lost");
  }
}

function getActiveUserWithPersonalAccount(
  user: User | null | undefined,
  account: Account | null | undefined,
): GatewayMappedUser | null {
  if (!user || !account) {
    return null;
  }
  const { deletedAt, type } = user;
  if (deletedAt !== null || type !== "user") {
    return null;
  }
  return { user, account };
}

async function findActiveUserWithPersonalAccount(
  userId: string,
  trx?: TransactionOrKnex,
): Promise<GatewayMappedUser> {
  const user = await User.query(trx)
    .findById(userId)
    .withGraphFetched("account");
  const mappedUser = getActiveUserWithPersonalAccount(user, user?.account);

  if (!mappedUser) {
    throw identityNotProvisioned();
  }

  return mappedUser;
}

/**
 * Resolves the explicit Gateway subject binding, while distinguishing an
 * absent binding from a binding whose Argos user graph is no longer valid.
 */
export async function findGatewayMappedUser(
  key: GatewayIdentityKey,
  trx?: TransactionOrKnex,
): Promise<GatewayMappedUser | null> {
  const identity = await TwingateGatewayIdentity.query(trx)
    .findOne(key)
    .withGraphFetched("user.account");
  if (!identity) {
    return null;
  }

  const mappedUser = getActiveUserWithPersonalAccount(
    identity.user,
    identity.user?.account,
  );
  if (!mappedUser) {
    throw identityNotProvisioned();
  }

  return mappedUser;
}

/**
 * Resolve the explicit Twingate subject binding to an active user and their
 * personal account. This lookup requires an existing binding and never creates
 * or repairs Argos data.
 */
export async function getGatewayMappedUser(
  key: GatewayIdentityKey,
): Promise<GatewayMappedUser> {
  const mappedUser = await findGatewayMappedUser(key);
  if (!mappedUser) {
    throw identityNotProvisioned();
  }
  return mappedUser;
}

interface EnrollGatewayIdentityProps {
  identity: VerifiedGatewayIdentity;
  policy: GatewayEnrollmentPolicy;
}

/**
 * Enroll a previously unseen Gateway identity without email linking,
 * invitations, profile reconciliation, or later grant reconciliation.
 */
export async function enrollGatewayIdentity(
  props: EnrollGatewayIdentityProps,
): Promise<GatewayMappedUser> {
  const { identity, policy } = props;
  const { tenantHost, subject: twingateUserId, email } = identity;
  const key = { tenantHost, twingateUserId };

  try {
    return await transaction(async (trx) => {
      const existing = await findGatewayMappedUser(key, trx);
      if (existing) {
        return existing;
      }

      const reviewerProjectIds = [...policy.reviewerProjectIds];
      const teamAccount = await Account.query(trx)
        .findById(policy.teamAccountId)
        .forShare();
      if (!teamAccount) {
        throw boom(503, "Service Unavailable");
      }
      const { id: teamAccountId, teamId } = teamAccount;
      if (teamId === null) {
        throw boom(503, "Service Unavailable");
      }

      const reviewerProjects = await Project.query(trx)
        .whereIn("id", reviewerProjectIds)
        .whereNull("deletedAt")
        .orderBy("id")
        .forShare();
      if (
        reviewerProjects.length !== reviewerProjectIds.length ||
        reviewerProjects.some((project) => project.accountId !== teamAccountId)
      ) {
        throw boom(503, "Service Unavailable");
      }

      const user = await User.query(trx).insert({
        email: null,
        staff: false,
        type: "user",
        deletedAt: null,
      });
      const now = new Date().toISOString();
      const claimed = await trx("twingate_gateway_identities")
        .insert({
          tenantHost,
          twingateUserId,
          userId: user.id,
          createdAt: now,
          updatedAt: now,
        })
        .onConflict(["tenantHost", "twingateUserId"])
        .ignore()
        .returning("id");
      if (claimed.length === 0) {
        throw new GatewayEnrollmentRaceLost();
      }

      const name =
        email === null
          ? `Twingate user ${user.id}`
          : parseAccountName(email.trim().slice(0, ACCOUNT_NAME_MAX_LENGTH));
      const account = await Account.query(trx).insert({
        userId: user.id,
        teamId: null,
        slug: `tg-${randomBytes(16).toString("hex")}`,
        name,
      });
      await TeamUser.query(trx).insert({
        teamId,
        userId: user.id,
        userLevel: "contributor",
      });
      await ProjectUser.query(trx).insert(
        reviewerProjects.map((project) => ({
          projectId: project.id,
          userId: user.id,
          userLevel: "reviewer" as const,
        })),
      );

      return { user, account };
    });
  } catch (error) {
    if (error instanceof GatewayEnrollmentRaceLost) {
      return getGatewayMappedUser(key);
    }
    throw error;
  }
}

interface ProvisionGatewayIdentityProps {
  tenantHost: string;
  twingateUserId: string;
  userId: string;
}

/**
 * Bind one already-valid Argos user to one Twingate subject. The binding is
 * read back after an insert-or-ignore so a racing or pre-existing conflicting
 * binding can never be reassigned.
 */
export async function provisionGatewayIdentity(
  props: ProvisionGatewayIdentityProps,
): Promise<TwingateGatewayIdentity> {
  const { tenantHost, twingateUserId, userId } = props;
  return transaction(async (trx) => {
    await findActiveUserWithPersonalAccount(userId, trx);

    await TwingateGatewayIdentity.query(trx)
      .insert({ tenantHost, twingateUserId, userId })
      .onConflict()
      .ignore();

    // userId is unique too, so a mapping for this subject that names this
    // user is also the user's only mapping.
    const mapping = await TwingateGatewayIdentity.query(trx).findOne({
      tenantHost,
      twingateUserId,
    });
    if (!mapping || mapping.userId !== userId) {
      throw new Error(
        "Twingate gateway identity is already bound to another user or subject.",
      );
    }

    return mapping;
  });
}
