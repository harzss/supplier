import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: repositoryRoot,
  transpilePackages: ['@supplier/shared-types'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'picsum.photos' }],
  },
};

export default nextConfig;
