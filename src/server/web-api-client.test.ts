import assert from 'node:assert/strict'
import test from 'node:test'
import { mutateJob } from '../web/api.js'

test('pause and cancel requests do not declare an empty JSON body', async () => {
  const originalFetch = globalThis.fetch
  const requests: RequestInit[] = []
  globalThis.fetch = async (_input, init) => {
    requests.push(init ?? {})
    return new Response(JSON.stringify({ job: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await mutateJob('job-id', 'pause')
    await mutateJob('job-id', 'cancel')
    assert.equal(requests.length, 2)
    for (const request of requests) {
      assert.equal(new Headers(request.headers).has('Content-Type'), false)
      assert.equal(request.body, undefined)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
