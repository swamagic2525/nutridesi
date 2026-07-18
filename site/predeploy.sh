#!/bin/sh
# Run before every deploy: fails loudly on placeholders and missing assets.
# Usage: sh site/predeploy.sh
cd "$(dirname "$0")"
fail=0

if grep -q "WA_NUMBER" index.html; then
  echo "FAIL: WA_NUMBER placeholder still in index.html — replace with the real WABA number"
  fail=1
fi
if grep -q "14155238886" index.html thanks.html; then
  echo "note: beta links still point to the Twilio sandbox (temp) — swap to wa.me/<number>?text=hi when the WABA number is live (search TEMP-CTA)"
fi
if grep -q "netlify.app" index.html; then
  echo "note: meta URLs point at the temp netlify.app subdomain — swap when the real domain is bought"
fi
if grep -q "PASTE_CODE_HERE" index.html; then
  echo "note: facebook-domain-verification tag not filled yet (fine until Meta asks for it)"
fi
for f in og.png apple-touch-icon.png privacy.html robots.txt sitemap.xml fonts/fraunces-var-latin.woff2; do
  if [ ! -f "$f" ]; then
    echo "FAIL: missing $f"
    fail=1
  fi
done

if [ $fail -eq 0 ]; then
  echo "OK: predeploy checks passed"
else
  exit 1
fi
