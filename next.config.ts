/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  // Next.js Image component needs this for static exports
  images: {
    unoptimized: true,
  },
};

export default nextConfig;