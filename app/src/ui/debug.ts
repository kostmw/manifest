/**
 * Hidden settings for phone tests. `?debug=1` shows per-stage timings and
 * quality measurements on the device, `?debug=0` hides them again; choices
 * are remembered, so they survive opening the installed app from the home
 * screen (whose start URL has no query).
 */
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * A hidden setting from the query string, remembered: `?name=value` sets it,
 * `?name=0` clears it. Returns the remembered value, or null.
 */
function rememberedSetting(name: string, allowed: readonly string[], search: string, store?: Store): string | null {
  const asked = new URLSearchParams(search).get(name);
  const key = `manifest-${name}`;
  try {
    const storage = store ?? globalThis.localStorage;
    if (asked !== null && allowed.includes(asked)) storage.setItem(key, asked);
    else if (asked === '0') storage.removeItem(key);
    const value = storage.getItem(key);
    return value !== null && allowed.includes(value) ? value : null;
  } catch {
    // Storage can be blocked (private mode); the query alone still works for this page.
    return asked !== null && allowed.includes(asked) ? asked : null;
  }
}

export function debugEnabled(search: string = globalThis.location?.search ?? '', store?: Store): boolean {
  return rememberedSetting('debug', ['1'], search, store) === '1';
}

/**
 * The live camera's resolution: 720p unless `?camera=1080` asked for more.
 * 1080p gives the collector line more pixels but costs more per frame; this
 * lets a phone test compare the two with the debug readout.
 */
export function cameraResolution(search: string = globalThis.location?.search ?? '', store?: Store): 720 | 1080 {
  return rememberedSetting('camera', ['1080'], search, store) === '1080' ? 1080 : 720;
}

/** "detect 41 · ocr 180 · total 412" from stage timings, in the order they ran. */
export function formatTimings(timings: Record<string, number>): string {
  return Object.entries(timings)
    .filter(([, ms]) => Number.isFinite(ms))
    .map(([stage, ms]) => `${stage} ${Math.round(ms)}`)
    .join(' · ');
}

/** Turns a remembered setting on (`value`) or off (null). Returns false when storage is blocked. */
function remember(name: string, value: string | null, store?: Store): boolean {
  try {
    const storage = store ?? globalThis.localStorage;
    if (value === null) storage.removeItem(`manifest-${name}`);
    else storage.setItem(`manifest-${name}`, value);
    return true;
  } catch {
    return false;
  }
}

/** The in-app switch for the timings readout (iOS home-screen apps don't share Safari's storage, or its address bar). */
export function setDebugEnabled(on: boolean, store?: Store): boolean {
  return remember('debug', on ? '1' : null, store);
}

/** The in-app switch for the live camera's resolution; it applies the next time the camera starts. */
export function setCameraResolution(resolution: 720 | 1080, store?: Store): boolean {
  return remember('camera', resolution === 1080 ? '1080' : null, store);
}
