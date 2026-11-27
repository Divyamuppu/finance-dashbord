// Vendor payables API for the a-tom Finance dashboard.
//
// Routes (need a signed-in person with Vendors access):
//   GET    /api/vendors                 list vendors (viewer or editor)
//   POST   /api/vendors                 create — multipart: "data" (JSON) + optional "invoice" (PDF; omitted for manual entries)
//   PUT    /api/vendors/:id             update  (editor) — multipart: "data" (JSON) + optional "invoice" (PDF)
//   PATCH  /api/vendors/:id             change payment status only — JSON { paymentStatus, amountPaid? }
//   POST   /api/vendors/import          bulk add from Excel — JSON { vendors: [...] } (rows may be incomplete; flagged needsDetails)
//   DELETE /api/vendors/:id             delete  (editor)
//   GET    /api/vendors/:id/invoice     download the invoice PDF (viewer or editor)
//

import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";
import { requireRole } from "../lib/auth.mjs";

const STORE = "atom-vendors";
const MAX_PDF_BYTES = 4.5 * 1024 * 1024; // Netlify function payloads are capped at 6 MB
const STATUSES = ["unpaid", "half", "custom", "paid"];
// can be left blank; everything else is required
const OPTIONAL = new Set(["vendorName", "poc", "contactNumber", "invoiceDate", "shootDate", "deadline"]);

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

// ---------- validation (mirrors the form; the server is the source of truth) ----------
const isoDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z"));
const text = (v, min, max) => typeof v === "string" && v.trim().length >= min && v.trim().length <= max;

const FIELD_LABELS = {
  project: "Project",
  vendorName: "Name of the vendor",
  service: "Service of the vendor",
  invoiceDate: "Invoice date",
  shootDate: "Shoot date",
  deadline: "Due date",
  amount: "Amount",
  quarter: "Quarter",
  poc: "POC",
  bankDetails: "Bank details",
  contactNumber: "Contact number",
  paymentStatus: "Payment status",
  amountPaid: "Amount paid",
  approvedBy: "Approved by / Project manager",
  invoice: "Invoice PDF",
};

