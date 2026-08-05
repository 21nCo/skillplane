import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { createMDX } from "fumadocs-mdx/next";

initOpenNextCloudflareForDev();

/** @type {import('next').NextConfig} */
const config = {
  basePath: "/docs",
  reactStrictMode: true,
  poweredByHeader: false,
};

const withMDX = createMDX({ agentRules: false });

export default withMDX(config);
