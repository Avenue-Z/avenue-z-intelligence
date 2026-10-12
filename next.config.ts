import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir:process.env.AVENUE_BUILD_TARGET==='sites'?'.next':'.next-vercel',
  typescript:{tsconfigPath:process.env.AVENUE_BUILD_TARGET==='sites'?'tsconfig.json':'tsconfig.vercel.json'},
};

export default nextConfig;
