// The function inspector (`run-side-panel.tsx`), loaded on first use: the
// workbench renders it through `lazy`, and asks for it as soon as a
// function is open, so it arrives alongside the function's detail.

import { lazy } from 'react'

const load = () => import('./run-side-panel')

/** Starts loading the inspector; the module is fetched once. */
export function preloadInspector(): void {
  void load()
}

export const RunSidePanel = lazy(() => load().then((module) => ({ default: module.RunSidePanel })))