function quarterOf(iso) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  const fy = m >= 4 ? y : y - 1;
  const q = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4;
  return `Q${q} FY${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;
}

function validate(input) {
  const e = {};
  const v = {};
  for (const k of ["project", "vendorName", "service", "poc", "approvedBy"]) {
    const blank = String(input[k] ?? "").trim() === "";
    if (blank && OPTIONAL.has(k)) v[k] = "";
    else if (!text(input[k], 1, 200)) e[k] = `${FIELD_LABELS[k]} is required (max 200 characters).`;
    else v[k] = input[k].trim().replace(/\s+/g, " ");
  }
  if (!text(input.bankDetails, 6, 1000)) e.bankDetails = "Bank details are required (account no., IFSC, bank name).";
  else v.bankDetails = input.bankDetails.trim();

  const phone = String(input.contactNumber ?? "").trim();
  const digits = phone.replace(/\D/g, "");
  if (!phone) v.contactNumber = "";
  else if (!/^[+\d][\d\s\-()]{6,19}$/.test(phone) || digits.length < 7 || digits.length > 15) e.contactNumber = "Enter a valid contact number (7–15 digits).";
  else v.contactNumber = phone;

  for (const k of ["invoiceDate", "shootDate", "deadline"]) {
    if (!String(input[k] ?? "").trim()) v[k] = "";
    else if (!isoDate(input[k])) e[k] = `${FIELD_LABELS[k]}: enter a valid date.`;
    else v[k] = input[k];
  }
  if (v.invoiceDate && v.deadline && v.deadline < v.invoiceDate) e.deadline = "Due date can't be before the invoice date.";

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e10) e.amount = "Amount must be more than 0.";
  else v.amount = Math.round(amount * 100) / 100;

  if (!/^Q[1-4] FY\d{2}-\d{2}$/.test(String(input.quarter || ""))) e.quarter = "Quarter is required (e.g. Q3 FY26-27).";
  else v.quarter = input.quarter;

  if (!STATUSES.includes(input.paymentStatus)) e.paymentStatus = "Choose a payment status.";
  else v.paymentStatus = input.paymentStatus;

  if (v.amount && v.paymentStatus) {
    if (v.paymentStatus === "paid") v.amountPaid = v.amount;
    else if (v.paymentStatus === "half") v.amountPaid = Math.round(v.amount * 50) / 100;
    else if (v.paymentStatus === "unpaid") v.amountPaid = 0;
    else {
      const paid = Number(input.amountPaid);
      if (!Number.isFinite(paid) || paid <= 0 || paid >= v.amount) e.amountPaid = "Custom amount must be more than 0 and less than the invoice amount.";
      else v.amountPaid = Math.round(paid * 100) / 100;
    }
  }
  return { errors: e, value: v };
}

// ---------- Excel import: lenient — keeps what the sheet has and lists what's still missing ----------
const MAX_IMPORT = 1000;
const REQUIRED_FOR_COMPLETE = ["project", "service", "quarter", "approvedBy", "bankDetails"];
const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const dedupeKey = (v) => [v.project, v.vendorName, v.service, v.invoiceDate, Number(v.amount).toFixed(2)].map((x) => String(x || "").toLowerCase().trim()).join("|");

function validateImport(input) {
  if (!input || typeof input !== "object") return { error: "Row is empty." };
  const v = {};
  for (const k of ["project", "vendorName", "service", "poc", "approvedBy"]) v[k] = clean(input[k], 200);
  v.bankDetails = String(input.bankDetails ?? "").trim().slice(0, 1000);
  v.contactNumber = clean(input.contactNumber, 40);
  if (!v.vendorName && !v.service) return { error: "No vendor name." };
  for (const k of ["invoiceDate", "shootDate", "deadline"]) v[k] = isoDate(input[k]) ? input[k] : "";
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e10) return { error: "No valid amount." };
  v.amount = Math.round(amount * 100) / 100;
  v.quarter = /^Q[1-4] FY\d{2}-\d{2}$/.test(String(input.quarter || "")) ? input.quarter : (v.invoiceDate ? quarterOf(v.invoiceDate) : "");
  v.paymentStatus = STATUSES.includes(input.paymentStatus) ? input.paymentStatus : "unpaid";
  if (v.paymentStatus === "paid") v.amountPaid = v.amount;
  else if (v.paymentStatus === "half") v.amountPaid = Math.round(v.amount * 50) / 100;
  else if (v.paymentStatus === "custom") {
    const paid = Number(input.amountPaid);
    if (Number.isFinite(paid) && paid > 0 && paid < v.amount) v.amountPaid = Math.round(paid * 100) / 100;
    else { v.paymentStatus = "unpaid"; v.amountPaid = 0; }
  } else v.amountPaid = 0;
  v.needsDetails = REQUIRED_FOR_COMPLETE.filter((k) => !v[k] || (k === "bankDetails" && v[k].length < 6)).map((k) => FIELD_LABELS[k]);
  return { value: v };
}

async function readPdf(file) {
  if (!file || typeof file === "string" || !file.size) return { file: null };
  if (file.size > MAX_PDF_BYTES) return { error: "Invoice PDF must be under 4.5 MB." };
  const buf = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder().decode(buf.slice(0, 5));
  if (head !== "%PDF-") return { error: "The invoice must be a PDF file." };
  return { file: { buf, name: String(file.name || "invoice.pdf").slice(0, 160), size: file.size } };
}

async function listVendors(store) {
  const { blobs } = await store.list({ prefix: "v/" });
  const rows = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return rows.filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
}

async function parseBody(req) {
  let form;
  try { form = await req.formData(); } catch { return { error: json({ error: "Send the vendor as multipart form data." }, 400) }; }
  let data;
  try { data = JSON.parse(String(form.get("data") || "")); } catch { return { error: json({ error: "Vendor data is not valid JSON." }, 400) }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: json({ error: "Vendor data is missing." }, 400) };
  const pdf = await readPdf(form.get("invoice"));
  if (pdf.error) return { error: json({ error: pdf.error, fields: { invoice: pdf.error } }, 400) };
  return { data, pdf: pdf.file };
}

export default async (req) => {
  const auth = await requireRole(req, "vendors");
  if (auth.error) return auth.error;
  const store = getStore(STORE);
  const parts = new URL(req.url).pathname.replace(/^\/api\/vendors\/?/, "").split("/").filter(Boolean);
  try {
    // ----- bulk import from Excel -----
    if (parts[0] === "import" && parts.length === 1) {
      if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
      let body;
      try { body = await req.json(); } catch { return json({ error: "Send the rows as JSON." }, 400); }
      const rows = Array.isArray(body?.vendors) ? body.vendors : null;
      if (!rows || !rows.length) return json({ error: "No vendors to import." }, 400);
      if (rows.length > MAX_IMPORT) return json({ error: `Import at most ${MAX_IMPORT} vendors at a time.` }, 400);
      const seen = new Set((await listVendors(store)).map(dedupeKey));
      const now = Date.now();
      const toSave = [], failed = [];
      let duplicates = 0;
      rows.forEach((row, i) => {
        const r = validateImport(row);
        const where = { sheet: clean(row?.sheet, 60), line: Number(row?.line) || i + 1 };
        if (r.error) return failed.push({ ...where, error: r.error });
        const key = dedupeKey(r.value);
        if (seen.has(key)) { duplicates++; return; }
        seen.add(key);
        toSave.push({ id: randomUUID(), ...r.value, source: "excel", createdBy: auth.user.email, invoice: null, createdAt: now + i, updatedAt: now });
      });
      for (let i = 0; i < toSave.length; i += 25) await Promise.all(toSave.slice(i, i + 25).map((rec) => store.setJSON(`v/${rec.id}`, rec)));
      return json({ added: toSave.length, duplicates, failed }, toSave.length ? 201 : 200);
    }

    const id = parts[0] ? decodeURIComponent(parts[0]) : null;
    if (id && !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Not found." }, 404);

    // ----- invoice download -----
    if (id && parts[1] === "invoice") {
      if (req.method !== "GET") return json({ error: "Method not allowed." }, 405);
      const rec = await store.getWithMetadata(`inv/${id}`, { type: "arrayBuffer" });
      if (!rec) return json({ error: "No invoice stored for this vendor." }, 404);
      const name = String(rec.metadata?.name || "invoice.pdf").replace(/[^\w.\- ()]/g, "_");
      return new Response(rec.data, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${name}"`, "cache-control": "no-store" } });
    }
    if (parts.length > 1) return json({ error: "Not found." }, 404);

    if (req.method === "GET" && !id) {
      return json({ vendors: await listVendors(store) });
    }

    if (req.method === "POST" && !id) {
      const body = await parseBody(req);
      if (body.error) return body.error;
      const { errors, value } = validate(body.data);
      if (Object.keys(errors).length) return json({ error: "Some required fields are missing or invalid.", fields: errors }, 400);
      const now = Date.now();
      const rec = { id: randomUUID(), ...value, createdBy: auth.user.email, invoice: body.pdf ? { name: body.pdf.name, size: body.pdf.size } : null, createdAt: now, updatedAt: now };
      if (body.pdf) await store.set(`inv/${rec.id}`, body.pdf.buf, { metadata: { name: body.pdf.name } });
      await store.setJSON(`v/${rec.id}`, rec);
      return json({ vendor: rec }, 201);
    }

    if (req.method === "PUT" && id) {
      const existing = await store.get(`v/${id}`, { type: "json" });
      if (!existing) return json({ error: "Vendor not found." }, 404);
      const body = await parseBody(req);
      if (body.error) return body.error;
      const { errors, value } = validate(body.data);
      if (Object.keys(errors).length) return json({ error: "Some required fields are missing or invalid.", fields: errors }, 400);
      const rec = { ...existing, ...value, needsDetails: [], updatedAt: Date.now(), updatedBy: auth.user.email };
      if (body.pdf) {
        await store.set(`inv/${id}`, body.pdf.buf, { metadata: { name: body.pdf.name } });
        rec.invoice = { name: body.pdf.name, size: body.pdf.size };
      }
      await store.setJSON(`v/${id}`, rec);
      return json({ vendor: rec });
    }

    // ----- payment status only (list "Edit") -----
    if (req.method === "PATCH" && id) {
      const existing = await store.get(`v/${id}`, { type: "json" });
      if (!existing) return json({ error: "Vendor not found." }, 404);
      let body;
      try { body = await req.json(); } catch { return json({ error: "Send the status as JSON." }, 400); }
      const status = body?.paymentStatus;
      if (!STATUSES.includes(status)) return json({ error: "Choose a payment status.", fields: { paymentStatus: "Choose a payment status." } }, 400);
      const amount = Number(existing.amount) || 0;
      let amountPaid;
      if (status === "paid") amountPaid = amount;
      else if (status === "half") amountPaid = Math.round(amount * 50) / 100;
      else if (status === "unpaid") amountPaid = 0;
      else {
        const paid = Number(body.amountPaid);
        if (!Number.isFinite(paid) || paid <= 0 || paid >= amount) { const msg = "Custom amount must be more than 0 and less than the invoice amount."; return json({ error: msg, fields: { amountPaid: msg } }, 400); }
        amountPaid = Math.round(paid * 100) / 100;
      }
      const rec = { ...existing, paymentStatus: status, amountPaid, updatedAt: Date.now(), updatedBy: auth.user.email };
      await store.setJSON(`v/${id}`, rec);
      return json({ vendor: rec });
    }

    if (req.method === "DELETE" && id) {
      const existing = await store.get(`v/${id}`, { type: "json" });
      if (!existing) return json({ error: "Vendor not found." }, 404);
      await store.delete(`v/${id}`);
      await store.delete(`inv/${id}`);
      return json({ ok: true });
    }
    return json({ error: "Method not allowed." }, 405);
  } catch (err) {
    console.error("vendors api", err);
    return json({ error: "Server error — please try again." }, 500);
  }
};

export const config = { path: ["/api/vendors", "/api/vendors/*"] };
