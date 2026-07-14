import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

interface LocalStorageOptions<T> {
  serialize?: (value: T) => string;
  deserialize?: (value: string) => T;
}

const serializeJson = <T,>(value: T) => JSON.stringify(value);
const deserializeJson = <T,>(value: string) => JSON.parse(value) as T;

function resolveInitialValue<T>(initialValue: T | (() => T)): T {
  return typeof initialValue === "function"
    ? (initialValue as () => T)()
    : initialValue;
}

export function useLocalStorage<T>(
  key: string,
  initialValue: T | (() => T),
  options: LocalStorageOptions<T> = {},
): [T, Dispatch<SetStateAction<T>>] {
  const serialize = options.serialize ?? serializeJson<T>;
  const deserialize = options.deserialize ?? deserializeJson<T>;
  const initialValueRef = useRef(initialValue);

  const [value, setValueState] = useState<T>(() => {
    const fallback = resolveInitialValue(initialValueRef.current);
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? fallback : deserialize(stored);
    } catch {
      return fallback;
    }
  });
  const valueRef = useRef(value);

  const setValue = useCallback<Dispatch<SetStateAction<T>>>((nextValue) => {
    const next = typeof nextValue === "function"
      ? (nextValue as (previous: T) => T)(valueRef.current)
      : nextValue;
    valueRef.current = next;
    setValueState(next);
    try {
      localStorage.setItem(key, serialize(next));
    } catch {
      // State still updates for this session when storage is unavailable.
    }
  }, [key, serialize]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.key !== key) return;
      if (event.newValue === null) {
        const fallback = resolveInitialValue(initialValueRef.current);
        valueRef.current = fallback;
        setValueState(fallback);
        return;
      }
      try {
        const next = deserialize(event.newValue);
        valueRef.current = next;
        setValueState(next);
      } catch {
        // Ignore malformed values written by another tab or an older app version.
      }
    };

    globalThis.addEventListener("storage", onStorage);
    return () => globalThis.removeEventListener("storage", onStorage);
  }, [key, deserialize]);

  return [value, setValue];
}
