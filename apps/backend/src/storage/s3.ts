import { S3Client } from "@aws-sdk/client-s3";
import { memoize } from "lodash-es";

import config from "@/config";

export type { S3Client } from "@aws-sdk/client-s3";

function getS3ClientBase(region: string = config.get("s3.region")) {
  const endpoint = config.get("s3.endpoint");
  return new S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: config.get("s3.forcePathStyle"),
  });
}

/**
 * Get the S3 client instance.
 */
export const getS3Client: typeof getS3ClientBase = memoize(getS3ClientBase);
