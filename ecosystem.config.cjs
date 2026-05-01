// pm2 ecosystem config — sys-pier dashboard
// Port: 5042 (backend-only, serves dashboard HTML + API)
module.exports = {
  apps: [
    {
      name: 'sys-pier-backend',
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
