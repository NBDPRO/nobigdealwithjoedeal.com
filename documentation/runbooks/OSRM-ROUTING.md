# OSRM routing: real drive times (2026-10-16)

The Next stop card and Mission Control's day route show **road** minutes instead
of "straight-line miles × 1.3 at 28 mph". Where routing is unavailable they
keep that estimate and say "(est.)".

```
browser (next-stop.js, mission.js)
  └─ route-drive.js ── routeDrive callable (functions/route-drive.js)
                        signed in · App Check · 60/min/user · cache
                          └─ POST /v1/route (ID token) ── Cloud Run "osrm-cincy" (private)
                                                           proxy.py ── osrm-routed (loopback, mmap)
```

## What is where

| Piece | File | Notes |
|---|---|---|
| Image | `routing/osrm/Dockerfile` | OSRM v26.10.0 (BSD-2), pinned by digest. Ohio + Kentucky + Indiana from Geofabrik, clipped to `-85.40,37.55,-83.65,39.75` (Hamilton/Butler/Warren/Clermont, Dearborn IN, Boone/Kenton/Campbell to Fayette/Madison KY). Car profile, MLD. |
| Proxy | `routing/osrm/proxy.py` | The only public port. Takes POST JSON so no coordinate is ever in a request URL (Cloud Run logs URLs). Never logs. Rejects stops outside the box. |
| Build | `routing/osrm/cloudbuild.yaml` | ~12 min on the default worker (free build minutes). |
| Deploy | `routing/osrm/deploy.sh` | **Jo runs it** (`--apply`); dry run by default. |
| Function | `functions/route-drive.js`, `route-drive-logic.js` | `OSRM_URL` in `functions/.env.nobigdeal-pro`. Cache: memory (with the road line) + `route_cache/{sha256}` (minutes and miles only, no coordinates, server-only). |
| Browser | `docs/pro/js/route-drive.js` | 12 s timeout, then the estimate. The sample account never calls it. |

## Measured (first build, 2026-10-16)

- Clipped extract: 119 MB `.osm.pbf` (the three states: 681 MB).
- Graph on disk: 798 MB. Image: 489 MB compressed in Artifact Registry.
- Build: 12 min 11 s on the default Cloud Build worker.

## Cost estimate (the gate was "≤ $10/month")

At 50–200 calls a day, worst case, us-central1 list prices:

| Item | Assumption | Per month |
|---|---|---|
| Cloud Run CPU | min-instances 0, request billing, 1 vCPU; 200 calls × 0.3 s + 30 cold starts × 8 s a day ≈ 9,000 vCPU-s | ~$0.22 (inside the 180,000 vCPU-s free tier) |
| Cloud Run memory | 2 GiB × 9,000 s = 18,000 GiB-s | ~$0.05 (free tier 360,000) |
| Requests | ~6,000 | $0 (2 M free) |
| Artifact Registry | 0.49 GB (cleanup policy keeps the newest 2) | ~$0.05–0.10 |
| Cloud Build | a monthly rebuild, ~12 min | $0 (free minutes) |
| routeDrive + Firestore cache | ~200 invocations, ~400 reads/writes a day | ~$0 |
| **Total** | | **≈ $0.30–$1.00** |

Cold start (estimate, measure after the first deploy): container start plus
`osrm-routed --mmap` (pages the graph in on demand) ≈ 3–6 s. The browser shows
"Calculating drive time…" and gives up at 12 s, falling back to "(est.)".

## Deploy (once, and after each rebuild)

```sh
sh routing/osrm/deploy.sh           # prints the command
sh routing/osrm/deploy.sh --apply   # deploys, then prints the IAM policy
```

Check the printed IAM policy: it must NOT contain `allUsers` or
`allAuthenticatedUsers`. routeDrive's runtime account
(`717435841570-compute@developer.gserviceaccount.com`) already has
`roles/run.invoker` on the project, so no binding is needed.

Measure the cold start after ~20 idle minutes:

```sh
URL=https://osrm-cincy-717435841570.us-central1.run.app
TOKEN=$(gcloud auth print-identity-token)
time curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"coords":[[-84.512,39.1031],[-84.6266,38.9989]]}' $URL/v1/route
```

(A user account's identity token works only if that user can invoke the service;
the project owner can.)

## Refresh the map (monthly is plenty)

```sh
gcloud builds submit routing/osrm --config routing/osrm/cloudbuild.yaml \
  --substitutions=_TAG=$(date -u +%Y%m%d) --project nobigdeal-pro
```

Then put the new digest in `routing/osrm/deploy.sh` (PR) and run it.

## Turning it off

Remove `OSRM_URL` from `functions/.env.nobigdeal-pro` (routeDrive answers
`not_configured`; every screen shows the estimate), or delete the Cloud Run
service. Nothing else depends on it.

## Privacy

- No coordinate is in a URL: the proxy takes POST JSON, and OSRM runs at
  `--verbosity WARNING` on loopback.
- routeDrive logs only an HTTP status when the service fails.
- `route_cache` holds a SHA-256 of the rounded stops plus minutes and miles.
  The road line is cached only in the function's memory.
- Routing data © OpenStreetMap contributors (ODbL), credited under Mission
  Control's route list.

## Alternative if Cloud Run is ever unwanted

openrouteservice's hosted free tier (an API key Jo would create; stored in
Secret Manager) or Google Routes through the existing Google key. Both need a
contract with a third party and send customer addresses off-platform, which this
setup avoids.
