import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import {
  DEMO_TOKEN_PATH,
  connectDialects,
  connectHosts,
  connectSnippet,
  defaultConnectHost,
  demoCredentials,
} from './connect'
import { CONNECT_TABS, type ConnectTarget } from './connect-tabs'

const PORTS: Record<string, number> = {
  auth: 9099,
  firestore: 8080,
  storage: 9199,
  functions: 5001,
  pubsub: 8085,
  tasks: 9499,
  eventarc: 9299,
  hub: 4400,
  ui: 4000,
  logging: 4500,
}

function status(project = 'demo-shop', host = '127.0.0.1'): ConsoleStatus {
  return {
    projectId: project,
    engine: { name: 'Firenook', version: null, revision: null, consoleBuild: 'test' },
    services: Object.entries(PORTS).map(([name, port]) => ({
      name,
      host,
      port,
      listening: true,
      pid: null,
    })),
    instance: 'test-instance',
    startedAt: '2026-01-01T00:00:00Z',
    sections: [],
    features: { diagnostics: true },
    unsupported: [],
    backgroundTriggers: { enabled: true, since: null, dropped: [] },
    data: {
      mode: 'memory',
      stateDir: null,
      resumed: false,
      importedFrom: null,
      exportOnExit: null,
      durability: 'write-behind',
    },
    foreignProjects: [],
  }
}

const ALL = Object.keys(PORTS)

