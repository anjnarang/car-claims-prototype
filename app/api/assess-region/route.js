import { NextResponse } from "next/server";

// Assesses a single region of the photo that a human adjuster drew a box around
// (damage the automated pass missed or under-called). The client sends a CROP of
// that region plus the full photo for context, so the model grounds on the right
// part instead of guessing from coordinates. Returns one line item.
const PROMPT = (vehicle, hasCrop) => `You are an auto-insurance vehicle damage assessment model. A human adjuster reviewing a photo of a vehicle${vehicle ? ` (${vehicle})` : ""} marked a specific region they believe contains damage the automated pass missed or under-assessed.

${hasCrop
    ? `You are given TWO images:
- Image 1: the FULL vehicle photo with a RED RECTANGLE drawn on it marking the adjuster's region (use it to work out which part of the car the region is on).
- Image 2: a ZOOMED-IN CROP of that same red-boxed region.

Assess the damage inside the red rectangle / shown in Image 2, and name the vehicle part that is actually inside it. Your "part" MUST be the part visible inside the red box and the crop — do NOT name a more prominent part elsewhere in the photo.`
    : `Assess the damage in the marked region of the attached photo and identify the part.`}

Break the repair cost into a parts cost (USD) and labor HOURS (the labor dollar cost is computed downstream from a regional rate). Give a calibrated confidence (0-1).

Respond with ONLY valid JSON (no markdown, no backticks, no preamble) matching exactly:
{"part": "string", "damageType": "string", "severity": "minor"|"moderate"|"severe", "partsCost": number, "laborHours": number, "confidence": number}

If the crop shows no clear damage, still identify the part, set damageType to "none clearly visible", and return a low confidence.`;

const MODEL = "claude-sonnet-4-6";

export async function POST(req) {
  try {
    const { base64, mediaType, vehicle, box, cropBase64 } = await req.json();
    if (!base64) {
      return NextResponse.json({ ok: false, error: "No image provided." }, { status: 400 });
    }
    if (!box || typeof box.x !== "number") {
      return NextResponse.json({ ok: false, error: "No region provided." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { ok: false, error: "ANTHROPIC_API_KEY is not set. Copy .env.local.example to .env.local and add your key." },
        { status: 500 }
      );
    }

    // Prefer the crop (Image 2) for damage detail; the full photo (Image 1) gives
    // context for naming the part. Falls back to coords-only if no crop was sent.
    const content = [
      { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: base64 } },
    ];
    if (cropBase64) {
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: cropBase64 } });
    }
    content.push({ type: "text", text: PROMPT(vehicle, !!cropBase64) });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        messages: [{ role: "user", content }],
      }),
    });

    const data = await res.json();

    if (data.error || !Array.isArray(data.content)) {
      return NextResponse.json(
        { ok: false, error: data.error?.message || "Model returned an error." },
        { status: 502 }
      );
    }

    const text = data.content.map((b) => b.text || "").join("").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const jsonStr = start !== -1 && end !== -1 ? text.slice(start, end + 1) : text;

    let item;
    try {
      item = JSON.parse(jsonStr);
    } catch {
      return NextResponse.json(
        { ok: false, error: "Could not parse model response: " + text.slice(0, 300) },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true, item });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
