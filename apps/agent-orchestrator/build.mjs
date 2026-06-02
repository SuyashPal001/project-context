import * as esbuild from 'esbuild'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

async function findTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts'))
    .map(e => join(e.parentPath, e.name))
    .filter(f => !f.includes('__tests__'))
}

const entryPoints = await findTsFiles('./src')

await esbuild.build({
  entryPoints,
  outdir: 'dist',
  outbase: 'src',
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  bundle: false,
})

console.log(`✓ Built ${entryPoints.length} files`)
