/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Deployed Cloudflare Worker origin that proxies Yahoo Finance and SEC
  // EDGAR requests (see worker/ and docs/providers.md).
  readonly VITE_PROVIDER_PROXY_URL: string;
  // Logo host for the company mark at the top of the dashboard, with
  // {ticker} (or {ticker_lower}) standing in for the symbol. Unset uses the
  // default host; empty asks for no logos at all (see lib/logo.ts).
  readonly VITE_TICKER_LOGO_URL?: string;
}
