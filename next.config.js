/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["sharp", "pdf-lib"]
  },
  async rewrites() {
    return [
      // ERC-8004 indexers and A2A clients probe these exact paths. They are
      // rewrites rather than `app/.well-known/...` route folders because a
      // leading dot makes Next skip the directory during route collection.
      { source: "/.well-known/agent-card.json", destination: "/api/agent-card" },
      { source: "/.well-known/agent.json", destination: "/api/agent-card" },
      { source: "/.well-known/agent-registration.json", destination: "/api/agent-registration" }
    ];
  }
};

module.exports = nextConfig;
