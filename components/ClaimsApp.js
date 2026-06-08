"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  Car, Upload, Loader2, CheckCircle2, AlertTriangle, RefreshCw,
  ShieldCheck, UserCheck, ArrowLeft, FileText, Gauge, Wrench, Inbox, Plus, X
} from "lucide-react";

// --- Routing config (tunable). In production these are set by the eval loop's
// acceptable error/leakage tolerance, NOT the model's self-report. ---
const CONF_THRESHOLD = 0.85;
// Auto-authorization limit: even a high-confidence claim above this dollar value
// is routed to a senior adjuster, because financial exposure — not just model
// confidence — gates straight-through approval (mirrors real authority limits).
const AUTO_APPROVE_CEILING = 1500;

const SEVERITY_STYLES = {
  minor: "bg-amber-50 text-amber-700 border-amber-200",
  moderate: "bg-orange-50 text-orange-700 border-orange-200",
  severe: "bg-red-50 text-red-700 border-red-200",
};

const fmt = (n) =>
  typeof n === "number" ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—";

// Capitalize the first letter — model output for ad-hoc regions can come back
// lowercase, so this keeps part names consistent with the rest of the list.
const capitalize = (s) => (typeof s === "string" && s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Re-encode an uploaded file to a right-sized JPEG → { dataUrl, base64, media_type }.
// Normalizes media type (HEIC/PNG/etc.) and keeps payloads under API size limits.
const reencodeFile = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1568;
        let { width, height } = img;
        if (Math.max(width, height) > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        const jpegUrl = canvas.toDataURL("image/jpeg", 0.85);
        resolve({ dataUrl: jpegUrl, base64: jpegUrl.split(",")[1], media_type: "image/jpeg" });
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

// --- Mocked standardized repair-cost database. In production this is a live
// integration (e.g. Mitchell/CCC/Audatex) keyed by region + part. The model
// returns parts cost + labor HOURS; the labor dollar figure is grounded here. ---
const REPAIR_DB = { laborRatePerHour: 56 };

// Regional body-shop labor rates ($/hr) — mocked tiers by state. Demonstrates
// that estimates vary by location; production would key off a live rate table.
const STATE_LABOR_RATES = { CA: 78, NY: 76, MA: 72, WA: 70, NJ: 70, CT: 70, IL: 64, CO: 62, AZ: 58, TX: 58, GA: 56, NC: 54, OH: 52, FL: 56 };
const laborRateForState = (state) => STATE_LABOR_RATES[String(state || "").toUpperCase().trim()] || REPAIR_DB.laborRatePerHour;
const regionLabel = (claim) =>
  claim?.city && claim?.state ? `${claim.city}, ${String(claim.state).toUpperCase()}` : "Regional avg (mocked DB)";

// Normalize a model line item: derive labor $ from hours via the regional rate and
// make estimatedCost = parts + labor, so the breakdown always sums to the total.
const ingestItem = (d, rate = REPAIR_DB.laborRatePerHour) => {
  const partsCost = Math.max(0, Math.round(Number(d.partsCost) || 0));
  const laborHours = Math.max(0, Math.round((Number(d.laborHours) || 0) * 10) / 10);
  const laborCost = Math.round(laborHours * rate);
  const computed = partsCost + laborCost;
  return {
    ...d,
    partsCost,
    laborHours,
    laborCost,
    estimatedCost: computed > 0 ? computed : Number(d.estimatedCost) || 0,
    box: d.box && typeof d.box.x === "number" ? d.box : null,
  };
};

// Crop a dataURL to a normalized box (with context padding) → dataURL JPEG, so
// the model (and the close-up gallery) sees the exact marked region.
const cropDataUrlToBox = (dataUrl, box, pad = 0.15) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const W = img.naturalWidth, H = img.naturalHeight;
      const padX = Math.max(box.w * pad, 0.03);
      const padY = Math.max(box.h * pad, 0.03);
      const x0 = Math.max(0, box.x - padX) * W;
      const y0 = Math.max(0, box.y - padY) * H;
      const x1 = Math.min(1, box.x + box.w + padX) * W;
      const y1 = Math.min(1, box.y + box.h + padY) * H;
      const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w);
      canvas.height = Math.round(h);
      canvas.getContext("2d").drawImage(img, x0, y0, w, h, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.9));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });

// Draw a red rectangle on a copy of the photo at the normalized box → base64
// JPEG. A drawn marker grounds the VLM far better than text coordinates.
const annotateDataUrlWithBox = (dataUrl, box) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const W = img.naturalWidth, H = img.naturalHeight;
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = Math.max(3, Math.round(Math.min(W, H) * 0.008));
      ctx.strokeRect(box.x * W, box.y * H, box.w * W, box.h * H);
      resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });

// A single damage close-up: crops the photo to the item's box on mount.
function Closeup({ dataUrl, box, label, idx, active, adjuster, onHover, onRemove }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    cropDataUrlToBox(dataUrl, box, 0.22).then((u) => { if (alive) setUrl(u); }).catch(() => {});
    return () => { alive = false; };
  }, [dataUrl, box?.x, box?.y, box?.w, box?.h]);
  const ring = active ? "border-blue-500" : adjuster ? "border-violet-500" : "border-amber-400";
  const tag = active ? "bg-blue-600 text-white" : adjuster ? "bg-violet-600 text-white" : "bg-amber-400 text-slate-900";
  return (
    <div onMouseEnter={() => onHover?.(idx)} onMouseLeave={() => onHover?.(null)} className="shrink-0 w-28">
      <div className={`relative h-24 w-28 rounded-md border-2 overflow-hidden bg-slate-100 ${ring}`}>
        {url ? <img src={url} alt={label} className="h-full w-full object-cover" /> : <div className="h-full w-full animate-pulse" />}
        <span className={`absolute top-0 left-0 text-[10px] font-bold px-1.5 py-0.5 rounded-br ${tag}`}>{idx + 1}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove?.(idx); }}
          title="Remove inaccurate close-up"
          aria-label="Remove inaccurate close-up"
          className="absolute top-0 right-0 h-5 w-5 grid place-items-center bg-black/55 hover:bg-red-600 text-white rounded-bl"
        >
          <X size={12} />
        </button>
      </div>
      <div className="text-[11px] text-slate-600 mt-1 leading-tight">{label}</div>
    </div>
  );
}

// Queue triage: rank by what an adjuster should work first. Pending-review
// claims float to the top, then by value-at-risk and (in)confidence.
const triage = (c) => {
  const value = c.adjustedTotal ?? c.assessment?.totalEstimate ?? 0;
  const conf = c.assessment?.overallConfidence ?? 0;
  const pending = c.status === "agent-review";
  let tier = "Low";
  if (pending && (value >= 2000 || conf < 0.6)) tier = "High";
  else if (pending) tier = "Medium";
  const score = (pending ? 1e7 : 0) + value + (1 - conf) * 1500;
  return { tier, score, value, conf };
};

