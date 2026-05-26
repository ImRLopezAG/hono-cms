/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: false
  },
  transpilePackages: [
    "@hono-cms/core",
    "@hono-cms/schema",
    "@hono-cms/platform",
    "@hono-cms/adapter-memory",
    "@hono-cms/storage-memory",
    "@hono-cms/cache",
    "@hono-cms/jobs"
  ]
};

export default nextConfig;
