import { describe, expect, it } from 'vitest'
import { clientLabel } from './clients'

const label = (raw: string | null) => clientLabel(raw)?.label

describe('who made a call', () => {
  it('reads the SDKs’ own headers', () => {
    expect(label('Chrome/JsCore/11.0.0/FirebaseCore-web')).toBe('Web SDK 11.0.0, Chrome')
    expect(label('Node/JsCore/10.12.2/FirebaseCore-web')).toBe('Web SDK 10.12.2, Node.js')
    expect(label('Node/Admin/13.10.0')).toBe('Admin SDK 13.10.0, Node.js')
    expect(label('Python/Admin/6.5.0')).toBe('Admin SDK 6.5.0, Python')
    expect(label('gl-node/24.20.0 fire-admin/13.10.0')).toBe('Admin SDK 13.10.0, Node.js 24.20.0')
    expect(label('iOS/FirebaseSDK/10.24.0/FirebaseCore-iOS')).toBe('iOS SDK 10.24.0')
    expect(label('Android/Fallback/X22003001/FirebaseCore-Android')).toBe('Android SDK')
  })

  it('reads the user agents of apps and tools', () => {
    expect(label('Dart/3.4 (dart:io)')).toBe('Flutter (Dart 3.4)')
    expect(label('Dalvik/2.1.0 (Linux; U; Android 14; Pixel 8 Build/AP1A)')).toBe('Android app')
    expect(label('MyApp/1 CFNetwork/1494.0.7 Darwin/23.4.0')).toBe('iOS app')
    expect(label('curl/8.7.1')).toBe('curl 8.7.1')
    expect(label('node')).toBe('Node.js (fetch)')
    expect(
      label(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      ),
    ).toBe('Chrome')
  })

  it('keeps what it cannot read, cut short, and says nothing for nothing recorded', () => {
    expect(label('SomethingElse/1')).toBe('SomethingElse/1')
    expect(label('x'.repeat(60))).toBe(`${'x'.repeat(39)}…`)
    expect(clientLabel('SomethingElse/1')?.raw).toBe('SomethingElse/1')
    expect(clientLabel(null)).toBeUndefined()
    expect(clientLabel('  ')).toBeUndefined()
  })
})
