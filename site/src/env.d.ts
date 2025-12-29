/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  readonly GITHUB_CLIENT_ID: string;
  readonly GITHUB_CLIENT_SECRET: string;
  readonly AUTH_SECRET: string;
  readonly AUTH_TRUST_HOST: string;
  readonly STROLLCAST_API_KEY: string;
  readonly STROLLCAST_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
