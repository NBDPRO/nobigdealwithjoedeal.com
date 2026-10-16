#!/bin/sh
# OSRM listens on loopback only; the proxy is the one public port.
# --mmap: the graph is paged in on demand, so a cold instance answers in
# seconds instead of reading the whole graph first. WARNING verbosity: OSRM
# writes no per-request line (request URLs carry coordinates).
osrm-routed --algorithm mld --mmap --ip 127.0.0.1 --port 5001 \
  --max-viaroute-size 30 --max-table-size 30 --verbosity WARNING /data/region.osrm &
exec python3 /app/proxy.py
