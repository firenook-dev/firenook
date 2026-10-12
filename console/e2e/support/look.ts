// How things look, measured the way the eye sees them: a control's colour
// over everything under it, a field's ring and ground, the room a clip
// leaves around a ring, what paints at a point. Moved out of the Firestore
// journeys so every section's journeys hold the same bar.

import type { Locator, Page } from '@playwright/test'

/**
 * A control's colour as the eye sees it, as one luminance level (0–255):
 * its own fill and every layer under it down to the first opaque ground,
 * composited — background images (the hover's ink is one) above
 * background colours, as the browser paints them.
 */
export const paintOf = (control: Locator) =>
  control.evaluate((el) => {
    const view = el.ownerDocument.defaultView!
    const canvas = el.ownerDocument.createElement('canvas') as unknown as {
      width: number
      height: number
      getContext: (kind: '2d') => {
        clearRect: (...xs: number[]) => void
        fillRect: (...xs: number[]) => void
        fillStyle: string
        getImageData: (...xs: number[]) => { data: ArrayLike<number> }
      }
    }
    canvas.width = canvas.height = 1
    const ink = canvas.getContext('2d')
    const rgba = (css: string) => {
      ink.clearRect(0, 0, 1, 1)
      ink.fillStyle = css
      ink.fillRect(0, 0, 1, 1)
      const [r = 0, g = 0, b = 0, a = 0] = Array.from(ink.getImageData(0, 0, 1, 1).data)
      return [r, g, b, a / 255]
    }
    // A flat gradient's first stop, which is the colour it paints.
    const stopColour = (image: string) => {
      const start = image.indexOf('linear-gradient(')
      if (start === -1) return undefined
      let depth = 0
      for (let at = start + 16; at < image.length; at++) {
        if (image[at] === '(') depth++
        else if (image[at] === ')') depth--
        if (depth === 0 && (image[at] === ',' || image[at] === ')'))
          return rgba(image.slice(start + 16, at).trim())
        if (depth < 0) break
      }
      return undefined
    }
    const layers: number[][] = []
    for (let at: typeof el | null = el; at; at = at.parentElement) {
      const style = view.getComputedStyle(at)
      const stop = stopColour(style.backgroundImage)
      if (stop) layers.push(stop)
      const colour = rgba(style.backgroundColor)
      layers.push(colour)
      if (at !== el && (colour[3] ?? 0) > 0.99) break
    }
    let colour = [255, 255, 255]
    for (const [r = 0, g = 0, b = 0, a = 0] of layers.toReversed())
      colour = [r, g, b].map((value, i) => value * a + (colour[i] ?? 0) * (1 - a))
    const [r = 0, g = 0, b = 0] = colour
    return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
  })

/** A field's outline and ground, as the eye sees them. */
export const fieldLook = (field: Locator) =>
  field.evaluate((el) => {
    const style = el.ownerDocument.defaultView!.getComputedStyle(el)
    return {
      ring: style.boxShadow
        .split(/,(?![^(]*\))/)
        .some(
          (layer: string) =>
            layer.trim().endsWith(' 0px 0px 0px 1px') && !layer.includes('rgba(0, 0, 0, 0)'),
        ),
      shadow: style.boxShadow,
      background: style.backgroundColor,
      height: (el as { offsetHeight: number }).offsetHeight,
      radius: style.borderRadius,
    }
  })

/** The least room any ancestor that clips leaves around a box, px. */
export const ringRoom = (field: Locator) =>
  field.evaluate((el) => {
    const view = el.ownerDocument.defaultView!
    const box = el.getBoundingClientRect()
    let room = Infinity
    for (let up = el.parentElement; up; up = up.parentElement) {
      const style = view.getComputedStyle(up)
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
      const clip = up.getBoundingClientRect()
      // A scroller clips at its padding edge, inside its border.
      const top = clip.top + Number.parseFloat(style.borderTopWidth)
      const bottom = clip.bottom - Number.parseFloat(style.borderBottomWidth)
      const left = clip.left + Number.parseFloat(style.borderLeftWidth)
      room = Math.min(room, box.top - top, bottom - box.bottom, box.left - left)
    }
    return room
  })

/**
 * Every outer ring on the page — a frame or a focus ring, both a
 * `box-shadow` spread outside the box — that an ancestor's clip cuts, or
 * only the focused element's. A control partly scrolled out of a scroller
 * is content, not chrome, and is passed over.
 */
export const cutRings = (page: Page, focusedOnly = false) =>
  page.locator('body').evaluate((body, only) => {
    const doc = body.ownerDocument
    const view = doc.defaultView!
    const cut: string[] = []
    const candidates = only ? [doc.activeElement] : [...doc.querySelectorAll('body *')]
    for (const el of candidates) {
      if (!el) continue
      const style = view.getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      let spread = 0
      for (const part of style.boxShadow.split(/,(?![^(]*\))/)) {
        if (part.includes('inset')) continue
        const ring = /^(.*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px$/.exec(
          part.trim(),
        )
        if (!ring || /rgba\(0, 0, 0, 0\)|\/ 0\)$/.test(ring[1] ?? '')) continue
        if (Number(ring[2]) === 0 && Number(ring[3]) === 0)
          spread = Math.max(spread, Number(ring[5]))
      }
      const box = el.getBoundingClientRect()
      if (spread === 0 || box.width === 0 || box.height === 0) continue
      for (let up = el.parentElement; up; up = up.parentElement) {
        const clip = view.getComputedStyle(up)
        if (clip.overflowX === 'visible' && clip.overflowY === 'visible') continue
        const bounds = up.getBoundingClientRect()
        const left = bounds.left + Number.parseFloat(clip.borderLeftWidth)
        const top = bounds.top + Number.parseFloat(clip.borderTopWidth)
        // A scroller clips at its padding edge, inside its scrollbar too.
        const right = left + up.clientWidth
        const bottom = top + up.clientHeight
        const room = {
          left: box.left - left,
          right: right - box.right,
          top: box.top - top,
          bottom: bottom - box.bottom,
        }
        if (Object.values(room).some((value) => value < -0.5)) break
        const short = Object.entries(room).filter(([, value]) => value < spread - 0.05)
        if (short.length > 0) {
          const name = el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.tagName
          cut.push(`${name}: ${short.map(([side]) => side).join(', ')}`)
          break
        }
      }
    }
    return cut
  }, focusedOnly)

/** Whether this is what the pointer would land on at its own centre. */
export async function paintedAtItsOwnCentre(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const hit = el.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return el === hit || el.contains(hit)
  })
}

/** Whether anything above this element is holding it at zero opacity. */
export async function faded(handle: Locator): Promise<boolean> {
  return handle.evaluate((el) => {
    const view = el.ownerDocument.defaultView!
    for (let node = el.parentElement; node; node = node.parentElement)
      if (Number(view.getComputedStyle(node).opacity) < 0.05) return true
    return false
  })
}

/** Whether an item is on top at its centre (nothing laid over it). */
export const onTop = (item: Locator) =>
  item.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const hit = el.ownerDocument.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    )
    return hit !== null && el.contains(hit)
  })

/** How a control is drawn: the two properties a variant change shows up in. */
export async function paint(locator: Locator): Promise<{ background: string; opacity: string }> {
  return await locator.evaluate((el) => {
    const style = el.ownerDocument.defaultView!.getComputedStyle(el)
    return { background: style.backgroundColor, opacity: style.opacity }
  })
}

/** The drawn height of a band of panel chrome. */
export async function band(locator: Locator): Promise<number> {
  return (await locator.boundingBox())!.height
}
