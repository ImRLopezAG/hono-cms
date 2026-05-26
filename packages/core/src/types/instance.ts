import type { Hono } from "hono";

export type HonoCMSEnv = {
  Variables: {
    /**
     * Opaque identity set by the installed AuthPlugin's `protected`
     * middleware. Core treats it as `unknown`; plugins narrow it.
     */
    identity: unknown;
  };
};

export type CMSAppLike = Hono<HonoCMSEnv>;
