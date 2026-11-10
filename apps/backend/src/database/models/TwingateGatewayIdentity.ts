import type { RelationMappings } from "objection";

import { Model } from "../util/model";
import { timestampsSchema } from "../util/schemas";
import { User } from "./User";

export class TwingateGatewayIdentity extends Model {
  static override tableName = "twingate_gateway_identities";

  static override jsonSchema = {
    allOf: [
      timestampsSchema,
      {
        type: "object",
        required: ["tenantHost", "twingateUserId", "userId"],
        properties: {
          tenantHost: { type: "string" },
          twingateUserId: { type: "string" },
          userId: { type: "string" },
        },
      },
    ],
  };

  declare tenantHost: string;
  declare twingateUserId: string;
  declare userId: string;

  static override get relationMappings(): RelationMappings {
    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: "twingate_gateway_identities.userId",
          to: "users.id",
        },
      },
    };
  }

  user?: User;
}
