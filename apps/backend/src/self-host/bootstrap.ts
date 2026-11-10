import type { TransactionOrKnex } from "objection";

import {
  Account,
  Plan,
  Project,
  Team,
  TeamUser,
  User,
  UserEmail,
} from "@/database/models";
import { transaction } from "@/database/transaction";
import { getSlugFromEmail, sanitizeEmail } from "@/util/email";

const INITIALIZATION_LOCK_KEY = "self-host-bootstrap:argos:screenshots";
const INITIAL_TEAM_ACCOUNT_NAME = "Argos";
const INITIAL_TEAM_ACCOUNT_SLUG = "argos";
const INITIAL_PLAN_NAME = "self-hosted";
const INITIAL_PROJECT_NAME = "screenshots";

export interface SelfHostBootstrapResult {
  userId: string;
  teamAccountId: string;
  projectId: string;
}

function bootstrapStateError(): Error {
  return new Error(
    "Self-host bootstrap state is incomplete or belongs to a different operator",
  );
}

async function readBootstrapState(
  email: string,
  trx: TransactionOrKnex,
): Promise<SelfHostBootstrapResult | null> {
  const userEmail = await UserEmail.query(trx).findOne({ email }).forUpdate();
  const teamAccount = await Account.query(trx)
    .findOne({ slug: INITIAL_TEAM_ACCOUNT_SLUG })
    .forUpdate();

  if (!userEmail && !teamAccount) {
    return null;
  }

  if (!userEmail || !teamAccount) {
    throw bootstrapStateError();
  }
  const { verified, userId } = userEmail;
  const { teamId, forcedPlanId, id: teamAccountId } = teamAccount;
  if (!verified || teamId === null || forcedPlanId === null) {
    throw bootstrapStateError();
  }

  const personalAccount = await Account.query(trx).findOne({ userId });
  const membership = await TeamUser.query(trx).findOne({
    teamId,
    userId,
    userLevel: "owner",
  });
  const project = await Project.query(trx)
    .where({
      accountId: teamAccountId,
      name: INITIAL_PROJECT_NAME,
    })
    .whereNull("deletedAt")
    .first();

  if (!personalAccount || !membership || !project) {
    throw bootstrapStateError();
  }

  return { userId, teamAccountId, projectId: project.id };
}

interface CreateBootstrapStateProps {
  email: string;
  name: string;
  trx: TransactionOrKnex;
}

async function createBootstrapState(
  props: CreateBootstrapStateProps,
): Promise<SelfHostBootstrapResult> {
  const { email, name, trx } = props;
  const user = await User.query(trx).insertAndFetch({ email });
  await UserEmail.query(trx).insert({
    email,
    userId: user.id,
    verified: true,
  });
  await Account.query(trx).insert({
    userId: user.id,
    name,
    slug: getSlugFromEmail(email),
  });

  // A self-hosted install has no plan to upgrade to, so a flat-rate cap would
  // eventually reject every CI build with a 402. This is the column's maximum.
  const plan = await Plan.query(trx).insertAndFetch({
    name: INITIAL_PLAN_NAME,
    includedScreenshots: 2_147_483_647,
    usageBased: false,
    interval: "month",
    fineGrainedAccessControlIncluded: true,
  });
  const team = await Team.query(trx).insertAndFetch({
    defaultUserLevel: "member",
  });
  const teamAccount = await Account.query(trx).insertAndFetch({
    teamId: team.id,
    forcedPlanId: plan.id,
    name: INITIAL_TEAM_ACCOUNT_NAME,
    slug: INITIAL_TEAM_ACCOUNT_SLUG,
  });
  await TeamUser.query(trx).insert({
    userId: user.id,
    teamId: team.id,
    userLevel: "owner",
  });
  const project = await Project.query(trx).insertAndFetch({
    name: INITIAL_PROJECT_NAME,
    token: Project.generateToken(),
    private: true,
    accountId: teamAccount.id,
  });

  return {
    userId: user.id,
    teamAccountId: teamAccount.id,
    projectId: project.id,
  };
}

interface BootstrapSelfHostProps {
  email: string;
  name: string;
}

export async function bootstrapSelfHost(
  props: BootstrapSelfHostProps,
): Promise<SelfHostBootstrapResult> {
  const { email: rawEmail, name: rawName } = props;
  const email = sanitizeEmail(rawEmail);
  const name = rawName.trim();
  if (!name) {
    throw new Error("Bootstrap operator name is required");
  }

  return transaction(async (trx) => {
    await trx.raw("select pg_advisory_xact_lock(hashtext(?))", [
      INITIALIZATION_LOCK_KEY,
    ]);

    return (
      (await readBootstrapState(email, trx)) ??
      createBootstrapState({ email, name, trx })
    );
  });
}
