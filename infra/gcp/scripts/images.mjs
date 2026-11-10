import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ROOT } from "./lib.mjs";

const manifestPath = join(ROOT, "images.json");
const IMAGE_KEYS = [
  "CONNECTOR_IMAGE",
  "GATEWAY_IMAGE",
  "POSTGRES_IMAGE",
  "REDIS_IMAGE",
  "RABBITMQ_IMAGE",
  "NGINX_IMAGE",
];

export async function imageManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.platform !== "linux/amd64" ||
    !manifest.images ||
    Object.keys(manifest.images).length !== IMAGE_KEYS.length ||
    !IMAGE_KEYS.every(
      (key) =>
        typeof manifest.images[key] === "string" &&
        /^.+@sha256:[a-f0-9]{64}$/.test(manifest.images[key]),
    )
  ) {
    throw new Error("Invalid immutable image manifest");
  }
  return manifest;
}
