# TLS Certificates go here

Portside talks to your Docker host over TLS. Drop three files in this folder
(or better: import them via **Settings → TLS Certificates** inside the app,
which also supports per-host certificates):

| File | What it is |
|---|---|
| `ca.pem` | Certificate Authority |
| `cert.pem` | Client certificate |
| `key.pem` | Client private key |

**QNAP Container Station:** Container Station → Preferences → Docker Certificate → Download,
then unzip — it contains exactly these three files.

> ⚠️ These are private keys. They are gitignored on purpose. Never commit them.
