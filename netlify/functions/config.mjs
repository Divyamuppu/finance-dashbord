// Public, non-secret config for the Finance dashboard.
// Set VENDOR_DASHBOARD_URL in Netlify → Site configuration → Environment variables
// (e.g. https://collective-pnl.onrender.com). When unset, the Vendors link stays hidden.
const safeUrl = (value) => {
  try {
    const u = new URL(String(value || "").trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
};

export default async (req) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  return Response.json(
    { vendorUrl: safeUrl(process.env.VENDOR_DASHBOARD_URL) },
    { headers: { "cache-control": "no-store" } }
  );
};

export const config = { path: "/api/config" };
