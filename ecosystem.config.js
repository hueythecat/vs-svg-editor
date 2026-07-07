module.exports = {
  apps: [
    {
      name: "vs-svg-editor",
      script: "node_modules/.bin/expo",
      args: "start --web --port 8081",
      cwd: __dirname,
      interpreter: "none",
      env: {
        // pm2 runs without a TTY, so Expo is already non-interactive. Avoid CI=1
        // here — in CI mode Metro disables file-watching/HMR, so saved edits never
        // rebuild. BROWSER=none stops Expo auto-opening a browser tab on (re)start.
        BROWSER: "none",
        EXPO_NO_TELEMETRY: "1",
      },
      // Metro can be memory-hungry; restart if it balloons
      max_memory_restart: "1G",
      // Give Metro time to boot before pm2 considers it "online"
      min_uptime: "20s",
      max_restarts: 10,
      autorestart: true,
    },
  ],
};
