// A value as the rules runtime writes it — in a coverage report, in a
// Requests event — and how the rules pages write it as text. The notation
// is the official runtime's, the same for Firestore's rules and Storage's,
// so it belongs to the kit; Firestore's decisions also read it into the
// console's Firestore value model (`fromRulesValue`), which stays theirs.

import { formatNumber } from '@/lib/format'

/** A value as the rules runtime writes it into a report or an event. */
export interface RulesTypedValue {
  nullValue?: null
  boolValue?: boolean
  intValue?: string | number
  floatValue?: number | string
  stringValue?: string
  timestampValue?: string
  bytesValue?: string
  latlngValue?: { latitude?: number; longitude?: number }
  pathValue?: { segments?: Array<{ simple?: string }> }
  mapValue?: { fields?: Record<string, RulesTypedValue> }
  listValue?: { values?: RulesTypedValue[] }
  undefined?: Record<string, never>
}

/** Whether the value is the runtime's "undefined" marker: an absence, not a value. */
function absent(value: RulesTypedValue | undefined): boolean {
  return !value || value.undefined !== undefined || kindOf(value) === undefined
}

function kindOf(value: RulesTypedValue): string | undefined {
  if (value.nullValue !== undefined) return 'null'
  if (value.boolValue !== undefined) return 'bool'
  if (value.intValue !== undefined) return 'int'
  if (value.floatValue !== undefined) return 'float'
  if (value.stringValue !== undefined) return 'string'
  if (value.timestampValue !== undefined) return 'timestamp'
  if (value.bytesValue !== undefined) return 'bytes'
  if (value.latlngValue !== undefined) return 'latlng'
  if (value.pathValue !== undefined) return 'path'
  if (value.mapValue !== undefined) return 'map'
  if (value.listValue !== undefined) return 'list'
  return undefined
}

/** A path value as the path below `documents`, or the whole path when it names none. */
export function rulesPathText(value: NonNullable<RulesTypedValue['pathValue']>): string {
  const segments = (value.segments ?? []).map((segment) => segment.simple ?? '')
  const at = segments.indexOf('documents')
  return at >= 0 ? segments.slice(at + 1).join('/') : segments.join('/')
}

/**
 * The one-line text of a value, as a grid cell writes it: numbers grouped,
 * a map or a list by its size; `undefined` for the "undefined" marker,
 * which has no text.
 */
export function rulesValueText(value: RulesTypedValue | undefined): string | undefined {
  if (!value || absent(value)) return undefined
  if (value.nullValue !== undefined) return 'null'
  if (value.boolValue !== undefined) return value.boolValue ? 'true' : 'false'
  if (value.intValue !== undefined) return formatNumber(Number(value.intValue))
  if (value.floatValue !== undefined)
    return formatNumber(
      typeof value.floatValue === 'number' ? value.floatValue : Number(value.floatValue),
    )
  if (value.stringValue !== undefined) return value.stringValue
  if (value.timestampValue !== undefined) return value.timestampValue
  if (value.bytesValue !== undefined) return `${Math.ceil((value.bytesValue.length * 3) / 4)} bytes`
  if (value.latlngValue !== undefined)
    return `${value.latlngValue.latitude ?? 0}, ${value.latlngValue.longitude ?? 0}`
  if (value.pathValue !== undefined) return rulesPathText(value.pathValue)
  if (value.mapValue !== undefined) {
    const fields = Object.values(value.mapValue.fields ?? {}).filter((item) => !absent(item)).length
    return fields === 0 ? '{}' : `{ ${fields} field${fields === 1 ? '' : 's'} }`
  }
  const items = (value.listValue?.values ?? []).filter((item) => !absent(item)).length
  return items === 0 ? '[]' : `[ ${items} item${items === 1 ? '' : 's'} ]`
}
