import { createServer } from 'vite';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const server = await createServer({
  configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true
  }
});

await server.listen();

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RENDERER_URL: 'http://127.0.0.1:1420'
  }
});

const shutdown = async (code = 0) => {
  await server.close();
  process.exit(code);
};

child.on('exit', (code) => shutdown(code ?? 0));
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
