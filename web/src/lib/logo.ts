/**
 * Company logo marks.
 *
 * A logo is not part of any financial provider's answer: Yahoo, SEC EDGAR and
 * Alpha Vantage return numbers, names and dates, never artwork. The mark is
 * therefore an ordinary image, requested straight from a logo host keyed by
 * ticker symbol. An <img> needs no CORS grant, so unlike provider traffic it
 * does not go through the Worker proxy, and nothing about it is saved to the
 * browser. Point VITE_TICKER_LOGO_URL at another host to change that, or set
 * it empty to request no logos at all; every company then wears the monogram
 * below, which is also what a company whose logo the host does not have gets.
 */
const DEFAULT_LOGO_URL =
  "https://assets.parqet.com/logos/symbol/{ticker}?format=png&size=128";

/** The logo image for a ticker, or null when no host is configured. */
export function logoUrl(ticker: string): string | null {
  const template = import.meta.env.VITE_TICKER_LOGO_URL ?? DEFAULT_LOGO_URL;
  const symbol = ticker.trim().toUpperCase();
  if (!template || !symbol) {
    return null;
  }
  const encoded = encodeURIComponent(symbol);
  return template
    .replaceAll("{ticker}", encoded)
    .replaceAll("{ticker_lower}", encoded.toLowerCase());
}

/**
 * The letters drawn when there is no image: the ticker's own opening letters,
 * since that is what the reader typed, falling back to the company name for a
 * symbol that carries no letters at all.
 */
export function monogram(ticker: string, name: string): string {
  const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
  const source = letters(ticker) || letters(name);
  return source.slice(0, 2) || "?";
}

/**
 * A hue for that monogram, fixed by the symbol so one company keeps one
 * colour across reloads and sits apart from the company beside it.
 */
export function monogramHue(ticker: string): number {
  let hash = 7;
  for (const character of ticker.toUpperCase()) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 360;
  }
  return hash;
}
