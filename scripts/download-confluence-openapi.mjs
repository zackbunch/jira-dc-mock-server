import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceUrl =
  "https://dac-static.atlassian.com/server/confluence/10.0.3.swagger.v3.json";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(
  projectRoot,
  "contracts/confluence-dc-10.0.3-openapi.json",
);
const checksumDestination = `${destination}.sha256`;
const temporaryDestination = `${destination}.tmp`;

const response = await fetch(sourceUrl, {
  headers: { Accept: "application/json" },
  redirect: "follow",
});
if (!response.ok) {
  throw new Error(
    `Unable to download Confluence OpenAPI contract: HTTP ${response.status}`,
  );
}

const content = await response.text();
const specification = JSON.parse(content);
if (specification.openapi !== "3.0.1") {
  throw new Error(`Unexpected OpenAPI version: ${specification.openapi ?? "missing"}`);
}
if (specification.info?.version !== "10.0.3") {
  throw new Error(
    `Unexpected Confluence version: ${specification.info?.version ?? "missing"}`,
  );
}
if (!specification.paths?.["/rest/api/content/{id}"]) {
  throw new Error("Downloaded contract does not contain the Confluence content endpoint");
}

await mkdir(dirname(destination), { recursive: true });
await writeFile(temporaryDestination, content, "utf8");
await rename(temporaryDestination, destination);

const checksum = createHash("sha256").update(content).digest("hex");
await writeFile(
  checksumDestination,
  `${checksum}  ${destination.split("/").at(-1)}\n`,
  "utf8",
);

console.log(
  JSON.stringify(
    {
      sourceUrl,
      destination,
      openapi: specification.openapi,
      confluenceVersion: specification.info.version,
      paths: Object.keys(specification.paths).length,
      schemas: Object.keys(specification.components?.schemas ?? {}).length,
      sha256: checksum,
    },
    null,
    2,
  ),
);
