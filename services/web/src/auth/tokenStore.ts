/*
 * Where the development token lives (arch §8.3): in memory, mirrored to
 * `sessionStorage` so a reload keeps the session and closing the tab ends it.
 * Never `localStorage`, cookies, URLs, logs or `VITE_*` variables.
 *
 * Every storage access is wrapped: `sessionStorage` can throw or be missing
 * (private windows, blocked site data). Then the token simply lives in memory
 * and a reload signs the user out.
 */
export const SESSION_TOKEN_KEY = "cbdc.devToken";

export type TokenStore = {
  get(): string | null;
  set(token: string): void;
  clear(): void;
};

function defaultStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function createTokenStore(getStorage: () => Storage | null = defaultStorage): TokenStore {
  let memory: string | null = null;

  return {
    get() {
      if (memory !== null) return memory;
      try {
        const stored = getStorage()?.getItem(SESSION_TOKEN_KEY) ?? null;
        memory = stored !== null && stored !== "" ? stored : null;
      } catch {
        memory = null;
      }
      return memory;
    },
    set(token) {
      memory = token;
      try {
        getStorage()?.setItem(SESSION_TOKEN_KEY, token);
      } catch {
        // Memory only.
      }
    },
    clear() {
      memory = null;
      try {
        getStorage()?.removeItem(SESSION_TOKEN_KEY);
      } catch {
        // Nothing to clear.
      }
    },
  };
}

/** The app's token store. */
export const tokenStore: TokenStore = createTokenStore();
