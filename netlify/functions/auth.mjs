// Sign-in and access management.
//   GET    /api/auth/me                 who is signed in (+ Google client ID for the sign-in button)
//   POST   /api/auth/google             { credential }          sign in with a Google ID token
//   POST   /api/auth/login              { email, password }     sign in with a password the person set
//   POST   /api/auth/password           { password, current? }  set / change your own password
//   POST   /api/auth/logout
//   GET    /api/auth/users              admin: everyone who has signed in or been granted access
//   PUT    /api/auth/users/:email       admin: { status: "active"|"denied", roles: { finance, vendors, admin } }
//   DELETE /api/auth/users/:email       admin: remove the person (they can request again later)
import {
  json, normEmail, isEmail, issueSession, clearSession, readSession, getUser, saveUser, listUsers, publicUser,
  currentUser, sameOrigin, hashPassword, checkPassword, passwordProblem, verifyGoogleToken, authStore, REFRESH_AFTER,
} from "../lib/auth.mjs";

const LOCK_AFTER = 5, LOCK_MINUTES = 15;

async function body(req) {
  try { const b = await req.json(); return b && typeof b === "object" ? b : {}; } catch { return {}; }
}
const signedIn = (user, extraHeaders = {}) => json({ user: publicUser(user) }, 200, { "set-cookie": issueSession(user.email), ...extraHeaders });

export default async (req) => {
  const path = new URL(req.url).pathname.replace(/^\/api\/auth\/?/, "");
  const [route, arg] = path.split("/");
  if (req.method !== "GET" && !sameOrigin(req)) return json({ error: "Blocked a request from another site." }, 403);
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    if (route === "me") return json({ user: null, googleClientId: process.env.GOOGLE_CLIENT_ID || null, setupError: "Sign-in is not set up yet — add SESSION_SECRET (32+ characters) in Netlify environment variables." });
    return json({ error: "Sign-in is not set up yet — add SESSION_SECRET in Netlify environment variables." }, 503);
  }

  try {
    // ----- who am I -----
    if (route === "me" && req.method === "GET") {
      const googleClientId = process.env.GOOGLE_CLIENT_ID || null;
      const s = readSession(req);
      if (!s) return json({ user: null, googleClientId });
      const user = await getUser(s.e);
      if (!user) return json({ user: null, googleClientId }, 200, { "set-cookie": clearSession });
      // keep people signed in until they log out: refresh the cookie while they use the site
      const refresh = Date.now() / 1000 - s.iat > REFRESH_AFTER ? { "set-cookie": issueSession(user.email) } : {};
      return json({ user: publicUser(user), googleClientId }, 200, refresh);
    }

    // ----- Google -----
    if (route === "google" && req.method === "POST") {
      const { credential } = await body(req);
      let g;
      try { g = await verifyGoogleToken(credential); } catch (e) { return json({ error: e.message }, 401); }
      let user = await getUser(g.email);
      const now = Date.now();
      if (!user) user = { email: g.email, status: "pending", roles: {}, requestedAt: now, createdAt: now }; // new person → access request
      user = await saveUser({ ...user, name: g.name || user.name, picture: g.picture || user.picture, lastLoginAt: now });
      return signedIn(user);
    }

    // ----- email + password -----
    if (route === "login" && req.method === "POST") {
      const { email, password } = await body(req);
      const generic = json({ error: "Wrong email or password." }, 401);
      if (!isEmail(email) || typeof password !== "string") return generic;
      let user = await getUser(email);
      if (!user || !user.passwordHash) return generic;
      if (user.lockedUntil && user.lockedUntil > Date.now()) {
        const mins = Math.ceil((user.lockedUntil - Date.now()) / 60000);
        return json({ error: `Too many wrong attempts — try again in ${mins} minute${mins === 1 ? "" : "s"}.` }, 429);
      }
      if (!checkPassword(password, user.passwordHash)) {
        const failed = (user.failedLogins || 0) + 1;
        await saveUser({ ...user, failedLogins: failed >= LOCK_AFTER ? 0 : failed, lockedUntil: failed >= LOCK_AFTER ? Date.now() + LOCK_MINUTES * 60000 : null });
        return generic;
      }
      if (user.status !== "active") return json({ error: "Your access hasn't been approved yet." }, 403);
      user = await saveUser({ ...user, failedLogins: 0, lockedUntil: null, lastLoginAt: Date.now() });
      return signedIn(user);
    }

    // ----- set / change own password -----
    if (route === "password" && req.method === "POST") {
      const r = await currentUser(req);
      if (r.error) return r.error;
      if (r.user.status !== "active") return json({ error: "Your access hasn't been approved yet." }, 403);
      const { password, current } = await body(req);
      if (r.user.passwordHash && !checkPassword(String(current || ""), r.user.passwordHash)) return json({ error: "Your current password is wrong.", fields: { current: "Wrong password." } }, 400);
      const problem = passwordProblem(password);
      if (problem) return json({ error: problem, fields: { password: problem } }, 400);
      const user = await saveUser({ ...r.user, passwordHash: hashPassword(password), failedLogins: 0, lockedUntil: null });
      return json({ user: publicUser(user) });
    }

    if (route === "logout" && req.method === "POST") return json({ ok: true }, 200, { "set-cookie": clearSession });

    // ----- admin: manage people -----
    if (route === "users") {
      const r = await currentUser(req);
      if (r.error) return r.error;
      if (r.user.status !== "active" || !r.user.roles?.admin) return json({ error: "Only admins can manage access." }, 403);
      if (req.method === "GET" && !arg) {
        const people = (await listUsers()).map(publicUser).sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || a.email.localeCompare(b.email));
        return json({ users: people, me: r.user.email });
      }
      const email = normEmail(decodeURIComponent(arg || ""));
      if (!isEmail(email)) return json({ error: "Not found." }, 404);
      const target = await getUser(email);
      if (target?.envAdmin) return json({ error: "This person is an admin set in Netlify (ADMIN_EMAILS) — change it there." }, 400);
      if (req.method === "PUT") {
        const { status, roles = {} } = await body(req);
        if (!["active", "denied"].includes(status)) return json({ error: "Choose approve or deny." }, 400);
        const next = { finance: !!roles.finance, vendors: !!roles.vendors, admin: !!roles.admin };
        if (status === "active" && !next.finance && !next.vendors && !next.admin) return json({ error: "Tick Finance, Vendors or Admin to give access." }, 400);
        if (email === r.user.email && (!next.admin || status !== "active")) return json({ error: "You can't remove your own admin access." }, 400);
        const now = Date.now();
        const base = target || { email, createdAt: now, requestedAt: null }; // admins can also pre-approve someone by email
        const user = await saveUser({ ...base, status, roles: status === "active" ? next : {}, approvedBy: r.user.email, approvedAt: now });
        return json({ user: publicUser(user) });
      }
      if (req.method === "DELETE") {
        if (email === r.user.email) return json({ error: "You can't remove yourself." }, 400);
        await authStore().delete("u/" + email);
        return json({ ok: true });
      }
    }
    return json({ error: "Not found." }, 404);
  } catch (err) {
    console.error("auth api", err);
    return json({ error: "Server error — please try again." }, 500);
  }
};

export const config = { path: ["/api/auth/*"] };
