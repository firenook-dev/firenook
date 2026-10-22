// The one place that writes "how do I point my app at this emulator": the
// snippet for each SDK with this engine's host, ports and project id. An
// empty section, Auth's settings, the Overview and the connection lines of
// Pub/Sub, Tasks and Storage all print from here, so a port or a project
// id is never typed by hand into a page, and every page says the same.
//
// A line for a service that is not running is left out, so a snippet never
// points at a port nothing listens on. A `demo-` project needs no real
// configuration, so its snippets are complete; any other project keeps the
// app's own configuration and only adds the emulator lines.

import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { mcpServersJson } from './agent-config'
import type { CodeLanguage } from './code-language'
import { CONNECT_TABS, type ConnectParam, type ConnectTarget } from './connect-tabs'

/** The Android emulator's name for the machine it runs on. */
export const ANDROID_HOST = '10.0.2.2'

/** The hub's token endpoint, which answers every refresh with the emulators' `owner` token. */
export const DEMO_TOKEN_PATH = '/firenook/oauth2/token'

/**
 * What `firenook emulators:exec` writes and points GOOGLE_APPLICATION_CREDENTIALS
 * at, with the hub at `hub` (`host:port`): an authorized_user file, the one
 * kind every release of every Admin SDK reads, holding the emulators' own
 * token (which the Python SDK takes as it is) and the hub as its `token_uri`
 * (where the Go and Java SDKs refresh it). The Node.js SDKs send any refresh
 * to Google, so only emulators:exec answers theirs, in their process.
 */
export function demoCredentials(hub: string): string {
  return JSON.stringify({
    type: 'authorized_user',
    client_id: 'demo',
    client_secret: 'demo',
    refresh_token: 'demo',
    token_uri: `http://${hub}${DEMO_TOKEN_PATH}`,
    token: 'owner',
    expiry: '2999-12-31T23:59:59Z',
  })
}

/**
 * An app id each mobile SDK accepts without a registered app: the
 * `1:<project number>:<platform>:<hex>` shape the Apple SDK validates (the
 * Android SDK only asks for one to be present).
 */
const DEMO_APP_ID = '1:000000000000:ios:0000000000000000'

export function isLoopback(host: string): boolean {
  const bare = host
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
  // A name under `localhost` (a local proxy's `my-app.localhost`) is this
  // machine too: it routes the console only, so apps keep the engine's host.
  return (
    bare === 'localhost' ||
    /^[^.]+(\.[^.]+)*\.localhost$/.test(bare) ||
    bare === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(bare)
  )
}

