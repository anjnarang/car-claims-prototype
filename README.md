# AI-Powered Car Insurance Claims Assessment

**Live demo:** https://car-claims-prototype.vercel.app

A prototype of an AI-assisted claims workflow for auto insurance. A policyholder files a claim and uploads damage photo(s); a vision model returns a structured, preliminary damage assessment (parts, damage type, severity, per-item parts + labor cost, and confidence). Claims are then routed for human review — **a human always signs off before anything is authorized** — and every reviewer correction is captured as a training signal.

---

## The problem

Today, the damage-assessment step of an auto claim is slow and manual:

- **Claims agents manually review** submitted photos/videos and assess the extent of damage from experience.
- They **estimate repair costs by hand**, sometimes consulting standardized repair-cost databases.
- A **senior adjuster reviews and authorizes** the estimate before repairs proceed.

This creates real pain:

- **No prioritization** — agents spend the same effort on a $400 scratch and a $9,000 structural claim.
- **Subjective, inconsistent estimates** — human judgment leads to over-/under-payment ("leakage") and rework between the agent, senior adjuster, and repair shop.
- **Slow resolution** — claims sit in a manual queue, and policyholders wait weeks at an already stressful time.

This prototype automates the **review → estimate** step with AI while keeping humans in control of **authorization** — increasing efficiency and consistency at lower cost.

---

## Key features

**AI assessment**
- Vision model turns a damage photo into **structured line items** — part, damage type, severity, parts cost, labor hours, per-item confidence — plus a plain-language summary and an overall confidence score.
- **Location-aware pricing** — labor billed at a region-specific rate (mocked regional table; parts costed for the local market).
- **First-pass fraud / authenticity check** — flags signs of manipulation, stock/duplicate images, or damage inconsistent with the reported incident.
- **Image-quality gate** — blurry/unusable photos are caught up front and returned for a retake.

**Routing — always a human in the loop**
- **Confidence + value gated.** High-confidence claims under an auto-authorization limit fast-track straight to a **senior adjuster** for sign-off; everything else goes to a **claims agent** first, then a senior adjuster — two independent human checkpoints.
- No claim is fully auto-approved; the dollar ceiling mirrors real adjuster authority limits.

**Claims-agent console**
- **Triaged queue** ranked by value-at-risk × (in)confidence, so the highest-impact claims surface first.
- **Editable line items** with a transparent parts + labor breakdown and an **editable labor rate** that recomputes the estimate.
- **Natural-language feedback** that edits, adds, or removes line items (e.g. "items 1 and 2 are driver-side, not passenger-side").
- **Adjuster-drawn damage regions** — draw a box on damage the AI missed and the model assesses just that region.
- **Damage close-ups** cropped per detected region, with the ability to dismiss an inaccurate one.
- Approve → routes to senior adjuster · Authorize → repairs approved · Reject → returns to the policyholder for new photos.

**Learning loop**
- Every correction (edits, dismissed crops, drawn regions, rate overrides) is captured as labeled **training data** to improve the model over time.

---

## How the AI works (and the human ↔ AI interaction)

- A general **vision-language model (Claude)** does what it's strong at — **identifying** damage, **pricing** it, and **explaining** its reasoning.
- **Precise localization** (bounding boxes) is approximate with a general model; in production this is a job for a **dedicated detection/segmentation model**. In the prototype, the adjuster localizes/corrects instead, and those corrections are training examples.
- The interaction is **two-way**: the AI drafts an assessment → a human verifies and corrects it in natural language or by drawing → corrections feed the next retraining cycle.
- The **API key is server-side only** — the browser calls `/api/assess`; the prompt and key never reach the client.

---

## Project structure

- `components/ClaimsApp.js` — the full UI: policyholder portal, assessment report, and claims-agent console.
- `app/api/assess/route.js` — damage assessment from photo(s) (vision model).
- `app/api/lineitem/route.js` — applies natural-language reviewer feedback to the line items.
- `app/api/assess-region/route.js` — assesses a single region an adjuster drew on the photo.
- `app/page.js`, `app/layout.js`, `app/globals.css` — Next.js App Router entry points.

---

## Run it locally

1. Install dependencies:
   ```bash
   npm install
   ```
2. Add your API key:
   ```bash
   cp .env.local.example .env.local
   ```
   Then open `.env.local` and paste a key from https://console.anthropic.com/ (Settings → API Keys).
3. Start the dev server:
   ```bash
   npm run dev
   ```
4. Open http://localhost:3000, click **Submit new claim**, fill in the fields, and upload a damage photo.

## Deploy

Hosted on Vercel. After connecting the repo, add an `ANTHROPIC_API_KEY` environment variable in the Vercel project settings; Vercel builds and hosts automatically. To deploy from the CLI: `npx vercel --prod`.

---

## Design notes & production path

- **Routing thresholds are tunable** (`CONF_THRESHOLD` and `AUTO_APPROVE_CEILING` in `ClaimsApp.js`). In production they'd be set by an evaluation loop balancing cycle-time savings against acceptable leakage — not the model's self-reported confidence. Auto-approved (fast-tracked) claims would also get a sampled audit and a full per-decision audit trail.
- **Repair-cost database is mocked** (regional labor rates). Production integrates a live source (e.g. Mitchell/CCC/Audatex) keyed by region and part.
- **Localization** would use a dedicated computer-vision detection model; the client contract stays the same.
- **Fraud detection** here is an illustrative AI first-pass. Production adds EXIF/metadata analysis, reverse-image search, manipulation-detection models, and claim-history cross-checks.
- **Image handling.** Uploads are re-encoded to a right-sized JPEG in the browser, normalizing formats (including iPhone HEIC) and keeping payloads within the model's image-size limits.
- **No fine-tuning is done here, by design.** The reviewer-correction loop is where labeled ground-truth would be collected to improve the model over time.
