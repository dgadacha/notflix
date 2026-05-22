/**
 * Global build-time constants.
 *
 * Notflix only ships a web build — no Electron desktop wrapper, no mobile
 * native shell. These flags exist for compatibility with the inherited
 * Seanime code that still branches on them; they all evaluate to false.
 */
export const __isElectronDesktop__ = false
export const __isDesktop__ = false
export const __clientPlatform__: string = "web"

/** Debug toggle from upstream Seanime — kept off in Notflix. */
export const HIDE_IMAGES = false
