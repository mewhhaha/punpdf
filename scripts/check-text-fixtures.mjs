import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(scriptsDir, '../test/fixtures')
const generatedFixturesDir = mkdtempSync(join(tmpdir(), 'punpdf-fixtures-'))

try {
  const generation = spawnSync(
    process.execPath,
    [join(scriptsDir, 'generate-text-fixtures.mjs'), generatedFixturesDir],
    { stdio: 'inherit' },
  )
  if (generation.error) {
    throw generation.error
  }
  if (generation.status !== 0) {
    throw new Error(`fixture generator exited with status ${generation.status}`)
  }

  for (const filename of readdirSync(generatedFixturesDir)) {
    const generatedFixture = readFileSync(join(generatedFixturesDir, filename))
    let committedFixture
    try {
      committedFixture = readFileSync(join(fixturesDir, filename))
    }
    catch (error) {
      throw new Error(`generated fixture "${filename}" is not committed`, { cause: error })
    }
    if (!generatedFixture.equals(committedFixture)) {
      throw new Error(`fixture "${filename}" is stale; run node scripts/generate-text-fixtures.mjs`)
    }
  }
}
finally {
  rmSync(generatedFixturesDir, { recursive: true })
}

console.log('verified generated text fixtures')
