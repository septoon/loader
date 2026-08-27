module.exports = {
  apps: [{
    name: 'loader',
    script: 'scripts/start-production.sh',
    interpreter: '/bin/bash',
    cwd: __dirname,
    autorestart: true,
    max_restarts: 8,
    min_uptime: '10s',
    restart_delay: 3_000,
    kill_timeout: 20_000,
    max_memory_restart: '650M',
    env: {
      NODE_ENV: 'production',
    },
  }, {
    name: 'loader-vlc',
    script: 'scripts/start-vlc-sftp.sh',
    interpreter: '/bin/bash',
    cwd: __dirname,
    autorestart: true,
    max_restarts: 8,
    min_uptime: '10s',
    restart_delay: 3_000,
    kill_timeout: 10_000,
    max_memory_restart: '180M',
    env: {
      NODE_ENV: 'production',
    },
  }],
}
