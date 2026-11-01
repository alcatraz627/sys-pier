// The service hub under pm2. Its port is pinned in the port ledger.
module.exports = {
  apps: [
    {
      name: 'service-hub',
      script: 'server.cjs',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 2000,
      env: { HUB_PORT: '3999' },
    },
  ],
};
