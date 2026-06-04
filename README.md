# Upwork Job Tracker

A Chrome extension  that monitors Upwork job postings you've applied to. It reloads tracked job tabs on a schedule, reads the Last viewed by client timestamp, and sends a desktop notification the moment the client views your proposal more recently than before.

## Features

- **Automatic tab refresh** — reloads each tracked job tab on a configurable interval (default: every 5 minutes)
- **Last viewed tracking** — reads and compares the "Last viewed by client" time in seconds for precise change detection
- **Instant notifications** — alerts you when the client views your proposal for the first time, or views it again more recently
- **Live stats** — displays proposals count, interviewing count, invites sent, and unanswered invites per job
- **Per-job check interval** — set a custom refresh rate (in minutes) for each tracked job independently
- **CAPTCHA detection** — warns you if Upwork shows a verification challenge on a tracked tab
- **Themes** — 9 built-in color themes (Upwork Pro, Ocean Dive, Forest Trail, Sunset Photo, Neon Gaming, Coffee Shop, Lavender Art, Clean Light, Rose Gold)
- **Custom background** — upload any image as a panel background with adjustable opacity
- **Debug log** — expandable in-panel log for troubleshooting extraction issues

---

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

---



## Themes

| Theme | Emoji | Style |
|---|---|---|
| Upwork Pro | 💼 | Dark green — default Upwork feel |
| Ocean Dive | 🌊 | Deep blue tones |
| Forest Trail | 🌲 | Dark green nature palette |
| Sunset Photo | 🌅 | Warm orange and rose |
| Neon Gaming | 🎮 | Purple/cyan neon dark |
| Coffee Shop | ☕ | Warm brown and tan |
| Lavender Art | 🎨 | Soft purple and violet |
| Clean Light | ✨ | Light mode, minimal |
| Rose Gold | 🌸 | Pink and rose tones |

---

## Notes

- The tracked job tab must remain **open** in Chrome. The extension reloads that specific tab — it does not open new tabs.
- If the tab is closed, the job is automatically removed from tracking.
- If Upwork shows a CAPTCHA on a tracked tab, the extension will warn you. Complete the verification manually, then remove and re-add the job.
- The extension stores all data locally in `chrome.storage.local` — nothing is sent to any external server.

---

## Version

**3.4**
