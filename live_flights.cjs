// 3) One-shot: find the Expert session, then fetch its flights
//    GET /if/expert-flights-test
//    Optional: ?name=Expert   (override the session name match)
//              ?limit=50      (just return the first N flights to keep payload light)
router.get("/expert-flights-test", async (req, res) => {
  const IF_API_BASE_URL = "https://api.infiniteflight.com/public/v2";
  const testKey = (req.query.key || IF_API_KEY || "").trim();
  const nameHint = (req.query.name || "Expert").toLowerCase();
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 1000)); // cap to 1000 for sanity

  if (!testKey) {
    return res.status(400).json({ ok: false, error: "Missing API key (INFINITE_FLIGHT_API_KEY not set and no ?key= provided)" });
  }

  try {
    // 1) Get active sessions (servers)
    const sess = await axios.get(`${IF_API_BASE_URL}/sessions`, {
      headers: { Authorization: `Bearer ${testKey}` },
      timeout: 15000,
    });

    const sessions = Array.isArray(sess.data?.result) ? sess.data.result : [];
    if (!sessions.length) {
      return res.status(502).json({ ok: false, error: "No sessions returned from IF Live API" });
    }

    // 2) Pick the Expert session:
    //    Prefer a "name" that contains "Expert" (defensive against doc changes).
    //    Fall back to the first session if no obvious Expert match is found.
    let expert = sessions.find(s => (s?.name || "").toLowerCase().includes(nameHint));
    if (!expert) {
      // Sometimes the property could be `displayName` or similar—try a few
      expert = sessions.find(s =>
        (s?.displayName || "").toLowerCase().includes(nameHint) ||
        (s?.serverName   || "").toLowerCase().includes(nameHint)
      );
    }
    const picked = expert || sessions[0];
    const sessionId = picked?.id || picked?.uuid || picked?.sessionId;

    if (!sessionId) {
      return res.status(502).json({
        ok: false,
        error: "Could not find a sessionId field in sessions payload",
        sessionsPreview: sessions.slice(0, 3),
      });
    }

    // 3) Fetch flights for that session
    const flightsResp = await axios.get(`${IF_API_BASE_URL}/sessions/${sessionId}/flights`, {
      headers: { Authorization: `Bearer ${testKey}` },
      timeout: 20000,
    });

    const flights = Array.isArray(flightsResp.data?.result) ? flightsResp.data.result : [];

    // 4) Respond with a concise preview so you can eyeball it in the browser
    const preview = flights.slice(0, limit).map(f => ({
      id: f.id || f.flightId,
      callsign: f.callsign,
      userId: f.userId,
      aircraftId: f.aircraftId,
      liveryId: f.liveryId,
      server: picked?.name || picked?.displayName || null,
      lastReport: f.lastReport ? new Date(f.lastReport).toISOString() : null,
      origin: f.departureAirportIcao || f.origin,
      destination: f.arrivalAirportIcao || f.destination,
    }));

    return res.json({
      ok: true,
      session: {
        id: sessionId,
        name: picked?.name || picked?.displayName || "(unknown)",
      },
      totalFlights: flights.length,
      showing: preview.length,
      flights: preview,
    });
  } catch (e) {
    if (e.response) {
      // Mirror IF Live API errors (e.g., { errorCode: 4, result: "API Key is invalid..." })
      return res.status(e.response.status).json({
        ok: false,
        status: e.response.status,
        body: e.response.data,
      });
    }
    return res.status(500).json({ ok: false, error: e.message });
  }
});
