# routing/osrm/Dockerfile — real drive times for the CRM (2026-10-16).
#
# OSRM (BSD-2-Clause) v26.10.0, car profile, MLD, on a CLIPPED region:
# Ohio + Kentucky + Indiana from Geofabrik, cut to a box around Greater
# Cincinnati, Northern Kentucky, Dayton's south edge and Lexington (BBOX), so
# the graph fits a 2 GiB Cloud Run instance and loads in seconds (mmap).
# The service is private (no allUsers invoker); only the routeDrive Cloud
# Function calls it. See documentation/runbooks/OSRM-ROUTING.md.
#
# Build (Cloud Build, ~15 min): see routing/osrm/cloudbuild.yaml.

# The upstream image, pinned by digest (multi-arch index of v26.10.0-debian).
ARG OSRM_IMAGE=ghcr.io/project-osrm/osrm-backend:v26.10.0-debian@sha256:55dbfd47d984c2cacd64e32901b4321c86b5ec761438e69aa053dc78698a786f

# ── 1. build the routing graph ───────────────────────────────────────────
FROM ${OSRM_IMAGE} AS graph
# lon/lat: west,south,east,north. Covers Hamilton/Butler/Warren/Clermont (OH),
# Dearborn (IN), Boone/Kenton/Campbell up through Fayette/Madison (KY).
ARG BBOX=-85.40,37.55,-83.65,39.75
RUN apt-get update && apt-get install -y --no-install-recommends osmium-tool curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /data
RUN set -eux; \
    for s in ohio kentucky indiana; do \
      curl -fsSL --retry 3 -o "$s.osm.pbf" "https://download.geofabrik.de/north-america/us/$s-latest.osm.pbf"; \
    done; \
    osmium merge ohio.osm.pbf kentucky.osm.pbf indiana.osm.pbf -o merged.osm.pbf; \
    osmium extract -b "$BBOX" --strategy=complete_ways merged.osm.pbf -o region.osm.pbf; \
    rm ohio.osm.pbf kentucky.osm.pbf indiana.osm.pbf merged.osm.pbf; \
    ls -la region.osm.pbf; \
    osrm-extract -p /opt/car.lua region.osm.pbf; \
    osrm-partition region.osrm; \
    osrm-customize region.osrm; \
    rm region.osm.pbf; \
    du -sh /data

# ── 2. the service ───────────────────────────────────────────────────────
FROM ${OSRM_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=graph /data /data
COPY proxy.py start.sh /app/
ENV PORT=8080
EXPOSE 8080
CMD ["/bin/sh", "/app/start.sh"]
