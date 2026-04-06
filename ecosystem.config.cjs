// pm2 ecosystem config — pm2 Manager Dashboard
// Port: 5042 (backend-only, serves dashboard HTML + API)
module.exports = {
  apps: [
    {
      name: 'pm2-manage-backend',
      script: 'server.cjs',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 2000,
      env: {
        NODE_ENV: 'development',
        PORT_BACKEND: '5042',
      },
    },
  ],
};
