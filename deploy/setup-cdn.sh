#!/usr/bin/env bash
# Put a CDN (CloudFront) in front of the recordings bucket, so players fetch
# videos, previews, thumbnails and seek-bar stills from a server near them
# instead of through the instance (see apps/server/src/storage/cdn.js).
#
# Creates, idempotently:
#   - a signing key pair: the private half in deploy/cloudfront-private-key.pem
#     (gitignored; keep it), the public half registered in CloudFront, in a
#     key group "8kount-media"
#   - an origin access control, so only CloudFront can read the bucket
#   - a distribution serving the bucket, which only accepts links signed with
#     that key (the server signs them for members who can see the session)
#   - a bucket policy letting that distribution (and nothing else) read it
#
# Prints the lines to add to deploy/prod.env on the instance. Until they're
# there, the server keeps serving files itself, so this can run any time.
#
# Requires: aws cli configured as an admin, openssl.
# Usage:    bash deploy/setup-cdn.sh
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-us-east-1}"
NAME="8kount-media"
KEY_FILE="deploy/cloudfront-private-key.pem"
export AWS_DEFAULT_REGION="$REGION"

log() { printf '\n==> %s\n' "$*"; }

log "Account"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
aws sts get-caller-identity --query Arn --output text
BUCKET="${S3_BUCKET:-8kount-recordings-${ACCOUNT_ID}}"
aws s3api head-bucket --bucket "$BUCKET"
echo "bucket $BUCKET"

# ---------------------------------------------------------------- signing key
log "Signing key"
if [ ! -f "$KEY_FILE" ]; then
  openssl genrsa -out "$KEY_FILE" 2048 2>/dev/null
  chmod 600 "$KEY_FILE"
  echo "made $KEY_FILE"
else
  echo "using $KEY_FILE"
fi
PUBLIC_KEY="$(openssl rsa -in "$KEY_FILE" -pubout 2>/dev/null)"

KEY_ID="$(aws cloudfront list-public-keys \
  --query "PublicKeyList.Items[?Name=='$NAME'].Id | [0]" --output text)"
if [ "$KEY_ID" = "None" ] || [ -z "$KEY_ID" ]; then
  KEY_ID="$(aws cloudfront create-public-key --public-key-config "$(cat <<EOF
{"CallerReference": "$NAME-$(date +%s)", "Name": "$NAME",
 "EncodedKey": $(printf '%s\n' "$PUBLIC_KEY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
 "Comment": "Signs 8kount media links"}
EOF
)" --query PublicKey.Id --output text)"
  echo "public key $KEY_ID registered"
else
  echo "public key $KEY_ID exists"
  echo "(if $KEY_FILE was made again since, delete that key in CloudFront and re-run)"
fi

GROUP_ID="$(aws cloudfront list-key-groups \
  --query "KeyGroupList.Items[?KeyGroup.KeyGroupConfig.Name=='$NAME'].KeyGroup.Id | [0]" --output text)"
if [ "$GROUP_ID" = "None" ] || [ -z "$GROUP_ID" ]; then
  GROUP_ID="$(aws cloudfront create-key-group --key-group-config \
    "{\"Name\": \"$NAME\", \"Items\": [\"$KEY_ID\"], \"Comment\": \"8kount media links\"}" \
    --query KeyGroup.Id --output text)"
  echo "key group $GROUP_ID created"
else
  echo "key group $GROUP_ID exists"
fi

# ---------------------------------------------------------------- origin access
log "Origin access control"
OAC_ID="$(aws cloudfront list-origin-access-controls \
  --query "OriginAccessControlList.Items[?Name=='$NAME'].Id | [0]" --output text)"
if [ "$OAC_ID" = "None" ] || [ -z "$OAC_ID" ]; then
  OAC_ID="$(aws cloudfront create-origin-access-control --origin-access-control-config \
    "{\"Name\": \"$NAME\", \"OriginAccessControlOriginType\": \"s3\",
      \"SigningBehavior\": \"always\", \"SigningProtocol\": \"sigv4\",
      \"Description\": \"CloudFront reads the 8kount recordings bucket\"}" \
    --query OriginAccessControl.Id --output text)"
  echo "created $OAC_ID"
else
  echo "exists $OAC_ID"
fi

# ---------------------------------------------------------------- distribution
log "Distribution"
DIST_ID="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='$NAME'].Id | [0]" --output text)"
# AWS's managed "CachingOptimized" policy: long caching, and the signature in
# the link isn't part of the cache key, so every member's link shares a copy.
CACHE_POLICY="658327ea-f89d-4fab-a63d-7e88639e58f6"
ORIGIN="$BUCKET.s3.$REGION.amazonaws.com"
if [ "$DIST_ID" = "None" ] || [ -z "$DIST_ID" ]; then
  DIST_ID="$(aws cloudfront create-distribution --distribution-config "$(cat <<EOF
{
  "CallerReference": "$NAME-$(date +%s)",
  "Comment": "$NAME",
  "Enabled": true,
  "PriceClass": "PriceClass_100",
  "HttpVersion": "http2and3",
  "Origins": {"Quantity": 1, "Items": [{
    "Id": "recordings",
    "DomainName": "$ORIGIN",
    "OriginAccessControlId": "$OAC_ID",
    "S3OriginConfig": {"OriginAccessIdentity": ""}
  }]},
  "DefaultCacheBehavior": {
    "TargetOriginId": "recordings",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"],
      "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}},
    "CachePolicyId": "$CACHE_POLICY",
    "Compress": false,
    "TrustedKeyGroups": {"Enabled": true, "Quantity": 1, "Items": ["$GROUP_ID"]}
  }
}
EOF
)" --query Distribution.Id --output text)"
  echo "created $DIST_ID (takes a few minutes to reach every location)"
else
  echo "exists $DIST_ID"
fi
DOMAIN="$(aws cloudfront get-distribution --id "$DIST_ID" --query Distribution.DomainName --output text)"
echo "https://$DOMAIN"

# ---------------------------------------------------------------- bucket policy
log "Bucket policy"
POLICY="{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Sid\": \"CloudFrontReads\",
    \"Effect\": \"Allow\",
    \"Principal\": {\"Service\": \"cloudfront.amazonaws.com\"},
    \"Action\": \"s3:GetObject\",
    \"Resource\": \"arn:aws:s3:::$BUCKET/*\",
    \"Condition\": {\"StringEquals\": {
      \"AWS:SourceArn\": \"arn:aws:cloudfront::$ACCOUNT_ID:distribution/$DIST_ID\"}}
  }]
}"
EXISTING="$(aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text 2>/dev/null || true)"
if [ -n "$EXISTING" ] && ! printf '%s' "$EXISTING" | grep -q '"CloudFrontReads"'; then
  echo "The bucket already has a policy, which this would replace:"
  printf '%s\n' "$EXISTING"
  echo "Add this statement to it by hand instead, then re-run:"
  printf '%s\n' "$POLICY"
  exit 1
fi
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$POLICY"
echo "only distribution $DIST_ID can read the bucket"

log "Done"
cat <<EOT
Add these lines to deploy/prod.env on the instance, then run  bash deploy/deploy.sh
(the last one is long: one line, no spaces):

CDN_URL=https://$DOMAIN
CLOUDFRONT_KEY_PAIR_ID=$KEY_ID
CLOUDFRONT_PRIVATE_KEY_BASE64=$(base64 -w0 "$KEY_FILE")

To go back to the server serving files itself, remove them and deploy again.
EOT
