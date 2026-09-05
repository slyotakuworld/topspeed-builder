# macOS Build and Release

This project supports macOS builds through electron-builder. Build macOS artifacts on macOS runners because the app uses `sharp`, a native dependency with platform-specific binaries.

## Internal Test Builds

Apple Silicon:

```bash
npm ci
npm run dist:mac:arm64
```

Intel Mac:

```bash
npm ci
npm run dist:mac:x64
```

Artifacts are written to `release/`:

- `Topspeed Builder-<version>-mac-arm64.dmg`
- `Topspeed Builder-<version>-mac-arm64.zip`
- `Topspeed Builder-<version>-mac-x64.dmg`
- `Topspeed Builder-<version>-mac-x64.zip`

The GitHub Actions workflow at `.github/workflows/build-app.yml` produces unsigned Windows and macOS artifacts for CI validation and internal testing.

## Smoke Test Checklist

Run this checklist on both Apple Silicon and Intel builds before publishing:

1. Launch the app from the DMG.
2. Create a project under `Documents/Topspeed Builder Projects`.
3. Import PNG/JPG/WebP reference images.
4. Switch provider to `local-draft` and generate an icon, a character sheet, and a tileset.
5. Use "show in folder" from an asset card.
6. Export with ZIP enabled and open the export directory.
7. Reopen the app and confirm the recent project list loads.

## Signed Distribution

Unsigned artifacts are suitable only for internal testing. Public macOS distribution should be signed with a Developer ID Application certificate and notarized by Apple.

Required GitHub Actions secrets for signed builds:

- `CSC_LINK`: Base64-encoded `.p12` certificate or a secure URL to it.
- `CSC_KEY_PASSWORD`: Password for the `.p12` certificate.
- `APPLE_ID`: Apple Developer account email.
- `APPLE_APP_SPECIFIC_PASSWORD`: App-specific password for notarization.
- `APPLE_TEAM_ID`: Apple Developer Team ID.

Signed scripts:

```bash
npm run dist:mac:signed:arm64
npm run dist:mac:signed:x64
```

After secrets are configured, run the signed scripts on macOS release runners and publish the notarized DMG/ZIP files.