/** A host as it is written next to a port or inside a URL: IPv6 in brackets. */
export function hostLiteral(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/** The host the engine tells apps to connect to (its connect host). */
function engineHost(status: ConsoleStatus): string {
  const named = (name: string) => status.services.find((service) => service.name === name)?.host
  return named('hub') ?? named('ui') ?? status.services[0]?.host ?? '127.0.0.1'
}

/**
 * The host an app should use, by the rule every address in the console
 * follows: the engine's connect host, unless that is loopback and this page
 * was opened from another machine — then the page's own host, which is
 * evidently how this machine is reached.
 */
export function defaultConnectHost(
  status: ConsoleStatus,
  pageHost: string = typeof location === 'undefined' ? '' : location.hostname,
): { host: string; why: 'engine' | 'browser' } {
  const host = engineHost(status)
  if (isLoopback(host) && pageHost !== '' && !isLoopback(pageHost))
    return { host: pageHost.replace(/^\[|\]$/g, ''), why: 'browser' }
  return { host, why: 'engine' }
}

/** The hosts to offer: the engine's connect host, this page's host when it differs, `10.0.2.2` (Android emulator). */
export function connectHosts(
  status: ConsoleStatus,
  pageHost: string = typeof location === 'undefined' ? '' : location.hostname,
): readonly { host: string; label: string }[] {
  const engine = engineHost(status)
  const page = pageHost.replace(/^\[|\]$/g, '')
  const hosts = [{ host: engine, label: 'This machine' }]
  if (page !== '' && page !== engine && !(isLoopback(page) && isLoopback(engine)))
    hosts.push({ host: page, label: 'The address this page was opened at' })
  hosts.push({ host: ANDROID_HOST, label: 'Android emulator' })
  return hosts
}

/**
 * The snippet for these services with this engine's host, ports and project
 * id; a service that is not running is left out; `host: '10.0.2.2'` adds
 * Android's cleartext comment line.
 */
export function connectSnippet(
  target: ConnectTarget,
  options: {
    services: readonly string[]
    host?: string | undefined
    status: ConsoleStatus
    /** The engine's default bucket; `<project>.appspot.com` when the caller does not know it. */
    bucket?: string | undefined
  },
): string {
  const { status } = options
  const host = hostLiteral(options.host ?? defaultConnectHost(status).host)
  const port = (name: string): number | undefined =>
    options.services.includes(name)
      ? status.services.find((service) => service.name === name)?.port
      : undefined
  const ports = {
    auth: port('auth'),
    firestore: port('firestore'),
    storage: port('storage'),
    functions: port('functions'),
    pubsub: port('pubsub'),
    tasks: port('tasks'),
    eventarc: port('eventarc'),
    hub: port('hub'),
    database: port('database'),
  }
  // The hub always runs, whichever services a snippet is for.
  const hub = status.services.find((service) => service.name === 'hub')?.port ?? 4400
  const context: SnippetContext = {
    host,
    bareHost: host.replace(/^\[|\]$/g, ''),
    credentials: demoCredentials(`${host}:${hub}`),
    android: (options.host ?? '') === ANDROID_HOST,
    project: status.projectId,
    demo: status.projectId.startsWith('demo-'),
    bucket: options.bucket ?? `${status.projectId}.appspot.com`,
    ports,
    services: options.services,
    status,
  }
  return WRITERS[target](context).join('\n')
}

interface SnippetContext {
  /** As it is written next to a port or inside a URL: IPv6 in brackets. */
  host: string
  /** Without the brackets, for an SDK that adds them itself. */
  bareHost: string
  /** The demo credentials file's content: the emulators' token, refreshed from this engine's hub. */
  credentials: string
  android: boolean
  project: string
  demo: boolean
  bucket: string
  ports: Record<
    | 'auth'
    | 'firestore'
    | 'storage'
    | 'functions'
    | 'pubsub'
    | 'tasks'
    | 'eventarc'
    | 'hub'
    | 'database',
    number | undefined
  >
  services: readonly string[]
  status: ConsoleStatus
}

/** Keeps the lines whose service runs; `false` drops a line. */
function lines(...items: Array<string | false | undefined>): string[] {
  return items.filter((item): item is string => typeof item === 'string')
}

const WRITERS: Record<ConnectTarget, (context: SnippetContext) => string[]> = {
  web: ({ host, project, demo, bucket, ports }) => {
    const { auth, firestore, storage, functions } = ports
    const note =
      auth !== undefined && storage !== undefined ? '// and Storage its default bucket.' : undefined
    return lines(
      "import { initializeApp } from 'firebase/app'",
      auth !== undefined && "import { connectAuthEmulator, getAuth } from 'firebase/auth'",
      firestore !== undefined &&
        "import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'",
      storage !== undefined &&
        "import { connectStorageEmulator, getStorage } from 'firebase/storage'",
      functions !== undefined &&
        "import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'",
      '',
      ...(demo
        ? [
            auth !== undefined
              ? `// A demo project needs no real configuration; the Auth emulator still wants an apiKey${note ? ',' : '.'}`
              : storage !== undefined
                ? '// A demo project needs no real configuration; Storage still wants its default bucket.'
                : '// A demo project needs no real configuration.',
            note,
            `const app = initializeApp({ projectId: '${project}', apiKey: 'demo-api-key'${storage !== undefined ? `, storageBucket: '${bucket}'` : ''} })`,
          ]
        : ["const app = initializeApp(firebaseConfig) // your app's configuration"]),
      auth !== undefined && `connectAuthEmulator(getAuth(app), 'http://${host}:${auth}')`,
      firestore !== undefined &&
        `connectFirestoreEmulator(getFirestore(app), '${host}', ${firestore})`,
      storage !== undefined && `connectStorageEmulator(getStorage(app), '${host}', ${storage})`,
      functions !== undefined &&
        `connectFunctionsEmulator(getFunctions(app), '${host}', ${functions})`,
    )
  },

  flutter: ({ host, project, demo, bucket, ports }) => {
    const { auth, firestore, storage, functions } = ports
    return lines(
      ...(demo
        ? [
            'await Firebase.initializeApp(options: const FirebaseOptions(',
            `  apiKey: 'demo-api-key', appId: '${DEMO_APP_ID}', messagingSenderId: '0', projectId: '${project}'${storage !== undefined ? `,\n  storageBucket: '${bucket}'` : ''}));`,
          ]
        : ['await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);']),
      auth !== undefined && `await FirebaseAuth.instance.useAuthEmulator('${host}', ${auth});`,
      firestore !== undefined &&
        `FirebaseFirestore.instance.useFirestoreEmulator('${host}', ${firestore});`,
      storage !== undefined &&
        `await FirebaseStorage.instance.useStorageEmulator('${host}', ${storage});`,
      functions !== undefined &&
        `FirebaseFunctions.instance.useFunctionsEmulator('${host}', ${functions});`,
    )
  },

  apple: ({ host, bareHost, project, demo, bucket, ports }) => {
    const { auth, firestore, storage, functions } = ports
    return lines(
      ...(demo
        ? lines(
            `let options = FirebaseOptions(googleAppID: "${DEMO_APP_ID}", gcmSenderID: "0")`,
            'options.apiKey = "demo-api-key"',
            `options.projectID = "${project}"`,
            storage !== undefined && `options.storageBucket = "${bucket}"`,
            'FirebaseApp.configure(options: options)',
          )
        : ['FirebaseApp.configure()']),
      // Auth brackets an IPv6 host itself.
      auth !== undefined && `Auth.auth().useEmulator(withHost: "${bareHost}", port: ${auth})`,
      // Firestore's useEmulator leaves TLS on, which the emulator does not speak.
      ...(firestore !== undefined
        ? [
            'let settings = Firestore.firestore().settings',
            `settings.host = "${host}:${firestore}"`,
            'settings.isSSLEnabled = false',
            'Firestore.firestore().settings = settings',
          ]
        : []),
      storage !== undefined &&
        `Storage.storage().useEmulator(withHost: "${host}", port: ${storage})`,
      functions !== undefined &&
        `Functions.functions().useEmulator(withHost: "${host}", port: ${functions})`,
    )
  },

  android: ({ host, android, ports }) => {
    const { auth, firestore, storage, functions } = ports
    return lines(
      android &&
        '// The Android emulator reaches this machine at 10.0.2.2; allow cleartext traffic to it in your network security config.',
      auth !== undefined && `Firebase.auth.useEmulator("${host}", ${auth})`,
      firestore !== undefined && `Firebase.firestore.useEmulator("${host}", ${firestore})`,
      storage !== undefined && `Firebase.storage.useEmulator("${host}", ${storage})`,
      functions !== undefined && `Firebase.functions.useEmulator("${host}", ${functions})`,
    )
  },

  'admin-node': ({ host, project, bucket, ports }) => {
    const variables = adminVariables('node', { host, ports })
    return lines(
      "// Easiest: run your script with the emulators' environment set for you:",
      '//   firenook emulators:exec -- node your-script.js',
      '// Or set these before initializeApp; the Admin SDK reads them when it starts.',
      // As emulators:exec does: without a project id, the task queue and
      // Eventarc clients ask the Compute Engine metadata server for one.
      `process.env.GCLOUD_PROJECT = '${project}'`,
      ...variables.map(([name, value]) => `process.env.${name} = '${value}'`),
      ...(ports.eventarc !== undefined
        ? [
            "// Eventarc's publish asks for an access token: under emulators:exec it gets the",
            "// emulators' own; run otherwise, it asks your default credentials for one.",
          ]
        : []),
      '',
      "import { initializeApp } from 'firebase-admin/app'",
      `initializeApp({ projectId: '${project}'${ports.storage !== undefined ? `, storageBucket: '${bucket}'` : ''} })`,
    )
  },

  python: ({ host, credentials, project, bucket, ports }) =>
    lines(
      "# Easiest: run your script with the emulators' environment set for you:",
      '#   firenook emulators:exec -- python your_script.py',
      '# Or set these before initialize_app. The SDK looks up default credentials',
      '# when it starts, so point it at a demo credentials file holding:',
      `#   ${credentials}`,
      "# It holds the emulators' own token, so the SDK never asks Google for one.",
      ports.storage !== undefined &&
        '# Storage reads STORAGE_EMULATOR_HOST, a URL; Python ignores FIREBASE_STORAGE_EMULATOR_HOST.',
      'import os',
      'os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "demo-credentials.json"',
      ...adminVariables('python', { host, ports }).map(
        ([name, value]) => `os.environ["${name}"] = "${value}"`,
      ),
      '',
      'import firebase_admin',
      `firebase_admin.initialize_app(options={"projectId": "${project}"${ports.storage !== undefined ? `, "storageBucket": "${bucket}"` : ''}})`,
    ),

  go: ({ host, credentials, project, bucket, ports }) =>
    lines(
      "// Easiest: run your program with the emulators' environment set for you:",
      '//   firenook emulators:exec -- go run .',
      '// Or set these before firebase.NewApp. The SDK looks up default credentials',
      '// when it starts, so point it at a demo credentials file holding:',
      `//   ${credentials}`,
      "// The SDK refreshes its token from the emulators' hub, its token_uri.",
      'os.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "demo-credentials.json")',
      ...adminVariables('go', { host, ports }).map(
        ([name, value]) => `os.Setenv("${name}", "${value}")`,
      ),
      '',
      `app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: "${project}"${ports.storage !== undefined ? `, StorageBucket: "${bucket}"` : ''}})`,
    ),

  java: ({ host, credentials, project, bucket, ports }) =>
    lines(
      "// Easiest: run your program with the emulators' environment set for you:",
      '//   firenook emulators:exec -- <your command>',
      "// Or set these in the JVM's environment before it starts; Java cannot set them itself:",
      '//   GOOGLE_APPLICATION_CREDENTIALS=demo-credentials.json, a file holding',
      `//     ${credentials}`,
      "//     (the SDK refreshes its token from the emulators' hub, its token_uri)",
      ...adminVariables('java', { host, ports }).map(([name, value]) => `//   ${name}=${value}`),
      'FirebaseOptions options = FirebaseOptions.builder()',
      `    .setProjectId("${project}")`,
      '    .setCredentials(GoogleCredentials.getApplicationDefault())',
      '    .build();',
      'FirebaseApp.initializeApp(options);',
      ...(ports.storage !== undefined
        ? [
            '',
            "// Java's Storage client reads no emulator variable, so build it on the emulator",
            `// (the default bucket is "${bucket}"):`,
            'Storage storage = StorageOptions.newBuilder()',
            `    .setHost("http://${host}:${ports.storage}")`,
            `    .setProjectId("${project}")`,
            '    .setCredentials(NoCredentials.getInstance())',
            '    .build()',
            '    .getService();',
          ]
        : []),
      ...(ports.pubsub !== undefined
        ? [
            '',
            "// Java's Pub/Sub client reads no emulator variable, so give it a plaintext channel:",
            `ManagedChannel channel = ManagedChannelBuilder.forTarget("${host}:${ports.pubsub}").usePlaintext().build();`,
            `Publisher publisher = Publisher.newBuilder(TopicName.of("${project}", "orders"))`,
            '    .setChannelProvider(FixedTransportChannelProvider.create(GrpcTransportChannel.create(channel)))',
            '    .setCredentialsProvider(NoCredentialsProvider.create())',
            '    .build();',
          ]
        : []),
    ),

  env: ({ host, project, ports }) => {
    const exec = 'set by emulators:exec'
    const rows = lines(
      `GCLOUD_PROJECT=${project}\u0000${exec}`,
      `GOOGLE_CLOUD_PROJECT=${project}\u0000${exec}`,
      ports.firestore !== undefined &&
        `FIRESTORE_EMULATOR_HOST=${host}:${ports.firestore}\u0000${exec}`,
      ports.firestore !== undefined &&
        `FIREBASE_FIRESTORE_EMULATOR_ADDRESS=${host}:${ports.firestore}\u0000${exec}`,
      ports.auth !== undefined && `FIREBASE_AUTH_EMULATOR_HOST=${host}:${ports.auth}\u0000${exec}`,
      ports.storage !== undefined &&
        `FIREBASE_STORAGE_EMULATOR_HOST=${host}:${ports.storage}\u0000${exec}`,
      ports.storage !== undefined &&
        `STORAGE_EMULATOR_HOST=http://${host}:${ports.storage}\u0000${exec}`,
      ports.hub !== undefined && `FIREBASE_EMULATOR_HUB=${host}:${ports.hub}\u0000${exec}`,
      ports.pubsub !== undefined && `PUBSUB_EMULATOR_HOST=${host}:${ports.pubsub}\u0000${exec}`,
      ports.tasks !== undefined && `CLOUD_TASKS_EMULATOR_HOST=${host}:${ports.tasks}\u0000${exec}`,
      ports.eventarc !== undefined &&
        `CLOUD_EVENTARC_EMULATOR_HOST=http://${host}:${ports.eventarc}\u0000${exec}`,
      `GOOGLE_APPLICATION_CREDENTIALS=demo-credentials.json\u0000emulators:exec writes a demo file and sets this`,
    )
    const width = Math.max(...rows.map((row) => row.indexOf('\u0000')))
    return rows.map((row) => {
      const [assignment = '', comment = ''] = row.split('\u0000')
      return `${assignment.padEnd(width)}  # ${comment}`
    })
  },

  'firebase-json': ({ host, ports, services, status }) => {
    const bare = host.replace(/^\[|\]$/g, '')
    const emulated = (
      [
        'auth',
        'firestore',
        'database',
        'storage',
        'functions',
        'pubsub',
        'eventarc',
        'tasks',
      ] as const
    ).filter((name) => ports[name] !== undefined)
    const port = (name: string) =>
      services.includes(name)
        ? status.services.find((service) => service.name === name)?.port
        : undefined
    const ui = port('ui')
    const logging = port('logging')
    const rows = [
      ...emulated.map((name) =>
        entry(name, `{ "host": ${JSON.stringify(bare)}, "port": ${ports[name]} }`),
      ),
      ...(ui !== undefined ? [entry('ui', `{ "enabled": true, "port": ${ui} }`)] : []),
      ...(ports.hub !== undefined ? [entry('hub', `{ "port": ${ports.hub} }`)] : []),
      ...(logging !== undefined ? [entry('logging', `{ "port": ${logging} }`)] : []),
    ]
    return ['{', '  "emulators": {', rows.join(',\n'), '  }', '}']
  },

  // A coding agent reaches the engine through `firenook mcp`, which finds
  // the running suite itself: the entry names no host, port or project.
  agent: () => mcpServersJson().split('\n'),
}

/** One line of firebase.json's `emulators` block. */
function entry(name: string, value: string): string {
  return `    "${name}": ${value}`
}

/**
 * The variables one language's SDKs read, for the services that run: only
 * those its clients read. Python's Storage takes STORAGE_EMULATOR_HOST (a URL)
 * and ignores FIREBASE_STORAGE_EMULATOR_HOST; Java's Storage and Pub/Sub read
 * neither, so the Java snippet builds those clients on the emulator; Node and
 * Python enqueue tasks (Python publishes no Eventarc event).
 */
function adminVariables(
  language: 'node' | 'python' | 'go' | 'java',
  { host, ports }: Pick<SnippetContext, 'host' | 'ports'>,
): Array<[string, string]> {
  const rows: Array<[string, string]> = []
  if (ports.firestore !== undefined)
    rows.push(['FIRESTORE_EMULATOR_HOST', `${host}:${ports.firestore}`])
  if (ports.auth !== undefined) rows.push(['FIREBASE_AUTH_EMULATOR_HOST', `${host}:${ports.auth}`])
  if (ports.storage !== undefined && language === 'python')
    rows.push(['STORAGE_EMULATOR_HOST', `http://${host}:${ports.storage}`])
  else if (ports.storage !== undefined && language !== 'java')
    rows.push(['FIREBASE_STORAGE_EMULATOR_HOST', `${host}:${ports.storage}`])
  if (ports.pubsub !== undefined && language !== 'java')
    rows.push(['PUBSUB_EMULATOR_HOST', `${host}:${ports.pubsub}`])
  if (ports.tasks !== undefined && (language === 'node' || language === 'python'))
    rows.push(['CLOUD_TASKS_EMULATOR_HOST', `${host}:${ports.tasks}`])
  if (ports.eventarc !== undefined && language === 'node')
    rows.push(['CLOUD_EVENTARC_EMULATOR_HOST', `http://${host}:${ports.eventarc}`])
  return rows
}

/**
 * The snippets as a `CodeBlock`'s tabs, for `services` on this engine: every
 * tab of `CONNECT_TABS`, or the ones `params` names, in the list's order.
 * Each tab's id is its `connect` value.
 */
export function connectDialects(
  status: ConsoleStatus,
  options: {
    services: readonly string[]
    params?: readonly ConnectParam[] | undefined
    host?: string | undefined
  },
): { id: ConnectParam; label: string; code: string; language: CodeLanguage }[] {
  return CONNECT_TABS.filter((tab) => !options.params || options.params.includes(tab.param)).map(
    (tab) => ({
      id: tab.param,
      label: tab.label,
      language: tab.language,
      code: connectSnippet(tab.target, {
        services: options.services,
        status,
        host: options.host,
      }),
    }),
  )
}
