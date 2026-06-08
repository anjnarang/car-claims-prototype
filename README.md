# AI-Powered Car Insurance Claims Assessment

A prototype claims-assessment tool for auto insurance. A policyholder files a claim and uploads a damage photo; an AI model returns a structured, preliminary damage assessment (parts, severity, per-item and total repair cost, and a confidence score). High-confidence claims auto-approve; lower-confidence ones route to a human adjuster, who can edit line items, leave feedback, and approve or reject. Every adjuster correction is captured as a training signal.

## What's in here

- `components/ClaimsApp.js` — the full claims UI (policyholder portal, assessment report, adjuster console).
- `app/api/assess/route.js` — server route that holds the API key and calls the vision model. The prompt and key never reach the browser.
- `app/page.js`, `app/layout.js`, `app/globals.css` — Next.js App Router entry points.

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

To record your demo, screen-record this local session — a public deployment is optional.

## Deploy (optional, gives a shareable link)

Push this repo to GitHub, then import it at https://vercel.com/new. In the Vercel project settings, add an environment variable `ANTHROPIC_API_KEY` with your key. Vercel builds and hosts it automatically.

## Notes & decisions

- **The key is server-side only.** The browser calls `/api/assess`, which calls the model. Never put the API key in client code.
- **Image handling.** Uploads are re-encoded to a right-sized JPEG in the browser before being sent, which normalizes formats (including iPhone HEIC) and keeps payloads within the model's image-size limits.
- **Confidence routing** uses the model's self-reported confidence (`CONF_THRESHOLD` in `ClaimsApp.js`). This is a prototype stand-in: in production, the routing threshold would be set from an evaluation loop comparing predicted cost to actual repair-shop cost, not the model's self-assessment.
- **Model.** Set in `app/api/assess/route.js` (`MODEL`). Defaults to a vision-capable Claude model; swap for a larger model for accuracy, a smaller one for cost, or a dedicated computer-vision model — the client contract stays the same.
- **No training/fine-tuning is done here, by design.** The adjuster-correction loop is where labeled ground-truth data would be collected to improve the model over time.

## Using Claude Code from here

Open this folder in Claude Code and try prompts like:
- "Run `npm install` and `npm run dev`, then tell me if anything errors."
- "Add bounding-box overlays on the photo for each detected damage item."
- "Help me push this to a new GitHub repo and deploy it to Vercel."
