module.exports = {
  apps: [
    {
      name: "claude-deepseek-proxy",
      script: "proxy/server.js",
      cwd: __dirname,
      // Restart if it crashes or runs out of memory
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      // Logging
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      merge_logs: true,
      // Process metadata
      env: {
        NODE_ENV: "production",
      },
      // Graceful shutdown: PM2 sends SIGINT; server drains in-flight
      // streams for up to 15s (see proxy/server.js), then exits itself.
      // Give it headroom before PM2 escalates to SIGKILL.
      kill_timeout: 20000,
      // Don't restart too fast to avoid crash loops
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
