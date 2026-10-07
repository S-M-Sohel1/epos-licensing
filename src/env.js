import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    AUTH_SECRET:
      process.env.NODE_ENV === "production"
        ? z.string()
        : z.string().optional(),
    DATABASE_URL: z.string().url(),
    /** Session-mode pooler, used by Prisma for migrations only. */
    DIRECT_URL: z.string().url().optional(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    /**
     * PKCS#8 PEM for the production RSA-2048 signing key. Every `.lic` file and
     * every signed blob returned from /api/activate and /api/checkin is signed
     * with it, and the WPF client verifies against the matching public key
     * compiled into `Pos.Core/Services/LicenseBlobSigning.cs`.
     *
     * Newlines may be written as literal `\n`, which is what Vercel's env UI
     * produces for multi-line values; `getSigningKey()` unescapes them. This
     * value is a secret: it lives only in the environment, never in the repo,
     * and is never logged or surfaced in the admin panel.
     */
    LICENSE_SIGNING_PRIVATE_KEY: z
      .string()
      .refine((v) => v.includes("BEGIN PRIVATE KEY"), {
        message:
          "must be a PKCS#8 PEM private key (-----BEGIN PRIVATE KEY-----)",
      }),

    /**
     * Shared with the corporate website's server (its INTERNAL_API_SECRET):
     * the bearer secret for the few routes here whose reply only that server
     * may have, such as a password-reset link token. Unset, those routes
     * answer 503. It is also what this service presents when it calls that
     * server (see WEB_PLATFORM_URL). At least 16 characters.
     */
    INTERNAL_API_SECRET: z.string().min(16).optional(),

    /** Seed-only. Used by `pnpm db:seed` to create the single admin login. */
    ADMIN_EMAIL: z.string().email().optional(),
    ADMIN_PASSWORD: z.string().min(8).optional(),

    /**
     * Cloudflare R2, where product pictures a till publishes are stored
     * (keyed `{shopId}/{hash}.{ext}`). R2 speaks the S3 API. All five are
     * optional: until they are set the picture endpoints answer 503 and the
     * rest of catalogue sync works without pictures.
     */
    R2_ACCOUNT_ID: z.string().min(1).optional(),
    R2_BUCKET: z.string().min(1).optional(),
    R2_ACCESS_KEY_ID: z.string().min(1).optional(),
    /** A secret: server environment only. */
    R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** Where the bucket is served from publicly, no trailing slash — an r2.dev address or a custom domain. */
    R2_PUBLIC_BASE_URL: z.string().url().optional(),

    /**
     * The address of the web platform: the ONE deployment of epos_corporate_web
     * that serves the corporate site and every shop's storefront. A single
     * value for the whole platform, e.g. "https://epos-365.com", no trailing
     * slash.
     *
     * NOT a shop's storefront address. Shops' storefronts are subdomains of
     * this deployment, and this service never calls one of those: it calls
     * `<WEB_PLATFORM_URL>/api/internal/pos-catalog/apply` and names the shop
     * in the request body.
     *
     * Used, with INTERNAL_API_SECRET, to tell that app a till has published,
     * so the shop's menu updates at once. Both optional: without them the
     * menu still catches up within a minute from that app's own sweep.
     */
    WEB_PLATFORM_URL: z.string().url().optional(),
    /**
     * For the till's order nudge over Supabase Realtime. The same three values
     * the corporate website's server holds: the project URL, its publishable
     * key, and the private signing key (a JWK with a `kid`) whose tokens
     * Realtime accepts. Whoever holds the signing key can mint a token for any
     * shop, so it lives only in server environments. All optional: without
     * them a till is told there is no live channel and asks once a minute.
     */
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
    REALTIME_SIGNING_KEY: z.string().min(1).optional(),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {},

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    AUTH_SECRET: process.env.AUTH_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_URL: process.env.DIRECT_URL,
    NODE_ENV: process.env.NODE_ENV,
    LICENSE_SIGNING_PRIVATE_KEY: process.env.LICENSE_SIGNING_PRIVATE_KEY,
    INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
    R2_BUCKET: process.env.R2_BUCKET,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_PUBLIC_BASE_URL: process.env.R2_PUBLIC_BASE_URL,
    WEB_PLATFORM_URL: process.env.WEB_PLATFORM_URL,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
    REALTIME_SIGNING_KEY: process.env.REALTIME_SIGNING_KEY,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for Docker builds.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
