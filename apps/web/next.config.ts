import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Allow Discord to embed the Activity page in an iframe
        source: "/activity",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "frame-ancestors https://discord.com https://*.discord.com https://*.discordsays.com",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
