import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Allow Discord to embed pages in an iframe (Activity mode)
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "frame-ancestors 'self' https://discord.com https://*.discord.com https://*.discordsays.com",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
