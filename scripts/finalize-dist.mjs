/**
 * finalize-dist.mjs — mark the ESM output directories as ES modules.
 *
 * The root package.json is `"type": "commonjs"`, so Node would treat the .js
 * files under dist/esm and dist/react as CommonJS and choke on their
 * import/export syntax. A nested package.json overrides the type for that
 * directory only; the CJS build at dist/ inherits the root type and needs no
 * marker.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const dist = path.join(import.meta.dirname, "..", "dist");

for (const name of ["esm", "react"]) {
  const dir = path.join(dist, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ type: "module" }, null, 2) + "\n",
  );
  console.log(`[dist] wrote dist/${name}/package.json ({ "type": "module" })`);
}
