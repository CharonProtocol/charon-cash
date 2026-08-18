import { beforeEach } from "vitest"

const storage = new Map<string, string>()

beforeEach(() => {
  // Clear the storage before each test
  storage.clear()

  // Provide a complete localStorage mock
  globalThis.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    get length() {
      return storage.size
    },
    key: (index: number) => {
      const keys = Array.from(storage.keys())
      return keys[index] ?? null
    },
  } as Storage
})
