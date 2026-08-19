// Secrets live in mcp-server/.env — start.sh sources it before exec.
// To restart after env changes: pm2 restart mcp-server-pc --update-env
module.exports = {
  apps: [
    {
      name: "mcp-server-pc",
      script: "start.sh",
      interpreter: "bash",
      cwd: __dirname,
    },
  ],
};
