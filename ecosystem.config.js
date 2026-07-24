module.exports = {
  apps: [{
    name: 'wallet-tracker',
    script: 'src/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    restart_delay: 3000,
    exp_backoff_restart_delay: 100,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
