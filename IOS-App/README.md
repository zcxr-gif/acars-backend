# FlightTracker (iOS / SwiftUI)

A native iOS flight tracker for the Infinite Flight ACARS backend. Built with
**SwiftUI** and **MapKit** (Apple Maps) so it feels at home on iPhone and iPad.

## Features

- 🗺️ **Live map** — every airborne aircraft as an Apple Maps annotation, oriented to its heading
- ✈️ **Flight detail** — altitude, speed, vertical rate, route, and breadcrumb trail
- 🛫 **ATC + airport info** — active frequencies, ATIS, inbound/outbound traffic, NOTAMs
- 🔍 **Search** — by callsign, ICAO, or Infinite Flight username
- 🔔 **Push notifications** — APNs registration plumbing on the client side (server side TBD)
- 🛰️ **Server picker** — Expert / Training / Casual

## Backend

By default the client points at the production backend:

```
https://site--acars-backend--6dmjph8ltlhv.code.run
```

Override at runtime in `Config/AppConfig.swift` or by editing the `API_BASE_URL`
key in `Info.plist`.

## Project layout

```
FlightTracker/
├── FlightTrackerApp.swift      # App entry point + DI container
├── Info.plist                  # Bundle config (background modes, ATS, etc.)
├── Config/
│   └── AppConfig.swift         # Backend URL + feature flags
├── Models/                     # Codable types matching the Node backend payloads
│   ├── Flight.swift
│   ├── Session.swift
│   ├── Airport.swift
│   ├── ATCFacility.swift
│   ├── FlightPlan.swift
│   └── FlightHistory.swift
├── Services/
│   ├── APIClient.swift              # async/await REST client
│   ├── LiveFlightsService.swift     # polling stream (swap for Socket.IO later)
│   └── PushNotificationService.swift
├── ViewModels/                 # @Observable view models
│   ├── MapViewModel.swift
│   ├── FlightDetailViewModel.swift
│   ├── AirportDetailViewModel.swift
│   └── SearchViewModel.swift
└── Views/
    ├── RootView.swift          # TabView shell
    ├── LiveMapView.swift       # MapKit-backed live view
    ├── FlightDetailView.swift
    ├── AirportDetailView.swift
    ├── ATCListView.swift
    ├── SearchView.swift
    ├── ServerPickerView.swift
    └── Components/
        └── PlaneAnnotation.swift
```

## Setup

1. Open Xcode 15+ and create a new **iOS App** project named `FlightTracker`
   (SwiftUI lifecycle, Swift, iOS 17.0 minimum target).
2. Delete the default `ContentView.swift` and `FlightTrackerApp.swift` files.
3. Drag every file under `FlightTracker/` into the Xcode project (uncheck
   "Copy items if needed" if you want to keep them living in this repo).
4. Set the deployment target to **iOS 17.0** — required for the modern
   `Map { Annotation(...) }` SwiftUI API.
5. Replace the generated `Info.plist` with this one (or merge the keys).
6. Build & run on an iOS 17 simulator or device.

### Adding push notification capability

In Xcode → target → **Signing & Capabilities**:
- Add **Push Notifications**
- Add **Background Modes** → check **Remote notifications**

The client will register for APNs on launch and POST the device token to
`/api/push/register` (you'll need to add that endpoint on the Node backend —
see `PushNotificationService.swift` for the exact contract).

### Optional: swap polling for Socket.IO

`LiveFlightsService` polls `/flights/:sessionId` every few seconds. The Node
backend also broadcasts via Socket.IO (`all_flights_update`,
`secondary_data_update`). To use sockets:

1. File → Add Package Dependencies → `https://github.com/socketio/socket.io-client-swift`
2. Replace the polling implementation in `LiveFlightsService.swift` — the
   `AsyncStream` interface stays the same, so call sites don't change.

## API contract (what the client expects)

| Method | Path | Used for |
| --- | --- | --- |
| GET | `/if-sessions` | List active servers |
| GET | `/flights/:sessionId` | All live flights for a server |
| GET | `/flights/:sessionId/:flightId/plan` | Filed flight plan + waypoints |
| GET | `/flights/:sessionId/:flightId/route` | Position history (server side) |
| GET | `/api/flights/:flightId/history` | Persisted breadcrumb trail |
| GET | `/atc/:sessionId` | Active ATC facilities |
| GET | `/notams/:sessionId` | NOTAMs |
| GET | `/api/live/world/:sessionId` | Per-airport traffic counts |
| GET | `/api/airport/:icao` | Static airport metadata |
| GET | `/api/live/airport/:sessionId/:icao/status` | Inbound/outbound + ATC at airport |
| GET | `/api/live/airport/:sessionId/:icao/atis` | Active ATIS text |
| POST | `/users` | User stats lookup |

All responses follow `{ ok: bool, ... }` and the client decodes against the
`Codable` models in `Models/`.
