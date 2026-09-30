// Tree Studio dev server (npm run studio): root src/studio, the library from
// source, the resolved upstream textures (npm run fetch:textures) at
// /textures/, and the game export endpoints (scripts/game-endpoint.mjs).
// DEINTERLEAVER_GAME_ROOT picks the game checkout the exports go to.
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { CACHE_ROOT } from './scripts/texture-paths.mjs';
import { gameEndpoint, treesRoot } from './scripts/game-endpoint.mjs';

const TYPES = { '.jpg': 'image/jpeg', '.png': 'image/png', '.md': 'text/plain' };

function studioServer() {
  const serve = (server) => {
    server.middlewares.use('/textures', (req, res, next) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.resolve(CACHE_ROOT, `.${rel}`);
      if (!file.startsWith(CACHE_ROOT + path.sep) || !existsSync(file) || !statSync(file).isFile()) return next();
      res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
      createReadStream(file).pipe(res);
    });
    server.middlewares.use(gameEndpoint({ root: treesRoot() }));
  };
  return { name: 'deinterleaver-studio', configureServer: serve, configurePreviewServer: serve };
}

/** @type {import('vite').UserConfig} */
export default {
  root: path.resolve(__dirname, 'src/studio'),
  resolve: {
    alias: { '@dgreenheck/ez-tree': path.resolve(__dirname, 'src/lib/index.js') },
  },
  server: {
    port: 5200,
    fs: { allow: [__dirname] },
  },
  plugins: [studioServer()],
};
