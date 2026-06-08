import { NextResponse } from "next/server";

// Applies free-text adjuster feedback to the current repair line items: it can
// EDIT/CORRECT existing items, ADD new ones, or REMOVE items, and returns the
// complete revised list. Like /api/assess, the prompt and API key live on the
// server and never reach the browser.
const PROMPT = (feedback, vehicle, currentItems) => `You are an auto-insurance vehicle damage assessment model assisting a human adjuster.

The adjuster reviewed an AI assessment of the attached vehicle photo${vehicle ? ` (${vehicle})` : ""} and wrote feedback. Apply their feedback to the current repair line items by:
- EDITING/CORRECTING existing items (e.g. fixing the affected side, part name, damage type, severity, or cost),
- ADDING new items they identify, and
- REMOVING items they say are wrong or not present.

Return the COMPLETE updated list of line items — not just the changes.

Current line items, numbered exactly as the adjuster sees them (#N. part — damageType — severity — parts $ / labor hrs):
${currentItems && currentItems.length
    ? currentItems.map((d, i) => `#${i + 1}. ${d.part} — ${d.damageType} — ${d.severity || "n/a"} — parts $${d.partsCost ?? "?"} / ${d.laborHours ?? "?"}h`).join("\n")
    : "(none yet)"}

When the adjuster refers to a line item by number (e.g. "line items 1 and 2"), it maps to #1, #2 above. Return the full revised list IN THE SAME ORDER.

Adjuster feedback:
"""
${feedback}
"""

Respond with ONLY valid JSON (no markdown, no backticks, no preamble) matching exactly:
{
  "lineItems": [
    {"part": "string", "damageType": "string", "severity": "minor"|"moderate"|"severe", "partsCost": number, "laborHours": number, "confidence": number, "change": "added"|"revised"|"unchanged", "box": {"x": number, "y": number, "w": number, "h": number}}
  ]
}
Rules:
- Include EVERY item that should remain on the estimate, including ones you did not change.
- Set "change" to "added" for a brand-new item, "revised" if you modified an existing item, or "unchanged" if you carried it over as-is.
- Omit items the feedback says to remove.
- Break cost into a parts cost (USD) and labor HOURS (the labor dollar cost is computed downstream from a regional rate). If the feedback names a dollar figure, reflect it in partsCost and/or laborHours.
- "box" is the damage location in normalized 0-1 coordinates (top-left origin), fractions of image dimensions, used to crop a close-up. Carry over the existing box for unchanged items if known; estimate one for added items.
- Base estimates on the visible damage and the adjuster's notes; give a calibrated confidence (0-1) per item.`;

// Same vision-capable model as the assessment route.
const MODEL = "claude-sonnet-4-6";

export async function POST(req) {
  try {
    const { base64, mediaType, feedback, vehicle, currentItems } = await req.json();
    if (!feedback || !feedback.trim()) {
      return NextResponse.json({ ok: false, error: "No feedback provided." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { ok: false, error: "ANTHROPIC_API_KEY is not set. Copy .env.local.example to .env.local and add your key." },
        { status: 500 }
      );
    }

    // Image is optional here — if present it grounds the cost estimate.
    const userContent = [];
    if (base64) {
      userContent.push({ type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: base64 } });
    }
    userContent.push({ type: "text", text: PROMPT(feedback, vehicle, currentItems) });

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
        messages: [{ role: "user", content: userContent }],
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

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return NextResponse.json(
        { ok: false, error: "Could not parse model response: " + text.slice(0, 300) },
        { status: 502 }
      );
    }

    const lineItems = Array.isArray(parsed.lineItems) ? parsed.lineItems : [];
    return NextResponse.json({ ok: true, lineItems });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
