module.exports = {
  apps: [{
    name: 'wallet-tracker',
    script: 'src/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
