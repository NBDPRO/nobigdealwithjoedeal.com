#!/bin/sh
# routing/osrm/deploy.sh — put the routing image on Cloud Run (Jo runs this).
#
# Agents do not deploy Cloud Run services from a session (the NBD guard blocks
# `gcloud run deploy`), and the GitHub deploy account has no Cloud Run admin
# role, so this one command is Jo's. Dry run by default: it prints the command.
#   sh routing/osrm/deploy.sh            # print it
#   sh routing/osrm/deploy.sh --apply    # run it
#
# Private by design: --no-allow-unauthenticated (no allUsers invoker). The
# Cloud Functions runtime account (717435841570-compute@) already holds
# roles/run.invoker on the project, so routeDrive can call it with no new IAM.
# min-instances 0: nothing runs (or bills) between calls.
set -e
IMAGE="${IMAGE:-us-central1-docker.pkg.dev/nobigdeal-pro/routing/osrm-cincy@sha256:b393a6726544b7b560718de76e232c1f5a6a0bce960bcba6c35fbe2bc3cae6c1}"
CMD="gcloud run deploy osrm-cincy --project nobigdeal-pro --region us-central1 \
  --image $IMAGE \
  --no-allow-unauthenticated --memory 2Gi --cpu 1 --cpu-boost \
  --min-instances 0 --max-instances 2 --concurrency 20 --timeout 30 --port 8080 \
  --labels app=nbd-routing"
if [ "$1" = "--apply" ]; then
  sh -c "$CMD"
  gcloud run services get-iam-policy osrm-cincy --project nobigdeal-pro --region us-central1
else
  echo "$CMD"
  echo "(dry run: add --apply to deploy)"
fi
