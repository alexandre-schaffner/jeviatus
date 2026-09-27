// One-time token setup for the platforms whose tokens come from an OAuth
// consent screen (social/README.md). Prints the lines to put in .env; stores
// nothing and posts nothing.
//
//   bun social/auth.ts youtube                 (YOUTUBE_CLIENT_ID/SECRET in env)
//   bun social/auth.ts tiktok [--code <code>]  (TIKTOK_CLIENT_KEY/SECRET, TIKTOK_REDIRECT_URI)
//   bun social/auth.ts instagram [--code <c>]  (IG_APP_ID, IG_APP_SECRET, IG_REDIRECT_URI)
//
// X (console access token + secret) and Reddit (script app, password grant)
// need no consent screen.

import { parseArgs } from "node:util";
import { form, json } from "./common";
import { YT_SCOPE } from "./youtube";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { code: { type: "string" }, port: { type: "string", default: "8765" } } });
const env = process.env;
const need = (...keys: string[]) => {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`set ${missing.join(", ")} first (see social/README.md)`);
    process.exit(1);
  }
};

async function youtube(): Promise<void> {
  need("YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET");
  // Desktop-app clients may redirect to any loopback port.
  const redirect = `http://127.0.0.1:${values.port}/callback`;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${form({ client_id: env.YOUTUBE_CLIENT_ID!, redirect_uri: redirect, response_type: "code", scope: YT_SCOPE, access_type: "offline", prompt: "consent" })}`;
  console.log(`Open this, sign in with the channel's Google account, and allow uploads:\n\n${url}\n`);
  const code = await new Promise<string>((resolve) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(values.port),
      fetch(req) {
        const c = new URL(req.url).searchParams.get("code");
        if (!c) return new Response("waiting for Google's redirect", { status: 400 });
        setTimeout(() => server.stop(), 100);
        resolve(c);
        return new Response("Done: go back to the terminal.");
      },
    });
  });
  const t = await json<{ refresh_token?: string }>("youtube code exchange", "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ code, client_id: env.YOUTUBE_CLIENT_ID!, client_secret: env.YOUTUBE_CLIENT_SECRET!, redirect_uri: redirect, grant_type: "authorization_code" }),
  });
  if (!t.refresh_token) throw new Error("no refresh_token returned (revoke the app's access at myaccount.google.com/permissions and retry)");
  console.log(`\nAdd to .env:\nYOUTUBE_REFRESH_TOKEN=${t.refresh_token}`);
}

async function tiktok(): Promise<void> {
  need("TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REDIRECT_URI");
  if (!values.code) {
    const scope = env.TIKTOK_MODE === "direct" ? "user.info.basic,video.publish" : "user.info.basic,video.upload";
    console.log(`Open this, log in as the TikTok account, approve, then copy the "code" parameter from the page you land on:\n\nhttps://www.tiktok.com/v2/auth/authorize/?${form({ client_key: env.TIKTOK_CLIENT_KEY!, scope, response_type: "code", redirect_uri: env.TIKTOK_REDIRECT_URI!, state: "jev" })}\n\nthen: bun social/auth.ts tiktok --code <code>`);
    return;
  }
  const t = await json<{ refresh_token?: string; refresh_expires_in?: number; error?: string; error_description?: string }>("tiktok code exchange", "https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ client_key: env.TIKTOK_CLIENT_KEY!, client_secret: env.TIKTOK_CLIENT_SECRET!, code: decodeURIComponent(values.code), grant_type: "authorization_code", redirect_uri: env.TIKTOK_REDIRECT_URI! }),
  });
  if (!t.refresh_token) throw new Error(`tiktok: ${t.error ?? "no refresh_token"} ${t.error_description ?? ""}`);
  console.log(`Add to .env (valid ${Math.round((t.refresh_expires_in ?? 0) / 86400)} days; the poster keeps rotating it):\nTIKTOK_REFRESH_TOKEN=${t.refresh_token}`);
}

async function instagram(): Promise<void> {
  need("IG_APP_ID", "IG_APP_SECRET", "IG_REDIRECT_URI");
  if (!values.code) {
    console.log(`Open this, log in as the Instagram professional account, allow, then copy the "code" parameter (drop the trailing #_):\n\nhttps://www.instagram.com/oauth/authorize?${form({ client_id: env.IG_APP_ID!, redirect_uri: env.IG_REDIRECT_URI!, response_type: "code", scope: "instagram_business_basic,instagram_business_content_publish" })}\n\nthen: bun social/auth.ts instagram --code <code>`);
    return;
  }
  const short = await json<{ access_token?: string; user_id?: number | string }>("instagram code exchange", "https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ client_id: env.IG_APP_ID!, client_secret: env.IG_APP_SECRET!, grant_type: "authorization_code", redirect_uri: env.IG_REDIRECT_URI!, code: values.code.replace(/#_$/, "") }),
  });
  if (!short.access_token) throw new Error("instagram: no access token");
  const long = await json<{ access_token?: string; expires_in?: number }>("instagram long-lived token", `https://graph.instagram.com/access_token?${form({ grant_type: "ig_exchange_token", client_secret: env.IG_APP_SECRET!, access_token: short.access_token })}`);
  const me = await json<{ user_id?: string; id?: string }>("instagram me", `https://graph.instagram.com/v25.0/me?${form({ fields: "user_id,username", access_token: long.access_token! })}`);
  console.log(`Add to .env (the token lasts ${Math.round((long.expires_in ?? 0) / 86400)} days; the poster refreshes it):\nIG_USER_ID=${me.user_id ?? me.id ?? short.user_id}\nIG_ACCESS_TOKEN=${long.access_token}`);
}

const which = positionals[0];
if (which === "youtube") await youtube();
else if (which === "tiktok") await tiktok();
else if (which === "instagram") await instagram();
else {
  console.error("usage: bun social/auth.ts youtube|tiktok|instagram [--code <code>]");
  process.exit(1);
}