describe('connection snippets', () => {
  it('writes a complete web setup for a demo project', () => {
    expect(connectSnippet('web', { services: ALL, status: status(), host: '127.0.0.1' })).toBe(
      [
        "import { initializeApp } from 'firebase/app'",
        "import { connectAuthEmulator, getAuth } from 'firebase/auth'",
        "import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'",
        "import { connectStorageEmulator, getStorage } from 'firebase/storage'",
        "import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'",
        '',
        '// A demo project needs no real configuration; the Auth emulator still wants an apiKey,',
        '// and Storage its default bucket.',
        "const app = initializeApp({ projectId: 'demo-shop', apiKey: 'demo-api-key', storageBucket: 'demo-shop.appspot.com' })",
        "connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099')",
        "connectFirestoreEmulator(getFirestore(app), '127.0.0.1', 8080)",
        "connectStorageEmulator(getStorage(app), '127.0.0.1', 9199)",
        "connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001)",
      ].join('\n'),
    )
  })

  it("keeps a real project's own configuration", () => {
    const web = connectSnippet('web', { services: ALL, status: status('shop-dev') })
    expect(web).toContain("const app = initializeApp(firebaseConfig) // your app's configuration")
    expect(web).not.toContain('demo-api-key')
    expect(connectSnippet('flutter', { services: ALL, status: status('shop-dev') })).toMatch(
      /^await Firebase\.initializeApp\(options: DefaultFirebaseOptions\.currentPlatform\);/,
    )
    expect(connectSnippet('apple', { services: ALL, status: status('shop-dev') })).toMatch(
      /^FirebaseApp\.configure\(\)\n/,
    )
  })

  it('starts the mobile snippets with a demo app for a demo project', () => {
    const flutter = connectSnippet('flutter', { services: ALL, status: status() })
    expect(flutter.split('\n')[0]).toBe(
      'await Firebase.initializeApp(options: const FirebaseOptions(',
    )
    expect(flutter).toContain("projectId: 'demo-shop'")
    expect(flutter).toContain("FirebaseFirestore.instance.useFirestoreEmulator('127.0.0.1', 8080);")
    const apple = connectSnippet('apple', { services: ALL, status: status() })
    expect(apple.split('\n')[0]).toMatch(
      /^let options = FirebaseOptions\(googleAppID: "1:\d+:ios:[0-9a-f]+"/,
    )
    expect(apple).toContain('options.projectID = "demo-shop"')
    expect(apple).toContain('Auth.auth().useEmulator(withHost: "127.0.0.1", port: 9099)')
  })

  it('leaves out every line of a service that is not running', () => {
    const services = ['firestore', 'hub', 'ui']
    const web = connectSnippet('web', { services, status: status() })
    expect(web).not.toMatch(/auth|storage|functions/i)
    expect(web).toContain('// A demo project needs no real configuration.')
    expect(web).toContain("connectFirestoreEmulator(getFirestore(app), '127.0.0.1', 8080)")
    const admin = connectSnippet('admin-node', { services, status: status() })
    expect(admin).toContain("process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'")
    expect(admin).not.toMatch(/AUTH|STORAGE|PUBSUB/)
    expect(admin).toContain("initializeApp({ projectId: 'demo-shop' })")
    const env = connectSnippet('env', { services, status: status() })
    expect(env).not.toMatch(/AUTH|STORAGE|PUBSUB|TASKS|EVENTARC/)
    const json = JSON.parse(connectSnippet('firebase-json', { services, status: status() }))
    expect(Object.keys(json.emulators)).toEqual(['firestore', 'ui', 'hub'])
  })

  it('adds the Android cleartext line only for 10.0.2.2', () => {
    const android = connectSnippet('android', { services: ALL, status: status(), host: '10.0.2.2' })
    expect(android.split('\n')[0]).toBe(
      '// The Android emulator reaches this machine at 10.0.2.2; allow cleartext traffic to it in your network security config.',
    )
    expect(android).toContain('Firebase.firestore.useEmulator("10.0.2.2", 8080)')
    const local = connectSnippet('android', { services: ALL, status: status(), host: '127.0.0.1' })
    expect(local).not.toContain('cleartext')
    expect(local.split('\n')[0]).toBe('Firebase.auth.useEmulator("127.0.0.1", 9099)')
  })

  it('brackets an IPv6 host wherever it meets a port', () => {
    const web = connectSnippet('web', { services: ALL, status: status('demo-shop', '::1') })
    expect(web).toContain("connectAuthEmulator(getAuth(app), 'http://[::1]:9099')")
    expect(web).toContain("connectFirestoreEmulator(getFirestore(app), '[::1]', 8080)")
    const env = connectSnippet('env', { services: ALL, status: status(), host: 'fd00::5' })
    expect(env).toContain('FIRESTORE_EMULATOR_HOST=[fd00::5]:8080')
    expect(env).toContain('STORAGE_EMULATOR_HOST=http://[fd00::5]:9199')
    const json = JSON.parse(
      connectSnippet('firebase-json', { services: ALL, status: status(), host: 'fd00::5' }),
    )
    expect(json.emulators.auth).toEqual({ host: 'fd00::5', port: 9099 })
  })

  it('writes the environment emulators:exec sets, in a stable order', () => {
    const env = connectSnippet('env', { services: ALL, status: status() }).split('\n')
    // The official emulators:exec's variables for the running emulators,
    // then the demo credentials Firenook adds.
    expect(env.map((line) => line.split('=')[0])).toEqual([
      'GCLOUD_PROJECT',
      'GOOGLE_CLOUD_PROJECT',
      'FIRESTORE_EMULATOR_HOST',
      'FIREBASE_FIRESTORE_EMULATOR_ADDRESS',
      'FIREBASE_AUTH_EMULATOR_HOST',
      'FIREBASE_STORAGE_EMULATOR_HOST',
      'STORAGE_EMULATOR_HOST',
      'FIREBASE_EMULATOR_HUB',
      'PUBSUB_EMULATOR_HOST',
      'CLOUD_TASKS_EMULATOR_HOST',
      'CLOUD_EVENTARC_EMULATOR_HOST',
      'GOOGLE_APPLICATION_CREDENTIALS',
    ])
    const comments = env.map((line) => line.indexOf('  # '))
    expect(new Set(comments).size).toBe(1)
    expect(env[0]).toMatch(/^GCLOUD_PROJECT=demo-shop +# set by emulators:exec$/)
    const row = (name: string) => env.find((line) => line.startsWith(`${name}=`))
    expect(row('CLOUD_TASKS_EMULATOR_HOST')).toMatch(/=127\.0\.0\.1:9499 +# set by emulators:exec$/)
    expect(row('CLOUD_EVENTARC_EMULATOR_HOST')).toMatch(
      /=http:\/\/127\.0\.0\.1:9299 +# set by emulators:exec$/,
    )
    expect(env.at(-1)).toContain('# emulators:exec writes a demo file and sets this')
  })

  it('points the server SDKs at demo credentials, which they look up when they start', () => {
    const credentials =
      '{"type":"external_account_authorized_user","client_id":"demo","client_secret":"demo","refresh_token":"demo","token_url":"http://127.0.0.1:4400/firenook/oauth2/token"}'
    expect(demoCredentials('127.0.0.1:4400')).toBe(credentials)
    for (const target of ['python', 'go', 'java'] as const) {
      const snippet = connectSnippet(target, { services: ALL, status: status() })
      expect(snippet).toContain('firenook emulators:exec --')
      expect(snippet).toContain('GOOGLE_APPLICATION_CREDENTIALS')
      // An authorized_user file would get its token from Google.
      expect(snippet).toContain(credentials)
      expect(snippet).not.toContain('"authorized_user"')
      expect(snippet).toContain('demo-shop')
    }
    // The credentials name the hub as the app reaches it.
    expect(connectSnippet('go', { services: ALL, status: status(), host: '10.0.2.2' })).toContain(
      '"token_url":"http://10.0.2.2:4400/firenook/oauth2/token"',
    )
    expect(connectSnippet('python', { services: ALL, status: status() })).toContain(
      'firebase_admin.initialize_app(options={"projectId": "demo-shop", "storageBucket": "demo-shop.appspot.com"})',
    )
    expect(connectSnippet('go', { services: ALL, status: status() })).toContain(
      'firebase.NewApp(ctx, &firebase.Config{ProjectID: "demo-shop", StorageBucket: "demo-shop.appspot.com"})',
    )
  })

  it('sends Python to the emulators, Storage and Tasks included', () => {
    // The Python Admin SDK ignores FIREBASE_STORAGE_EMULATOR_HOST: its
    // Storage client reads STORAGE_EMULATOR_HOST, a URL, and without it
    // goes to storage.googleapis.com. Without CLOUD_TASKS_EMULATOR_HOST its
    // task queue goes to cloudtasks.googleapis.com.
    expect(connectSnippet('python', { services: ALL, status: status() })).toBe(
      [
        "# Easiest: run your script with the emulators' environment set for you:",
        '#   firenook emulators:exec -- python your_script.py',
        '# Or set these before initialize_app. The SDK looks up default credentials',
        '# when it starts, so point it at a demo credentials file holding:',
        '#   {"type":"external_account_authorized_user","client_id":"demo","client_secret":"demo","refresh_token":"demo","token_url":"http://127.0.0.1:4400/firenook/oauth2/token"}',
        "# Its token comes from the emulators' hub, never from Google.",
        '# Storage reads STORAGE_EMULATOR_HOST, a URL; Python ignores FIREBASE_STORAGE_EMULATOR_HOST.',
        'import os',
        'os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "demo-credentials.json"',
        'os.environ["FIRESTORE_EMULATOR_HOST"] = "127.0.0.1:8080"',
        'os.environ["FIREBASE_AUTH_EMULATOR_HOST"] = "127.0.0.1:9099"',
        'os.environ["STORAGE_EMULATOR_HOST"] = "http://127.0.0.1:9199"',
        'os.environ["PUBSUB_EMULATOR_HOST"] = "127.0.0.1:8085"',
        'os.environ["CLOUD_TASKS_EMULATOR_HOST"] = "127.0.0.1:9499"',
        '',
        'import firebase_admin',
        'firebase_admin.initialize_app(options={"projectId": "demo-shop", "storageBucket": "demo-shop.appspot.com"})',
      ].join('\n'),
    )
    const firestoreOnly = connectSnippet('python', { services: ['firestore'], status: status() })
    expect(firestoreOnly).not.toMatch(/STORAGE|TASKS/)
  })

  it('sends the Node Admin SDK’s task queue and Eventarc channel to the emulators', () => {
    // Without CLOUD_EVENTARC_EMULATOR_HOST a publish goes to Google, and
    // with it the SDK still asks for an access token: from your own
    // default credentials (Google's token endpoint) unless it is given the
    // demo ones, whose token the hub hands out.
    expect(connectSnippet('admin-node', { services: ALL, status: status() })).toBe(
      [
        "// Easiest: run your script with the emulators' environment set for you:",
        '//   firenook emulators:exec -- node your-script.js',
        '// Or set these before initializeApp; the Admin SDK reads them when it starts.',
        "process.env.GCLOUD_PROJECT = 'demo-shop'",
        "process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'",
        "process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'",
        "process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199'",
        "process.env.PUBSUB_EMULATOR_HOST = '127.0.0.1:8085'",
        "process.env.CLOUD_TASKS_EMULATOR_HOST = '127.0.0.1:9499'",
        "process.env.CLOUD_EVENTARC_EMULATOR_HOST = 'http://127.0.0.1:9299'",
        "// Eventarc's publish asks for an access token: these demo credentials get it",
        "// from the emulators' hub, never from Google. Set them under emulators:exec too,",
        '// whose own the Node.js SDK cannot use. The file holds:',
        '//   {"type":"external_account","audience":"firenook","subject_token_type":"urn:ietf:params:oauth:token-type:access_token","token_url":"http://127.0.0.1:4400/firenook/oauth2/token","credential_source":{"url":"http://127.0.0.1:4400/firenook/oauth2/token","format":{"type":"json","subject_token_field_name":"access_token"}}}',
        "process.env.GOOGLE_APPLICATION_CREDENTIALS = 'demo-credentials.json'",
        '',
        "import { initializeApp } from 'firebase-admin/app'",
        "initializeApp({ projectId: 'demo-shop', storageBucket: 'demo-shop.appspot.com' })",
      ].join('\n'),
    )
    const withoutFunctions = connectSnippet('admin-node', {
      services: ['firestore', 'storage'],
      status: status(),
    })
    expect(withoutFunctions).not.toMatch(/TASKS|EVENTARC|Eventarc|CREDENTIALS/)
  })

  it('turns TLS off for Firestore in the Apple snippet, which useEmulator leaves on', () => {
    const apple = connectSnippet('apple', { services: ALL, status: status() })
    expect(apple).not.toContain('Firestore.firestore().useEmulator')
    expect(apple).toContain(
      [
        'let settings = Firestore.firestore().settings',
        'settings.host = "127.0.0.1:8080"',
        'settings.isSSLEnabled = false',
        'Firestore.firestore().settings = settings',
      ].join('\n'),
    )
    // Auth brackets an IPv6 host itself; Firestore's host:port needs them.
    const v6 = connectSnippet('apple', { services: ALL, status: status('demo-shop', '::1') })
    expect(v6).toContain('Auth.auth().useEmulator(withHost: "::1", port: 9099)')
    expect(v6).toContain('settings.host = "[::1]:8080"')
  })

  it('builds Java’s Storage and Pub/Sub clients on the emulators, which read no variable', () => {
    const java = connectSnippet('java', { services: ALL, status: status() })
    expect(java).not.toMatch(/FIREBASE_STORAGE_EMULATOR_HOST|PUBSUB_EMULATOR_HOST|setStorageBucket/)
    expect(java).toContain('//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080')
    expect(java).toContain('//   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099')
    expect(java).toContain(
      [
        'Storage storage = StorageOptions.newBuilder()',
        '    .setHost("http://127.0.0.1:9199")',
        '    .setProjectId("demo-shop")',
        '    .setCredentials(NoCredentials.getInstance())',
        '    .build()',
        '    .getService();',
      ].join('\n'),
    )
    expect(java).toContain(
      'ManagedChannel channel = ManagedChannelBuilder.forTarget("127.0.0.1:8085").usePlaintext().build();',
    )
    expect(java).toContain('    .setCredentialsProvider(NoCredentialsProvider.create())')
    expect(connectSnippet('java', { services: ['firestore'], status: status() })).not.toMatch(
      /Storage|Pub\/Sub|ManagedChannel/,
    )
  })

  it('names the token endpoint the engine and the CLI serve and write', () => {
    const root = join(import.meta.dirname, '..', '..', '..')
    expect(readFileSync(join(root, 'packages/cli/src/runtime.mjs'), 'utf8')).toContain(
      `export const DEMO_TOKEN_PATH = '${DEMO_TOKEN_PATH}';`,
    )
    expect(readFileSync(join(root, 'crates/suite-front/src/lib.rs'), 'utf8')).toContain(
      `pub const DEMO_TOKEN_PATH: &str = "${DEMO_TOKEN_PATH}";`,
    )
  })

  it("uses the engine's bucket when the caller knows it", () => {
    expect(
      connectSnippet('admin-node', { services: ALL, status: status(), bucket: 'shop-files' }),
    ).toContain("initializeApp({ projectId: 'demo-shop', storageBucket: 'shop-files' })")
  })

  it('writes every target without throwing', () => {
    const targets: ConnectTarget[] = CONNECT_TABS.map((tab) => tab.target)
    expect(new Set(targets).size).toBe(11)
    for (const target of targets)
      for (const services of [ALL, [], ['firestore']])
        expect(typeof connectSnippet(target, { services, status: status() })).toBe('string')
  })

  it('gives a coding agent the MCP server entry, which names no host, port or project', () => {
    const entry = connectSnippet('agent', { services: ALL, status: status() })
    expect(JSON.parse(entry)).toEqual({
      mcpServers: { firenook: { command: 'npx', args: ['firenook', 'mcp'] } },
    })
    expect(entry).not.toContain(status().projectId)
  })

  it('draws a CodeBlock’s tabs from the one tab list, named by their connect value', () => {
    const all = connectDialects(status(), { services: ['firestore'] })
    expect(all.map((dialect) => dialect.id)).toEqual(CONNECT_TABS.map((tab) => tab.param))
    const some = connectDialects(status(), { services: ['firestore'], params: ['go', 'web'] })
    expect(some.map((dialect) => [dialect.id, dialect.label])).toEqual([
      ['web', 'Web'],
      ['go', 'Go'],
    ])
    expect(some[0]?.code).toBe(connectSnippet('web', { services: ['firestore'], status: status() }))
  })
})

describe('which host an app should use', () => {
  it("is the engine's connect host when the page is on the same machine", () => {
    expect(defaultConnectHost(status(), 'localhost')).toEqual({ host: '127.0.0.1', why: 'engine' })
    expect(defaultConnectHost(status(), '127.0.0.1')).toEqual({ host: '127.0.0.1', why: 'engine' })
  })

  it("keeps the engine's host when a local proxy names the console (portless)", () => {
    for (const page of ['my-app.localhost', 'branch.emulator.my-app.localhost', 'App.LocalHost.']) {
      expect(defaultConnectHost(status(), page)).toEqual({ host: '127.0.0.1', why: 'engine' })
      expect(connectHosts(status(), page).map((entry) => entry.host)).toEqual([
        '127.0.0.1',
        '10.0.2.2',
      ])
    }
    // Only names under localhost: a lookalike is another machine.
    expect(defaultConnectHost(status(), 'localhost.example.test').why).toBe('browser')
    expect(defaultConnectHost(status(), 'my-laptop.local').why).toBe('browser')
  })

  it("is the page's host when the console was opened from another machine", () => {
    expect(defaultConnectHost(status(), '192.168.1.20')).toEqual({
      host: '192.168.1.20',
      why: 'browser',
    })
    // This test page is on the engine's machine, so the snippet keeps the engine's host.
    expect(connectSnippet('admin-node', { services: ALL, status: status() })).toContain(
      "'127.0.0.1:8080'",
    )
  })

  it("keeps a non-loopback engine host whatever the page's host", () => {
    expect(defaultConnectHost(status('demo-shop', '10.1.2.3'), '192.168.1.20')).toEqual({
      host: '10.1.2.3',
      why: 'engine',
    })
  })

  it('offers the engine host, the page host when it differs, and the Android emulator', () => {
    expect(connectHosts(status(), 'localhost').map((entry) => entry.host)).toEqual([
      '127.0.0.1',
      '10.0.2.2',
    ])
    expect(connectHosts(status(), '192.168.1.20').map((entry) => entry.host)).toEqual([
      '127.0.0.1',
      '192.168.1.20',
      '10.0.2.2',
    ])
  })
})
