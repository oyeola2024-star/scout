/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { cpus: 1 },
  turbopack: { root: process.cwd() },
  staticPageGenerationTimeout: 120,
  typescript: { ignoreBuildErrors: true },
  outputFileTracingIncludes: {
    '/api/classic': ['./legacy/scout-classic.html']
  }
};

export default nextConfig;
