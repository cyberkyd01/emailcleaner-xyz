import { cp, mkdir } from 'node:fs/promises';

// tsc only emits JS; the static UI has to be copied into dist alongside it.
await mkdir('dist/src/web', { recursive: true });
await cp('src/web', 'dist/src/web', { recursive: true });
process.stdout.write('copied src/web -> dist/src/web\n');
