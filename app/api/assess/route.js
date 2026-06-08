import { NextResponse } from "next/server";

// The damage-assessment prompt lives on the server so it (and the API key)
// never reach the browser. To swap in a dedicated computer-vision model later,
// replace the fetch below — the request/response contract to the client stays the same.
const PROMPT = (location, photoCount = 1) => `You are an auto-insurance vehicle damage assessment model. Analyze the attached ${photoCount > 1 ? `${photoCount} photos of the SAME vehicle/claim (different angles)` : "photo of a vehicle"}.

First judge whether the ${photoCount > 1 ? "photos are" : "image is"} usable for assessment. Then, if usable, identify all visible damage across ${photoCount > 1 ? "the photos (deduplicate the same damage seen in multiple shots)" : "the photo"}, and for each item:
- give an approximate bounding box in NORMALIZED coordinates (0-1, x,y = top-left corner, origin at the top-left of the FIRST photo) so the region can be cropped for a close-up,
- break the repair cost into a parts cost (USD) and labor hours (the labor dollar cost is computed downstream from a regional rate, so return HOURS, not labor dollars),
- give a calibrated confidence (0-1).
Estimate PARTS costs for the local market${location ? ` of ${location}` : ""} — parts pricing varies by region.
Also give an overall confidence (0-1).

Additionally, do a first-pass authenticity / fraud screen on the image (this is advisory only): note whether it shows signs of digital manipulation, looks like a stock/web image rather than an original photo, or shows damage inconsistent with a single real-world collision.

Respond with ONLY valid JSON (no markdown, no backticks, no preamble) matching exactly:
{
  "imageQuality": "clear" | "blurry" | "unusable",
  "qualityReason": "one short sentence on why",
  "vehicle": "best-guess make/model/year, or 'Unknown'",
  "damageItems": [
    {"part": "string", "damageType": "string", "severity": "minor"|"moderate"|"severe", "partsCost": number, "laborHours": number, "confidence": number, "box": {"x": number, "y": number, "w": number, "h": number}}
  ],
  "overallConfidence": number,
  "summary": "2-3 sentence plain-language summary for a claims agent",
  "authenticity": {
    "flag": "clear" | "review",
    "summary": "one short sentence on the authenticity assessment",
    "checks": ["2-4 short bullet findings, e.g. 'No obvious signs of digital manipulation'"]
  }
}
Box values are fractions of the image dimensions (e.g. {"x":0.41,"y":0.55,"w":0.2,"h":0.15}); center it on the damaged area. If the image is blurry, dark, partial, or otherwise not reliably assessable, set imageQuality to "blurry" or "unusable" and return an empty damageItems array.`;

// Vision-capable model. Swap for "claude-opus-4-8" (higher accuracy) or
// "claude-haiku-4-5-20251001" (cheaper/faster) as you like.
const MODEL = "claude-sonnet-4-6";

export async function POST(req) {
  try {
    const { base64, mediaType, location, images } = await req.json();
    // Accept either a single image (base64) or multiple photos (images[]).
    const photos = Array.isArray(images) && images.length
      ? images.filter((p) => p && p.base64)
      : base64 ? [{ base64, mediaType }] : [];
    if (!photos.length) {
      return NextResponse.json({ ok: false, error: "No image provided." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { ok: false, error: "ANTHROPIC_API_KEY is not set. Copy .env.local.example to .env.local and add your key." },
        { status: 500 }
      );
    }

    const content = photos.map((p) => ({
      type: "image",
      source: { type: "base64", media_type: p.mediaType || "image/jpeg", data: p.base64 },
    }));
    content.push({ type: "text", text: PROMPT(location, photos.length) });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3072,
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

    let assessment;
    try {
      assessment = JSON.parse(jsonStr);
    } catch {
      return NextResponse.json(
        { ok: false, error: "Could not parse model response: " + text.slice(0, 300) },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true, assessment });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
