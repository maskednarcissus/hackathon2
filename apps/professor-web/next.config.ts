import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@ci/ui', '@ci/types'],
};

export default nextConfig;
