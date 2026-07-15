/**
 * finalize-dist.mjs — mark dist/esm as ES modules.
 *
 * The root package.json is `"type": "commonjs"`, so Node would treat the .js
 * files under dist/esm as CommonJS and choke on their import/export syntax.
 * A nested package.json overrides the type for that directory only; the CJS
 * build at dist/ inherits the root type and needs no marker.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const esmDir = path.join(import.meta.dirname, "..", "dist", "esm");
fs.mkdirSync(esmDir, { recursive: true });
fs.writeFileSync(
  path.join(esmDir, "package.json"),
  JSON.stringify({ type: "module" }, null, 2) + "\n",
);
console.log('[dist] wrote dist/esm/package.json ({ "type": "module" })');
