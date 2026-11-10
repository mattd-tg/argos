/**
 * Explicit bindings between Twingate Gateway subjects and Argos users.
 *
 * @param {import("knex").Knex} knex
 */
export const up = async (knex) => {
  await knex.schema.createTable("twingate_gateway_identities", (table) => {
    table.bigIncrements("id").primary();
    table.dateTime("createdAt").notNullable();
    table.dateTime("updatedAt").notNullable();
    table.text("tenantHost").notNullable();
    table.text("twingateUserId").notNullable();
    table.bigInteger("userId").notNullable();
    table.foreign("userId").references("users.id").onDelete("CASCADE");
    table.unique(["tenantHost", "twingateUserId"]);
    table.unique(["userId"]);
  });

  await knex.raw(
    `ALTER TABLE team_users DROP CONSTRAINT "team_users_lastAuthMethod_check"`,
  );
  await knex.raw(
    `ALTER TABLE team_users ADD CONSTRAINT "team_users_lastAuthMethod_check" CHECK ("lastAuthMethod" = ANY (ARRAY['email'::text, 'google'::text, 'github'::text, 'gitlab'::text, 'saml'::text, 'passkey'::text, 'twingate'::text]))`,
  );
};

/**
 * @param {import("knex").Knex} knex
 */
export const down = async (knex) => {
  await knex.raw(
    `UPDATE team_users SET "lastAuthMethod" = NULL WHERE "lastAuthMethod" = 'twingate'`,
  );
  await knex.raw(
    `ALTER TABLE team_users DROP CONSTRAINT "team_users_lastAuthMethod_check"`,
  );
  await knex.raw(
    `ALTER TABLE team_users ADD CONSTRAINT "team_users_lastAuthMethod_check" CHECK ("lastAuthMethod" = ANY (ARRAY['email'::text, 'google'::text, 'github'::text, 'gitlab'::text, 'saml'::text, 'passkey'::text]))`,
  );

  await knex.schema.dropTable("twingate_gateway_identities");
};
