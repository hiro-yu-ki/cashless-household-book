import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const out=join(process.cwd(),'dist');await mkdir(out,{recursive:true});await cp('public',join(out,'public'),{recursive:true,force:true});await cp('src',join(out,'src'),{recursive:true,force:true});await cp('migrations',join(out,'migrations'),{recursive:true,force:true});
const manifest=JSON.parse(await readFile('public/manifest.webmanifest','utf8'));await writeFile(join(out,'build-meta.json'),JSON.stringify({builtAt:new Date().toISOString(),name:manifest.name,worker:'src/worker/index.js'},null,2));console.log('Build complete: dist/');
