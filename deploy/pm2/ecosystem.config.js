// deploy/pm2/ecosystem.config.js - Phase 12 (item 5): process supervision
// via PM2, an alternative to systemd/Docker for a bare-metal/VM deployment.
//
// Same honesty note as deploy/docker-compose.yml and deploy/systemd/: ONE
// app to supervise (apps/api/src/index.ts already runs the API + worker +
// scheduler together) - `instances: 1` is deliberate, not an oversight. See
// docs/PHASE12_PRODUCTION.md "Database" for why this must stay at 1 unless
// PostgreSQL replaces SQLite (a single shared SQLite file is not safe for
// concurrent writers across multiple instances).
//
// Usage (from the repo root):
//   npx prisma migrate deploy --schema=database/schema.prisma
//   pm2 start deploy/pm2/ecosystem.config.js
//   pm2 save && pm2 startup   # so PM2 itself survives a host reboot
module.exports = {
  apps: [
    {
      name: "jarvis-api",
      script: "npm",
      args: "run start -w apps/api",
      cwd: __dirname + "/../..",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      // PM2's own crash-loop guard - a complement to, not a replacement
      // for, core/worker/watchdog.ts's in-process bounded restart/give-up
      // logic, which handles a HUNG (not crashed) tick loop that PM2 alone
      // cannot detect (the process is still alive from the OS's point of
      // view).
      min_uptime: "30s",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
