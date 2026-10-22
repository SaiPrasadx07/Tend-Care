# Devpost submission checklist

Deadline: **Friday, October 23, 2026, 12:00 PM Pacific** (= Oct 24, 12:30 AM IST). Submit a draft early; drafts can be edited until the deadline.

Source: official Rules (sections 4, Submission Requirements, 6) and the FAQ, both checked on Oct 21, 2026.

## Eligibility

- [ ] Entrant is at least the age of majority, not resident in an excluded jurisdiction, and not affiliated with Amazon or Devpost (Rules §3)
- [ ] Registered on amazonappdev2026.devpost.com ("Join Hackathon")

## Project requirements: Alexa+ track

- [x] Self-hosted MCP server implementing spec **2025-11-25** over **Streamable HTTP** (`src/mcp/server.ts`, `src/http/app.ts`; asserted in `test/mcp.e2e.test.ts`)
- [x] The repo uses the track technology at runtime in code (imports and calls `@modelcontextprotocol/sdk` server + client), not just in the README
- [x] Simulated Alexa+ experience in a web app acting as a real MCP client (FAQ-approved path); its source is in `web/` and `src/agent/`
- [x] New project created during the Submission Period (first commit Oct 21, 2026)
- [x] Clear setup and run instructions (README → Quick start)
- [ ] Demo video shows the project functioning (see `docs/DEMO_SCRIPT.md`)

## AWS Builder mini challenge

- [x] Integration in code: Amazon Bedrock Converse + tool use (`src/agent/bedrock.ts`); Guardrails (`scripts/create-guardrail.ts`)
- [x] Documented integration (`docs/AWS_INTEGRATION.md`, README)
- [ ] **Verified live with your AWS account:** `npm run smoke:bedrock` passes, and the simulator badge shows Amazon Bedrock
- [ ] (Optional) Guardrail created and verified to refuse a dosing-advice question
- [ ] In the Product Feedback answer, describe which AWS services were used and how (text ready in `docs/PRODUCT_FEEDBACK.md`)

## Repository

- [ ] Create a GitHub repo (rules require **GitHub**) and push. **Needs your approval: this makes code public.**
- [ ] Public: the MIT `LICENSE` is detected and shown in the repo's About section (GitHub does this automatically for a root LICENSE file)
- [ ] *or* private, shared with `testing@devpost.com` and GitHub users `knmeiss`, `giolaq`, `anishamalde`, `mosesroth`, `emersonsklar` (invites expire after 7 days)
- [x] No secrets in git history (`.env` ignored; tokens are generated at runtime). Re-check with `git log -p | grep -iE "aws_secret|AKIA|token="` before pushing
- [x] `npm install && npm test` passes on a clean clone (re-run right before submitting)

## Video (public YouTube or Vimeo)

- [ ] Under 3:00
- [ ] Shows the project functioning (caregiver app + Alexa+ companion + Developer trace + Bedrock badge)
- [ ] No third-party trademarks or copyrighted music without permission (no Amazon logos; fictional pharmacies)
- [ ] Uploaded as publicly visible; link pasted in the form
- [ ] English (or English subtitles)

## Devpost form fields

- [ ] Project name, tagline, description: `docs/DEVPOST_DESCRIPTION.md`
- [ ] "Built with" tags
- [ ] Repository URL
- [ ] Video URL
- [ ] Primary track: **Alexa+**
- [ ] Mini challenge(s): **AWS Builder** (and **Open Source** only if you also make a separate contribution; see below)
- [ ] Product Feedback for each tool: `docs/PRODUCT_FEEDBACK.md` (edit after the live Bedrock run)
- [ ] Optional feature requests (table in `docs/PRODUCT_FEEDBACK.md`)
- [ ] Optional **friction log** (up to a **10% bonus**): `docs/FRICTION_LOG.md`
- [ ] Testing instructions: "Run locally: `npm install && npm start`, open http://127.0.0.1:8787. Without AWS credentials an offline router is used; with credentials, Amazon Bedrock."
- [ ] Screenshots / gallery images (take them from the running app)

## Optional: Open Source mini challenge

It requires a *separate* contribution (a new open-source repo or a PR to an existing public repo) made during the hackathon window, plus the contribution URL, repo URL, GitHub username and a description. Candidate: extract `web/mcp-browser.js` + `web/sandbox-proxy.html` as a tiny dependency-free "MCP Apps host for vanilla JS" package with tests. Only if time remains.

## Final verification (do it yourself; the agent must not claim this)

- [ ] Open the submitted Devpost page logged out and check that every link works
- [ ] Clone the repo fresh in a new folder: `npm install && npm test && npm start`
- [ ] Confirm the submission shows as **Submitted**, not a draft
