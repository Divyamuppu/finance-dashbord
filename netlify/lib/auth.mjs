// Shared sign-in helpers for the a-tom Finance dashboard's Netlify functions.
//
// Netlify environment variables:
//   SESSION_SECRET    long random string (32+ characters) used to sign the login cookie — required
//   GOOGLE_CLIENT_ID  OAuth client ID from Google Cloud Console — required for "Sign in with Google"
//   ADMIN_EMAILS      comma-separated emails that are always admins with full access
//
// Roles per person: finance (Overview, Revenue, Expenses), vendors (Vendors page), admin (Access page).

import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const COOKIE = "atom_session";
const MAX_AGE = 400 * 24 * 3600;       // browsers cap cookies at ~400 days; refreshed while in use
export const REFRESH_AFTER = 7 * 24 * 3600;

export const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

export const normEmail = (e) => String(e || "").trim().toLowerCase();
export const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail(e)) && normEmail(e).length <= 254;
const envAdmins = () => new Set(String(process.env.ADMIN_EMAILS || "").split(",").map(normEmail).filter(Boolean));
const secret = () => {
  const s = process.env.SESSION_SECRET || "";
  return s.length >= 32 ? s : null;
};
export const authStore = () => getStore("atom-auth");

// ---------- session cookie (HMAC-signed, HttpOnly) ----------
const hmac = (data) => crypto.createHmac("sha256", secret()).update(data).digest("base64url");
export function issueSession(email) {
  const payload = Buffer.from(JSON.stringify({ e: normEmail(email), iat: Math.floor(Date.now() / 1000) })).toString("base64url");
  return `${COOKIE}=${payload}.${hmac(payload)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}
export const clearSession = `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
export function readSession(req) {
  if (!secret()) return null;
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)atom_session=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  const good = hmac(payload);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!data.e || !data.iat || Date.now() / 1000 - data.iat > MAX_AGE) return null;
  return data;
}

// ---------- users ----------
function withEnvAdmin(email, user) {
  if (!envAdmins().has(normEmail(email))) return user;
  const base = user || { email: normEmail(email), createdAt: Date.now() };
  return { ...base, status: "active", roles: { finance: true, vendors: true, admin: true }, envAdmin: true };
}
export async function getUser(email) {
  const u = await authStore().get("u/" + normEmail(email), { type: "json" });
  return withEnvAdmin(email, u);
}
export async function saveUser(user) {
  const { envAdmin, ...rest } = user;
  rest.email = normEmail(rest.email);
  rest.updatedAt = Date.now();
  await authStore().setJSON("u/" + rest.email, rest);
  return withEnvAdmin(rest.email, rest);
}
export async function listUsers() {
  const { blobs } = await authStore().list({ prefix: "u/" });
  const rows = (await Promise.all(blobs.map((b) => authStore().get(b.key, { type: "json" })))).filter(Boolean);
  const seen = new Set(rows.map((u) => u.email));
  for (const e of envAdmins()) if (!seen.has(e)) rows.push({ email: e, createdAt: 0 });
  return rows.map((u) => withEnvAdmin(u.email, u));
}
export const publicUser = (u) => ({
  email: u.email, name: u.name || "", picture: u.picture || "", status: u.status || "pending",
  roles: { finance: !!u.roles?.finance, vendors: !!u.roles?.vendors, admin: !!u.roles?.admin },
  hasPassword: !!u.passwordHash, envAdmin: !!u.envAdmin,
  requestedAt: u.requestedAt || null, approvedBy: u.approvedBy || null, lastLoginAt: u.lastLoginAt || null,
});

// ---------- guards ----------
export function sameOrigin(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === new URL(req.url).host; } catch { return false; }
}
export async function currentUser(req) {
  if (!secret()) return { error: json({ error: "Sign-in is not set up yet — add SESSION_SECRET in Netlify environment variables.", code: "setup" }, 503) };
  const s = readSession(req);
  if (!s) return { error: json({ error: "Please sign in.", code: "signin" }, 401) };
  const user = await getUser(s.e);
  if (!user) return { error: json({ error: "Please sign in.", code: "signin" }, 401, { "set-cookie": clearSession }) };
  return { user, session: s };
}
// For data APIs: signed in, approved, and holding the role. State-changing calls must come from this site.
export async function requireRole(req, role) {
  const r = await currentUser(req);
  if (r.error) return r;
  if (r.user.status !== "active" || !r.user.roles?.[role]) return { error: json({ error: "You don't have access to this section.", code: "forbidden" }, 403) };
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return { error: json({ error: "Blocked a request from another site." }, 403) };
  return r;
}

// ---------- passwords (scrypt) ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}
export function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const got = crypto.scryptSync(pw, Buffer.from(salt, "base64"), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(hash, "base64");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
export function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "Use at least 8 characters.";
  if (pw.length > 200) return "That password is too long.";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "Use letters and at least one number.";
  return null;
}

// ---------- Google ID token ----------
let jwks = null, jwksAt = 0;
async function googleKeys(force) {
  if (!force && jwks && Date.now() - jwksAt < 3600e3) return jwks;
  const r = await fetch(process.env.GOOGLE_JWKS_URL || "https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw new Error("Could not reach Google to check the sign-in.");
  jwks = (await r.json()).keys || [];
  jwksAt = Date.now();
  return jwks;
}
export async function verifyGoogleToken(token) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("Google sign-in is not set up — add GOOGLE_CLIENT_ID in Netlify.");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid Google sign-in.");
  const [h, p, s] = parts;
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch { throw new Error("Invalid Google sign-in."); }
  if (header.alg !== "RS256") throw new Error("Invalid Google sign-in.");
  let key = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!key) key = (await googleKeys(true)).find((k) => k.kid === header.kid);
  if (!key) throw new Error("Invalid Google sign-in.");
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) throw new Error("Invalid Google sign-in.");
  const now = Math.floor(Date.now() / 1000);
  if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) throw new Error("Invalid Google sign-in.");
  if (claims.aud !== clientId) throw new Error("This Google sign-in was made for a different app.");
  if (!claims.exp || claims.exp < now - 60) throw new Error("Google sign-in expired — try again.");
  if (!claims.email || claims.email_verified !== true && claims.email_verified !== "true") throw new Error("Your Google email isn't verified.");
  return { email: normEmail(claims.email), name: claims.name || "", picture: claims.picture || "" };
}
