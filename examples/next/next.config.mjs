/**
 * next.config.mjs — dev/build config for the Next.js example.
 *
 * `rtsp-streamer` is linked from the repo via `file:../..` (a symlink). If
 * webpack resolves that symlink to the repo's real path, the package's compiled
 * `import "react"` would resolve to a *second* React under the repo root and
 * break rendering (null dispatcher / "Invalid hook call"). Keeping symlinks
 * unresolved makes the package resolve React from *this* app's node_modules —
 * a single copy — without disturbing Next's own react-server resolution.
 *
 * This block is example-only. In a real app you `npm i rtsp-streamer` and none
 * of it is needed.
 *
 * @type {import('next').NextConfig}
 */
export default {
  webpack: (config) => {
    config.resolve.symlinks = false;
    return config;
  },
};
