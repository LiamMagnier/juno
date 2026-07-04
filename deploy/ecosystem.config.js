module.exports = {
  apps: [
    {
      name: "juno-backend",
      script: "npm",
      args: "run start",
      watch: false,
      max_memory_restart: "800M", // Automatically restart if memory exceeds 800MB (safe for 1GB AMD or ARM VM shapes)
      env: {
        PORT: 3000,
        NODE_ENV: "production",
      },
      error_file: "logs/err.log",
      out_file: "logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
  ],
};
