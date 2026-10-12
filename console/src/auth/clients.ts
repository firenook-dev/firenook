// Who made a call, as a developer reads it: the engine records the first of
// `x-client-version`, `x-firebase-client`, `x-goog-api-client` and
// `user-agent` (160 characters at most), and this turns it into "Web SDK
// 11.0.0, Chrome", "Admin SDK 13.10.0, Node.js", "Android app", "curl
// 8.7.1". What it cannot read comes back as given, cut short.

/** "Web SDK 11.0.0, Chrome" and the raw value it came from, for the tooltip. */
export interface ClientLabel {
  label: string
  raw: string
}

const PLATFORMS: Readonly<Record<string, string>> = {
  Node: 'Node.js',
  Python: 'Python',
  Go: 'Go',
  Java: 'Java',
  Chrome: 'Chrome',
  Firefox: 'Firefox',
  Safari: 'Safari',
  Edge: 'Edge',
  Opera: 'Opera',
  ReactNative: 'React Native',
  Cordova: 'Cordova',
  Worker: 'a web worker',
}

function platform(name: string): string {
  return PLATFORMS[name] ?? name
}

/** The words for one recorded client value; `null` reads as nothing recorded. */
export function clientLabel(client: string | null | undefined): ClientLabel | undefined {
  const raw = client?.trim() ?? ''
  if (raw === '') return undefined
  const said = (label: string): ClientLabel => ({ label, raw })

  // `x-client-version` of the Admin SDKs: `Node/Admin/13.10.0`.
  let match = /^(\w+)\/Admin\/([\w.-]+)/.exec(raw)
  if (match) return said(`Admin SDK ${match[2]}, ${platform(match[1] ?? '')}`)
  // The Web SDK: `Chrome/JsCore/11.0.0/FirebaseCore-web` (Handler, Worker… for its other surfaces).
  match = /^(\w+)\/(JsCore|Handler|Worker|ReactNative|Cordova)\/([\w.-]+)/.exec(raw)
  if (match) return said(`Web SDK ${match[3]}, ${platform(match[1] ?? '')}`)
  // The Apple SDKs: `iOS/FirebaseSDK/10.24.0/FirebaseCore-iOS`.
  match = /^(iOS|macOS|tvOS|watchOS)\/FirebaseSDK\/([\w.-]+)/.exec(raw)
  if (match) return said(`${match[1]} SDK ${match[2]}`)
  // The Android SDK: `Android/Fallback/X22003001/FirebaseCore-Android`.
  if (raw.startsWith('Android/')) return said('Android SDK')
  // `x-goog-api-client`: `gl-node/24.20.0 fire-admin/13.10.0`.
  match = /fire-admin\/([\w.-]+)/.exec(raw)
  if (match) {
    const runtime = /gl-(node|python|go|java)\/([\w.-]+)/.exec(raw)
    const on = runtime ? `, ${platform(capitalize(runtime[1] ?? ''))} ${runtime[2]}` : ''
    return said(`Admin SDK ${match[1]}${on}`)
  }
  // Flutter's native clients send the Dart runtime's user agent.
  match = /^Dart\/([\w.]+)/.exec(raw)
  if (match) return said(`Flutter (Dart ${match[1]})`)
  if (/\bflutter/i.test(raw)) return said('Flutter')
  // Native apps: the platform's HTTP stack.
  if (/^Dalvik\/|\bAndroid \d/.test(raw) && !/Mozilla\//.test(raw)) return said('Android app')
  if (/CFNetwork\/.*Darwin\//.test(raw)) return said('iOS app')
  match = /^curl\/([\w.]+)/.exec(raw)
  if (match) return said(`curl ${match[1]}`)
  if (raw === 'node' || /^node(-fetch)?\b/.test(raw)) return said('Node.js (fetch)')
  match = /^(python-requests|axios|okhttp|Go-http-client|Wget|HTTPie)\/([\w.]+)/i.exec(raw)
  if (match) return said(`${match[1]} ${match[2]}`)
  // A browser's own user agent: the browser.
  if (/Mozilla\//.test(raw)) {
    const browser = /Edg\//.test(raw)
      ? 'Edge'
      : /Firefox\//.test(raw)
        ? 'Firefox'
        : /Chrome\//.test(raw)
          ? 'Chrome'
          : /Safari\//.test(raw)
            ? 'Safari'
            : 'a browser'
    return said(browser)
  }
  return said(raw.length > 40 ? `${raw.slice(0, 39)}…` : raw)
}

function capitalize(word: string): string {
  return word === '' ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`
}
