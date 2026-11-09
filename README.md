# Kagura QR

**Make every code clear.** Kagura QR is a local-first QR studio for creating,
repairing, and reading QR codes. It runs as a static web app, requires no account,
and does not send QR images or payloads to a processing service.

## Features

- Create QR codes for URLs, text, and Wi-Fi, then save them as PNG or SVG.
- Read QR codes from images, PDFs, or a camera, with optional image repair.
- Review decoded links before opening them; the app never opens them automatically.
- Sign payloads with Ed25519 and verify issuers using an independently checked
  fingerprint.
- Use the installable app offline after its local assets have been cached.

## Run locally

Requires Node.js 22.13 or later and pnpm 12.17.0.

```sh
corepack enable
corepack prepare pnpm@12.17.0 --activate
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:4173`.

## Privacy and security

QR content and private keys are processed in the browser. Signed QR codes are not
encrypted, and signatures do not prevent a code from being replaced or removed.
PNG watermarking is experimental and does not establish authenticity.

## License

Kagura QR is licensed under the MIT License. Third-party license notices are in
[`licenses/`](licenses/).
