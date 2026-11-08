import { resolve } from 'node:path';
import type { NextConfig } from 'next';

const API = `http://127.0.0.1:${process.env.STUDIO_API_PORT ?? 4310}`;

const config: NextConfig = {
  // The repo root, so Next doesn't guess from lockfiles.
  turbopack: { root: resolve(import.meta.dirname, '../..') },
  // The UI only talks to the studio server. Proxying keeps everything on one origin.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
};

export default config;
