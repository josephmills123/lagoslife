module.exports = {
  apps: [{
    name: 'lagoslife-test',
    script: 'index.js',
    instances: 1,
    autorestart: false,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      // PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium',
      // BASE_URL: 'https://lagoslife.app'
    }
  }]
};
