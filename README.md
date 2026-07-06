

## Features

- **Instant notifications** — alerts you when the client views your proposal for the first time, or views it again more recently
- **Live stats** — displays proposals count, interviewing count, invites sent, and unanswered invites per job
- **Per-job check interval** — set a custom refresh rate (in minutes) for each tracked job independently
- **CAPTCHA detection** — warns you if Upwork shows a verification challenge on a tracked tab
- **Themes** — 9 built-in color themes (Upwork Pro, Ocean Dive, Forest Trail, Sunset Photo, Neon Gaming, Coffee Shop, Lavender Art, Clean Light, Rose Gold)
- **Custom background** — upload any image as a panel background with adjustable opacity

## How It Works

1. Open an Upwork job posting you've applied to in a Chrome tab
2. Click the extension icon to open the side panel
3. Click **Track Current Job Tab**
4. The extension reads the current "Last viewed by client" value and saves it as the baseline
5. On each scheduled interval, the job tab is reloaded silently and the page is re-read
6. If the client viewed more recently than the stored baseline, a desktop notification fires immediately

---

## Installation (Developer / Unpacked)

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. The extension icon appears in the toolbar — click it to open the side panel

