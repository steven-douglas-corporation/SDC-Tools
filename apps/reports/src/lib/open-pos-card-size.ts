"use client";

// Open POs' card size (Cards view), per browser like the app's other display preferences.
// One step scales both ways at once: the card's width (`min`, the grid's narrowest card, so
// how many fit to a row) and the height of its PO list (`list`, so how many POs show before
// it scrolls). Step 2 is the size the cards were before the slider (2026-11-17).
export const CARD_SIZES: readonly { min: number; list: number }[] = [
  { min: 300, list: 176 },
  { min: 340, list: 232 },
  { min: 380, list: 288 },
  { min: 460, list: 384 },
  { min: 560, list: 480 },
];
export const DEFAULT_CARD_SIZE = 2;

const KEY = "open-pos-card-size";
const EVENT = "open-pos-card-size-change";

/** A stored step; anything missing or out of range is the default. */
export function parseCardSize(raw: string | null): number {
  if (raw == null || raw.trim() === "") return DEFAULT_CARD_SIZE;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < CARD_SIZES.length ? n : DEFAULT_CARD_SIZE;
}

export function readCardSize(): number {
  try {
    return parseCardSize(window.localStorage.getItem(KEY));
  } catch {
    return DEFAULT_CARD_SIZE;
  }
}

/** The server render (no localStorage): the default, until the browser reads its own. */
export function serverCardSize(): number {
  return DEFAULT_CARD_SIZE;
}

export function writeCardSize(step: number): void {
  try {
    window.localStorage.setItem(KEY, String(parseCardSize(String(step))));
  } catch {
    return;
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeCardSize(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
