/**
 * TEMPORARY — #2267 diagnostic, standalone file. Not for merge.
 *
 * `bun test` orders files deterministically but not alphabetically; this one
 * lands at position 38 of 48, fifteen files after `gateway.test.ts` (23), so it
 * answers "does the failing shape hang from a parent with the graph loaded, at
 * a LATER point in the suite?" The in-situ copy of the same sweep inside
 * `gateway.test.ts` answers it at the position where the hang was recorded.
 * Both import the rpx graph on purpose. The test always passes; the log is the
 * result, every line prefixed `[2267-diag]`.
 */
import { describe, expect, it } from 'bun:test'
import * as path from 'node:path'
import { readGatewayFragments } from '../src/gateway'
import * as Start from '../src/start'
import { envDump, runSweep, say } from './helpers/spawn-diag'

const CLI = path.join(import.meta.dir, '..', 'bin', 'cli.ts')

describe('2267 diagnostic (standalone file)', () => {
  it('records how each spawn variant of the CLI behaves here', async () => {
    envDump()
    say('parent graph loaded:', typeof Start.startProxies, typeof readGatewayFragments)
    const results = await runSweep(CLI, 'standalone')
    expect(results).toHaveLength(8)
  }, 200_000)
})