const TIER_STYLES = {
  High: "bg-red-50 text-red-700 border-red-200",
  Medium: "bg-amber-50 text-amber-700 border-amber-200",
  Low: "bg-slate-50 text-slate-500 border-slate-200",
};

// --- Demo seed claims so the console shows a populated, multi-status queue.
// These have no photo (placeholder thumbnail); the live flow adds real claims. ---
const seedItem = (rate, part, damageType, severity, partsCost, laborHours, confidence) => {
  const laborCost = Math.round(laborHours * rate);
  return { part, damageType, severity, partsCost, laborHours, laborCost, estimatedCost: partsCost + laborCost, confidence };
};
const SEED_CLAIMS = [
  { id: "CLM-7042", name: "Marcus Hill", city: "Austin", state: "TX", status: "agent-review",
    vehicle: "Toyota Highlander, 2019", conf: 0.79, summary: "Front-end collision damage with bumper, grille, and headlight involvement.",
    items: [["Front bumper cover", "Cracked, deep gouging", "severe", 820, 5, 0.80], ["Grille assembly", "Shattered", "moderate", 360, 2, 0.77], ["Right headlight assembly", "Housing crack, mounting damage", "moderate", 480, 1.5, 0.74]] },
  { id: "CLM-6318", name: "Priya Shah", city: "Columbus", state: "OH", status: "agent-review",
    vehicle: "Honda Civic, 2020", conf: 0.55, summary: "Rear impact; low confidence due to shadow and partial framing.",
    items: [["Rear bumper", "Scuffing, possible bracket damage", "moderate", 300, 2, 0.55], ["Trunk lid", "Misalignment", "minor", 260, 1.5, 0.5]] },
  { id: "CLM-4890", name: "Lena Park", city: "Seattle", state: "WA", status: "senior-review", fastTracked: true,
    vehicle: "Mazda CX-5, 2021", conf: 0.93, summary: "Minor cosmetic rear-corner damage; high confidence, low cost.",
    items: [["Rear quarter panel", "Minor scrape", "minor", 260, 2, 0.93], ["Tail light", "Cracked lens", "minor", 140, 0.8, 0.9]] },
  { id: "CLM-4123", name: "Samuel Reyes", city: "Denver", state: "CO", status: "senior-review", fastTracked: false, corrected: true,
    vehicle: "Subaru Outback, 2017", conf: 0.84, summary: "Reviewed by claims agent; significant front-corner damage awaiting senior sign-off.",
    items: [["Front fender", "Crushed, paint transfer", "severe", 560, 4.5, 0.84], ["Hood", "Buckled leading edge", "moderate", 480, 3, 0.8], ["Front bumper cover", "Cracked", "moderate", 420, 2.5, 0.82]] },
  { id: "CLM-3781", name: "Grace Liu", city: "Sacramento", state: "CA", status: "approved",
    vehicle: "Nissan Altima, 2019", conf: 0.9, summary: "Minor side cosmetic damage; authorized.",
    items: [["Left door", "Dent", "minor", 300, 2, 0.9], ["Rocker panel", "Scrape", "minor", 180, 1.5, 0.88]] },
  { id: "CLM-3055", name: "Omar Haddad", city: "Miami", state: "FL", status: "returned",
    returnReason: "Photo is too far away — please retake ~3 ft from the damaged area, filling the frame.",
    vehicle: "Hyundai Tucson, 2020", conf: 0.41, summary: "Photo too distant to assess reliably; returned for a clearer image.",
    items: [["Front-end (unclear)", "Indeterminate — retake photo", "minor", 200, 1, 0.41]] },
].map((c) => {
  const rate = laborRateForState(c.state);
  const damageItems = c.items.map((it) => seedItem(rate, ...it));
  return {
    id: c.id, name: c.name, email: "policyholder@email.com", policy: "MA-0000-00",
    city: c.city, state: c.state, status: c.status, fastTracked: !!c.fastTracked,
    reviewerFeedback: "", corrected: !!c.corrected, image: null, returnReason: c.returnReason,
    assessment: {
      vehicle: c.vehicle, overallConfidence: c.conf, summary: c.summary,
      authenticity: { flag: "clear" }, damageItems,
      totalEstimate: damageItems.reduce((s, d) => s + d.estimatedCost, 0),
    },
  };
});

// Damage photo with clickable bounding-box overlays. Boxes are normalized 0-1,
// so positioning as % of a width-filled image stays aligned at any size.
// In drawMode the adjuster can drag a new box; onDrawComplete gets the box.
function DamagePhoto({ src, items, activeIdx, setActiveIdx, drawMode, onDrawComplete }) {
  const ref = useRef(null);
  const startRef = useRef(null);
  const [draft, setDraft] = useState(null);

  const toNorm = (e) => {
    const r = ref.current.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };
  const onDown = (e) => {
    if (!drawMode) return;
    e.preventDefault();
    startRef.current = toNorm(e);
    setDraft({ ...startRef.current, w: 0, h: 0 });
  };
  const onMove = (e) => {
    if (!drawMode || !startRef.current) return;
    const p = toNorm(e), s = startRef.current;
    setDraft({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };
  const onUp = () => {
    if (!drawMode || !startRef.current) return;
    const d = draft;
    startRef.current = null;
    setDraft(null);
    if (d && d.w > 0.02 && d.h > 0.02) onDrawComplete?.(d);
  };

  const boxCls = (d, active) =>
    active ? "border-blue-500 bg-blue-500/20"
      : d.addedByAdjuster ? "border-violet-500 bg-violet-500/20"
        : "border-amber-400 bg-amber-400/10";
  const tagCls = (d, active) =>
    active ? "bg-blue-600 text-white"
      : d.addedByAdjuster ? "bg-violet-600 text-white"
        : "bg-amber-400 text-slate-900";

  // Only overlay adjuster-DRAWN boxes on the main photo (accurate). AI boxes are
  // approximate and used only to crop the close-up gallery, not drawn here.
  const boxed = (items || []).map((d, i) => ({ d, i })).filter(({ d }) => d.drawnBox && d.box && typeof d.box.x === "number");
  return (
    <div
      ref={ref}
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onMouseLeave={onUp}
      className={`relative inline-block w-full select-none ${drawMode ? "cursor-crosshair" : ""}`}
    >
      {src ? (
        <img src={src} alt="damage" draggable={false} className="block w-full rounded-lg border border-slate-200 bg-white" />
      ) : (
        <div className="grid place-items-center h-56 w-full rounded-lg border border-slate-200 bg-slate-50 text-slate-400">
          <div className="text-center"><Car size={28} className="mx-auto" /><div className="text-xs mt-1">Demo claim — no photo</div></div>
        </div>
      )}
      {boxed.map(({ d, i }) => {
        const active = activeIdx === i;
        return (
          <div
            key={i}
            onMouseEnter={() => !drawMode && setActiveIdx?.(i)}
            onMouseLeave={() => !drawMode && setActiveIdx?.(null)}
            className={`absolute border-2 rounded-sm transition-colors ${drawMode ? "pointer-events-none" : "cursor-pointer"} ${boxCls(d, active)}`}
            style={{
              left: `${Math.max(0, d.box.x) * 100}%`,
              top: `${Math.max(0, d.box.y) * 100}%`,
              width: `${Math.min(1, d.box.w) * 100}%`,
              height: `${Math.min(1, d.box.h) * 100}%`,
            }}
          >
            <span className={`absolute top-0 left-0 -translate-y-full text-[10px] font-bold px-1.5 py-0.5 rounded-t ${tagCls(d, active)}`}>
              {i + 1}
            </span>
          </div>
        );
      })}
      {draft && (
        <div
          className="absolute border-2 border-violet-500 bg-violet-500/20 rounded-sm pointer-events-none"
          style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }}
        />
      )}
    </div>
  );
}

