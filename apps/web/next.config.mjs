/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@supplier/shared-types'],
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
