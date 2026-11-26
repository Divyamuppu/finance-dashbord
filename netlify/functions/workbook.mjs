// Published finance workbook (revenue + expenses). Only people with Finance access can read or publish it.
import { getStore } from "@netlify/blobs";
import { json, requireRole } from "../lib/auth.mjs";

export default async (req) => {
  const auth = await requireRole(req, "finance");
  if (auth.error) return auth.error;
  const store = getStore("atom-finance");
  try {
    if (req.method === "GET") {
      const data = (await store.get("workbook", { type: "json" })) || {};
      return json(data);
    }
    if (req.method === "PUT") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
      if (!body || typeof body !== "object") return json({ error: "Bad JSON" }, 400);
      await store.setJSON("workbook", {
        imports: body.imports && typeof body.imports === "object" ? body.imports : {},
        added: body.added && Array.isArray(body.added.revenue) ? body.added : { revenue: [], expenses: [] },
        updatedAt: Date.now(),
        updatedBy: auth.user.email,
      });
      return json({ ok: true });
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("workbook api", err);
    return json({ error: "Server error — please try again." }, 500);
  }
};

export const config = { path: "/api/workbook" };