// First-pass fraud / image-authenticity signal. Illustrative only — production
// would use EXIF/metadata, reverse-image search, and manipulation-detection models.
function AuthenticityPanel({ authenticity }) {
  if (!authenticity) return null;
  const review = authenticity.flag === "review";
  return (
    <div className={`mt-3 rounded-lg border px-3 py-2 ${review ? "bg-amber-50 border-amber-200" : "bg-emerald-50 border-emerald-200"}`}>
      <div className={`flex items-center gap-1.5 text-sm font-medium ${review ? "text-amber-800" : "text-emerald-800"}`}>
        {review ? <AlertTriangle size={14} className="shrink-0" /> : <ShieldCheck size={14} className="shrink-0" />}
        Authenticity check: {review ? "possible fraud indicators detected" : "no fraud indicators detected"}
      </div>
      <p className={`text-xs mt-1 ${review ? "text-amber-700" : "text-emerald-700"}`}>
        {review
          ? `${authenticity.summary || "The image shows possible signs of manipulation or inconsistency with the reported incident."} Recommend rejecting this claim.`
          : "Image appears to be an authentic, original photo taken at the scene of an actual collision with no signs of manipulation."}
      </p>
    </div>
  );
}

function ConfidenceBar({ value }) {
  const pct = Math.round((value || 0) * 100);
  const color = value >= CONF_THRESHOLD ? "bg-emerald-500" : value >= 0.5 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="w-full">
      <div className="flex justify-between text-xs text-slate-500 mb-1">
        <span>Model confidence</span>
        <span className="font-medium text-slate-700">{pct}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    "agent-review": { label: "Pending claims-agent review", cls: "bg-amber-50 text-amber-700 border-amber-200", Icon: UserCheck },
    "senior-review": { label: "Pending senior-adjuster sign-off", cls: "bg-indigo-50 text-indigo-700 border-indigo-200", Icon: ShieldCheck },
    approved: { label: "Authorized by senior adjuster", cls: "bg-emerald-50 text-emerald-700 border-emerald-200", Icon: CheckCircle2 },
    returned: { label: "Returned for more photos", cls: "bg-sky-50 text-sky-700 border-sky-200", Icon: Upload },
  };
  const { label, cls, Icon } = map[status] || map["agent-review"];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium ${cls}`}>
      <Icon size={13} /> {label}
    </span>
  );
}

// Stable top-level layout shell. Defined OUTSIDE App so it is not recreated on
// every render (which previously caused inputs to lose focus after one keystroke).
function Shell({ screen, setScreen, resetClaim, claims, children }) {
  const pendingCount = claims.filter((c) => c.status === "agent-review").length;
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <div className="h-8 w-8 rounded-lg bg-blue-600 text-white grid place-items-center">
              <Car size={18} />
            </div>
            Meridian Auto · Claims
          </div>
          <div className="flex items-center gap-2 text-sm">
            <button
              onClick={() => { resetClaim(); setScreen("portal"); }}
              className={`px-3 py-1.5 rounded-md ${["portal","form","scanning","retry","report"].includes(screen) ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:bg-slate-100"}`}
            >
              Policyholder
            </button>
            <button
              onClick={() => setScreen("queue")}
              className={`px-3 py-1.5 rounded-md flex items-center gap-1.5 ${["queue","detail"].includes(screen) ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:bg-slate-100"}`}
            >
              <Inbox size={15} /> Claims agent
              {pendingCount > 0 && (
                <span className="ml-1 h-5 min-w-5 px-1 grid place-items-center rounded-full bg-amber-500 text-white text-xs">
                  {pendingCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState("portal"); // portal | form | scanning | retry | report | queue | detail
  const [form, setForm] = useState({ name: "", email: "", policy: "", city: "", state: "" });
  const [image, setImage] = useState(null); // primary photo { dataUrl, base64, media_type }
  const [extraImages, setExtraImages] = useState([]); // additional photos
  const [assessment, setAssessment] = useState(null);
  const [error, setError] = useState("");
  const [retryReason, setRetryReason] = useState("");
  const [claims, setClaims] = useState(SEED_CLAIMS);
  const [current, setCurrent] = useState(null);
  const [feedback, setFeedback] = useState("");
  const [debug, setDebug] = useState("");
  const [editedItems, setEditedItems] = useState([]);
  const [laborRate, setLaborRate] = useState(REPAIR_DB.laborRatePerHour); // editable in claims-agent view
  const [savedNote, setSavedNote] = useState("");
  const [addingItem, setAddingItem] = useState(false);
  const [addItemError, setAddItemError] = useState("");
  const [resubmitId, setResubmitId] = useState(null); // when set, a new photo updates this existing claim
  const [activeIdx, setActiveIdx] = useState(null); // highlighted damage box <-> line item
  const [drawMode, setDrawMode] = useState(false); // adjuster drawing a new damage box
  const [assessingRegion, setAssessingRegion] = useState(false);
  const fileRef = useRef(null);

  const resetClaim = () => {
    setForm({ name: "", email: "", policy: "", city: "", state: "" });
    setImage(null);
    setExtraImages([]);
    setAssessment(null);
    setError("");
    setRetryReason("");
    setDebug("");
    setResubmitId(null);
  };

  // Policyholder re-uploads photos for a claim the adjuster returned. Prefills
  // their details and flags the next assessment to update the SAME claim.
  const startResubmit = (c) => {
    setForm({ name: c.name || "", email: c.email || "", policy: c.policy || "", city: c.city || "", state: c.state || "" });
    setImage(null);
    setExtraImages([]);
    setError("");
    setRetryReason("");
    setDebug("");
    setResubmitId(c.id);
    setScreen("form");
  };

  const onPickFile = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setError("");
    const hadPrimary = !!image;
    try {
      const encoded = await Promise.all(files.map(reencodeFile));
      if (hadPrimary) {
        setExtraImages((prev) => [...prev, ...encoded]);
      } else {
        const [first, ...rest] = encoded;
        setImage(first);
        setExtraImages((prev) => [...prev, ...rest]);
      }
    } catch {
      setError("That image format can't be read here (often HEIC from iPhone). Please upload a JPEG or PNG — on iPhone, take a screenshot of the photo and upload that.");
    }
    e.target.value = ""; // allow re-selecting the same file
  };

  // Remove a photo by combined index (0 = primary, then extras). Removing the
  // primary promotes the first extra so the claim always has a primary photo.
  const removePhoto = (i) => {
    if (i === 0) {
      setImage(extraImages[0] || null);
      setExtraImages((prev) => prev.slice(1));
    } else {
      setExtraImages((prev) => prev.filter((_, idx) => idx !== i - 1));
    }
  };

  const runAssessment = async () => {
    setScreen("scanning");
    setError("");
    setDebug("");
    setActiveIdx(null);
    try {
      const location = form.city && form.state ? `${form.city}, ${form.state}` : "";
      const rate = laborRateForState(form.state);
      const allImages = [image, ...extraImages];
      const res = await fetch("/api/assess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64: image.base64,
          mediaType: image.media_type,
          images: allImages.map((p) => ({ base64: p.base64, mediaType: p.media_type })),
          location,
        }),
      });
      const data = await res.json();

      if (!data.ok || !data.assessment) {
        setError("The assessment service returned an error (not a problem with your photo).");
        setDebug(typeof data.error === "string" ? data.error : JSON.stringify(data.error || data, null, 2).slice(0, 800));
        setRetryReason("A processing error occurred while contacting the model.");
        setScreen("retry");
        return;
      }

      const parsed = data.assessment;

      // Ground costs in the regional labor rate and recompute the total.
      if (Array.isArray(parsed.damageItems)) {
        parsed.damageItems = parsed.damageItems.map((d) => ingestItem(d, rate));
        parsed.totalEstimate = parsed.damageItems.reduce((s, d) => s + (d.estimatedCost || 0), 0);
      }

      if (parsed.imageQuality !== "clear") {
        setRetryReason(parsed.qualityReason || "The photo could not be reliably assessed.");
        setScreen("retry");
        return;
      }

      // Always a human in the loop. High confidence AND under the auto-authorization
      // limit fast-tracks straight to a senior adjuster (claims-agent step skipped);
      // everything else goes to a claims agent first, then a senior adjuster.
      const fastTracked =
        parsed.overallConfidence >= CONF_THRESHOLD && (parsed.totalEstimate || 0) < AUTO_APPROVE_CEILING;
      const status = fastTracked ? "senior-review" : "agent-review";

      if (resubmitId) {
        // Re-assessment of a returned claim: refresh it in place, clear the
        // return reason and any prior adjuster edits, and re-route by confidence.
        const patch = {
          ...form,
          image,
          extraImages,
          assessment: parsed,
          status,
          returnReason: "",
          reviewerFeedback: "",
          corrected: false,
          adjustedItems: undefined,
          adjustedTotal: undefined,
          resubmitted: true,
          fastTracked,
        };
        updateClaim(resubmitId, patch);
        setAssessment(parsed);
        setCurrent({ id: resubmitId, ...patch });
        setResubmitId(null);
        setScreen("report");
        return;
      }

      const claim = {
        id: "CLM-" + Math.floor(1000 + Math.random() * 9000),
        ...form,
        image,
        extraImages,
        assessment: parsed,
        status,
        reviewerFeedback: "",
        corrected: false,
        fastTracked,
      };
      setAssessment(parsed);
      setCurrent(claim);
      setClaims((c) => [claim, ...c]);
      setScreen("report");
    } catch (e) {
      setError("Network or processing error (not a problem with your photo).");
      setDebug(String(e?.message || e));
      setScreen("retry");
      setRetryReason("The request to the model failed before it could respond.");
    }
  };

  const updateClaim = (id, patch) =>
    setClaims((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  // ----------------------- SCREEN CONTENT -----------------------
  let content = null;

  if (screen === "portal") {
    content = (
      <div className="max-w-xl">
        <h1 className="text-2xl font-bold tracking-tight">File a new auto claim</h1>
        <p className="text-slate-500 mt-2">
          Report accident damage and upload photos. Our assessment model gives you a
          preliminary repair estimate in seconds, with a claims agent and senior adjuster reviewing before anything is authorized.
        </p>
        <button
          onClick={() => setScreen("form")}
          className="mt-6 inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium px-5 py-3 rounded-lg"
        >
          <FileText size={18} /> Submit new claim
        </button>
      </div>
    );
  } else if (screen === "form") {
    const ready = form.name && form.email && form.policy && form.city && form.state && image;
    content = (
      <>
        <button onClick={() => { setResubmitId(null); setScreen("portal"); }} className="text-sm text-slate-500 flex items-center gap-1 mb-4">
          <ArrowLeft size={15} /> Back
        </button>
        <h1 className="text-xl font-bold">{resubmitId ? `Re-upload photos · ${resubmitId}` : "Claim details"}</h1>
        {resubmitId && (
          <div className="mt-3 bg-sky-50 border border-sky-200 rounded-lg p-3 text-sky-800 text-sm flex gap-2">
            <Upload size={16} className="shrink-0 mt-0.5" />
            Your claims team returned this claim for new photos. Your details are prefilled — just upload a clearer or additional photo and re-run the assessment.
          </div>
        )}
        <div className="grid md:grid-cols-2 gap-6 mt-5">
          <div className="space-y-4">
            {[
              { k: "name", label: "Full name", ph: "Anjali Rao" },
              { k: "email", label: "Email", ph: "you@email.com" },
              { k: "policy", label: "Policy number", ph: "MA-4471-22" },
            ].map((f) => (
              <div key={f.k}>
                <label className="block text-sm font-medium text-slate-700 mb-1">{f.label}</label>
                <input
                  value={form[f.k]}
                  onChange={(e) => setForm({ ...form, [f.k]: e.target.value })}
                  placeholder={f.ph}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            ))}
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">City</label>
                <input
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                  placeholder="San Jose"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">State</label>
                <input
                  value={form.state}
                  onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase().slice(0, 2) })}
                  placeholder="CA"
                  maxLength={2}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 uppercase focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <p className="text-xs text-slate-400">Location is used to estimate repair costs at local labor &amp; parts rates.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Damage photos</label>
            <div
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center cursor-pointer hover:border-blue-400 bg-white"
            >
              <div className="text-slate-500">
                <Upload className="mx-auto mb-2" />
                <div className="text-sm">{[image, ...extraImages].filter(Boolean).length ? "Click to add more photos" : "Click to upload photo(s) of the damage"}</div>
                <div className="text-xs text-slate-400 mt-1">You can add multiple angles — close-ups and a wider shot.</div>
              </div>
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onPickFile} />
            </div>
            {[image, ...extraImages].filter(Boolean).length > 0 && (
              <div className="flex gap-2 flex-wrap mt-2">
                {[image, ...extraImages].filter(Boolean).map((p, i) => (
                  <div key={i} className="relative">
                    <img src={p.dataUrl} alt={`photo ${i + 1}`} className="h-16 w-16 rounded-md object-cover border border-slate-200" />
                    <button
                      onClick={(e) => { e.stopPropagation(); removePhoto(i); }}
                      aria-label="Remove photo"
                      className="absolute -top-1.5 -right-1.5 h-5 w-5 grid place-items-center rounded-full bg-slate-800 hover:bg-red-600 text-white"
                    >
                      <X size={11} />
                    </button>
                    {i === 0 && <span className="absolute bottom-0 left-0 text-[9px] bg-blue-600 text-white px-1 rounded-tr">primary</span>}
                  </div>
                ))}
              </div>
            )}
            <ul className="text-xs text-slate-500 mt-2 space-y-0.5">
              <li>• Make sure photos are clear and well-lit</li>
              <li>• Capture the full damaged area in the frame</li>
              <li>• Stand about 3 ft back · avoid glare &amp; motion blur</li>
            </ul>
            {error && <p className="text-red-600 text-sm mt-2">{error}</p>}
          </div>
        </div>
        <button
          disabled={!ready}
          onClick={runAssessment}
          className="mt-6 inline-flex items-center gap-2 bg-blue-600 disabled:bg-slate-300 hover:bg-blue-700 text-white font-medium px-5 py-3 rounded-lg"
        >
          Run damage assessment
        </button>
      </>
    );
  } else if (screen === "scanning") {
    content = (
      <div className="grid place-items-center py-24 text-center">
        <Loader2 className="animate-spin text-blue-600" size={40} />
        <p className="mt-4 font-medium">Scanning photo for vehicle damage…</p>
        <p className="text-sm text-slate-500 mt-1">Checking image quality, detecting damage, estimating repair cost</p>
      </div>
    );
  } else if (screen === "retry") {
    content = (
      <div className="max-w-lg mx-auto bg-white border border-amber-200 rounded-xl p-6 text-center">
        <AlertTriangle className="mx-auto text-amber-500" size={36} />
        <h2 className="text-lg font-bold mt-3">We couldn't assess this photo</h2>
        <p className="text-slate-600 mt-2">{retryReason}</p>
        {error && <p className="text-red-600 text-sm mt-2">{error}</p>}
        {debug && (
          <pre className="text-left text-xs bg-slate-900 text-slate-100 rounded-lg p-3 mt-3 overflow-auto max-h-40 whitespace-pre-wrap">{debug}</pre>
        )}
        <div className="bg-amber-50 text-amber-800 text-sm rounded-lg p-3 mt-4 text-left">
          For an accurate estimate: stand ~3 ft back, fill the frame with the damaged area, and avoid glare or motion blur.
        </div>
        <button
          onClick={() => { setImage(null); setScreen("form"); }}
          className="mt-5 inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium px-5 py-2.5 rounded-lg"
        >
          <RefreshCw size={16} /> Retake & resubmit
        </button>
      </div>
    );
  } else if (screen === "report" && assessment) {
    const a = assessment;
    content = (
      <>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm text-slate-500">{current?.id} · {a.vehicle}</div>
            <h1 className="text-xl font-bold">Preliminary damage assessment</h1>
          </div>
          <StatusBadge status={current?.status} />
        </div>

        {current?.status === "senior-review" && current?.fastTracked ? (
          <div className="mt-4 bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-emerald-800 text-sm flex gap-2">
            <ShieldCheck size={18} className="shrink-0" />
            Confidence is at/above {Math.round(CONF_THRESHOLD * 100)}% and the estimate is under the {fmt(AUTO_APPROVE_CEILING)} auto-authorization limit, so this claim is fast-tracked straight to a senior adjuster for final sign-off — the claims-agent review step is skipped. A human still authorizes every claim.
          </div>
        ) : (
          <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800 text-sm flex gap-2">
            <UserCheck size={18} className="shrink-0" />
            {a.overallConfidence < CONF_THRESHOLD
              ? `Confidence is below the ${Math.round(CONF_THRESHOLD * 100)}% threshold, so this claim goes to a claims agent for review, then a senior adjuster for final sign-off.`
              : `Confidence is high, but the estimate exceeds the ${fmt(AUTO_APPROVE_CEILING)} auto-authorization limit, so it goes to a claims agent for review, then a senior adjuster for final sign-off.`}
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-6 mt-6">
          <div>
            <DamagePhoto src={current?.image?.dataUrl} items={a.damageItems} activeIdx={activeIdx} setActiveIdx={setActiveIdx} />
            {current?.extraImages?.length > 0 && (
              <div className="mt-2">
                <div className="text-xs text-slate-400 mb-1">Additional photos ({current.extraImages.length})</div>
                <div className="flex gap-2 flex-wrap">
                  {current.extraImages.map((p, i) => (
                    <img key={i} src={p.dataUrl} alt={`additional ${i + 1}`} className="h-14 w-14 rounded object-cover border border-slate-200" />
                  ))}
                </div>
              </div>
            )}
          </div>
          <div>
            <ConfidenceBar value={a.overallConfidence} />
            <AuthenticityPanel authenticity={a.authenticity} />
            <p className="text-sm text-slate-600 mt-3">{a.summary}</p>
            <div className="mt-4 flex items-center justify-between bg-white border border-slate-200 rounded-lg px-4 py-3">
              <span className="text-slate-500 flex items-center gap-2"><Gauge size={16} /> Estimated total</span>
              <span className="text-xl font-bold">{fmt(a.totalEstimate)}</span>
            </div>
            <p className="text-xs text-slate-400 mt-2">Labor billed at {fmt(laborRateForState(current?.state))}/hr · {regionLabel(current)}.</p>
          </div>
        </div>

        <h3 className="font-semibold mt-7 mb-2 flex items-center gap-2"><Wrench size={16} /> Detected damage</h3>
        <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          {a.damageItems?.length ? a.damageItems.map((d, i) => (
            <div key={i} onMouseEnter={() => setActiveIdx(i)} onMouseLeave={() => setActiveIdx(null)}
              className={`px-4 py-3 flex items-center justify-between gap-4 ${activeIdx === i ? "bg-blue-50" : ""}`}>
              <div className="flex items-center gap-3 min-w-0">
                <span className="shrink-0 h-5 w-5 grid place-items-center rounded bg-slate-800 text-white text-[11px] font-bold">{i + 1}</span>
                <div className="min-w-0">
                  <div className="font-medium">{d.part}</div>
                  <div className="text-sm text-slate-500">{d.damageType}</div>
                  <div className="text-xs text-slate-400">Parts {fmt(d.partsCost)} · Labor {d.laborHours || 0}h × {fmt(laborRateForState(current?.state))} = {fmt(d.laborCost)}</div>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className={`text-xs px-2 py-0.5 rounded-full border ${SEVERITY_STYLES[d.severity] || ""}`}>{d.severity}</span>
                <span className="text-sm text-slate-400 w-12 text-right">{Math.round((d.confidence || 0) * 100)}%</span>
                <span className="font-semibold w-20 text-right">{fmt(d.estimatedCost)}</span>
              </div>
            </div>
          )) : <div className="px-4 py-6 text-slate-500 text-sm">No discrete damage items returned.</div>}
        </div>

        <div className="mt-6 flex gap-3">
          <button onClick={() => setScreen("queue")} className="bg-slate-900 text-white px-4 py-2.5 rounded-lg text-sm">
            View in claims-agent console
          </button>
          <button onClick={() => { resetClaim(); setScreen("portal"); }} className="border border-slate-300 px-4 py-2.5 rounded-lg text-sm">
            File another claim
          </button>
        </div>
      </>
    );
  } else if (screen === "queue") {
    content = (
      <>
        <h1 className="text-xl font-bold">Claims agent console</h1>
        <p className="text-slate-500 text-sm mt-1">
          Triaged by priority — claims needing your review float to the top, ranked by value-at-risk and (in)confidence. Fast-tracked high-confidence claims await senior-adjuster sign-off; everything else you review first, then it routes to a senior adjuster. Every correction is logged as training data.
        </p>
        <div className="mt-5 bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          {claims.length === 0 && <div className="px-4 py-10 text-center text-slate-400 text-sm">No claims yet. Submit one from the policyholder portal.</div>}
          {[...claims].sort((x, y) => triage(y).score - triage(x).score).map((c) => {
            const t = triage(c);
            return (
              <button key={c.id} onClick={() => { setCurrent(c); setFeedback(c.reviewerFeedback || ""); setEditedItems((c.adjustedItems || c.assessment?.damageItems || []).map((d) => ({ ...d }))); setLaborRate(c.laborRate ?? laborRateForState(c.state)); setSavedNote(""); setAddItemError(""); setAddingItem(false); setActiveIdx(null); setDrawMode(false); setAssessingRegion(false); setScreen("detail"); }}
                className="w-full px-4 py-3 flex items-center justify-between gap-3 hover:bg-slate-50 text-left">
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`shrink-0 text-[10px] uppercase tracking-wide font-semibold px-2 py-1 rounded border ${TIER_STYLES[t.tier]}`}>{t.tier}</span>
                  {c.image?.dataUrl ? (
                    <img src={c.image.dataUrl} alt="" className="h-12 w-12 rounded object-cover border border-slate-200 shrink-0" />
                  ) : (
                    <div className="h-12 w-12 rounded border border-slate-200 bg-slate-100 grid place-items-center text-slate-400 shrink-0"><Car size={18} /></div>
                  )}
                  <div className="min-w-0">
                    <div className="font-medium truncate">{c.id} · {c.name}</div>
                    <div className="text-sm text-slate-500">{fmt(c.adjustedTotal ?? c.assessment?.totalEstimate)} at risk · {Math.round((c.assessment?.overallConfidence || 0) * 100)}% confidence</div>
                  </div>
                </div>
                <StatusBadge status={c.status} />
              </button>
            );
          })}
        </div>
      </>
    );
  } else if (screen === "detail" && current) {
    const a = current.assessment;
    const aiTotal = a.totalEstimate || 0;
    const editedTotal = editedItems.reduce((s, d) => s + (Number(d.estimatedCost) || 0), 0);
    const delta = editedTotal - aiTotal;
    const changed =
      feedback.trim().length > 0 ||
      editedItems.some((d, i) => Number(d.estimatedCost) !== Number(a.damageItems?.[i]?.estimatedCost));

    const setItemCost = (i, val) => {
      setSavedNote("");
      setEditedItems((items) => items.map((d, idx) => (idx === i ? { ...d, estimatedCost: val } : d)));
    };

    // Adjuster overrides the regional labor rate → recompute every item's labor
    // dollars and total. Lets a reviewer correct the rate (e.g. to $85/hr).
    const applyLaborRate = (rate) => {
      setSavedNote("");
      setLaborRate(rate);
      setEditedItems((items) => items.map((d) => {
        const laborCost = Math.round((Number(d.laborHours) || 0) * rate);
        return { ...d, laborCost, estimatedCost: (Number(d.partsCost) || 0) + laborCost };
      }));
    };

    // Adjuster dismisses an inaccurate close-up: clear that item's box (and any
    // drawn-region overlay). The damage line item itself stays on the estimate.
    const removeCloseup = (i) => {
      setSavedNote("");
      setEditedItems((items) => items.map((d, idx) => (idx === i ? { ...d, box: null, drawnBox: false } : d)));
      setActiveIdx(null);
    };

    // Adjuster drew a box on the photo → re-run the AI on just that region and
    // append the result as an adjuster-added line item (rendered in violet).
    const assessDrawnRegion = async (box) => {
      if (assessingRegion) return;
      setDrawMode(false);
      setAssessingRegion(true);
      setAddItemError("");
      setSavedNote("");
      try {
        // Ground the model: send the full photo with a red box drawn on it
        // (Image 1) plus a tight crop of the region (Image 2).
        let cropBase64 = null, annotatedBase64 = null;
        try { cropBase64 = (await cropDataUrlToBox(current.image.dataUrl, box, 0.1)).split(",")[1]; } catch { /* fall back */ }
        try { annotatedBase64 = await annotateDataUrlWithBox(current.image.dataUrl, box); } catch { /* fall back */ }
        const res = await fetch("/api/assess-region", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base64: annotatedBase64 || current.image?.base64,
            mediaType: annotatedBase64 ? "image/jpeg" : current.image?.media_type,
            vehicle: a.vehicle,
            box,
            cropBase64,
          }),
        });
        const data = await res.json();
        if (!data.ok || !data.item) {
          setAddItemError(typeof data.error === "string" ? data.error : "Couldn't assess that region. Try drawing a tighter box around the damage.");
          return;
        }
        const ing = ingestItem({ ...data.item, box }, laborRate);
        const newItem = {
          part: capitalize(data.item.part) || "Agent-marked region",
          damageType: data.item.damageType || "agent-marked",
          severity: data.item.severity || "moderate",
          partsCost: ing.partsCost,
          laborHours: ing.laborHours,
          laborCost: ing.laborCost,
          estimatedCost: ing.estimatedCost,
          confidence: typeof data.item.confidence === "number" ? data.item.confidence : null,
          box,
          addedByAdjuster: true,
          drawnBox: true,
        };
        const newIdx = editedItems.length;
        setEditedItems((items) => [...items, newItem]);
        setActiveIdx(newIdx);
        setSavedNote(`Assessed agent-marked region: ${newItem.part} — ${fmt(newItem.estimatedCost)}. Review and save.`);
      } catch (e) {
        setAddItemError(String(e?.message || e));
      } finally {
        setAssessingRegion(false);
      }
    };

    // Apply the free-text adjuster feedback to the line items: the AI can edit
    // existing items, add new ones, or remove them, and returns the complete
    // revised list. Costs land in the editable fields so they can still be tuned.
    const applyFeedbackToLineItems = async () => {
      if (!feedback.trim() || addingItem) return;
      setAddingItem(true);
      setAddItemError("");
      setSavedNote("");
      try {
        const res = await fetch("/api/lineitem", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base64: current.image?.base64,
            mediaType: current.image?.media_type,
            feedback,
            vehicle: a.vehicle,
            currentItems: editedItems,
          }),
        });
        const data = await res.json();
        if (!data.ok || !Array.isArray(data.lineItems) || data.lineItems.length === 0) {
          setAddItemError(
            typeof data.error === "string"
              ? data.error
              : "Couldn't apply that feedback. Try describing the part and damage more specifically."
          );
          return;
        }
        // Preserve the exact box (and drawn-region status) for items carried over,
        // matched by part name — otherwise an adjuster's hand-drawn region would
        // revert to an AI-estimated box after a text-feedback pass.
        const prevByPart = {};
        editedItems.forEach((d) => {
          if (d.box) prevByPart[(d.part || "").toLowerCase().trim()] = { box: d.box, drawnBox: !!d.drawnBox };
        });
        const revised = data.lineItems.map((d) => {
          const ing = ingestItem(d, laborRate);
          const prev = d.change !== "added" ? prevByPart[(d.part || "").toLowerCase().trim()] : null;
          return {
            part: capitalize(d.part) || "Agent item",
            damageType: d.damageType || "from reviewer feedback",
            severity: d.severity || "moderate",
            partsCost: ing.partsCost,
            laborHours: ing.laborHours,
            laborCost: ing.laborCost,
            estimatedCost: ing.estimatedCost,
            confidence: typeof d.confidence === "number" ? d.confidence : null,
            box: prev ? prev.box : ing.box,
            drawnBox: prev ? prev.drawnBox : false,
            addedByAdjuster: d.change === "added",
            revisedByAdjuster: d.change === "revised",
          };
        });
        const added = revised.filter((d) => d.addedByAdjuster).length;
        const edited = revised.filter((d) => d.revisedByAdjuster).length;
        setEditedItems(revised);
        const parts = [];
        if (added) parts.push(`${added} added`);
        if (edited) parts.push(`${edited} revised`);
        setSavedNote(
          (parts.length ? `Applied feedback: ${parts.join(", ")}.` : "Applied feedback to line items.") +
          " Review the costs and save."
        );
      } catch (e) {
        setAddItemError(String(e?.message || e));
      } finally {
        setAddingItem(false);
      }
    };

    const persist = (extra = {}) => {
      const patch = {
        adjustedItems: editedItems,
        adjustedTotal: editedTotal,
        reviewerFeedback: feedback,
        corrected: changed,
        laborRate,
        ...extra,
      };
      updateClaim(current.id, patch);
      setCurrent((c) => ({ ...c, ...patch }));
    };

    const saveOnly = () => { persist(); setSavedNote("Draft saved — status unchanged."); };
    // Claims agent approves their review → routes to a senior adjuster for the
    // final sign-off (always a second human before authorization).
    const agentApprove = () => { persist({ status: "senior-review" }); setSavedNote("Approved. Sent for final approval from senior adjuster."); };
    // Senior adjuster authorizes → claim is approved and repairs can proceed.
    const seniorAuthorize = () => { persist({ status: "approved" }); setSavedNote("Authorized — repairs approved."); };
    // Reject the AI estimate and return the claim to the policyholder for new
    // photos. The reviewer's feedback becomes the reason they see.
    const requestPhotos = () => {
      const reason = feedback.trim() || "Additional or clearer photos are needed for an accurate assessment.";
      persist({ status: "returned", returnReason: reason });
      setScreen("queue");
    };
    content = (
      <>
        <button onClick={() => setScreen("queue")} className="text-sm text-slate-500 flex items-center gap-1 mb-4">
          <ArrowLeft size={15} /> Back to console
        </button>
        <div className="flex items-start justify-between">
          <div>
            <div className="text-sm text-slate-500">{current.id} · {current.name} · {current.policy}</div>
            <h1 className="text-xl font-bold">{a.vehicle} · {fmt(editedTotal)}</h1>
          </div>
          <StatusBadge status={current.status} />
        </div>

        <div className="grid md:grid-cols-2 gap-6 mt-5">
          <div>
            <DamagePhoto src={current.image?.dataUrl} items={editedItems} activeIdx={activeIdx} setActiveIdx={setActiveIdx} drawMode={drawMode} onDrawComplete={assessDrawnRegion} />
            <div className="flex items-center justify-between gap-2 mt-2 flex-wrap">
              <div className="flex items-center gap-3 text-[11px] text-slate-500">
                <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border-2 border-violet-500 bg-violet-500/20" /> Agent-marked region</span>
                <span>· Draw a box on damage the AI missed to assess it.</span>
              </div>
              <button
                onClick={() => setDrawMode((m) => !m)}
                disabled={assessingRegion}
                className={`text-xs inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border disabled:opacity-60 ${drawMode ? "bg-violet-600 text-white border-violet-600" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
              >
                {assessingRegion ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                {assessingRegion ? "Assessing region…" : drawMode ? "Drag a box on the photo (click to cancel)" : "Add damage region"}
              </button>
            </div>
            {current.extraImages?.length > 0 && (
              <div className="mt-3">
                <div className="text-xs text-slate-400 mb-1">Additional photos ({current.extraImages.length})</div>
                <div className="flex gap-2 flex-wrap">
                  {current.extraImages.map((p, i) => (
                    <img key={i} src={p.dataUrl} alt={`additional ${i + 1}`} className="h-14 w-14 rounded object-cover border border-slate-200" />
                  ))}
                </div>
              </div>
            )}
          </div>
          <div>
            <ConfidenceBar value={a.overallConfidence} />
            <AuthenticityPanel authenticity={a.authenticity} />
            <p className="text-sm text-slate-600 mt-3">{a.summary}</p>

            <div className="flex items-center justify-between mt-4 mb-1">
              <h3 className="text-sm font-semibold text-slate-700">Line items (editable)</h3>
              <div className="flex items-center gap-1 text-xs text-slate-500">
                <span>Labor $</span>
                <input
                  type="number"
                  value={laborRate}
                  onChange={(e) => applyLaborRate(Number(e.target.value) || 0)}
                  className="w-14 rounded border border-slate-300 px-1 py-0.5 text-right focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span>/hr · {regionLabel(current)}</span>
              </div>
            </div>
            <div className="space-y-1">
              {editedItems.map((d, i) => (
                <div key={i} onMouseEnter={() => setActiveIdx(i)} onMouseLeave={() => setActiveIdx(null)}
                  className={`flex items-center justify-between gap-3 border-b border-slate-100 py-1.5 px-1 rounded ${activeIdx === i ? "bg-blue-50" : ""}`}>
                  <div className="min-w-0">
                    <div className="text-sm font-medium flex items-start gap-1.5">
                      <span className="shrink-0 mt-0.5 h-4 w-4 grid place-items-center rounded bg-slate-800 text-white text-[10px] font-bold">{i + 1}</span>
                      <span>{d.part}</span>
                      {d.addedByAdjuster && (
                        <span className="shrink-0 whitespace-nowrap text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border border-blue-200 bg-blue-50 text-blue-700">
                          agent-added
                        </span>
                      )}
                      {d.revisedByAdjuster && (
                        <span className="shrink-0 whitespace-nowrap text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-700">
                          revised
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500">{d.damageType}</div>
                    <div className="text-[11px] text-slate-400">Parts {fmt(d.partsCost)} · Labor {d.laborHours || 0}h = {fmt(d.laborCost)}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-slate-400 text-sm">$</span>
                    <input
                      type="number"
                      value={d.estimatedCost}
                      onChange={(e) => setItemCost(i, e.target.value)}
                      className="w-24 rounded-md border border-slate-300 px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-3 flex justify-between text-sm text-slate-500 bg-slate-50 rounded-md px-3 py-1.5">
              <span>AI predicted</span><span>{fmt(aiTotal)}</span>
            </div>
            <div className="flex justify-between px-3 py-1.5 font-semibold">
              <span>Reviewer total</span>
              <span>
                {fmt(editedTotal)}
                {delta !== 0 && (
                  <span className={`ml-2 text-xs ${delta > 0 ? "text-red-600" : "text-emerald-600"}`}>
                    ({delta > 0 ? "+" : ""}{fmt(delta)} vs AI)
                  </span>
                )}
              </span>
            </div>
          </div>
        </div>

        {editedItems.some((d) => d.box) && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2"><Wrench size={15} /> Damage close-ups</h3>
            <div className="flex gap-3 overflow-x-auto pb-1">
              {editedItems.map((d, i) => d.box ? (
                <Closeup key={i} dataUrl={current.image?.dataUrl} box={d.box} label={d.part} idx={i}
                  active={activeIdx === i} adjuster={d.drawnBox} onHover={setActiveIdx} onRemove={removeCloseup} />
              ) : null)}
            </div>
            <p className="text-[11px] text-slate-400 mt-1">Close-ups cropped at each detected region. AI crops (amber) are approximate; regions you mark (violet) are exact. Precise localization would come from a dedicated detection model in production.</p>
          </div>
        )}

        <div className="mt-6 bg-white border border-slate-200 rounded-lg p-4">
          <label className="block text-sm font-medium text-slate-700 mb-1">Reviewer feedback (logged as training data)</label>
          <textarea value={feedback} onChange={(e) => { setFeedback(e.target.value); setSavedNote(""); }} rows={3}
            placeholder="e.g. Missed cracked headlight assembly; rear bumper is replace not repair — revise estimate up ~$400."
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <div className="mt-3">
            <button onClick={applyFeedbackToLineItems} disabled={!feedback.trim() || addingItem}
              className="inline-flex items-center gap-2 bg-blue-600 disabled:bg-slate-300 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm">
              {addingItem ? <Loader2 size={16} className="animate-spin" /> : <Wrench size={16} />}
              {addingItem ? "Updating…" : "Update assessment"}
            </button>
            <p className="text-xs text-slate-400 mt-1.5">Applies your note to the line items above — edits existing items, adds new ones, or removes them — with AI-estimated costs you can still edit.</p>
            {addItemError && <p className="text-red-600 text-sm mt-2">{addItemError}</p>}
          </div>
          {current.status === "senior-review" && (
            <p className="text-xs text-indigo-600 mt-4 flex items-center gap-1.5">
              <ShieldCheck size={13} />
              {current.fastTracked
                ? "Fast-tracked (high confidence, under the auto-authorization limit) — claims-agent review was skipped. As senior adjuster, authorize to approve."
                : "Reviewed by a claims agent — awaiting senior-adjuster sign-off."}
            </p>
          )}
          <div className="flex gap-3 mt-4 flex-wrap">
            {(current.status === "agent-review" || current.status === "senior-review") && (
              <button onClick={saveOnly} className="inline-flex items-center gap-2 border border-slate-300 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-lg text-sm">
                <RefreshCw size={16} /> Save draft
              </button>
            )}
            {current.status === "agent-review" && (
              <button onClick={agentApprove} className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm">
                <CheckCircle2 size={16} /> Approve & send to senior adjuster
              </button>
            )}
            {current.status === "senior-review" && (
              <button onClick={seniorAuthorize} className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm">
                <ShieldCheck size={16} /> Authorize (senior adjuster)
              </button>
            )}
            {(current.status === "agent-review" || current.status === "senior-review") && (
              <button onClick={requestPhotos} className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white px-4 py-2 rounded-lg text-sm">
                <Upload size={16} /> Reject & request new photos
              </button>
            )}
            {current.status === "approved" && (
              <span className="inline-flex items-center gap-1.5 text-emerald-700 text-sm font-medium"><CheckCircle2 size={16} /> Authorized — repairs can proceed.</span>
            )}
            {current.status === "returned" && (
              <span className="inline-flex items-center gap-1.5 text-sky-700 text-sm font-medium"><Upload size={16} /> Returned to the policyholder for new photos.</span>
            )}
          </div>
          {savedNote && (
            <p className="text-emerald-700 text-sm mt-3 flex items-center gap-1.5">
              <CheckCircle2 size={14} /> {savedNote}
            </p>
          )}
          {changed && (
            <p className="text-xs text-slate-500 mt-2 flex items-center gap-1.5">
              <RefreshCw size={12} /> This correction{delta !== 0 ? ` (Δ ${fmt(delta)} vs AI)` : ""} is captured and would feed the next model retraining cycle.
            </p>
          )}
        </div>
      </>
    );
  }

  return (
    <Shell screen={screen} setScreen={setScreen} resetClaim={resetClaim} claims={claims}>
      {content}
    </Shell>
  );
}
