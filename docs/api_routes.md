# Flood — Server API

The HTTP API exposed by the Fastify server. Two kinds of client talk to it:

- **The device** — pushes readings, fetches its own config, checks for firmware.
- **The app** (iOS, and the web dashboard) — reads history and risk, manages devices and notification settings.

Everything is JSON over HTTPS under `/api/v1`.


| Method | Path | Who | What it does |
|---|---|---|---|
| **1. Accounts and logging in** | | | |
| POST | `/auth/register` | anyone | Make an account |
| POST | `/auth/login` | anyone | Sign in |
| POST | `/auth/refresh` | anyone | Renew the short-lived token |
| POST | `/auth/logout` | you | End the session |
| GET | `/me` | you | Your account |
| PATCH | `/me` | you | Change name, theme or password |
| DELETE | `/me` | you | Delete account and everything in it |
| **2. Registering and managing sensors** | | | |
| POST | `/devices/claim` | you | Register a sensor after Bluetooth setup |
| GET | `/devices` | you | Home screen — all sensors with current state |
| GET | `/devices/:id` | you | One sensor in detail |
| PATCH | `/devices/:id` | you | Rename, relocate, change surface material |
| DELETE | `/devices/:id` | you | Unclaim and delete its history |
| **3. Reading data and risk** | | | |
| GET | `/devices/:id/readings` | you | History for charts, compressed |
| GET | `/devices/:id/latest` | you | The live number |
| GET | `/devices/:id/risk` | you | Score plus why |
| GET | `/devices/:id/risk/history` | you | Is it getting better? |
| **4. The sensor's side** | | | |
| POST | `/ingest/readings` | sensor | **Upload readings** — the main one |
| POST | `/ingest/heartbeat` | sensor | Still alive, here's my health |
| GET | `/device/config` | sensor | How often should I measure? |
| GET | `/device/firmware` | sensor | Is there an update? |
| POST | `/device/firmware/report` | sensor | Here's how it went |
| **5. Notifications** | | | |
| POST | `/push/tokens` | you | This phone can get alerts |
| DELETE | `/push/tokens/:token` | you | This one can't anymore |
| GET | `/notifications/preferences` | you | Read alert toggles |
| PUT | `/notifications/preferences` | you | Save alert toggles |
| GET | `/alerts` | you | What was I told, and when |
| POST | `/alerts/:id/acknowledge` | you | Seen it |
| **6. The operator's view** | | | |
| GET | `/admin/stats` | admin | Totals |
| GET | `/admin/devices` | admin | Every sensor's health |
| GET | `/admin/users` | admin | Every account |
| GET | `/admin/health` | anyone/admin | Is the server okay |
