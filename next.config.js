/** @type {import('import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  typescript: {
    // 🟢 يتجاهل أخطاء الـ TypeScript أثناء بناء الموقع للنشر
    ignoreBuildErrors: true,
  },
  eslint: {
    // 🟢 يتجاهل أخطاء الـ ESLint والمتغيرات غير المستخدمة أثناء بناء الموقع للنشر
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
