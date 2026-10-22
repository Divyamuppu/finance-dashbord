import { getStore } from "@netlify/blobs";

export default async (req) => {
  const store = getStore("atom-finance");
  if (req.method === "GET") {
    const data = (await store.get("workbook", { type: "json" })) || {};
    return Response.json(data, { headers: { "cache-control": "no-store" } });
  }
  if (req.method === "PUT") {
    const key = req.headers.get("x-admin-key") || "";
    if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
    let body;
    try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
    await store.setJSON("workbook", { imports: body.imports || {}, added: body.added || { revenue: [], expenses: [] }, updatedAt: Date.now() });
    return Response.json({ ok: true });
  }
  return new Response("Method not allowed", { status: 405 });
};

export const config = { path: "/api/workbook" };
