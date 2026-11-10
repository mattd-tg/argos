import config from "@/config";
import { boom } from "@/util/error";

/** Refuse native sign-in and account-linking flows while Gateway owns identity. */
export function assertNativeLoginAllowed(): void {
  if (config.get("twingate.gateway.enabled")) {
    throw boom(403, "Authentication is managed by Twingate", {
      code: "GATEWAY_MANAGED_AUTH",
    });
  }
}
