// What the suite tells every engine it starts about its release. The engine
// learns its release from the distribution that launches it, so the suite
// declares one: that is the only way the console's engine badge has a
// version to show, and the only honest way to test the handoff.

/** The release the suite tells the engine it ships as. */
export const RELEASE_VERSION = '0.2.0-e2e.1'
/** The engine source commit the suite declares, shortened in the console. */
export const ENGINE_REVISION = '63d554c15f2699cf623c7fac19a4d1393c77f322'

/** The engine environment that carries them. */
export const RELEASE_ENV = {
  FIRENOOK_RELEASE_VERSION: RELEASE_VERSION,
  FIRENOOK_ENGINE_REVISION: ENGINE_REVISION,
}
