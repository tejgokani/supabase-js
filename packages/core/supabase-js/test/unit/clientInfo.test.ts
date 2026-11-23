import { createClient } from '../../src/index'
import { DEFAULT_HEADERS } from '../../src/lib/constants'
import { applySettingDefaults } from '../../src/lib/helpers'

const URL = 'http://localhost:3000'
const KEY = 'some.fake.key'
const BASE = DEFAULT_HEADERS['X-Client-Info']

/** Records the headers of every request and answers with an empty JSON body. */
function stubFetch() {
  const calls: { url: string; headers: Headers }[] = []
  const fetch = jest.fn(async (input: any, init?: any) => {
    calls.push({ url: String(input?.url ?? input), headers: new Headers(init?.headers) })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

function resolveHeaders(global: Record<string, unknown>) {
  return applySettingDefaults({ global } as any, { global: { headers: DEFAULT_HEADERS } } as any)
    .global.headers!
}

describe('global.clientInfo', () => {
  describe('header value', () => {
    test('appends to the default value, in entry order', () => {
      const headers = resolveHeaders({
        clientInfo: { via: 'supabase-server/1.10.0', middleware: 'oauth-protected-resource' },
      })
      expect(headers['X-Client-Info']).toBe(
        `${BASE}; via=supabase-server/1.10.0; middleware=oauth-protected-resource`
      )
    })

    test('keeps the order the keys were given in', () => {
      const headers = resolveHeaders({ clientInfo: { b: '1', a: '2' } })
      expect(headers['X-Client-Info']).toBe(`${BASE}; b=1; a=2`)
    })

    test.each(['X-Client-Info', 'x-client-info', 'X-CLIENT-INFO'])(
      'appends to a caller override set as %s and emits one header',
      (name) => {
        const headers = resolveHeaders({
          headers: { [name]: 'my-lib/3.0.0', 'x-other': 'kept' },
          clientInfo: { via: 'my-lib/3.0.0' },
        })
        const clientInfoHeaders = Object.entries(headers).filter(
          ([key]) => key.toLowerCase() === 'x-client-info'
        )
        expect(clientInfoHeaders).toEqual([['X-Client-Info', 'my-lib/3.0.0; via=my-lib/3.0.0']])
        expect(headers['x-other']).toBe('kept')
      }
    )

    test('does not mutate the caller options', () => {
      const global = { headers: { 'x-client-info': 'my-lib/1.0.0' }, clientInfo: { via: 'a' } }
      resolveHeaders(global)
      expect(global).toEqual({
        headers: { 'x-client-info': 'my-lib/1.0.0' },
        clientInfo: { via: 'a' },
      })
    })

    test.each([undefined, {}])('leaves the header alone for clientInfo %p', (clientInfo) => {
      const headers = resolveHeaders({ clientInfo, headers: { 'x-client-info': 'my-lib/1.0.0' } })
      expect(headers).toEqual({ 'X-Client-Info': BASE, 'x-client-info': 'my-lib/1.0.0' })
      expect(resolveHeaders({ clientInfo })).toEqual({ 'X-Client-Info': BASE })
    })

    test('trims values and percent-encodes ";", "%" and non-ASCII', () => {
      const headers = resolveHeaders({
        clientInfo: {
          a: '  x;y  ',
          b: '100%',
          c: 'café ☕',
          d: 'two words',
          e: 'a,b',
          f: '😀',
          g: 'a\r\n\x7fb',
        },
      })
      expect(headers['X-Client-Info']).toBe(
        `${BASE}; a=x%3By; b=100%25; c=caf%C3%A9 %E2%98%95; d=two words; e=a,b; f=%F0%9F%98%80; g=a%0D%0A%7Fb`
      )
    })
  })

  describe('validation at createClient', () => {
    test.each(['Via', 'has space', 'a=b', 'a;b', 'é', ''])('rejects the key %p', (key) => {
      expect(() => createClient(URL, KEY, { global: { clientInfo: { [key]: 'v' } } })).toThrow(
        /Invalid global\.clientInfo key/
      )
    })

    test.each(['', '   ', '\t'])('rejects the empty value %p', (value) => {
      expect(() => createClient(URL, KEY, { global: { clientInfo: { via: value } } })).toThrow(
        'Invalid global.clientInfo value for "via"'
      )
    })

    test('rejects a non-string value', () => {
      expect(() =>
        createClient(URL, KEY, { global: { clientInfo: { via: 1 as unknown as string } } })
      ).toThrow('Invalid global.clientInfo value for "via"')
    })

    test.each([
      'platform',
      'platform-version',
      'platform-architecture',
      'runtime',
      'runtime-version',
      'framework',
      'framework-version',
      'features',
    ])('rejects the SDK-owned key %s and names it', (key) => {
      expect(() => createClient(URL, KEY, { global: { clientInfo: { [key]: 'x' } } })).toThrow(
        `Invalid global.clientInfo key "${key}"`
      )
    })

    test('rejects a key already in the caller-supplied X-Client-Info', () => {
      expect(() =>
        createClient(URL, KEY, {
          global: {
            headers: { 'x-client-info': 'my-lib/1.0.0; via=other' },
            clientInfo: { via: 'a' },
          },
        })
      ).toThrow('Invalid global.clientInfo key "via"')
    })

    test('accepts lowercase kebab-case keys', () => {
      expect(() =>
        createClient(URL, KEY, { global: { clientInfo: { via: 'lib/1.0.0', 'a-1': 'x' } } })
      ).not.toThrow()
    })

    test('rejects underscores: keys are lowercase kebab-case', () => {
      expect(() => createClient(URL, KEY, { global: { clientInfo: { a_b: 'x' } } })).toThrow(
        /key "a_b"/
      )
    })
  })

  describe('outgoing requests', () => {
    test('the serialized header reaches PostgREST, Storage, Functions and Auth', async () => {
      const { fetch, calls } = stubFetch()
      const client = createClient(URL, KEY, {
        global: { fetch, clientInfo: { via: 'supabase-server/1.10.0' } },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })

      await client.from('t').select()
      await client.storage.from('b').list()
      await client.functions.invoke('fn')
      await client.auth.signInWithPassword({ email: 'a@b.co', password: 'pw' })

      const expected = `${BASE}; via=supabase-server/1.10.0`
      const services = ['/rest/v1/', '/storage/v1/', '/functions/v1/', '/auth/v1/']
      for (const service of services) {
        const call = calls.find((c) => c.url.includes(service))
        expect(call).toBeDefined()
        expect(call!.headers.get('x-client-info')).toBe(expected)
      }
    })

    test('without clientInfo the header is the SDK default', async () => {
      const { fetch, calls } = stubFetch()
      const client = createClient(URL, KEY, { global: { fetch } })
      await client.from('t').select()
      expect(calls[0].headers.get('x-client-info')).toBe(BASE)
    })

    test('a lowercase caller override is replaced by one combined header', async () => {
      const { fetch, calls } = stubFetch()
      const client = createClient(URL, KEY, {
        global: {
          fetch,
          headers: { 'x-client-info': 'my-lib/2.0.0' },
          clientInfo: { middleware: 'a,b' },
        },
      })
      await client.from('t').select()
      expect(calls[0].headers.get('x-client-info')).toBe('my-lib/2.0.0; middleware=a,b')
    })
  })
})
