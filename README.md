# Upwork Job Tracker

A Chrome extension  that monitors Upwork job postings you've applied to. It reloads tracked job tabs on a schedule, reads the Last viewed by client timestamp, and sends a desktop notification the moment the client views your proposal more recently than before.

## Features

- **Instant notifications** — alerts you when the client views your proposal for the first time, or views it again more recently
- **Live stats** — displays proposals count, interviewing count, invites sent, and unanswered invites per job
- **Per-job check interval** — set a custom refresh rate (in minutes) for each tracked job independently
- **CAPTCHA detection** — warns you if Upwork shows a verification challenge on a tracked tab
- **Themes** — 9 built-in color themes (Upwork Pro, Ocean Dive, Forest Trail, Sunset Photo, Neon Gaming, Coffee Shop, Lavender Art, Clean Light, Rose Gold)
- **Custom background** — upload any image as a panel background with adjustable opacity

1. Open an Upwork job posting you've applied to in a Chrome tab
2. Click the extension icon to open the side panel
3. Click **Track Current Job Tab**
4. The extension reads the current "Last viewed by client" value and saves it as the baseline
5. On each scheduled interval, the job tab is reloaded silently and the page is re-read
6. If the client viewed more recently than the stored baseline, a desktop notification fires immediately

---
