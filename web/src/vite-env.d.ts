/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Deployed Cloudflare Worker origin that proxies Yahoo Finance and SEC
  // EDGAR requests (see worker/ and docs/providers.md).
  readonly VITE_PROVIDER_PROXY_URL: string;
}
