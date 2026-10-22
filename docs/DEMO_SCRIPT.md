# Demo video script (target 2:45, hard limit < 3:00)

**Setup before recording**

1. `npm run seed` (fresh demo data), then `npm start` with AWS configured. Check that the badge says **Amazon Bedrock · …** (and **Guardrails** if configured).
2. Use Chrome at 1920×1080, 110% zoom. Turn on **Speak replies**. Use a quiet room and a real microphone.
3. Do a dry run of every line once, then `npm run seed` again so the double-dose moment is fresh.
4. Avoid Amazon logos and third-party marks; demo pharmacies are fictional. Use no copyrighted music (or none at all).
5. Record with OBS (screen + mic). Upload to YouTube as **Public** (or Unlisted only if the rules allow; they say *publicly visible*).

| Time | On screen | Say / do |
|---|---|---|
| 0:00–0:15 | Title card: "Tend: a care circle for Alexa+" | "When siblings share care of a parent, the hardest question in the house is: *did Mom already take her pill?* Tend gives Alexa+ one shared memory for the whole care circle." (If you have a personal story here, use it; it's stronger, but only if it's true.) |
| 0:15–0:30 | The **Today** command center: scroll past the summary, *Needs attention*, the timeline and the adherence heatmap | "Tend is a self-hosted MCP server, spec 2025-11-25 over Streamable HTTP. This caregiver app and the Alexa+ companion on the right both read and write only through Tend's MCP tools. Alexa+ add-on tooling is partner-only, so the device is simulated; its reasoning runs on Amazon Bedrock." |
| 0:30–0:55 | Tap the mic: **"Did Mom take her pills today?"** | Let the reply speak. Point at the **care card** (an MCP App), then click **Trace** to show the Developer workspace: `initialize → tools/list → tools/call get_care_status`. |
| 0:55–1:10 | **"I just gave Dad his amlodipine."** | It's logged and stock goes down. "Every record knows who logged it." |
| 1:10–1:30 | Second window already open as **Arjun** (not yet refreshed): press **Mark given** on Ravi's 9:00 AM Amlodipine. Or switch the caregiver menu to Arjun and say **"I just gave Dad his amlodipine."** | The double-dose guard: "already logged at … by Priya. Nothing was saved." "This is the moment that prevents a double dose between siblings." |
| 1:30–1:55 | **"When will we run out of anything?"** then **"Reorder Mom's metformin."** | It reads the summary and asks "Should I go ahead?" Show in the trace that nothing has been executed yet. |
| 1:55–2:10 | **"Yes, go ahead."** | Confirmed, with the pharmacy message drafted. "Consequential actions are two-step, and the host, not the model, enforces the yes. Our tests include a model trying to confirm on its own; it gets blocked." |
| 2:10–2:25 | **"Note that Dad felt dizzy after lunch."** then **"Give me the handoff for this week."** | The handoff card shows adherence bars, missed doses and the note. |
| 2:25–2:35 | (If a guardrail is configured) **"Dad's dizzy, should he skip his blood pressure pill?"** | The Bedrock Guardrail refuses medical advice and points to the pharmacist. (Without a guardrail, the system prompt still declines; say that instead.) |
| 2:35–2:45 | Switch to **Nurse Maria**: **"Mom took her metformin."** | Refused: view-only. Show the view-only banner, then flash **Developer → Tools** (annotations, MCP App badges) and a terminal showing `npm test`: **111 passing**. |
| 2:45–2:55 | End card: repo URL, "MCP 2025-11-25 · Streamable HTTP · Amazon Bedrock · MCP Apps" | "Tend: one shared memory for the people who care." |

**Fallbacks:** if voice recognition misfires, type the line (it's the same pipeline). If Bedrock is unavailable, the app falls back to the offline router and shows a yellow note. Re-record that take rather than shipping it, because the AWS story depends on Bedrock being visible.

**Optional 15-second beat on conversational quality** (swap in for the activity log if time allows): say **"I want to know about the medicine."** Alexa asks whether you mean today's doses or a particular medicine, rather than reciting everything. Answer **"What Mom needs today"**, then **"What about tonight?"**: a short, focused answer that carries Mom over from the previous turn.
