import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const staticExport = process.env.WEB_BUILD_TARGET === 'static';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: staticExport ? 'export' : 'standalone',
  ...(!staticExport && { outputFileTracingRoot: repositoryRoot }),
  transpilePackages: ['@supplier/shared-types'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'picsum.photos' }],
  },
};

export default nextConfig;
