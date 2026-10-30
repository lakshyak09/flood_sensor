# Flood — iOS app

A SwiftUI client for the Flood server in `../src`. Requires Xcode 16 or newer
(built against Xcode 27); deployment target is iOS 18.

## Running it

Three terminals' worth of setup, once:

```sh
# 1. the server (from the repo root)
JWT_SECRET=dev-secret-not-for-production npm start

# 2. fake data -- there is no hardware yet, so this invents a week of it
npm run seed

# 3. the app
open ios/Flood.xcodeproj      # then hit Run
```

`npm run seed` prints the demo credentials. It creates four sensors that are
deliberately different from each other, because the interesting bugs live in the
states that are easy to forget:

| Sensor | What it exercises |
|---|---|
| Basement — north wall | A week that gets steadily damper, ending around `55 (high)` with an alert |
| Crawlspace | Steady and dry: the boring green case |
| Bathroom wall | Humidity spikes to ~84% twice a day and still scores `low` — sustained conditions are what matter, not peaks |
| Attic hatch | Stopped reporting three hours ago: offline state and a backdated offline alert |
| Garage — back corner | Claimed but never reported: the empty states |

The seeder is idempotent — sensors it has already created are skipped, so it is
safe to re-run. To start over, stop the server, delete `flood.db*`, restart and
re-seed.

## Pointing it somewhere else

The app defaults to `http://127.0.0.1:3000/api/v1`, which is what the simulator
needs. Change it from the **Server** button on the login screen, or in
**Settings → Change server** — no rebuild required. On a physical device, use the
Mac's LAN address.

The server speaks plain HTTP, which iOS blocks by default. `Info.plist` carries
`NSAllowsLocalNetworking`, which permits cleartext to loopback and local-network
addresses **only** — cleartext to the public internet stays blocked. When the
server gets TLS, delete that key.

## Debug launch arguments

Debug builds only, compiled out of release. They exist so that iterating on a
screen does not mean signing in and tapping through the app on every rebuild:

```sh
xcrun simctl launch booted dev.flood.app \
  -demoEmail demo@flood.local -demoPassword demo-password-123 \
  -demoOpenDevice 0 \
  -demoTab sensors \
  -demoScrollTo charts
```

| Argument | Effect |
|---|---|
| `-demoEmail` / `-demoPassword` | Sign in automatically at launch |
| `-demoOpenDevice <index>` | Open straight to that sensor's detail screen |
| `-demoTab sensors\|alerts\|settings` | Start on that tab |
| `-demoScrollTo charts` | Open the detail screen scrolled to the charts |

Screenshots without the GUI:

```sh
xcrun simctl io booted screenshot shot.png
xcrun simctl ui booted appearance dark    # or light
```

## Tests

```sh
xcodebuild test -project ios/Flood.xcodeproj -scheme Flood \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

`FloodTests` is a separate target — it is never part of the app that gets
installed. It covers the plumbing rather than the pixels:

- **Decoding**, against payloads copied from the real server. The cases that
  matter are the awkward ones: a device with too little history answers `200`
  with *every* risk field null (not a zero, not a 404), the list route omits the
  dew point that the detail route includes, `bucket=raw` omits the aggregate
  fields, and an unrecognised enum value from a newer server decodes to
  `.unknown` instead of taking the screen down.
- **Auth**, including the one that matters most: the server revokes every
  session on the account when a spent refresh token is replayed, so several
  screens hitting a dead access token at once must share a *single* refresh. If
  they raced, the app would log itself out.

## The app icon

`Flood/Assets.xcassets/AppIcon.appiconset/AppIcon.png` is generated, not drawn by
hand, so changing it is a code change with a readable diff:

```sh
swift Tools/make-app-icon.swift Flood/Assets.xcassets/AppIcon.appiconset/AppIcon.png
```

## Console messages you can ignore

The Simulator is noisy and almost none of it comes from this app. These are
Apple's and are safe to scroll past:

| Message | What it is |
|---|---|
| `... may only be set for UIKBDynamicRenderFactory` | Keyboard internals. Any app with a text field prints these. |
| `CHHapticPattern ... hapticpatternlibrary.plist ... no such file` | The Simulator has no haptics hardware. Gone on a real iPhone. |
| `Unable to simultaneously satisfy constraints` naming `TUIPredictionViewCell` / `TUICandidateGradientContentLabel` | The keyboard's predictive-text bar. `TUI` is the keyboard, not us — this app has no Auto Layout constraints, it is all SwiftUI. |
| `Invalid UIScreen coordinate space conversion` | Simulator windowing. |
| `cannot add handler to 0 from 0`, `non-launching port ... PointerUI` | Simulator services. |

`CoreUI: ... unable to find a bundle ... with identifier 'dev.flood.app'` *was*
ours — the build referenced an app icon and an accent color that did not exist.
Adding the asset catalog fixed it.

## How it is put together

```
Flood/
  Models/        Codable mirrors of the API. No logic.
  Networking/    APIClient (an actor), Endpoint, token storage, JSON coding.
  Design/        Risk colors, chart palette, shared components.
  Features/      One folder per screen, each with its own @Observable model.
```

Two things are worth knowing before changing anything:

**There is one `APIClient` and it is an actor.** That is what serialises token
refresh (see above). Do not construct a second one.

**The project file does not list source files.** It uses Xcode's synchronized
file groups, so adding a `.swift` file anywhere under `Flood/` is enough — there
is no project file to edit and nothing to merge-conflict over.
