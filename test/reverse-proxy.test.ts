import { beforeAll, describe, expect, it } from 'bun:test'

describe('@stacksjs/reverse-proxy', () => {
  beforeAll(() => {
    process.env.APP_ENV = 'test'
  })

  it('should work', async () => {
    expect(true).toBe(true)
  })
})
